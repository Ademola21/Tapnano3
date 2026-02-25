const fs = require("fs");

const MAX_RETRIES = 3;

function solveTurnstileMax({ url, proxy }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const token = await _attemptSolve({ url, proxy });
        return resolve(token);
      } catch (e) {
        const isRetryable = e.includes?.('Target closed') || e.includes?.('TargetCloseError') ||
          e.includes?.('Protocol error') || e.includes?.('Session closed');
        if (isRetryable && attempt < MAX_RETRIES) {
          console.log(`[SOLVER] Attempt ${attempt}/${MAX_RETRIES} failed (${e}). Retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          return reject(e);
        }
      }
    }
    reject("Max retries exceeded");
  });
}

function _attemptSolve({ url, proxy }) {
  return new Promise(async (resolve, reject) => {
    const context = await global.browser
      .createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
      })
      .catch(() => null);

    if (!context) return reject("Failed to create browser context");

    let isResolved = false;
    const isLinux = process.platform === 'linux';

    var cl = setTimeout(async () => {
      if (!isResolved) {
        try { await context.close(); } catch (e) { }
        reject("Timeout Error");
      }
    }, global.timeOut || 60000);

    try {
      const page = await context.newPage();
      page.on('console', msg => console.log(`[MAX-PAGE-LOG] ${msg.text()}`));

      // Window restore — skip on Linux to avoid TargetCloseError
      if (!isLinux) {
        try {
          const session = await page.target().createCDPSession();
          const { windowId } = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal' }
          });
          await page.bringToFront();
        } catch (e) {
          console.log("Failed to restore window:", e.message);
        }
      }

      if (proxy?.username && proxy?.password)
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });

      // Injection to capture the response token
      await page.evaluateOnNewDocument(() => {
        let token = null;
        async function waitForToken() {
          while (!token) {
            try {
              token = window.turnstile.getResponse();
            } catch (e) { }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const check = document.getElementById("turnstile-token");
          if (check) check.value = token;
          else {
            const el = document.createElement("input");
            el.id = "turnstile-token";
            el.type = "hidden";
            el.value = token;
            document.body.appendChild(el);
          }
        }
        waitForToken();
      });

      console.log(`[SOLVER] Navigating to: ${url}`);
      
      // Bandwidth Optimization: Block unnecessary resources
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'font', 'media', 'texttrack'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // Simulate mouse movement to help Turnstile pass
      const mouseLoop = setInterval(async () => {
        if (isResolved) return clearInterval(mouseLoop);
        try {
          await page.mouse.move(Math.random() * 500, Math.random() * 400);
        } catch (e) { }
      }, 2000);

      // Try to find and click the Turnstile checkbox iframe if it's there
      setTimeout(async () => {
        try {
          const frames = page.frames();
          for (const frame of frames) {
            const fUrl = frame.url();
            if (fUrl.includes('challenges.cloudflare.com')) {
              console.log("[SOLVER] Found Turnstile iframe, attempting interaction...");
              const rect = await frame.$eval('body', el => {
                const b = el.getBoundingClientRect();
                return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
              }).catch(() => null);

              if (rect) {
                await page.mouse.click(rect.x, rect.y);
                console.log("[SOLVER] Clicked Turnstile checkbox area.");
              }
            }
          }
        } catch (e) {
          console.log("[SOLVER] Interaction skip/fail:", e.message);
        }
      }, 5000);

      const tokenElement = await page.waitForSelector("#turnstile-token", {
        timeout: global.timeOut || 60000,
      });
      const token = await page.evaluate(() => {
        try {
          return document.querySelector("#turnstile-token").value;
        } catch (e) {
          return null;
        }
      });
      isResolved = true;
      clearInterval(mouseLoop);
      clearInterval(cl);
      try { await context.close(); } catch (e) { }
      if (!token || token.length < 10) return reject("Failed to get token");
      return resolve(token);
    } catch (e) {
      console.log(e);

      if (!isResolved) {
        try { await context.close(); } catch (e) { }
        clearInterval(cl);
        reject(e.message);
      }
    }
  });
}
module.exports = solveTurnstileMax;


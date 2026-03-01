function getSource({ url, proxy, headers }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");
    const context = await global.browser
      .createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined, // https://pptr.dev/api/puppeteer.browsercontextoptions
      })
      .catch(() => null);
    if (!context) return reject("Failed to create browser context");

    let isResolved = false;

    var cl = setTimeout(async () => {
      if (!isResolved) {
        await context.close();
        reject("Timeout Error");
      }
    }, global.timeOut || 60000);

    try {
      const page = await context.newPage();

      try {
        const session = await page.target().createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' }
        });
        // Also bring to front
        await page.bringToFront();
      } catch (e) {
        console.log("Failed to restore window:", e.message);
      }

      if (proxy?.username && proxy?.password)
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });

      if (headers) {
        await page.setExtraHTTPHeaders(headers);
      }

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: global.timeOut || 60000
      });

      // Wait for scripts to settle and localStorage to be populated
      await new Promise(r => setTimeout(r, 10000));

      const html = await page.content();
      const client = await page.target().createCDPSession();
      const { cookies } = await client.send('Network.getAllCookies');
      const localStorage = await page.evaluate(() => JSON.stringify(window.localStorage));

      if (!isResolved) {
        isResolved = true;
        clearInterval(cl);
        resolve({ source: html, cookies, localStorage: JSON.parse(localStorage) });
        await context.close();
      }
    } catch (e) {
      if (!isResolved) {
        await context.close();
        clearInterval(cl);
        reject(e.message);
      }
    }
  });
}
module.exports = getSource;

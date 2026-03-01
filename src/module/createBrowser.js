const { connect } = require("puppeteer-real-browser")
async function createBrowser() {
    try {
        if (global.finished == true) return
        global.browser = null
        const isLinux = process.platform === 'linux';

        const browserConfig = {
            headless: false,
            turnstile: true,
            connectOption: {
                defaultViewport: null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-site-isolation',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--test-type',
                    '--ignore-certificate-errors',
                    '--allow-running-insecure-content',
                    '--disable-blink-features=AutomationControlled',
                    '--no-first-run',
                    '--use-gl=swiftshader',
                    '--disable-gpu'
                ]
            },
            disableXvfb: false,
        };

        if (isLinux) {
            const fs = require('fs');
            const paths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'];
            const valid = paths.find(p => fs.existsSync(p));
            if (valid) browserConfig.customConfig = { chromePath: valid };
        } else {
            browserConfig.customConfig = { chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' };
        }

        console.log(`[INFO] Launching Browser (Linux=${isLinux})...`);
        const { browser } = await connect(browserConfig);
        global.browser = browser;

        browser.on('disconnected', async () => {
            if (global.finished == true) return
            await new Promise(r => setTimeout(r, 3000));
            await createBrowser();
        })
    } catch (e) {
        console.log(`[BROWSER ERR] ${e.message}`);
        if (global.finished == true) return
        await new Promise(r => setTimeout(r, 5000));
        await createBrowser();
    }
}
createBrowser()
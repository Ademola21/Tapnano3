const { connect } = require("puppeteer-real-browser")
async function createBrowser() {
    try {
        if (global.finished == true) return

        global.browser = null

        // console.log('Launching the browser...');

        const isLinux = process.platform === 'linux';
        const browserConfig = {
            headless: isLinux ? true : false,
            turnstile: true,
            connectOption: {
                defaultViewport: null,
                args: isLinux ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] : []
            },
            disableXvfb: false,
        };

        if (!isLinux) {
            browserConfig.customConfig = { chromePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' };
        }

        console.log(`[INFO] Launching Browser (Linux=${isLinux}, Headless=${browserConfig.headless})...`);
        const { browser, page } = await connect(browserConfig);

        try {
            const session = await page.target().createCDPSession();
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', {
                windowId,
                bounds: { windowState: 'minimized' }
            });
            // Try to minimize any other open pages
            const pages = await browser.pages();
            for (const p of pages) {
                try {
                    const s = await p.target().createCDPSession();
                    const { windowId: wid } = await s.send('Browser.getWindowForTarget');
                    await s.send('Browser.setWindowBounds', {
                        windowId: wid,
                        bounds: { windowState: 'minimized' }
                    });
                } catch (err) { }
            }
        } catch (e) {
            console.log("Failed to minimize initial window", e.message);
        }

        // console.log('Browser launched');

        global.browser = browser;

        browser.on('disconnected', async () => {
            if (global.finished == true) return
            console.log('Browser disconnected');
            await new Promise(resolve => setTimeout(resolve, 3000));
            await createBrowser();
        })

    } catch (e) {
        console.log(e.message);
        if (global.finished == true) return
        await new Promise(resolve => setTimeout(resolve, 3000));
        await createBrowser();
    }
}
createBrowser()
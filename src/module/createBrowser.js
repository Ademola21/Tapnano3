const { connect } = require("puppeteer-real-browser")
async function createBrowser() {
    try {
        if (global.finished == true) return

        global.browser = null

        const isLinux = process.platform === 'linux';

        // Use a persistent but unique profile dir to avoid lock files and ensure bypasses stick
        const profilePath = isLinux ? `/tmp/chrome-profile-${process.pid}` : undefined;

        const browserConfig = {
            headless: false, // Must be false for Turnstile — Xvfb handles display on Linux
            turnstile: true,
            connectOption: {
                defaultViewport: null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-site-isolation',
                    '--disable-site-isolation-trials',
                    '--disable-features=IsolateOrigins,site-per-process,TrackingPrevention,EdgeTrackingPrevention',
                    '--test-type',
                    '--disable-blink-features=AutomationControlled',
                    '--ignore-certificate-errors',
                    '--allow-running-insecure-content',
                    '--no-first-run',
                    '--no-service-autorun',
                    '--password-store=basic',
                    '--use-mock-keychain',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-extensions',
                    '--disable-component-update',
                    '--use-gl=swiftshader',
                    '--disable-gpu',
                    '--window-size=1280,720'
                ]
            },
            disableXvfb: false,
        };

        if (profilePath) {
            browserConfig.connectOption.args.push(`--user-data-dir=${profilePath}`);
        }

        if (!isLinux) {
            browserConfig.customConfig = { chromePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' };
        } else {
            // Hardened Linux path detection for Ubuntu/Debian
            const fs = require('fs');
            const commonPaths = [
                process.env.CHROME_PATH,
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium'
            ];

            const validPath = commonPaths.find(p => p && fs.existsSync(p));
            if (validPath) {
                console.log(`[INFO] Linux: Using detected browser path: ${validPath}`);
                browserConfig.customConfig = { chromePath: validPath };
            } else {
                console.log(`[WARNING] Linux: No browser found in common paths. Falling back to default...`);
            }
        }

        console.log(`[INFO] Launching Browser (Linux=${isLinux}, Headless=${browserConfig.headless})...`);
        const { browser, page } = await connect(browserConfig);

        // Minimize browser window (skip on Linux — Xvfb has no real window manager)
        if (!isLinux) {
            try {
                const session = await page.target().createCDPSession();
                const { windowId } = await session.send('Browser.getWindowForTarget');
                await session.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { windowState: 'minimized' }
                });
            } catch (e) {
                console.log("Failed to minimize initial window", e.message);
            }
        }

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
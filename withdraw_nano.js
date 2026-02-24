const axios = require('axios');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { spawn } = require('child_process');

const sessionToken = process.argv[2];
const nanoAddress = process.argv[3];
const proxy = process.argv[4] || null;
const proxySeed = process.argv[5] || null;
const masterAddress = process.argv[6] || null;
const remoteSolverUrl = process.argv[7] || null;

if (!sessionToken || !nanoAddress) {
    console.log('Usage: node withdraw_nano.js <session_token> <nano_address> [proxy] [proxy_seed] [master_address] [remote_solver_url]');
    process.exit(1);
}

const WS_URL = `wss://api.thenanobutton.com/ws?token=${sessionToken}`;
const API_WITHDRAW = 'https://api.thenanobutton.com/api/withdraw';
let TURNSTILE_SERVER = remoteSolverUrl || 'http://127.0.0.1:3000/cf-clearance-scraper';

if (remoteSolverUrl && !TURNSTILE_SERVER.includes('/cf-clearance-scraper')) {
    TURNSTILE_SERVER = TURNSTILE_SERVER.replace(/\/+$/, '') + '/cf-clearance-scraper';
}

async function getBalance() {
    let attempts = 0;
    while (attempts < 3) {
        attempts++;
        try {
            return await new Promise((resolve, reject) => {
                console.log(`[INFO] Fetching balance (Attempt ${attempts}/3)...`);
                const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
                const ws = new WebSocket(WS_URL, { agent });
                const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Timeout')); }, 20000);
                ws.on('message', (data) => {
                    try {
                        const json = JSON.parse(data.toString());
                        let b = json.balance ?? json.session?.currentNano ?? json.currentNano;
                        if (b !== undefined) { clearTimeout(timeout); ws.close(); resolve(b); }
                    } catch (e) { }
                });
                ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
            });
        } catch (e) {
            console.log(`[WARN] Balance fetch failed: ${e.message}`);
            if (attempts < 3) await new Promise(r => setTimeout(r, 3000));
            else throw e;
        }
    }
}

async function solveTurnstile() {
    // Retry CAPTCHA solve up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`[INFO] Solving CAPTCHA attempt ${attempt}/3 (direct, no proxy)...`);
            const res = await axios.post(TURNSTILE_SERVER, {
                mode: 'turnstile-max',
                url: 'https://thenanobutton.com/',
                siteKey: '0x4AAAAAACZpJ7kmZ3RsO1rU'
            }, { timeout: 180000 });
            if (res.data && res.data.token) return res.data.token;
            throw new Error(res.data.message || 'Solver returned empty token');
        } catch (e) {
            console.error(`[WARN] CAPTCHA attempt ${attempt}/3 failed: ${e.message}`);
            if (attempt < 3) {
                console.log('[INFO] Retrying CAPTCHA in 5s...');
                await new Promise(r => setTimeout(r, 5000));
            } else {
                throw new Error(`CAPTCHA failed after 3 attempts: ${e.message}`);
            }
        }
    }
}

async function withdraw(amount) {
    let currentToken = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
        attempts++;
        const tokenDisplay = currentToken ? "WITH token" : "WITHOUT token";
        console.log(`[INFO] Withdrawal attempt ${attempts}/${maxAttempts} (Proceeding ${tokenDisplay})...`);

        try {
            const res = await axios.post(API_WITHDRAW,
                { token: sessionToken, address: nanoAddress, amount: amount, turnstileToken: currentToken || undefined },
                {
                    headers: {
                        'Origin': 'https://thenanobutton.com',
                        'Referer': 'https://thenanobutton.com/',
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                    },
                    httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
                    timeout: 40000
                }
            );

            if (res.status === 200 || res.status === 204) {
                console.log('[SUCCESS] Withdrawal complete.');
                return true;
            }
        } catch (e) {
            const msg = e.response?.data?.message || e.message || '';
            const isCaptcha = e.response?.data?.captchaRequired || msg.toLowerCase().includes('captcha');

            if (isCaptcha) {
                console.log('[ALERT] API requested CAPTCHA.');
                if (currentToken) {
                    console.log('[WARN] Token was rejected. Getting a fresh token...');
                    currentToken = null; // Clear rejected token
                }
                try {
                    currentToken = await solveTurnstile();
                    continue; // Loop again with the new token
                } catch (err) {
                    console.error(`[ERROR] Solver failed: ${err.message}`);
                    if (attempts < maxAttempts) {
                        console.log('[INFO] Will retry withdrawal in 10s...');
                        await new Promise(r => setTimeout(r, 10000));
                        continue;
                    }
                    return false;
                }
            }

            const isNetwork = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('timeout');
            if (isNetwork && attempts < maxAttempts) {
                console.log(`[WARN] Network hiccup (${msg}). Retrying in 1s...`);
                currentToken = null; // Clean token state for network retry
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            console.error(`[ERROR] Fatal: ${msg}`);
            return false;
        }
    }
    return false;
}

async function main() {
    try {
        const balance = await getBalance();
        console.log(`[INFO] Balance to secure: ${balance}`);
        if (balance <= 0) process.exit(0);

        if (await withdraw(balance)) {
            console.log('[FINISH] Withdrawal successful.');
            if (proxySeed && masterAddress) {
                console.log('[INFO] Immediate consolidation triggered...');
                await new Promise(r => setTimeout(r, 500));
                const p = spawn('node', ['consolidator.js', proxySeed, masterAddress], { stdio: 'inherit' });
                p.on('close', (c) => process.exit(c));
            } else {
                process.exit(0);
            }
        } else {
            console.log('[FAIL] Withdrawal cycle failed.');
            process.exit(1);
        }
    } catch (e) {
        console.error(`[CRITICAL] Error: ${e.message}`);
        process.exit(1);
    }
}

main();

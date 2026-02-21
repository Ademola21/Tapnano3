const axios = require('axios');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { spawn } = require('child_process');

const sessionToken = process.argv[2];
const nanoAddress = process.argv[3];
const proxy = process.argv[4] || null;
const proxySeed = process.argv[5] || null;
const masterAddress = process.argv[6] || null;

if (!sessionToken || !nanoAddress) {
    console.log('Usage: node withdraw_nano.js <session_token> <nano_address> [proxy] [proxy_seed] [master_address]');
    process.exit(1);
}

const WS_URL = `wss://api.thenanobutton.com/ws?token=${sessionToken}`;
const API_WITHDRAW = 'https://api.thenanobutton.com/api/withdraw';
const TURNSTILE_SERVER = 'http://127.0.0.1:3000/cf-clearance-scraper';

async function getBalance() {
    return new Promise((resolve, reject) => {
        console.log('[INFO] Connecting to WebSocket to fetch current balance...');
        const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
        const ws = new WebSocket(WS_URL, { agent });

        const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket connection timed out after 30 seconds'));
        }, 30000);

        ws.on('open', () => {
            console.log('[WS] Connected. Waiting for balance...');
        });

        ws.on('message', (data) => {
            const msg = data.toString();
            console.log(`[WS RECV] ${msg}`);
            try {
                const json = JSON.parse(msg);
                let balance = undefined;

                if (json.balance !== undefined) {
                    balance = json.balance;
                } else if (json.session && json.session.currentNano !== undefined) {
                    balance = json.session.currentNano;
                } else if (json.currentNano !== undefined) {
                    balance = json.currentNano;
                }

                if (balance !== undefined) {
                    console.log(`[INFO] Found balance: ${balance}`);
                    clearTimeout(timeout);
                    ws.close(); // Clean close
                    resolve(balance);
                }
            } catch (e) {
                console.log(`[DEBUG WS ERROR] ${e.message}`);
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

async function solveTurnstile() {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        console.log(`[INFO] Requesting Turnstile token from local server (Attempt ${attempts}/${maxAttempts})...`);
        try {
            let proxyObj = undefined;
            if (proxy) {
                try {
                    const pUrl = new URL(proxy);
                    proxyObj = {
                        host: pUrl.hostname,
                        port: parseInt(pUrl.port),
                        username: pUrl.username,
                        password: pUrl.password
                    };
                } catch (e) { }
            }

            const res = await axios.post(TURNSTILE_SERVER, {
                mode: 'turnstile-max',
                url: 'https://thenanobutton.com/',
                siteKey: '0x4AAAAAACZpJ7kmZ3RsO1rU',
                proxy: proxyObj
            }, { timeout: 60000 });

            if (res.data && res.data.token) return res.data.token;
            throw new Error(res.data.message || 'Solver returned empty response');
        } catch (e) {
            const status = e.response ? e.response.status : (e.code || 'NETWORK_ERROR');
            const data = e.response ? JSON.stringify(e.response.data) : (e.message || 'No error message');
            console.error(`[ERROR] Turnstile solver failed [${status}]: ${data}`);
            if (e.code === 'ECONNREFUSED') console.error('[DEBUG] Connection refused - is the solver on port 3000 active?');

            if (attempts < maxAttempts) {
                console.log('[INFO] Solver busy or failed. Waiting 5 seconds before retry...');
                await new Promise(r => setTimeout(r, 5000));
            } else {
                throw e;
            }
        }
    }
}

async function withdraw(amount, turnstileToken = null) {
    console.log(`[INFO] Attempting to withdraw ${amount} Nano-units...`);
    const payload = {
        token: sessionToken,
        address: nanoAddress,
        amount: amount
    };
    if (turnstileToken) {
        payload.turnstileToken = turnstileToken;
    }

    try {
        const res = await axios.post(API_WITHDRAW, payload, {
            headers: {
                'Origin': 'https://thenanobutton.com',
                'Referer': 'https://thenanobutton.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Content-Type': 'application/json'
            },
            httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined
        });

        if (res.status === 200 || res.status === 204) {
            console.log('[SUCCESS] Withdrawal processed successfully!');
            console.log(`[DATA] Response: ${JSON.stringify(res.data)}`);
            return true;
        } else {
            console.log(`[WARN] Unknown status code: ${res.status}`);
            console.log(`[DEBUG] Response: ${JSON.stringify(res.data)}`);
            return false;
        }
    } catch (e) {
        if (e.response && e.response.data && (e.response.data.captchaRequired || e.response.data.message?.includes('captcha'))) {
            console.log('[ALERT] CAPTCHA required for withdrawal.');
            if (turnstileToken) {
                console.error('[ERROR] CAPTCHA failed even after solving.');
                return false;
            }
            try {
                const newToken = await solveTurnstile();
                return withdraw(amount, newToken);
            } catch (err) {
                console.error(`[ERROR] CAPTCHA solver failed: ${err.message}`);
                return false;
            }
        }
        console.error(`[ERROR] Withdrawal failed: ${e.message}`);
        if (e.response && e.response.data) {
            const errData = e.response.data;
            console.error(`[DEBUG] API Error: ${errData.message || JSON.stringify(errData)}`);
            if (errData.captchaRequired) console.log('[ALERT] Source reports CAPTCHA still required.');
        }
        return false;
    }
}

async function main() {
    try {
        const balance = await getBalance();
        console.log(`[INFO] Current Balance: ${balance} Nano-units`);

        if (balance <= 0) {
            console.log('[SKIP] No balance to withdraw.');
            process.exit(0);
        }

        const success = await withdraw(balance);
        if (success) {
            console.log('[FINISH] Withdrawal successful.');

            if (proxySeed && masterAddress) {
                console.log('[INFO] Withdrawal to Proxy Wallet confirmed. Starting consolidation to Master Wallet...');
                // Wait a bit for the transaction to be semi-confirmed by the API side
                await new Promise(r => setTimeout(r, 10000));

                const consolidatorProc = spawn('node', ['consolidator.js', proxySeed, masterAddress]);
                consolidatorProc.stdout.on('data', (d) => console.log(`[CONSOLIDATOR] ${d.toString().trim()}`));
                consolidatorProc.stderr.on('data', (d) => console.log(`[CONSOLIDATOR ERROR] ${d.toString().trim()}`));
                consolidatorProc.on('close', (code) => {
                    console.log(`[CONSOLIDATOR] Finished with code ${code}`);
                    process.exit(0);
                });
            } else {
                process.exit(0);
            }
        } else {
            console.log('[FAIL] Withdrawal failed.');
            process.exit(1);
        }
    } catch (e) {
        console.error(`[CRITICAL] Script failed: ${e.message}`);
        process.exit(1);
    }
}

main();

const axios = require('axios');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { spawn } = require('child_process');

const sessionToken = process.argv[2] || null;
const nanoAddress = process.argv[3] || null;
let proxy = process.argv[4] || null;
const proxySeed = process.argv[5] || null;
const masterAddress = process.argv[6] || null;
const remoteSolverUrl = process.argv[7] || null;
const fakeIpArg = process.argv[8] || null;
const useFakeIp = fakeIpArg && fakeIpArg !== 'false';

// Force proxy to null if spoofing IP locally
if (useFakeIp) {
    proxy = null;
}

if (!sessionToken || !nanoAddress) {
    console.log('Usage: node withdraw_nano.js <session_token> <nano_address> [proxy] [proxy_seed] [master_address] [remote_solver_url] [fake_ip]');
    process.exit(1);
}

const WS_URL = sessionToken && sessionToken !== 'AUTO' ? `wss://api.thenanobutton.com/ws?token=${sessionToken}` : null;
const API_WITHDRAW = 'https://api.thenanobutton.com/api/withdraw';
let TURNSTILE_SERVER = remoteSolverUrl || 'http://127.0.0.1:3000/cf-clearance-scraper';

if (remoteSolverUrl && !TURNSTILE_SERVER.includes('/cf-clearance-scraper')) {
    TURNSTILE_SERVER = TURNSTILE_SERVER.replace(/\/+$/, '') + '/cf-clearance-scraper';
}

const bridgeSessionId = `ws_${Math.random().toString(36).substring(2, 11)}`;
let bridgeWs = null;
let currentSessionToken = (sessionToken === 'AUTO') ? null : sessionToken;
let browserCookies = '';

async function connectBridge() {
    try {
        const bridgeBase = TURNSTILE_SERVER.replace('/cf-clearance-scraper', '');
        console.log(`[INFO] connectBridge: Starting bridge ${bridgeSessionId} at ${bridgeBase}`);

        const startRes = await axios.post(`${bridgeBase}/ws-bridge/start`, {
            sessionId: bridgeSessionId,
            url: 'https://thenanobutton.com/',
            sessionToken: currentSessionToken,
            proxy: (proxy && proxy !== '' && proxy !== 'null' && !useFakeIp) ? {
                host: new URL(proxy).hostname,
                port: new URL(proxy).port,
                username: new URL(proxy).username,
                password: new URL(proxy).password
            } : null
        }, { timeout: 90000 });

        if (!startRes.data.success) throw new Error("Bridge start failed");

        let wsBridgeUrl = bridgeBase;
        if (wsBridgeUrl.startsWith('http://')) wsBridgeUrl = wsBridgeUrl.replace('http://', 'ws://');
        else if (wsBridgeUrl.startsWith('https://')) wsBridgeUrl = wsBridgeUrl.replace('https://', 'wss://');
        wsBridgeUrl = `${wsBridgeUrl}/ws-bridge/connect/${bridgeSessionId}`;

        console.log(`[INFO] Connecting local WS to bridge at ${wsBridgeUrl}`);
        bridgeWs = new WebSocket(wsBridgeUrl);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Bridge connect timeout')), 30000);
            bridgeWs.on('open', () => {
                console.log('[INFO] Bridge connection established.');
            });
            bridgeWs.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'event' && msg.eventType === 'open') {
                        clearTimeout(timeout);
                        console.log('[INFO] Browser WebSocket is OPEN via bridge.');
                        resolve();
                    }
                } catch (e) { }
            });
            bridgeWs.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    } catch (err) {
        console.error(`[ERROR] connectBridge failed: ${err.message}`);
        throw err;
    }
}

async function getBalance() {
    if (!bridgeWs) await connectBridge();

    return new Promise((resolve, reject) => {
        console.log(`[INFO] Fetching balance via bridge...`);
        const timeout = setTimeout(() => { reject(new Error('Balance fetch timeout')); }, 20000);

        const onMessage = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'message') {
                    const json = JSON.parse(msg.data);
                    let b = json.totalEarnedNano ?? json.balance ?? json.session?.currentNano ?? json.currentNano;
                    if (b !== undefined) {
                        clearTimeout(timeout);
                        bridgeWs.off('message', onMessage);
                        resolve(b);
                    }
                }
            } catch (e) { }
        };

        bridgeWs.on('message', onMessage);
    });
}

async function solveTurnstile() {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`[INFO] Solving CAPTCHA attempt ${attempt}/3 via solver bridge...`);
            const res = await axios.post(TURNSTILE_SERVER, { mode: 'source', url: 'https://thenanobutton.com/' }, { timeout: 180000 });

            if (res.data?.localStorage && res.data.localStorage['nano_session_token']) {
                currentSessionToken = res.data.localStorage['nano_session_token'];
                const cookies = res.data.cookies || [];
                browserCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                console.log(`[INFO] Successfully fetched token and ${cookies.length} cookies.`);
                return currentSessionToken;
            }
            throw new Error('Token not found in solver response');
        } catch (e) {
            console.error(`[WARN] CAPTCHA attempt ${attempt}/3 failed: ${e.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
            else throw e;
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
            const requestId = `req_${Math.random().toString(36).substring(2, 11)}`;
            const payload = {
                type: 'req_http',
                id: requestId,
                url: '/api/withdraw', // Use relative URL or full URL, the bridge fetch handles it
                method: 'POST',
                body: { token: currentSessionToken, address: nanoAddress, amount: amount, turnstileToken: currentToken || undefined }
            };

            const response = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    bridgeWs.off('message', onHandler);
                    reject(new Error('Withdrawal request timeout'));
                }, 60000);

                const onHandler = (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'resp_http' && msg.id === requestId) {
                            clearTimeout(timeout);
                            bridgeWs.off('message', onHandler);
                            resolve(msg.result);
                        }
                    } catch (e) { }
                };
                bridgeWs.on('message', onHandler);
                bridgeWs.send(JSON.stringify(payload));
            });

            if (response.error) throw new Error(response.error);

            if (response.status === 200 || response.status === 204) {
                console.log('[SUCCESS] Withdrawal complete.');
                return true;
            } else {
                const msg = response.data?.message || JSON.stringify(response.data) || 'Unknown error';
                throw { response: { data: response.data, status: response.status }, message: msg };
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
        if (sessionToken === 'AUTO') {
            await solveTurnstile();
        }

        const balance = await getBalance();
        console.log(`[INFO] Balance to secure: ${balance}`);

        if (balance <= 0) {
            console.log('[INFO] Balance is 0. Nothing to withdraw.');
            process.exit(0);
        }

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

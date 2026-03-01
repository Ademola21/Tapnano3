const nano = require('nanocurrency');
const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

console.log(`[DEBUG] Worker started with args: ${process.argv.slice(2).join(' ')}`);

// Altcha PoW Solver
function solveAltcha(salt, challenge, maxNumber = 10000000) {
    console.log(`[POW] Solving challenge: ${challenge} with salt: ${salt}`);
    const start = Date.now();
    for (let i = 0; i <= maxNumber; i++) {
        const hash = crypto.createHash('sha256').update(salt + i).digest('hex');
        if (hash === challenge) {
            const took = Date.now() - start;
            console.log(`[POW] Solved in ${took}ms! Number: ${i}`);
            return i;
        }
    }
    return null;
}

let TURNSTILE_SERVER = 'http://127.0.0.1:3000/cf-clearance-scraper';

function generateRandomIP() {
    return `${Math.floor(Math.random() * 255) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

class FastTapper {
    constructor(sessionToken, proxy = null, useFakeIp = false) {
        this.sessionToken = sessionToken;
        this.proxy = proxy;
        this.useFakeIp = useFakeIp;
        this.fakeIp = useFakeIp ? generateRandomIP() : null;
        this.ws = null;
        this.tapInterval = null;
        this.balance = 0;
        this.sitekey = '0x4AAAAAACZpJ7kmZ3RsO1rU';
        this.limitReached = false;
        this.captchaSolving = false;
        this.browserCookies = '';
        this.proxyWallet = null;
        this.halted = false;
        this.starting = false;
        this.isPaused = false;
        this._lastWithdrawalFailure = 0;
        this.bridgeSessionId = `ws_${Math.random().toString(36).slice(2, 11)}`;
    }

    async generateProxyWallet() {
        const seed = Array.from(crypto.randomBytes(32)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        const publicKey = nano.derivePublicKey(nano.deriveSecretKey(seed, 0));
        const address = nano.deriveAddress(publicKey, { alphabet: 'nano' });
        return { seed, address };
    }

    rotateProxy() {
        if (!this.proxy) return;
        const newSessionId = crypto.randomBytes(4).toString('hex');
        this.proxy = this.proxy.replace(/(-session-[^:@]+)/i, `-session-rand_${newSessionId}`);
        if (!this.proxy.includes('-session-')) {
            this.proxy = this.proxy.replace(/(brd-customer-[^:]+)/, `$1-session-rand_${newSessionId}`);
        }
        console.log(`[PROXY] Rotated session ID to: rand_${newSessionId}`);
    }

    async start() {
        if (this.starting) return;
        this.starting = true;

        if (!this.sessionToken || this.sessionToken === 'AUTO') {
            console.log('[DEBUG] Start: sessionToken is AUTO, requesting token via solver bridge...');
            let fetched = false;
            for (let attempt = 1; attempt <= 3 && !fetched; attempt++) {
                try {
                    const solverUrl = TURNSTILE_SERVER;
                    console.log(`[DEBUG] Requesting session from solver at ${solverUrl}... Attempt ${attempt}/3`);
                    const solverRes = await axios.post(solverUrl, { mode: 'source', url: 'https://thenanobutton.com/' }, { timeout: 180000 });

                    if (solverRes?.data?.localStorage && solverRes.data.localStorage['nano_session_token']) {
                        this.sessionToken = solverRes.data.localStorage['nano_session_token'];
                        console.log(`[DEBUG] Successfully fetched token: ${this.sessionToken.substring(0, 15)}...`);
                        fetched = true;
                    } else {
                        console.warn(`[DEBUG] Token not found in solver response.`);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                } catch (e) {
                    console.error(`[DEBUG] Solver fetch failed: ${e.message}`);
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
            if (!fetched) { console.error('[FATAL] No session token. Exiting.'); process.exit(1); }
        }

        if (this.withdrawAddress && !this.proxyWallet) {
            this.proxyWallet = savedWalletSeed ? { seed: savedWalletSeed, address: savedWalletAddr } : await this.generateProxyWallet();
        }

        try { process.send({ type: 'session-info', sessionToken: this.sessionToken, proxyWalletSeed: this.proxyWallet?.seed || '', proxyWalletAddress: this.proxyWallet?.address || '' }); } catch (e) { }

        this.starting = false;
        await this.connectBridge();
    }

    async connectBridge() {
        try {
            const bridgeBase = TURNSTILE_SERVER.replace('/cf-clearance-scraper', '');
            console.log(`[DEBUG] connectBridge: Starting bridge ${this.bridgeSessionId} at ${bridgeBase}`);

            const startRes = await axios.post(`${bridgeBase}/ws-bridge/start`, {
                sessionId: this.bridgeSessionId,
                url: 'https://thenanobutton.com/',
                sessionToken: this.sessionToken,
                cookies: this.cookies,
                headers: this.useFakeIp ? {
                    'X-Forwarded-For': this.fakeIp,
                    'X-Real-IP': this.fakeIp,
                    'Forwarded': `for=${this.fakeIp}`
                } : undefined,
                proxy: (this.proxy && this.proxy !== '' && this.proxy !== 'null' && !this.useFakeIp) ? {
                    host: new URL(this.proxy).hostname,
                    port: new URL(this.proxy).port,
                    username: new URL(this.proxy).username,
                    password: new URL(this.proxy).password
                } : null
            }, { timeout: 90000 });

            if (!startRes.data.success) throw new Error("Bridge start failed");

            let wsBridgeUrl = bridgeBase;
            if (wsBridgeUrl.startsWith('http://')) wsBridgeUrl = wsBridgeUrl.replace('http://', 'ws://');
            else if (wsBridgeUrl.startsWith('https://')) wsBridgeUrl = wsBridgeUrl.replace('https://', 'wss://');
            wsBridgeUrl = `${wsBridgeUrl}/ws-bridge/connect/${this.bridgeSessionId}`;

            console.log(`[DEBUG] Connecting local WS to bridge at ${wsBridgeUrl}`);

            this.ws = new WebSocket(wsBridgeUrl);

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'message') this.handleWSMessage(msg.data);
                    else if (msg.type === 'event') {
                        if (msg.eventType === 'stream_connected') {
                            console.log('[DEBUG] Local WS connected to bridge. Waiting for browser to open WS...');
                        } else if (msg.eventType === 'open') {
                            console.log('[BRIDGE] Online!');
                            // Authenticate connection dynamically
                            this.ws.send(JSON.stringify({ type: 'session', token: this.sessionToken }));

                            if (this.tapInterval) clearInterval(this.tapInterval);
                            this.tapInterval = setInterval(() => this.tap(), 100);
                        } else if (msg.eventType === 'close') {
                            console.log('[BRIDGE] Offline. Retrying...');
                            this.stop();
                            if (!this.halted) setTimeout(() => this.start(), 5000);
                        } else if (msg.eventType === 'error') {
                            console.error('[BRIDGE] Browser WebSocket Error', msg.data);
                        }
                    }
                } catch (e) {
                    console.error('[DEBUG] Error parsing WS message from bridge:', e.message);
                }
            });

            this.ws.on('close', () => {
                console.log('[DEBUG] Local WS to bridge closed.');
                this.stop();
                if (!this.halted) setTimeout(() => this.start(), 5000);
            });

            this.ws.on('error', (err) => {
                console.error(`[DEBUG] Local WS error: ${err.message}`);
            });

        } catch (e) {
            console.error(`[BRIDGE ERR] ${e.message}`);
            setTimeout(() => this.start(), 5000);
        }
    }

    handleWSMessage(data) {
        try {
            const json = JSON.parse(data);

            if (json.type === 'stats') {
                this.displayStats(json.onlineUsers);
            } else if (json.type === 'init') {
                if (json.session) {
                    if (json.session.captchaRequired) {
                        this.handleCaptchaRequired();
                    }
                    if (json.session.currentNano !== undefined) {
                        this.balance = json.session.currentNano;
                        this.checkAutoWithdraw(this.balance);
                    }
                }
            } else if (json.type === 'captcha_required') {
                this.handleCaptchaRequired();
            } else if (json.currentNano !== undefined) {
                // Direct tap success
                console.log(`[SUCCESS] Tap accepted! Balance: ${json.currentNano}`);
                this.balance = json.currentNano;
                this.checkAutoWithdraw(this.balance);
            } else if (json.type === 'hourly_limit') {
                if (!this.limitReached) {
                    console.log(`[WARN] Hourly limit reached! Server responding with hourly_limit.`);
                    this.limitReached = true;
                    this.stop();
                }
            }
        } catch (e) { }
    }

    async tap() {
        if (this.halted || this.isPaused || this.captchaSolving || this.ws?.readyState !== 1) return;
        try {
            this.ws.send('c');

            this._tapCount = (this._tapCount || 0) + 1;
            if (this._tapCount % 50 === 0) {
                console.log(`[DEBUG] Dispatched 50 tap payload signals to Bridge...`);
            }
        } catch (e) {
            console.error(`[TAP ERR] Failed to send tap to bridge: ${e.message}`);
        }
    }

    stop() {
        if (this.tapInterval) clearInterval(this.tapInterval);
        this.tapInterval = null;
        if (this.ws) { this.ws.close(); this.ws = null; }
    }

    async bridgeFetch(url, method = 'GET', body = null, headers = {}) {
        if (!this.ws || this.ws.readyState !== 1) throw new Error("Bridge WebSocket not ready for HTTP forwarding");
        const reqId = `req_${Math.random().toString(36).substring(2, 11)}`;

        const wsMsg = {
            type: 'req_http',
            id: reqId,
            url: url,
            method: method,
            headers: Object.assign({}, headers, {
                'Content-Type': 'application/json'
            })
        };
        if (body) wsMsg.body = body;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.ws.off('message', onHandler);
                reject(new Error(`bridgeFetch timeout for ${url}`));
            }, 30000);

            const onHandler = (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'resp_http' && msg.id === reqId) {
                        clearTimeout(timeout);
                        this.ws.off('message', onHandler);
                        resolve(msg.result);
                    }
                } catch (e) { }
            };
            this.ws.on('message', onHandler);
            this.ws.send(JSON.stringify(wsMsg));
        });
    }

    async handleCaptchaRequired() {
        if (this.captchaSolving || this.isPaused) return;
        this.captchaSolving = true;
        console.log('[INFO] CAPTCHA / Altcha Required! Starting automated solving sequence...');

        try {
            // 1. Get Challenge from /api/c via bridge
            console.log('[INFO] Fetching PoW challenge from /api/c...');
            const challengeResponse = await this.bridgeFetch('https://api.thenanobutton.com/api/c');

            if (challengeResponse.error) throw new Error(`Bridge fetch failed: ${challengeResponse.error}`);

            let payloadBase64 = challengeResponse.data;
            if (typeof payloadBase64 === 'object' && payloadBase64.d) {
                payloadBase64 = payloadBase64.d;
            } else if (!payloadBase64) {
                throw new Error(`Empty Altcha payload from bridge. Status: ${challengeResponse.status}`);
            }

            const challengeData = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
            console.log(`[INFO] Received challenge: ${challengeData.c}`);

            // 2. Solve PoW
            const number = solveAltcha(challengeData.s, challengeData.c);
            if (number === null) {
                console.error('[ERROR] PoW solving failed - no solution found.');
                return;
            }

            // 3. Get Turnstile token (Solver is local HTTP, so direct axios is fine)
            console.log('[INFO] Requesting Turnstile token from local solver...');
            const turnstileResponse = await axios.post(TURNSTILE_SERVER, {
                mode: 'turnstile-max',
                url: 'https://thenanobutton.com/',
                siteKey: this.sitekey
            }, { timeout: 180000 });

            const turnstileToken = turnstileResponse.data.token;
            if (!turnstileToken) {
                console.error('[ERROR] Turnstile solver returned empty token.');
                return;
            }
            console.log('[INFO] Received Turnstile token.');

            // 4. Submit Verified Schema via bridge
            const pObj = {
                algorithm: challengeData.a,
                challenge: challengeData.c,
                number: number,
                salt: challengeData.s,
                signature: challengeData.g
            };

            const p = Buffer.from(JSON.stringify(pObj)).toString('base64');
            console.log('[INFO] Submitting solved CAPTCHA + Altcha payload...');

            const body = {
                token: this.sessionToken,
                turnstileToken: turnstileToken,
                p: p
            };

            const verifyResponse = await this.bridgeFetch('https://api.thenanobutton.com/api/captcha', 'POST', body);

            if (verifyResponse.error) throw new Error(`Verify failed: ${verifyResponse.error}`);

            if (verifyResponse.status === 200 || verifyResponse.status === 204) {
                console.log('[SUCCESS] CAPTCHA solved and verified! Resuming tapping...');
                this.stop();
                this.start(); // Reconnect bridge with fresh session state
            } else {
                console.error(`[ERROR] CAPTCHA verification returned status: ${verifyResponse.status} - ${JSON.stringify(verifyResponse.data)}`);
            }
        } catch (e) {
            console.error(`[ERROR] CAPTCHA sequence fail: ${e.message}`);
        } finally {
            this.captchaSolving = false;
        }
    }

    checkAutoWithdraw(balance) {
        if (this.withdrawAddress && balance >= this.withdrawThreshold && !this.withdrawing) {
            if (this._lastWithdrawalFailure && (Date.now() - this._lastWithdrawalFailure) < 300000) return;
            this.performWithdrawal();
        }
    }

    async performWithdrawal(isRetry = false) {
        if (this.withdrawing) return;
        this.withdrawing = true;

        const dest = this.proxyWallet ? this.proxyWallet.address : this.withdrawAddress;
        const proxySeed = this.proxyWallet ? this.proxyWallet.seed : '';
        const masterAddr = this.proxyWallet ? this.withdrawAddress : '';

        return new Promise((resolve) => {
            const { spawn } = require('child_process');
            const fakeIpArg = this.useFakeIp && this.fakeIp ? this.fakeIp : 'false';
            const args = ['withdraw_nano.js', this.sessionToken, dest, this.proxy || '', proxySeed, masterAddr, global.remoteSolverUrl || '', fakeIpArg];
            const withdrawProc = spawn('node', args);

            withdrawProc.on('close', async (code) => {
                if (code === 0) {
                    this.balance = 0;
                    this.withdrawing = false;
                    this._lastWithdrawalFailure = 0;
                    if (this.ws) this.ws.close();
                } else if (!isRetry) {
                    this.proxyWallet = await this.generateProxyWallet();
                    await this.performWithdrawal(true);
                } else {
                    this._lastWithdrawalFailure = Date.now();
                    this.withdrawing = false;
                }
                resolve();
            });
        });
    }

    displayStats(onlineUsers) {
        const earned = (this.balance / 10 ** 9).toFixed(9);
        console.log(`[STATS] Balance: Ӿ${earned} | Online: ${onlineUsers} | ID: ${this.bridgeSessionId}`);
    }
}

if (require.main === module) {
    const token = process.argv[2] || 'YOUR_SESSION_TOKEN_HERE';
    let proxy = process.argv[3] === 'null' ? null : (process.argv[3] || null);
    const address = process.argv[4] || null;
    const threshold = parseInt(process.argv[5]) || 0;
    const referralCode = process.argv[6] || '';
    const savedWalletSeed = process.argv[7] || '';
    const savedWalletAddr = process.argv[8] || '';
    const remoteSolverUrl = process.argv[9] || null;
    const useFakeIpFlag = true;

    if (useFakeIpFlag) proxy = null;
    if (remoteSolverUrl) {
        global.remoteSolverUrl = remoteSolverUrl;
        TURNSTILE_SERVER = remoteSolverUrl.replace(/\/+$/, '') + '/cf-clearance-scraper';
    }

    const tapper = new FastTapper(token, proxy, useFakeIpFlag);
    tapper.withdrawAddress = address;
    tapper.withdrawThreshold = threshold;
    tapper.start();

    process.on('message', (msg) => {
        if (msg.type === 'pause') tapper.isPaused = true;
        else if (msg.type === 'resume') {
            tapper.isPaused = false;
            if (!tapper.ws || tapper.ws.readyState !== 1) tapper.start();
        } else if (msg.type === 'stop_and_sweep') {
            tapper.halted = true;
            tapper.stop();
            if (tapper.withdrawAddress) tapper.performWithdrawal().then(() => process.exit(0));
            else process.exit(0);
        } else if (msg.type === 'withdraw') {
            tapper.checkAutoWithdraw(tapper.balance + 1000);
        } else if (msg.type === 'rotate-proxy') {
            tapper.rotateProxy();
            if (tapper.ws) tapper.ws.close();
        }
    });
}

module.exports = { FastTapper };

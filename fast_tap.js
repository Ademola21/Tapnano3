const nano = require('nanocurrency');
const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

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

const WS_URL = 'wss://api.thenanobutton.com/ws';

class FastTapper {
    constructor(sessionToken, proxy = null, referralCode = '', solverUrl = 'http://127.0.0.1:3000') {
        this.sessionToken = sessionToken;
        this.proxy = proxy;
        this.referralCode = referralCode;
        this.solverUrl = solverUrl.replace(/\/+$/, '');
        if (!this.solverUrl.includes('/cf-clearance-scraper')) {
            this.solverUrl += '/cf-clearance-scraper';
        }
        this.ws = null;
        this.tapInterval = null;
        this.balance = 0;
        this.sitekey = '0x4AAAAAACZpJ7kmZ3RsO1rU';
        this.limitReached = false;
        this.captchaSolving = false;
        this.proxyWallet = null;
        this.halted = false;
        this.starting = false;
        this.isPaused = false;
        this._lastWithdrawalFailure = 0;
        this.name = 'Worker'; // Will be set by multi-worker
    }

    log(msg, level = 'INFO') {
        const fullMsg = `[${this.name}] [${level}] ${msg}`;
        if (!process.send) {
            console.log(fullMsg);
        } else {
            // Only send critical logs to master to avoid saturation
            if (level === 'ERROR' || level === 'FATAL' || level === 'SUCCESS' || level === 'ALERT') {
                process.send({ type: 'log', name: this.name, msg: fullMsg });
            }
        }
    }

    sendStatus(statusUpdate = {}) {
        if (process.send) {
            process.send({
                type: 'status-update',
                name: this.name,
                balance: this.balance,
                status: this.status,
                ...statusUpdate
            });
        }
    }

    async generateProxyWallet() {
        const seed = await nano.generateSeed();
        const privateKey = nano.deriveSecretKey(seed, 0);
        const publicKey = nano.derivePublicKey(privateKey);
        const address = nano.deriveAddress(publicKey).replace('xrb_', 'nano_');
        return { seed, address };
    }

    // Rotate BrightData session ID to get a new IP
    rotateProxy() {
        if (!this.proxy) return;
        const oldProxy = this.proxy;
        // Replace the session ID in the proxy URL to get a new IP
        // Format: brd-customer-xxx-session-rand_XXXXXXXX
        const newSessionId = crypto.randomBytes(4).toString('hex');
        this.proxy = this.proxy.replace(
            /(-session-[^:@]+)/i,
            `-session-rand_${newSessionId}`
        );
        // If no session was in the proxy string, append one to the username
        if (this.proxy === oldProxy && this.proxy.includes('brd-customer')) {
            this.proxy = this.proxy.replace(
                /(brd-customer-[^:]+)/,
                `$1-session-rand_${newSessionId}`
            );
        }
        console.log(`[PROXY] Rotated session ID to: rand_${newSessionId}`);
    }

    // Verify current proxy IP using a public IP check service
    async verifyNewIP() {
        if (!this.proxy) return null;
        try {
            const reqOpts = {
                timeout: 15000,
                httpsAgent: new HttpsProxyAgent(this.proxy)
            };
            // Use httpbin which works with BrightData (not Google-blocked)
            const res = await axios.get('https://lumtest.com/myip.json', reqOpts);
            const ip = res.data?.ip || res.data;
            console.log(`[PROXY] Verified new IP: ${ip}`);
            return ip;
        } catch (e) {
            // Fallback to another service
            try {
                const reqOpts2 = {
                    timeout: 15000,
                    httpsAgent: new HttpsProxyAgent(this.proxy)
                };
                const res2 = await axios.get('https://api.ipify.org?format=json', reqOpts2);
                const ip = res2.data?.ip;
                console.log(`[PROXY] Verified new IP (fallback): ${ip}`);
                return ip;
            } catch (e2) {
                console.warn(`[PROXY] Could not verify IP: ${e2.message}`);
                return null;
            }
        }
    }

    async start() {
        if (this.starting) return;
        this.starting = true;

        if (this.proxy) {
            const p = new URL(this.proxy);
            this.log(`Initial Proxy: ${p.protocol}//****:****@${p.host}`);
        }

        if (!this.sessionToken || this.sessionToken === 'AUTO') {
            this.log('Needs session token. Fetching new auto-session token...');
            let fetched = false;
            for (let attempt = 1; attempt <= 3 && !fetched; attempt++) {
                try {
                    const reqOpts = {
                        timeout: 20000,
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://thenanobutton.com/',
                            'Origin': 'https://thenanobutton.com'
                        }
                    };
                    if (this.proxy) {
                        reqOpts.httpsAgent = new HttpsProxyAgent(this.proxy);
                    }

                    const sessionUrl = this.referralCode
                        ? `https://api.thenanobutton.com/api/session?ref=${encodeURIComponent(this.referralCode)}`
                        : 'https://api.thenanobutton.com/api/session';
                    if (this.referralCode) this.log(`Using referral code: ${this.referralCode}`);
                    this.log(`Attempting session fetch (Attempt ${attempt}/3)...`);
                    let data;
                    try {
                        const res = await axios.get(sessionUrl, reqOpts);
                        data = res.data;
                    } catch (axiosErr) {
                        const status = axiosErr.response ? axiosErr.response.status : 'NETWORK_ERROR';
                        this.log(`Direct API fetch failed [Status: ${status}]. Trying Solver Fallback...`, 'WARN');

                        // FALLBACK: Use Turnstile Solver to get the session token via real browser
                        this.log('Trying Solver Fallback (Direct VM data)...');
                        let solverRes = await axios.post(this.solverUrl, {
                            url: 'https://api.thenanobutton.com/api/session',
                            mode: 'source'
                        }, { timeout: 60000 }).catch(e => null);

                        if (!solverRes || !solverRes.data || !solverRes.data.source || !solverRes.data.source.includes('token')) {
                            this.log('Solver direct fetch failed or returned no token. Retrying Solver with PROXY...', 'WARN');
                            solverRes = await axios.post(this.solverUrl, {
                                url: 'https://api.thenanobutton.com/api/session',
                                mode: 'source',
                                proxy: this.proxy ? { server: this.proxy } : undefined
                            }, { timeout: 60000 }).catch(e => {
                                this.log(`Solver Fallback (with Proxy) failed: ${e.message}`, 'ERROR');
                                return null;
                            });
                        }

                        if (solverRes && solverRes.data && solverRes.data.source) {
                            try {
                                // The source mode returns the HTML content. If it's a JSON API, it's often wrapped in <body> or raw.
                                const html = solverRes.data.source;
                                const startIdx = html.indexOf('{');
                                const endIdx = html.lastIndexOf('}');
                                if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                                    const jsonStr = html.substring(startIdx, endIdx + 1);
                                    data = JSON.parse(jsonStr);
                                    if (data.token) {
                                        this.log(`Session token extracted via Solver Fallback.`, 'SUCCESS');
                                    }
                                } else {
                                    const snippet = html.replace(/[\n\r]/g, ' ').substring(0, 200);
                                    this.log(`Could not find token JSON block in solver output. Content: ${snippet}...`, 'ERROR');
                                }
                            } catch (parseErr) {
                                this.log(`Failed to parse solver output: ${parseErr.message}`, 'ERROR');
                            }
                        }
                    }

                    if (data && data.token) {
                        this.sessionToken = data.token;
                        this.log(`Auto-session created: ${this.sessionToken.slice(0, 16)}...`);
                        fetched = true;
                    } else {
                        this.log(`Session fetch failed completely (Direct + Fallback).`, 'ERROR');
                        if (attempt < 3) {
                            this.log('Retrying in 5 seconds...');
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }
                } catch (e) {
                    this.log(`Token fetch process failed: ${e.message}`, 'ERROR');
                    if (attempt < 3) {
                        const jitter = Math.floor(Math.random() * 5000) + 5000;
                        this.log(`Retrying in ${jitter / 1000} seconds...`);
                        await new Promise(r => setTimeout(r, jitter));
                    }
                }
            }
            if (!fetched) {
                this.log('Could not fetch session token after 3 attempts. Standing by...', 'FATAL');
                this.status = 'error';
                this.sendStatus();
                return;
            }
        }

        // Initialize Proxy Wallet if we have a destination
        if (this.withdrawAddress && !this.proxyWallet) {
            // Check if a saved wallet was passed via CLI
            if (savedWalletSeed && savedWalletAddr) {
                this.proxyWallet = { seed: savedWalletSeed, address: savedWalletAddr };
                this.log(`Restored saved Proxy Wallet: ${this.proxyWallet.address}`);
            } else {
                this.proxyWallet = await this.generateProxyWallet();
                this.log(`Proxy Wallet generated for session: ${this.proxyWallet.address}`);
            }
        }

        // Report session info to server for persistence
        try {
            process.send({
                type: 'session-info',
                sessionToken: this.sessionToken,
                proxyWalletSeed: this.proxyWallet?.seed || '',
                proxyWalletAddress: this.proxyWallet?.address || ''
            });
        } catch (e) { /* not running under IPC */ }

        this.starting = false;
        const urlWithToken = `${WS_URL}?token=${this.sessionToken}`;
        this.log(`Connecting to ${urlWithToken}...`);

        const wsOptions = {
            headers: {
                'Origin': 'https://thenanobutton.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        };

        if (this.proxy) {
            this.log(`Using proxy: ${this.proxy}`);
            wsOptions.agent = new HttpsProxyAgent(this.proxy);
        }

        this.ws = new WebSocket(urlWithToken, wsOptions);

        this.ws.on('open', () => {
            this.log('Connected!', 'SUCCESS');
            this.status = 'running';
            this.sendStatus();
            // Send initial registration if needed
            this.ws.send(JSON.stringify({ type: 'session', token: this.sessionToken }));
        });

        this.ws.on('message', async (data) => {
            const message = data.toString();
            // this.log(`[WS RECV RAW] ${message}`, 'DEBUG');

            try {
                const json = JSON.parse(message);
                if (json.type === 'captcha_required' || (json.session && json.session.captchaRequired)) {
                    if (!this.captchaSolving) {
                        this.captchaSolving = true;
                        try {
                            await this.handleCaptchaRequired();
                        } finally {
                            this.captchaSolving = false;
                        }
                    }
                } else if (json.type === 'update' && json.balance !== undefined) {
                    this.balance = json.balance;
                    this.log(`Current Balance: ${this.balance} Nano-units`);
                    this.sendStatus();
                } else if (json.type === 'limit' || json.type === 'hourly_limit') {
                    const msg = json.message || 'Limit reached';
                    this.log(`Rate limit reached: ${msg}`, 'ALERT');
                    this._rateLimited = true; // Flag for the close handler
                    this.ws.close();
                }
                else if (json.type === 'click') {
                    this.log(`Tap Success! Balance: ${json.currentNano} | Total Earned: ${json.totalEarned}`, 'SUCCESS');
                    this.balance = json.currentNano;
                    this.sendStatus();
                    this.checkAutoWithdraw(json.currentNano);
                }
            } catch (e) {
                // Not JSON or unknown format
                if (message === 'ping') {
                    this.ws.send('pong');
                } else if (message.includes('captcha_required')) {
                    if (!this.captchaSolving) {
                        this.captchaSolving = true;
                        try {
                            await this.handleCaptchaRequired();
                        } finally {
                            this.captchaSolving = false;
                        }
                    }
                }
            }
        });

        this.ws.on('error', (err) => {
            this.log(`WS ERROR: ${err.message}`, 'ERROR');
        });

        this.ws.on('close', async () => {
            this.log('Disconnected.');
            this.status = 'disconnected';
            this.sendStatus();
            clearInterval(this.tapInterval);
            if (!this.halted) {
                if (this._rateLimited) {
                    this._rateLimited = false;
                    this.log('Rate limited — signaling server to rotate ALL workers...', 'ALERT');
                    // Signal the server to rotate all workers to a new shared IP
                    try { process.send({ type: 'rate-limited' }); } catch (e) { }
                    // Don't reconnect here — wait for the server to send 'rotate-proxy' IPC
                    // which will trigger reconnection with the new shared IP
                    this._waitingForRotation = true;
                    // Safety timeout: if server doesn't respond in 15s, self-rotate
                    this._rotationTimeout = setTimeout(() => {
                        if (this._waitingForRotation) {
                            this.log('No rotation signal from server, self-rotating...', 'WARN');
                            this._waitingForRotation = false;
                            this.rotateProxy();
                            this.start();
                        }
                    }, 15000);
                } else {
                    if (this.isPaused) {
                        this.log('Paused — Reconnection loop suspended until Resume.');
                        return;
                    }
                    this.log('Reconnecting in 5s...');
                    setTimeout(() => this.start(), 5000);
                }
            }
        });

        // Start tapping loop
        this.tapInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.captchaSolving && !this.limitReached && !this.withdrawing && !this.isPaused) {
                this.ws.send('c');
            }
        }, 150);
    }

    async handleCaptchaRequired() {
        if (this.isPaused) {
            this.log('CAPTCHA required but fleet is paused. Skipping solve sequence.');
            return;
        }
        // Cooldown: don't re-attempt CAPTCHA within 30 seconds of last attempt
        const now = Date.now();
        if (this._lastCaptchaAttempt && (now - this._lastCaptchaAttempt) < 30000) {
            return;
        }
        this._lastCaptchaAttempt = now;

        this.log('CAPTCHA Required! Starting automated solving sequence...', 'ALERT');

        try {
            // 1. Get Challenge from /api/c
            this.log('Fetching PoW challenge from /api/c...');
            const challengeResponse = await axios.get('https://api.thenanobutton.com/api/c', {
                timeout: 15000,
                proxy: false,
                httpsAgent: this.proxy ? new HttpsProxyAgent(this.proxy) : undefined
            });

            let payloadBase64 = challengeResponse.data;
            if (typeof payloadBase64 === 'object' && payloadBase64.d) {
                payloadBase64 = payloadBase64.d;
            }

            const challengeData = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
            this.log(`Received challenge: ${challengeData.c}`);

            // 2. Solve PoW
            const number = solveAltcha(challengeData.s, challengeData.c);
            if (number === null) {
                this.log('PoW solving failed - no solution found.', 'ERROR');
                return;
            }

            // 3. Get Turnstile token from local solver (with 60s timeout)
            if (this.isPaused) {
                this.log('Paused — Aborting CAPTCHA solve before Turnstile call.');
                return;
            }
            this.log('Requesting Turnstile token from local server (direct, no proxy)...');

            const turnstileResponse = await axios.post(this.solverUrl, {
                mode: 'turnstile-max',
                url: 'https://thenanobutton.com/',
                siteKey: this.sitekey
            }, { timeout: 180000 }); // 3 min timeout
            const turnstileToken = turnstileResponse.data.token;

            if (!turnstileToken) {
                this.log('Turnstile solver returned empty token. Is cf-clearance-scraper running on port 3000?', 'ERROR');
                return;
            }
            this.log('Received Turnstile token.');

            // 4. Submit Verified Schema
            const pObj = {
                algorithm: challengeData.a,
                challenge: challengeData.c,
                number: number,
                salt: challengeData.s,
                signature: challengeData.g
            };

            const p = Buffer.from(JSON.stringify(pObj)).toString('base64');
            this.log(`Submitting solved CAPTCHA payload...`);

            const verifyResponse = await axios.post('https://api.thenanobutton.com/api/captcha', {
                token: this.sessionToken,
                turnstileToken: turnstileToken,
                p: p
            }, {
                timeout: 15000,
                headers: {
                    'Origin': 'https://thenanobutton.com',
                    'Referer': 'https://thenanobutton.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Content-Type': 'application/json'
                },
                proxy: false,
                httpsAgent: this.proxy ? new HttpsProxyAgent(this.proxy) : undefined
            });

            if (verifyResponse.status === 200 || verifyResponse.status === 204) {
                this.log('CAPTCHA solved and verified! Resuming tapping...', 'SUCCESS');
            } else {
                this.log(`CAPTCHA verification returned unexpected status: ${verifyResponse.status}`, 'ERROR');
            }
        } catch (e) {
            if (e.code === 'ECONNREFUSED') {
                this.log('Turnstile solver is NOT running! Start cf-clearance-scraper on port 3000 first.', 'ERROR');
            } else {
                this.log(`CAPTCHA solving sequence failed: ${e.message}`, 'ERROR');
            }
        }
    }

    async checkAutoWithdraw(balance) {
        if (this.isPaused) return;
        if (!this.withdrawAddress || !this.withdrawThreshold) return;
        if (this.withdrawing) return;

        // 5-minute cooldown after a hard failure
        const now = Date.now();
        if (this._lastWithdrawalFailure && (now - this._lastCaptchaAttempt) < 300000) {
            return;
        }

        if (balance >= this.withdrawThreshold) {
            this.log(`Threshold ${this.withdrawThreshold} reached. Pausing tapping for withdrawal...`);
            this.withdrawing = true; // Set early to stop tapping interval immediately
            await this.performWithdrawal();
        }
    }

    async performWithdrawal(isRetry = false) {
        const dest = this.proxyWallet ? this.proxyWallet.address : this.withdrawAddress;
        const proxySeed = this.proxyWallet ? this.proxyWallet.seed : '';
        const masterAddr = this.proxyWallet ? this.withdrawAddress : '';

        this.log(`${isRetry ? 'Retrying' : 'Triggering'} withdrawal to ${isRetry ? '(NEW) ' : ''}${dest}...`);
        this.withdrawing = true;
        this.status = 'withdrawing';
        this.sendStatus();

        return new Promise((resolve) => {
            const { spawn } = require('child_process');
            const args = ['withdraw_nano.js', this.sessionToken, dest, this.proxy || '', proxySeed, masterAddr, global.remoteSolverUrl || ''];
            const withdrawProc = spawn('node', args);

            withdrawProc.stdout.on('data', (d) => this.log(d.toString().trim(), 'DEBUG'));
            withdrawProc.stderr.on('data', (d) => this.log(d.toString().trim(), 'ERROR'));

            withdrawProc.on('close', async (code) => {
                this.log(`Withdrawal process finished with code ${code}`);

                if (code === 0) {
                    this.log(`Withdrawal/Consolidation complete. Refreshing session...`, 'SUCCESS');
                    this.balance = 0;
                    this.withdrawing = false;
                    this.status = 'running';
                    this.sendStatus();
                    this._lastWithdrawalFailure = 0; // Clear cooldown on success

                    // Force a full WebSocket refresh to reset server-side session state
                    if (this.ws) {
                        this.log(`Forcing WebSocket refresh to sync post-withdrawal state.`);
                        this.ws.close();
                    }
                } else if (!isRetry) {
                    this.log(`Withdrawal failed. Generating a FRESH proxy wallet and retrying...`, 'WARN');
                    this.proxyWallet = await this.generateProxyWallet();
                    await this.performWithdrawal(true);
                } else {
                    this.log(`Withdrawal failed after retry. Entering 5-minute cooldown to prevent spam.`, 'ERROR');
                    this._lastWithdrawalFailure = Date.now();
                    this.withdrawing = false;
                    this.status = 'running';
                    this.sendStatus();
                }

                resolve();
            });
        });
    }
}

// Export the class for multi-worker support
module.exports = { FastTapper, solveAltcha };

if (require.main === module) {
    const token = process.argv[2] || 'YOUR_SESSION_TOKEN_HERE';
    const proxy = process.argv[3] || null;
    const address = process.argv[4] || null;
    const threshold = parseInt(process.argv[5]) || 0;
    const referralCodeExtra = process.argv[6] || '';
    const savedWalletSeedExtra = process.argv[7] || '';
    const savedWalletAddrExtra = process.argv[8] || '';
    const remoteSolverUrlExtra = process.argv[9] || null;

    const tapper = new FastTapper(
        token,
        proxy,
        referralCodeExtra,
        remoteSolverUrlExtra || 'http://127.0.0.1:3000'
    );
    tapper.withdrawAddress = address;
    tapper.withdrawThreshold = threshold;
    tapper.start();

    // IPC Handlers omitted for brevity in module mode, but preserved for standalone
    process.on('message', (msg) => {
        // ... same logic as before ...
        if (msg.type === 'pause') tapper.isPaused = true;
        else if (msg.type === 'resume') { tapper.isPaused = false; if (!tapper.ws || tapper.ws.readyState !== WebSocket.OPEN) tapper.start(); }
        else if (msg.type === 'stop_and_sweep') { tapper.halted = true; tapper.performWithdrawal().then(() => process.exit(0)); }
    });
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { createWallet, ensureWallets, fillFleet } = require('./wallet_mgr');

const isSolverOnly = process.argv.includes('--solver-only');
const isWorkerOnly = process.argv.includes('--worker-only');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const RESCUED_FILE = path.join(__dirname, 'rescued_wallets.json');
const SESSIONS_FILE = path.join(__dirname, 'active_sessions.json');

const isFresh = process.argv.includes('--fresh');
if (isFresh) {
    console.log("[INIT] 🧹 --- FRESH START TRIGGERED --- 🧹");
    const filesToWipe = [ACCOUNTS_FILE, SETTINGS_FILE, RESCUED_FILE, SESSIONS_FILE];
    filesToWipe.forEach(f => {
        if (fs.existsSync(f)) {
            try {
                fs.unlinkSync(f);
                console.log(`[INIT] Deleted: ${path.basename(f)}`);
            } catch (e) { console.error(`[ERR] Failed to delete ${f}:`, e.message); }
        }
    });
}

// Global Safety Shields
process.on('uncaughtException', (err) => {
    console.error(`[CRITICAL] Uncaught Exception on Master: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[CRITICAL] Unhandled Rejection on Master:`, reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = 4000;
const NODES = [
    'https://rainstorm.city/api',
    'https://node.somenano.com/proxy',
    'https://nanoslo.0x.no/proxy',
    'https://uk1.public.xnopay.com/proxy'
];

app.use(cors());
app.use(express.json());

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'dashboard/dist')));

// Fallback for SPA routing
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard/dist/index.html'));
});

// State Management
let runners = {}; // { accountName: { process, status, logs[] } }
let nodeHealth = {};
let allAccounts = []; // Cache for accounts.json
let pendingLogs = []; // Global log buffer for dashboard
let activeSessions = {}; // Storage for account session tokens and proxy wallets
let rescuedWallets = []; // Wallets that received funds but failed to consolidate
let solverProcess = null;
let settings = {
    mainWalletAddress: "",
    proxyMode: "manual",
    proxyHost: "",
    proxyPort: "",
    proxyUser: "",
    proxyPass: "",
    referralCode: "",
    referralEnabled: false,
    fleetPaused: false,
    activeFleet: {
        targetSize: 0,
        autoWithdraw: false,
        withdrawLimit: 0
    },
    turnstileSolverUrl: "http://localhost:3000"
};

function flushSessions() {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(activeSessions, null, 2));
    } catch (e) { console.error('[SERVER] Error saving sessions:', e.message); }
}

async function checkNodes() {
    for (let url of NODES) {
        try {
            const start = Date.now();
            await axios.post(url, { action: 'block_count' }, { timeout: 5000 });
            nodeHealth[url] = { status: 'healthy', latency: Date.now() - start };
        } catch (e) {
            nodeHealth[url] = { status: 'down', error: e.message };
        }
    }
    if (!isSolverOnly) io.emit('node-health', nodeHealth);
}

async function autoRecoverFleet() {
    if (settings.activeFleet && settings.activeFleet.targetSize > 0) {
        const { targetSize, autoWithdraw, withdrawLimit } = settings.activeFleet;
        console.log(`[RECOVERY] Found active fleet invitation in settings (size: ${targetSize}). Recovering bots...`);

        const accounts = await fillFleet(targetSize);
        const sliced = accounts.slice(0, targetSize);

        // Staggered launch to avoid resource spike
        for (let i = 0; i < sliced.length; i++) {
            const acc = sliced[i];
            const baseProxy = acc.proxy || '';
            const rotatedProxy = getRotatedProxy(baseProxy);
            startRunner({ ...acc, proxy: rotatedProxy }, autoWithdraw, withdrawLimit, settings.mainWalletAddress);
            await new Promise(r => setTimeout(r, 2000));
        }
        console.log(`[RECOVERY] Fleet recovery complete. Current status: ${settings.fleetPaused ? 'PAUSED' : 'RUNNING'}`);
    }
}

// Initial node check and fleet recovery
async function initServer() {
    await checkNodes();
    // Delay recovery slightly to ensure solver and other components are ready
    setTimeout(autoRecoverFleet, 5000);
}

if (!isSolverOnly) {
    // Load dashboard data only if NOT in solver-only mode
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try {
            allAccounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        } catch (e) { console.error("Error loading accounts:", e); }
    }

    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
        } catch (e) { console.error("Error loading settings:", e); }
    }

    if (fs.existsSync(RESCUED_FILE)) {
        try {
            rescuedWallets = JSON.parse(fs.readFileSync(RESCUED_FILE, 'utf8'));
            console.log(`[SERVER] Loaded ${rescuedWallets.length} rescued wallets from disk.`);
        } catch (e) { console.error("Error loading rescued wallets:", e); }
    }

    if (fs.existsSync(SESSIONS_FILE)) {
        try {
            activeSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            console.log(`[SERVER] Loaded ${Object.keys(activeSessions).length} saved sessions from disk.`);
        } catch (e) { console.error("Error loading sessions:", e); }
    }

    // Initial node check and fleet recovery
    initServer();
    setInterval(checkNodes, 30000);
}

function getAccounts() {
    return allAccounts;
}

function flushAccountsToDisk() {
    try {
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(allAccounts, null, 4));
        console.log(`[SERVER] Flushed ${allAccounts.length} accounts to disk.`);
    } catch (e) {
        console.error(`[SERVER] Critical error flushing accounts: ${e.message}`);
    }
}

function flushRescuedWallets() {
    try {
        fs.writeFileSync(RESCUED_FILE, JSON.stringify(rescuedWallets, null, 4));
        console.log(`[SERVER] Saved ${rescuedWallets.length} rescued wallets to disk.`);
    } catch (e) {
        console.error(`[SERVER] Error saving rescued wallets: ${e.message}`);
    }
}

function rescueWallet(workerName, optionalToken = null, optionalProxy = null) {
    const acc = allAccounts.find(a => a.name === workerName);
    const sess = activeSessions[workerName] || {};

    const seed = sess.proxyWalletSeed || (acc ? acc.wallet_seed : null);
    const address = sess.proxyWalletAddress || (acc ? acc.wallet_address : null);

    if (!seed) return;

    // Update existing entry if found, otherwise create new
    let entry = rescuedWallets.find(w => w.seed === seed);
    const earnings = runners[workerName]?.earnings || (acc ? acc.earnings : 0) || (sess.earnings) || 0;
    if (earnings <= 0 && !entry) return; // No point rescuing zero-balance wallets if not already known

    // Pull session token and proxy from active sessions if not provided
    const token = optionalToken || sess.sessionToken || '';
    const proxy = optionalProxy || sess.proxy || (acc ? acc.proxy : '') || '';

    if (entry) {
        entry.balance = Math.max(entry.balance, earnings);
        entry.token = token || entry.token;
        entry.proxy = proxy || entry.proxy;
        entry.lastUpdate = new Date().toISOString();
    } else {
        entry = {
            name: workerName,
            address: address,
            seed: seed,
            balance: earnings,
            token: token,
            proxy: proxy,
            rescuedAt: new Date().toISOString()
        };
        rescuedWallets.push(entry);
    }

    flushRescuedWallets();
    console.log(`[RESCUE] Secured ${workerName} (${earnings} NANO) to vault. Session: ${token ? 'AVAILABLE' : 'MISSING'}`);
    const totalBalance = rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0);
    io.emit('rescue-updated', { count: rescuedWallets.length, totalBalance, wallets: rescuedWallets });
}

// Periodic flush every 60 seconds
setInterval(flushAccountsToDisk, 60000);

// Flush on exit
process.on('SIGINT', () => {
    console.log('[SERVER] Shutting down, flushing state...');
    flushAccountsToDisk();
    if (solverProcess) {
        console.log('[SERVER] Terminating integrated solver...');
        solverProcess.kill();
    }
    process.exit(0);
});

function startSolver() {
    console.log('[SERVER] Starting integrated CAPTCHA solver on port 3000...');
    const solverPath = path.join(__dirname, 'src/index.js');

    solverProcess = spawn('node', [solverPath], {
        cwd: __dirname,
        env: { ...process.env, PORT: '3000', SKIP_LAUNCH: 'false' }
    });

    solverProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        console.log(`[SOLVER] ${msg}`);
        io.emit('runner-log', { name: 'SYSTEM', msg: `[SOLVER] ${msg}` });
    });

    solverProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        console.error(`[SOLVER ERR] ${msg}`);
        io.emit('runner-log', { name: 'SYSTEM', msg: `[SOLVER ERROR] ${msg}` });
    });

    solverProcess.on('close', (code) => {
        console.log(`[SERVER] Solver process exited with code ${code}`);
        if (code !== 0 && !process.exitCode) {
            console.log('[SERVER] Solver crashed? Restarting in 5s...');
            setTimeout(startSolver, 5000);
        }
    });
}

// Helper to inject unique session IDs into BrightData proxies
// Each worker gets a random session ID to guarantee a unique exit IP
// Shared proxy session ID — all workers use the same IP
let sharedProxySessionId = require('crypto').randomBytes(4).toString('hex');

function getRotatedProxy(baseProxy) {
    let proxy = baseProxy;
    if (!proxy) {
        // Fallback to global settings if no account-specific proxy is provided
        proxy = `http://${settings.proxyUser}:${settings.proxyPass}@${settings.proxyHost}:${settings.proxyPort}`;
    }

    try {
        const url = new URL(proxy);
        if (url.hostname.includes('superproxy') || url.username.includes('brd-customer')) {
            // Strip any existing session ID and use the shared one
            url.username = url.username.replace(/-session-[^:@]*/i, '');
            url.username = `${url.username}-session-rand_${sharedProxySessionId}`;
            return url.toString();
        }
    } catch (e) { }
    return proxy;
}

function rotateSharedProxy() {
    const oldId = sharedProxySessionId;
    sharedProxySessionId = require('crypto').randomBytes(4).toString('hex');
    console.log(`[FLEET] 🔄 Rotating ALL workers to new shared IP: rand_${sharedProxySessionId} (was rand_${oldId})`);
    // Broadcast new session ID to ALL running workers via IPC
    Object.keys(runners).forEach(name => {
        const r = runners[name];
        if (r && r.process && r.status === 'running') {
            try {
                r.process.send({ type: 'rotate-proxy', newSessionId: sharedProxySessionId });
            } catch (e) { /* worker may have exited */ }
        }
    });
}

io.on('connection', (socket) => {
    console.log('[WS] Dashboard connected');

    // Only send back accounts that are actually part of the active fleet
    const activeNames = Object.keys(runners);
    const allAccounts = getAccounts();
    const activeAccounts = activeNames.length > 0
        ? allAccounts.filter(a => activeNames.includes(a.name)).map(a => {
            a.earnings = runners[a.name].earnings || 0;
            return a;
        })
        : [];

    socket.emit('init', {
        accounts: activeAccounts,
        runners: activeNames.map(k => ({ name: k, status: runners[k].status })),
        nodeHealth,
        settings,
        rescued: { count: rescuedWallets.length, totalBalance: rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0), wallets: rescuedWallets }
    });

    socket.on('save-settings', (newSettings) => {
        const refEnabledChanged = newSettings.referralEnabled !== undefined && newSettings.referralEnabled !== settings.referralEnabled;
        const refCodeChanged = newSettings.referralCode !== undefined && newSettings.referralCode !== settings.referralCode;

        settings = { ...settings, ...newSettings };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        console.log("[SERVER] Settings updated and saved.");

        // If referral code or enabled status changed, invalidate all cached session tokens
        // This forces runners to fetch fresh sessions with the correct code on next start
        if (refEnabledChanged || refCodeChanged) {
            console.log("[SERVER] Referral settings changed! Invalidating all active session tokens to force rotation.");
            Object.keys(activeSessions).forEach(name => {
                if (activeSessions[name]) {
                    delete activeSessions[name].sessionToken;
                }
            });
            flushSessions();
        }

        io.emit('settings-updated', settings);
    });

    socket.on('start-runner', (accountName) => {
        const acc = getAccounts().find(a => a.name === accountName);
        if (acc) startRunner(acc);
    });

    socket.on('stop-runner', (accountName) => {
        stopRunner(accountName, true);
    });

    socket.on('start-fleet', async ({ targetSize, autoWithdrawEnabled, withdrawLimit, mainWalletAddress: payloadWallet, defaultProxy }) => {
        console.log(`[MASTER] Starting fleet with size: ${targetSize}`);

        const mainWalletAddress = payloadWallet || settings.mainWalletAddress;

        // Persist fleet config for recovery
        settings.activeFleet = {
            targetSize,
            autoWithdraw: autoWithdrawEnabled,
            withdrawLimit
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));

        // Ensure accounts exist (this also assigns proxies if available)
        const newAccounts = await fillFleet(targetSize);
        const slicedAccounts = newAccounts.slice(0, targetSize);

        // Stop all existing runners gracefully
        const existingNames = Object.keys(runners);
        for (const name of existingNames) {
            stopRunner(name, true);
        }
        // Do NOT wipe runners map here, let 'close' handlers clean up naturally or just overwrite

        // Immediately notify UI of the pending 100 accounts (they will show up as idle/deploying)
        io.emit('init', {
            accounts: slicedAccounts,
            runners: slicedAccounts.map(a => ({ name: a.name, status: 'deploying...' })),
            nodeHealth
        });

        // Launch all workers simultaneously — they all share the same IP
        console.log(`[FLEET] All workers sharing IP session: rand_${sharedProxySessionId}`);
        for (let i = 0; i < targetSize; i++) {
            const acc = slicedAccounts[i];
            const baseProxy = (defaultProxy && defaultProxy.trim()) ? defaultProxy : (acc.proxy || '');
            const rotatedProxy = getRotatedProxy(baseProxy);

            startRunner({ ...acc, proxy: rotatedProxy }, autoWithdrawEnabled, withdrawLimit, mainWalletAddress);
        }
    });

    socket.on('pause-fleet', () => {
        console.log(`[MASTER] Pausing all active workers...`);
        settings.fleetPaused = true;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        io.emit('settings-updated', settings);

        Object.keys(runners).forEach(name => {
            if (runners[name] && runners[name].process && runners[name].process.connected) {
                runners[name].process.send({ type: 'pause' });
                runners[name].status = 'paused';
                io.emit('runner-status', { name, status: 'paused' });
            }
        });
    });

    socket.on('resume-fleet', () => {
        console.log(`[MASTER] Resuming all active workers...`);
        settings.fleetPaused = false;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        io.emit('settings-updated', settings);

        Object.keys(runners).forEach(name => {
            if (runners[name] && runners[name].process && runners[name].process.connected) {
                runners[name].process.send({ type: 'resume' });
                runners[name].status = 'running';
                io.emit('runner-status', { name, status: 'running' });
            }
        });
    });

    socket.on('stop-fleet', async () => {
        console.log(`[MASTER] Staggered halt sequence initiated... securely dumping worker balances...`);
        const names = Object.keys(runners);
        for (const name of names) {
            io.emit('runner-log', { name, msg: 'Halt Fleet signal received. Initiating final sweep...' });
            stopRunner(name, true);
            await new Promise(r => setTimeout(r, 4000)); // Stagger sweep out to prevent ratelimits
        }

        // Clear active fleet config
        if (settings.activeFleet) {
            settings.activeFleet.targetSize = 0;
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        }
        // When stopping fleet, keep the accounts visible but mark as stopped
        const stoppedAccounts = getAccounts().filter(a => names.includes(a.name));
        io.emit('init', {
            accounts: stoppedAccounts,
            runners: names.map(k => ({ name: k, status: runners[k]?.status || 'stopped' })),
            nodeHealth
        });
    });

    socket.on('sweep-active', async () => {
        console.log(`[MASTER] Initiating staggered emergency sweep across all active workers...`);
        const names = Object.keys(runners);
        for (const name of names) {
            if (runners[name] && runners[name].process) {
                runners[name].process.send({ type: 'withdraw' });
                io.emit('runner-log', { name, msg: 'Emergency sweep IPC signal dispatched.' });
                await new Promise(r => setTimeout(r, 4000)); // Stagger sequential withdrawal 4s
            }
        }
    });

    socket.on('sweep-all', (mainAddress) => {
        const sweepAddr = mainAddress.replace('xrb_', 'nano_');
        console.log(`[MASTER] Initiating sweep to ${sweepAddr}`);
        const sweeper = spawn('node', ['sweeper.js', sweepAddr]);
        sweeper.stdout.on('data', (d) => io.emit('runner-log', { name: 'SYSTEM', msg: d.toString() }));
        sweeper.on('close', () => io.emit('runner-log', { name: 'SYSTEM', msg: 'Global Sweep complete.' }));
    });

    socket.on('sweep-worker', ({ accountName, mainAddress }) => {
        const acc = getAccounts().find(a => a.name === accountName);
        if (!acc) return;
        const sweepAddr = mainAddress.replace('xrb_', 'nano_');
        console.log(`[MASTER] Initiating individual sweep for ${accountName} to ${sweepAddr}`);
        io.emit('runner-log', { name: accountName, msg: `Sweeping balance to master wallet...` });

        // Pass individual seed and address to sweeper
        const sweeper = spawn('node', ['sweeper.js', sweepAddr, acc.wallet_seed]);
        sweeper.stdout.on('data', (d) => io.emit('runner-log', { name: accountName, msg: d.toString() }));
        sweeper.on('close', () => io.emit('runner-log', { name: accountName, msg: 'Sweep complete.' }));
    });

    socket.on('rescue-stale-sessions', () => {
        console.log(`[RESCUE] Manual "Rescue Stale Sessions" triggered... scanning session database.`);
        let rescuedCount = 0;
        let rescuedAmount = 0;

        Object.keys(activeSessions).forEach(name => {
            const sess = activeSessions[name];
            if (sess.earnings > 0 && sess.proxyWalletSeed) {
                // Use the updated rescueWallet logic to handle duplicates and tokens
                rescueWallet(name, sess.sessionToken, sess.proxy);
                rescuedCount++;
                rescuedAmount += sess.earnings;
            }
        });
        console.log(`[RESCUE] Deep scan complete. Processed ${rescuedCount} potential stale sessions.`);
    });

    socket.on('rescue-retry-withdrawal', (seed) => {
        const w = rescuedWallets.find(x => x.seed === seed);
        if (!w || !w.token) {
            return socket.emit('runner-log', { name: 'SYSTEM', msg: `[RESCUE ERROR] Cannot retry ${w?.name || 'unknown'}: Missing session token.` });
        }

        console.log(`[RESCUE] Retrying remote withdrawal for ${w.name}...`);
        io.emit('rescue-status', { seed, status: 'retrying...' });

        const withdrawProc = spawn('node', ['withdraw_nano.js', w.token, w.address, w.proxy || '']);

        withdrawProc.stdout.on('data', (d) => {
            const msg = d.toString().trim();
            console.log(`[RESCUE][${w.name}] ${msg}`);
            io.emit('runner-log', { name: w.name, msg: `[RETRY] ${msg}` });
        });

        withdrawProc.on('close', (code) => {
            if (code === 0) {
                console.log(`[RESCUE] SUCCESS: Remote funds secured for ${w.name}.`);
                w.balance = 0; // Balance cleared from faucet
                w.withdrawn = true;
                flushRescuedWallets();
                io.emit('rescue-updated', { count: rescuedWallets.length, totalBalance: rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0), wallets: rescuedWallets });
            } else {
                console.log(`[RESCUE] FAIL: Remote withdrawal for ${w.name} failed with code ${code}.`);
                io.emit('rescue-status', { seed, status: 'failed' });
            }
        });
    });
});

// Batch State Sync for Dashboard UI Performance
setInterval(() => {
    if (Object.keys(runners).length > 0 || pendingLogs.length > 0) {
        const earnings = {};
        const proxyWallets = {};
        Object.keys(runners).forEach(name => {
            earnings[name] = runners[name].earnings;
            if (runners[name].proxyWallet) proxyWallets[name] = runners[name].proxyWallet;
        });

        const logsToEmit = [...pendingLogs];
        pendingLogs = [];

        io.emit('sync-state', { earnings, proxyWallets, logs: logsToEmit });
    }
}, 1500);

// Helper to persist account state (Cache only, flush handles disk)
function saveAccountState(name, earnings) {
    const index = allAccounts.findIndex(a => a.name === name);
    if (index !== -1) {
        allAccounts[index].earnings = earnings;
    }
}

function startRunner(acc, autoWithdrawEnabled, withdrawLimit, mainWalletAddress) {
    if (runners[acc.name] && runners[acc.name].status === 'running') return;

    console.log(`[MASTER] Starting runner for ${acc.name}...`);

    // Address handles auto withdrawing to the main wallet
    const addr = (mainWalletAddress || '').replace('xrb_', 'nano_');
    const threshold = autoWithdrawEnabled ? withdrawLimit : 0;

    // Check if we have a saved session for this worker
    const saved = activeSessions[acc.name];
    const sessionArg = (saved && saved.sessionToken) ? saved.sessionToken : 'AUTO';
    if (saved && saved.sessionToken) {
        console.log(`[MASTER] Resuming ${acc.name} with saved session: ${saved.sessionToken.slice(0, 16)}...`);
    }

    // Resource Bounds: Cap memory to 128MB per worker to prevent host crashes
    const refCode = (settings.referralEnabled && settings.referralCode) ? settings.referralCode : '';
    const savedWalletSeed = (saved && saved.proxyWalletSeed) ? saved.proxyWalletSeed : '';
    const savedWalletAddr = (saved && saved.proxyWalletAddress) ? saved.proxyWalletAddress : '';
    const solverUrl = settings.turnstileSolverUrl || 'http://localhost:3000';
    const proc = spawn('node', ['--max-old-space-size=128', 'fast_tap.js', sessionArg, acc.proxy || '', addr, threshold.toString(), refCode, savedWalletSeed, savedWalletAddr, solverUrl], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    runners[acc.name] = {
        process: proc,
        status: 'running',
        pid: proc.pid,
        earnings: parseFloat(acc.earnings) || 0,
        proxyWallet: null,
        logs: []
    };

    // Listen for IPC messages from workers (rate-limit signals + session info)
    proc.on('message', (msg) => {
        if (msg && msg.type === 'rate-limited') {
            // Debounce: only rotate once per 5 seconds even if multiple workers signal
            const now = Date.now();
            if (!global._lastFleetRotation || (now - global._lastFleetRotation) > 5000) {
                global._lastFleetRotation = now;
                console.log(`[FLEET] Worker ${acc.name} hit rate limit — rotating ALL workers...`);
                rotateSharedProxy();
            }
        } else if (msg && msg.type === 'session-info') {
            // Worker reporting its session token and proxy wallet — save to disk
            activeSessions[acc.name] = {
                sessionToken: msg.sessionToken,
                proxyWalletSeed: msg.proxyWalletSeed || '',
                proxyWalletAddress: msg.proxyWalletAddress || '',
                earnings: runners[acc.name]?.earnings || 0,
                proxy: acc.proxy || '',
                savedAt: new Date().toISOString()
            };
            flushSessions();
            console.log(`[SESSION] Saved session for ${acc.name}: ${msg.sessionToken.slice(0, 16)}...`);
        }
    });

    // If fleet is currently paused, tell the new worker immediately
    if (settings.fleetPaused) {
        runners[acc.name].status = 'paused';
        setTimeout(() => {
            if (proc.connected) proc.send({ type: 'pause' });
        }, 2000);
    }

    proc.stdout.on('data', (data) => {
        if (!runners[acc.name]) return; // Safety check
        const rawData = data.toString();

        // Using fast string checks instead of regex/split on every tick saves ~80% CPU overhead
        if (rawData.indexOf('Balance:') !== -1 || rawData.indexOf('Tap Success!') !== -1) {
            // Only use balance hook if it's there
            let bMatch = rawData.match(/Current Balance: ([\d.]+)/) || rawData.match(/Tap Success! Balance: ([\d.]+)/);
            if (bMatch && runners[acc.name] && runners[acc.name].pid === proc.pid) {
                runners[acc.name].earnings = parseFloat(bMatch[1]);
            }
            return; // Skip balance spam from logs
        }

        const lines = rawData.split('\n').map(line => line.trim()).filter(Boolean);

        lines.forEach(line => {
            // Hook Proxy Wallet generation
            let pMatch = line.match(/Proxy Wallet generated for session: (nano_[a-z0-9]+)/);
            if (pMatch) {
                if (runners[acc.name] && runners[acc.name].pid === proc.pid) {
                    runners[acc.name].proxyWallet = pMatch[1];
                }
            }

            // Hook Consolidation Status
            if (line.includes('Starting consolidation to Master Wallet')) {
                if (runners[acc.name] && runners[acc.name].pid === proc.pid) {
                    runners[acc.name].status = 'consolidating';
                    io.emit('runner-status', { name: acc.name, status: 'consolidating' });
                }
            }
            if (line.includes('[SUCCESS] Consummated transfer')) {
                if (runners[acc.name] && runners[acc.name].pid === proc.pid) {
                    runners[acc.name].status = 'bridged';
                    runners[acc.name].earnings = 0; // Reset balance as it's now in Master
                    saveAccountState(acc.name, 0);
                    io.emit('runner-status', { name: acc.name, status: 'bridged' });
                }
            }

            if (line.includes('Refreshing session...')) {
                if (runners[acc.name] && runners[acc.name].pid === proc.pid) {
                    runners[acc.name].status = 'restarting';
                    io.emit('runner-status', { name: acc.name, status: 'restarting' });
                }
            }

            if (line.includes('[WS] Connected!')) {
                if (runners[acc.name] && runners[acc.name].pid === proc.pid) {
                    runners[acc.name].status = 'running';
                    io.emit('runner-status', { name: acc.name, status: 'running' });
                }
            }
            if (line.includes('[CONSOLIDATOR ERROR]') || line.includes('[FATAL]') || line.includes('Work generation failed')) {
                runners[acc.name].status = 'bridge-error';
                io.emit('runner-status', { name: acc.name, status: 'bridge-error' });
                // RESCUE: Save the wallet so funds aren't lost
                rescueWallet(acc.name);
            }

            // Store logs in memory and global buffer, skipping balance spam
            if (!line.includes('Current Balance:') && !line.includes('Tap Success!')) {
                const logObj = { name: acc.name, msg: line };
                runners[acc.name].logs.push(line);
                pendingLogs.push(logObj);

                if (runners[acc.name].logs.length > 50) {
                    runners[acc.name].logs.shift();
                }
                // Cap global buffer to prevent memory leaks if UI is disconnected
                if (pendingLogs.length > 500) {
                    pendingLogs.shift();
                }
            }
        });
    });

    proc.stderr.on('data', (data) => {
        if (!runners[acc.name]) return;
        const rawData = data.toString();
        const lines = rawData.split('\n').map(line => line.trim()).filter(Boolean);

        lines.forEach(line => {
            const logObj = { name: acc.name, msg: `[ERR] ${line}` };
            runners[acc.name].logs.push(`[ERR] ${line}`);
            pendingLogs.push(logObj);

            if (runners[acc.name].logs.length > 50) runners[acc.name].logs.shift();
            if (pendingLogs.length > 500) pendingLogs.shift();
        });
    });

    proc.on('close', (code) => {
        if (!runners[acc.name] || runners[acc.name].pid !== proc.pid) return; // Map might have been cleaned up or overwritten

        const wasBridged = runners[acc.name].status === 'bridged';
        const earnings = runners[acc.name].earnings || 0;

        if (!wasBridged) {
            runners[acc.name].status = 'stopped';
            // EMERGENCY RESCUE: If worker exits with balance and NOT bridged, save to vault
            if (earnings > 0) {
                console.log(`[RESCUE] Worker ${acc.name} exited with ${earnings} NANO remaining. Securing to vault...`);
                rescueWallet(acc.name);
            }
        }

        saveAccountState(acc.name, earnings);
        io.emit('runner-status', { name: acc.name, status: runners[acc.name].status });

        // Clean up memory if stopped
        if (runners[acc.name].status === 'stopped' || wasBridged) {
            runners[acc.name].process = null;
        }
    });

    io.emit('runner-status', { name: acc.name, status: 'running' });
}

function stopRunner(accountName, doSweep = false) {
    if (runners[accountName] && runners[accountName].process) {
        if (doSweep) {
            runners[accountName].status = 'sweeping...';
            io.emit('runner-status', { name: accountName, status: 'sweeping...' });

            try {
                if (runners[accountName].process.connected) {
                    runners[accountName].process.send({ type: 'stop_and_sweep' });
                } else {
                    runners[accountName].process.kill();
                }
            } catch (e) {
                console.error(`[SERVER] Failed to send sweep to ${accountName}: ${e.message}`);
                runners[accountName].process.kill();
            }
        } else {
            runners[accountName].process.kill();
            runners[accountName].status = 'stopped';
            io.emit('runner-status', { name: accountName, status: 'stopped' });
        }
    }
}

// REST API for dashboard
app.get('/api/accounts', (req, res) => res.json(getAccounts()));
app.post('/api/accounts', (req, res) => {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(req.body, null, 2));
    io.emit('accounts-updated', req.body);
    res.json({ success: true });
});

// Rescue Vault API
app.get('/api/rescued-wallets', (req, res) => {
    const totalBalance = rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0);
    res.json({ count: rescuedWallets.length, totalBalance, wallets: rescuedWallets });
});

app.get('/api/rescued-wallets/download', (req, res) => {
    if (rescuedWallets.length === 0) return res.status(404).send('No rescued wallets.');

    let text = `RESCUED WALLETS - ${new Date().toISOString()}\n`;
    text += `Total Wallets: ${rescuedWallets.length}\n`;
    text += `Total Balance: ${rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0)} nano\n`;
    text += '='.repeat(80) + '\n\n';

    rescuedWallets.forEach((w, i) => {
        text += `${i + 1}.\n`;
        text += `  Worker:  ${w.name}\n`;
        text += `  Address: ${w.address}\n`;
        text += `  Seed:    ${w.seed}\n`;
        text += `  Balance: ${w.balance} nano\n`;
        text += `  Rescued: ${w.rescuedAt}\n\n`;
    });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="rescued_wallets.txt"');
    res.send(text);
});

app.delete('/api/rescued-wallets', (req, res) => {
    rescuedWallets = [];
    flushRescuedWallets();
    io.emit('rescue-updated', { count: 0, totalBalance: 0, wallets: [] });
    res.json({ success: true });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Port ${PORT} is already in use. Please kill the existing process first.`);
        process.exit(1);
    } else {
        console.error(`[FATAL] Server error: ${err.message}`);
        process.exit(1);
    }
});

if (isSolverOnly) {
    console.log("================================================");
    console.log("🚀 NANO FLEET COMMAND - DEDICATED SOLVER MODE");
    console.log("================================================");
    startSolver();
} else {
    server.listen(PORT, '0.0.0.0', () => {
        const os = require('os');
        const networkInterfaces = os.networkInterfaces();
        let localIp = 'localhost';

        for (const name of Object.keys(networkInterfaces)) {
            for (const net of networkInterfaces[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    localIp = net.address;
                }
            }
        }

        console.log(`\n================================================`);
        console.log(`  DASHBOARD IS LIVE!`);
        console.log(`  Local:  http://localhost:${PORT}`);
        console.log(`  Remote: http://${localIp}:${PORT}`);
        console.log(`================================================\n`);

        if (!isWorkerOnly) {
            startSolver();
        } else {
            console.log("⚠️  Running in WORKER-ONLY mode. Local solver disabled.");
        }
    });
}

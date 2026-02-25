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

// State Management (Absolute Top-Level for safe access in all scopes)
let runners = {};
let nodeHealth = {};
let allAccounts = [];
let pendingLogs = [];
let activeSessions = {};
let rescuedWallets = [];
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

async function initServer() {
    await checkNodes();
    setTimeout(autoRecoverFleet, 5000);
}

if (!isSolverOnly) {
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
            console.log(`[SERVER] Loaded ${rescuedWallets.length} rescued wallets.`);
        } catch (e) { console.error("Error loading rescued wallets:", e); }
    }
    if (fs.existsSync(SESSIONS_FILE)) {
        try {
            activeSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            console.log(`[SERVER] Loaded ${Object.keys(activeSessions).length} saved sessions.`);
        } catch (e) { console.error("Error loading sessions:", e); }
    }
    initServer();
    setInterval(checkNodes, 30000);
    if (!isWorkerOnly) startSolver();
} else {
    // Dedicated Solver Mode
    startSolver();
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
    } catch (e) { console.error(`[SERVER] Error saving rescued wallets: ${e.message}`); }
}

function rescueWallet(workerName, optionalToken = null, optionalProxy = null) {
    const acc = allAccounts.find(a => a.name === workerName);
    const sess = activeSessions[workerName] || {};
    const seed = sess.proxyWalletSeed || (acc ? acc.wallet_seed : null);
    const address = sess.proxyWalletAddress || (acc ? acc.wallet_address : null);
    if (!seed) return;

    let entry = rescuedWallets.find(w => w.seed === seed);
    const earnings = (runners[workerName] ? runners[workerName].earnings : 0) || (acc ? acc.earnings : 0) || (sess.earnings) || 0;
    if (earnings <= 0 && !entry) return;

    const token = optionalToken || sess.sessionToken || '';
    const proxy = optionalProxy || sess.proxy || (acc ? acc.proxy : '') || '';

    if (entry) {
        entry.balance = Math.max(entry.balance, earnings);
        entry.token = token || entry.token;
        entry.proxy = proxy || entry.proxy;
        entry.lastUpdate = new Date().toISOString();
    } else {
        entry = {
            name: workerName, address, seed, balance: earnings, token, proxy, rescuedAt: new Date().toISOString()
        };
        rescuedWallets.push(entry);
    }
    flushRescuedWallets();
    console.log(`[RESCUE] Secured ${workerName} (${earnings} NANO) to vault.`);
    const totalBalance = rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0);
    io.emit('rescue-updated', { count: rescuedWallets.length, totalBalance, wallets: rescuedWallets });
}

setInterval(flushAccountsToDisk, 60000);

process.on('SIGINT', () => {
    console.log('[SERVER] Shutting down...');
    flushAccountsToDisk();
    if (solverProcess) solverProcess.kill();
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
    });
    solverProcess.stderr.on('data', (data) => console.error(`[SOLVER ERR] ${data.toString()}`));
    solverProcess.on('close', (code) => {
        if (code !== 0 && !process.exitCode) {
            console.log('[SERVER] Solver crashed. Restarting...');
            setTimeout(startSolver, 5000);
        }
    });
}

let sharedProxySessionId = require('crypto').randomBytes(4).toString('hex');

function getRotatedProxy(baseProxy) {
    let proxy = baseProxy;
    if (!proxy) {
        proxy = `http://${settings.proxyUser}:${settings.proxyPass}@${settings.proxyHost}:${settings.proxyPort}`;
    }
    try {
        const url = new URL(proxy);
        if (url.hostname.includes('superproxy') || url.username.includes('brd-customer')) {
            url.username = url.username.replace(/-session-[^:@]*/i, '');
            url.username = `${url.username}-session-rand_${sharedProxySessionId}`;
            return url.toString();
        }
    } catch (e) { }
    return proxy;
}

function rotateSharedProxy() {
    sharedProxySessionId = require('crypto').randomBytes(4).toString('hex');
    console.log(`[FLEET] Rotating Shared IP: rand_${sharedProxySessionId}`);
    Object.keys(runners).forEach(name => {
        const r = runners[name];
        if (r && r.process && r.status === 'running') {
            try { r.process.send({ type: 'rotate-proxy', newSessionId: sharedProxySessionId }); } catch (e) { }
        }
    });
}

io.on('connection', (socket) => {
    console.log('[WS] Dashboard connected');
    const runnerNames = Object.keys(runners);
    // Explicitly using global allAccounts to avoid shadowing confusion
    const activeAccountsList = runnerNames.length > 0
        ? allAccounts.filter(a => runnerNames.includes(a.name)).map(a => ({ ...a, earnings: runners[a.name].earnings || 0 }))
        : [];

    socket.emit('init', {
        accounts: activeAccountsList,
        runners: runnerNames.map(k => ({ name: k, status: runners[k].status })),
        nodeHealth,
        settings,
        rescued: { count: rescuedWallets.length, totalBalance: rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0), wallets: rescuedWallets }
    });

    socket.on('save-settings', (newSettings) => {
        const refChanged = newSettings.referralCode !== undefined && newSettings.referralCode !== settings.referralCode;
        settings = { ...settings, ...newSettings };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        if (refChanged) {
            Object.keys(activeSessions).forEach(name => { if (activeSessions[name]) delete activeSessions[name].sessionToken; });
            flushSessions();
        }
        io.emit('settings-updated', settings);
    });

    socket.on('start-runner', (name) => {
        const acc = allAccounts.find(a => a.name === name);
        if (acc) startRunner(acc);
    });

    socket.on('stop-runner', (name) => stopRunner(name, true));

    socket.on('start-fleet', async ({ targetSize, autoWithdrawEnabled, withdrawLimit, mainWalletAddress: pWallet, defaultProxy }) => {
        const mWallet = pWallet || settings.mainWalletAddress;
        settings.activeFleet = { targetSize, autoWithdraw: autoWithdrawEnabled, withdrawLimit };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));

        const sliced = (await fillFleet(targetSize)).slice(0, targetSize);
        Object.keys(runners).forEach(n => stopRunner(n, true));

        io.emit('init', { accounts: sliced, runners: sliced.map(a => ({ name: a.name, status: 'deploying' })), nodeHealth });

        for (const acc of sliced) {
            const proxy = (defaultProxy && defaultProxy.trim()) ? defaultProxy : (acc.proxy || '');
            startRunner({ ...acc, proxy: getRotatedProxy(proxy) }, autoWithdrawEnabled, withdrawLimit, mWallet);
        }
    });

    socket.on('pause-fleet', () => {
        settings.fleetPaused = true;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        Object.keys(runners).forEach(n => {
            if (runners[n]?.process?.connected) {
                runners[n].process.send({ type: 'pause' });
                runners[n].status = 'paused';
                io.emit('runner-status', { name: n, status: 'paused' });
            }
        });
    });

    socket.on('resume-fleet', () => {
        settings.fleetPaused = false;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        Object.keys(runners).forEach(n => {
            if (runners[n]?.process?.connected) {
                runners[n].process.send({ type: 'resume' });
                runners[n].status = 'running';
                io.emit('runner-status', { name: n, status: 'running' });
            }
        });
    });

    socket.on('stop-fleet', async () => {
        const names = Object.keys(runners);
        for (const n of names) {
            stopRunner(n, true);
            await new Promise(r => setTimeout(r, 2000));
        }
        settings.activeFleet.targetSize = 0;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
    });

    socket.on('sweep-active', async () => {
        for (const n of Object.keys(runners)) {
            if (runners[n]?.process) runners[n].process.send({ type: 'withdraw' });
            await new Promise(r => setTimeout(r, 2000));
        }
    });

    socket.on('rescue-stale-sessions', () => {
        Object.keys(activeSessions).forEach(n => {
            const s = activeSessions[n];
            if (s.earnings > 0 && s.proxyWalletSeed) rescueWallet(n, s.sessionToken, s.proxy);
        });
    });

    socket.on('rescue-retry-withdrawal', (seed) => {
        const w = rescuedWallets.find(x => x.seed === seed);
        if (!w || !w.token) return;
        io.emit('rescue-status', { seed, status: 'retrying' });
        const p = spawn('node', ['withdraw_nano.js', w.token, w.address, w.proxy || '']);
        p.on('close', (c) => {
            if (c === 0) {
                w.balance = 0; w.withdrawn = true; flushRescuedWallets();
                io.emit('rescue-updated', { count: rescuedWallets.length, totalBalance: rescuedWallets.reduce((s, x) => s + (x.balance || 0), 0), wallets: rescuedWallets });
            } else io.emit('rescue-status', { seed, status: 'failed' });
        });
    });
});

setInterval(() => {
    if (Object.keys(runners).length > 0 || pendingLogs.length > 0) {
        const earnings = {};
        const pWallets = {};
        Object.keys(runners).forEach(n => {
            earnings[n] = runners[n].earnings;
            if (runners[n].proxyWallet) pWallets[n] = runners[n].proxyWallet;
        });
        const lToEmit = [...pendingLogs];
        pendingLogs = []; // Assignment is fine as pendingLogs is let
        io.emit('sync-state', { earnings, proxyWallets: pWallets, logs: lToEmit });
    }
}, 1500);

function saveAccountState(name, earnings) {
    const idx = allAccounts.findIndex(a => a.name === name);
    if (idx !== -1) allAccounts[idx].earnings = earnings;
}

function startRunner(acc, autoWithdraw, limit, mWallet) {
    if (runners[acc.name]?.status === 'running') return;
    const addr = (mWallet || '').replace('xrb_', 'nano_');
    const thr = autoWithdraw ? limit : 0;
    const sess = activeSessions[acc.name];
    const sArg = (sess && sess.sessionToken) ? sess.sessionToken : 'AUTO';
    const rCode = (settings.referralEnabled && settings.referralCode) ? settings.referralCode : '';
    const seed = (sess && sess.proxyWalletSeed) ? sess.proxyWalletSeed : '';
    const wAddr = (sess && sess.proxyWalletAddress) ? sess.proxyWalletAddress : '';
    const sUrl = settings.turnstileSolverUrl || 'http://localhost:3000';

    const p = spawn('node', ['--max-old-space-size=128', 'fast_tap.js', sArg, acc.proxy || '', addr, thr.toString(), rCode, seed, wAddr, sUrl], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

    runners[acc.name] = { process: p, status: 'running', pid: p.pid, earnings: parseFloat(acc.earnings) || 0, proxyWallet: null, logs: [] };

    p.on('message', (m) => {
        if (m?.type === 'rate-limited') rotateSharedProxy();
        else if (m?.type === 'session-info') {
            activeSessions[acc.name] = { sessionToken: m.sessionToken, proxyWalletSeed: m.proxyWalletSeed || '', proxyWalletAddress: m.proxyWalletAddress || '', earnings: runners[acc.name]?.earnings || 0, proxy: acc.proxy || '', savedAt: new Date().toISOString() };
            flushSessions();
        }
    });

    p.stdout.on('data', (d) => {
        if (!runners[acc.name]) return;
        const raw = d.toString();
        if (raw.includes('Balance:') || raw.includes('Tap Success!')) {
            let m = raw.match(/Current Balance: ([\d.]+)/) || raw.match(/Tap Success! Balance: ([\d.]+)/);
            if (m && runners[acc.name]) runners[acc.name].earnings = parseFloat(m[1]);
            return;
        }
        raw.split('\n').filter(Boolean).forEach(l => {
            let pM = l.match(/Proxy Wallet generated for session: (nano_[a-z0-9]+)/);
            if (pM && runners[acc.name]) runners[acc.name].proxyWallet = pM[1];
            if (l.includes('Starting consolidation')) { runners[acc.name].status = 'consolidating'; io.emit('runner-status', { name: acc.name, status: 'consolidating' }); }
            if (l.includes('[SUCCESS] Consummated transfer')) { runners[acc.name].status = 'bridged'; runners[acc.name].earnings = 0; saveAccountState(acc.name, 0); io.emit('runner-status', { name: acc.name, status: 'bridged' }); }
            if (l.includes('Refreshing session...')) { runners[acc.name].status = 'restarting'; io.emit('runner-status', { name: acc.name, status: 'restarting' }); }
            if (l.includes('[WS] Connected!')) { runners[acc.name].status = 'running'; io.emit('runner-status', { name: acc.name, status: 'running' }); }
            if (l.includes('[ERROR]') || l.includes('[FATAL]')) { runners[acc.name].status = 'error'; io.emit('runner-status', { name: acc.name, status: 'error' }); rescueWallet(acc.name); }
            pendingLogs.push({ name: acc.name, msg: l.trim() });
            if (pendingLogs.length > 500) pendingLogs.shift();
        });
    });

    p.on('close', (c) => {
        if (!runners[acc.name]) return;
        const earns = runners[acc.name].earnings || 0;
        if (runners[acc.name].status !== 'bridged') {
            runners[acc.name].status = 'stopped';
            if (earns > 0) rescueWallet(acc.name);
        }
        saveAccountState(acc.name, earns);
        io.emit('runner-status', { name: acc.name, status: runners[acc.name].status });
        runners[acc.name].process = null;
    });
}

function stopRunner(name, sweep = false) {
    if (runners[name]?.process) {
        if (sweep && runners[name].process.connected) runners[name].process.send({ type: 'stop_and_sweep' });
        else runners[name].process.kill();
    }
}

app.get('/api/accounts', (req, res) => res.json(allAccounts));
app.post('/api/accounts', (req, res) => {
    allAccounts = req.body;
    flushAccountsToDisk();
    res.json({ success: true });
});

app.get('/api/rescued-wallets', (req, res) => {
    res.json({ count: rescuedWallets.length, totalBalance: rescuedWallets.reduce((s, w) => s + (w.balance || 0), 0), wallets: rescuedWallets });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n================================================\n  DASHBOARD IS LIVE!\n  Local:  http://localhost:${PORT}\n  Remote: http://YOUR_IP:${PORT}\n================================================\n`);
    if (isSolverOnly) console.log("⚠️  Running in SOLVER-ONLY mode.");
    if (isWorkerOnly) console.log("⚠️  Running in WORKER-ONLY mode.");
});

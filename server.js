const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { createWallet, ensureWallets, fillFleet } = require('./wallet_mgr');

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
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
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

// State
let runners = {}; // { accountName: { process, status, logs[] } }
let nodeHealth = {};
let allAccounts = []; // Cache for accounts.json
let pendingLogs = []; // Global log buffer for dashboard
let settings = {
    mainWalletAddress: "",
    proxyHost: "",
    proxyPort: "",
    proxyUser: "",
    proxyPass: ""
};
let solverProcess = null;

// Load initial data
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
    io.emit('node-health', nodeHealth);
}

setInterval(checkNodes, 30000);
checkNodes();

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
        console.error(`[SOLVER ERROR] ${msg}`);
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
function getRotatedProxy(baseProxy, workerName) {
    if (!baseProxy) return '';
    try {
        const url = new URL(baseProxy);
        // BrightData specific: inject session ID if using their domain
        if (url.hostname.includes('superproxy') || url.username.includes('brd-customer')) {
            // Append session ID to username
            if (!url.username.includes('-session-')) {
                url.username = `${url.username}-session-${workerName}`;
            }
        }
        return url.toString();
    } catch (e) {
        return baseProxy; // Return as-is if parsing fails
    }
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
        settings
    });

    socket.on('save-settings', (newSettings) => {
        settings = { ...settings, ...newSettings };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        console.log("[SERVER] Settings updated and saved.");
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

        // Staggered launch sequence (launch 1 worker every 5 seconds to spread initial load)
        for (let i = 0; i < targetSize; i++) {
            const acc = slicedAccounts[i];
            const baseProxy = (defaultProxy && defaultProxy.trim()) ? defaultProxy : (acc.proxy || '');
            const rotatedProxy = getRotatedProxy(baseProxy, acc.name);

            startRunner({ ...acc, proxy: rotatedProxy }, autoWithdrawEnabled, withdrawLimit, mainWalletAddress);
            await new Promise(r => setTimeout(r, 5000));
        }
    });

    socket.on('stop-fleet', async () => {
        console.log(`[MASTER] Staggered halt sequence initiated... securely dumping worker balances...`);
        const names = Object.keys(runners);
        for (const name of names) {
            io.emit('runner-log', { name, msg: 'Halt Fleet signal received. Initiating final sweep...' });
            stopRunner(name, true);
            await new Promise(r => setTimeout(r, 4000)); // Stagger sweep out to prevent ratelimits
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

    console.log(`[MASTER] Starting runner for ${acc.name} with AUTO token...`);

    // Address handles auto withdrawing to the main wallet
    const addr = (mainWalletAddress || '').replace('xrb_', 'nano_');
    const threshold = autoWithdrawEnabled ? withdrawLimit : 0;

    // Pass 'AUTO' to instruct fast_tap.js to generate its own session token
    // Resource Bounds: Cap memory to 128MB per worker to prevent host crashes
    const proc = spawn('node', ['--max-old-space-size=128', 'fast_tap.js', 'AUTO', acc.proxy || '', addr, threshold.toString()], {
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

    proc.stdout.on('data', (data) => {
        if (!runners[acc.name]) return; // Safety check
        const rawData = data.toString();

        // --- HIGH PERFORMANCE LOG PARSING ---
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
            if (line.includes('[CONSOLIDATOR ERROR]')) {
                runners[acc.name].status = 'bridge-error';
                io.emit('runner-status', { name: acc.name, status: 'bridge-error' });
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

    proc.on('close', (code) => {
        if (!runners[acc.name] || runners[acc.name].pid !== proc.pid) return; // Map might have been cleaned up or overwritten
        if (runners[acc.name].status !== 'bridged') {
            runners[acc.name].status = 'stopped';
        }
        saveAccountState(acc.name, runners[acc.name].earnings);
        io.emit('runner-status', { name: acc.name, status: runners[acc.name].status });
        // Clean up memory if stopped
        if (runners[acc.name].status === 'stopped' || runners[acc.name].status === 'bridged') {
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

    startSolver();
});

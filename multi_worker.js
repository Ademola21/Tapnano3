const { FastTapper } = require('./fast_tap');

// Accounts are passed as a JSON array in the first argument
const accountsRaw = process.argv[2];
const globalConfig = JSON.parse(process.argv[3] || '{}');

if (!accountsRaw) {
    console.error('[FATAL] No accounts provided to multi_worker.js');
    process.exit(1);
}

let accounts = [];
try {
    accounts = JSON.parse(accountsRaw);
} catch (e) {
    console.error('[FATAL] Failed to parse accounts JSON');
    process.exit(1);
}

const tappers = {};

async function init() {
    console.log(`[MULTI-WORKER] Spawning ${accounts.length} units in PID ${process.pid}`);

    for (const acc of accounts) {
        // Wait a small bit between spawns to avoid slamming the session API
        await new Promise(r => setTimeout(r, 200));

        const tapper = new FastTapper(acc.sessionToken || 'AUTO', acc.proxy || globalConfig.defaultProxy);
        tapper.name = acc.name;
        tapper.withdrawAddress = globalConfig.mainWalletAddress;
        tapper.withdrawThreshold = globalConfig.withdrawThreshold;

        // Pass extra context if available
        if (acc.seed) {
            tapper.proxyWallet = { seed: acc.seed, address: acc.address };
        }

        tappers[acc.name] = tapper;
        tapper.start();
    }
}

process.on('message', (msg) => {
    if (msg.type === 'pause') {
        Object.values(tappers).forEach(t => t.isPaused = true);
    } else if (msg.type === 'resume') {
        Object.values(tappers).forEach(t => {
            t.isPaused = false;
            if (!t.ws || t.ws.readyState === 3 /* CLOSED */) t.start();
        });
    } else if (msg.type === 'stop_and_sweep') {
        console.log('[MULTI-WORKER] Stop & Sweep signal received. Closing all connections...');
        const promises = Object.values(tappers).map(t => {
            t.halted = true;
            clearInterval(t.tapInterval);
            if (t.ws) t.ws.close();
            return t.performWithdrawal();
        });
        Promise.all(promises).then(() => {
            console.log('[MULTI-WORKER] All sweeps complete. Terminating.');
            process.exit(0);
        });
    } else if (msg.type === 'rotate-proxy') {
        Object.values(tappers).forEach(t => {
            // Re-use logic from standalone mode
            if (t.proxy) {
                t.proxy = t.proxy.replace(/(-session-[^:@]+)/i, `-session-rand_${msg.newSessionId}`);
            }
            if (t._waitingForRotation) {
                t._waitingForRotation = false;
                t.start();
            } else if (t.ws && t.ws.readyState === 1 /* OPEN */) {
                t.ws.close();
            }
        });
    } else if (msg.type === 'stop-runner') {
        const t = tappers[msg.name];
        if (t) {
            t.halted = true;
            if (t.ws) t.ws.close();
            if (msg.sweep) {
                t.performWithdrawal().then(() => delete tappers[msg.name]);
            } else {
                delete tappers[msg.name];
            }
        }
    }
});

init().catch(err => {
    console.error('[MULTI-WORKER] [FATAL] Initialization failed:', err);
    process.exit(1);
});

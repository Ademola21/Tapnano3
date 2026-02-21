const axios = require('axios');
const nano = require('nanocurrency');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const NODES = [
    'https://nanoslo.0x.no/proxy',
    'https://node.somenano.com/proxy',
    'https://rainstorm.city/api',
    'https://uk1.public.xnopay.com/proxy'
];

async function callNode(action, params = {}) {
    for (let url of NODES) {
        try {
            const res = await axios.post(url, { action, ...params }, { timeout: 10000 });
            if (res.data && !res.data.error) return res.data;
        } catch (e) {
            console.log(`[WARN] Node ${url} failed: ${e.message}`);
        }
    }
    throw new Error('All Nano nodes failed');
}

async function sweepAccount(acc, mainAddress) {
    const address = acc.wallet_address;
    const seed = acc.wallet_seed;
    const privateKey = nano.derivePrivateKey(seed, 0);

    console.log(`[INFO] Checking balance for ${acc.name} (${address})...`);

    // 1. Get account info
    const info = await callNode('account_info', { account: address, representative: true });
    if (!info || !info.balance || info.balance === '0') {
        console.log(`[SKIP] ${acc.name} balance is 0.`);
        return;
    }

    console.log(`[INFO] Sweeping ${info.balance} raw to ${mainAddress}...`);

    // 2. Create block (Draft)
    // Note: This is a simplified logic. In a real scenario, we'd need PoW.
    // Some public nodes provide 'work_generate' or we calculate it.

    let work = null;
    try {
        const workRes = await callNode('work_generate', { hash: info.frontier });
        work = workRes.work;
    } catch (e) {
        console.log(`[ERROR] Could not generate work for ${acc.name}: ${e.message}`);
        return;
    }

    const block = {
        type: 'state',
        account: address,
        previous: info.frontier,
        representative: info.representative,
        balance: '0', // Sweep all
        link: mainAddress,
        work: work
    };

    // 3. Sign block
    block.signature = nano.signBlock(block, privateKey);

    // 4. Process (Broadcast)
    const processRes = await callNode('process', { json_block: 'true', block: block });
    console.log(`[SUCCESS] ${acc.name} swept! Hash: ${processRes.hash}`);
}

async function main() {
    const mainAddress = process.argv[2];
    if (!mainAddress) {
        console.log('Usage: node sweeper.js <main_nano_address>');
        process.exit(1);
    }

    if (!fs.existsSync(ACCOUNTS_FILE)) {
        console.log('[ERROR] accounts.json not found.');
        process.exit(1);
    }

    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const acc of accounts) {
        if (!acc.wallet_seed || acc.token.includes('REPLACE')) continue;
        try {
            await sweepAccount(acc, mainAddress);
        } catch (e) {
            console.error(`[ERROR] Failed to sweep ${acc.name}: ${e.message}`);
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = { sweepAccount };

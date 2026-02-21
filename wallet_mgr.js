const nano = require('nanocurrency');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

async function createWallet() {
    const seed = await nano.generateSeed();
    const privateKey = nano.deriveSecretKey(seed, 0);
    const publicKey = nano.derivePublicKey(privateKey);
    // Standardize to nano_ prefix
    const address = nano.deriveAddress(publicKey).replace('xrb_', 'nano_');
    return { seed, address };
}

async function ensureWallets() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        fs.writeFileSync(ACCOUNTS_FILE, '[]');
    }

    let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    let updated = false;

    for (let acc of accounts) {
        // Fix legacy xrb_ addresses
        if (acc.wallet_address && acc.wallet_address.startsWith('xrb_')) {
            acc.wallet_address = acc.wallet_address.replace('xrb_', 'nano_');
            updated = true;
        }

        // Fix legacy placeholders
        if (acc.proxy === 'REPLACE_WITH_YOUR_PROXY' || !acc.proxy) {
            acc.proxy = 'http://brd-customer-hl_abe74837-zone-datacenter_proxy1:f0oh54nh9r33@brd.superproxy.io:33335';
            updated = true;
        }

        if (acc.token === 'REPLACE_WITH_YOUR_TOKEN' || !acc.token) {
            acc.token = 'AUTO';
            updated = true;
        }

        if (!acc.wallet_seed || !acc.wallet_address) {
            console.log(`[INFO] Generating wallet for ${acc.name || acc.token.slice(0, 8)}...`);
            const wallet = await createWallet();
            acc.wallet_seed = wallet.seed;
            acc.wallet_address = wallet.address;
            updated = true;
        }
    }

    if (updated) {
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    }
}

async function fillFleet(targetSize) {
    if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '[]');
    let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

    let currentCount = accounts.filter(a => !a.token.includes('REPLACE')).length;
    let autoCount = accounts.length;

    while (accounts.length < targetSize) {
        autoCount++;
        console.log(`[INFO] Creating filler account Worker_${autoCount}...`);
        const wallet = await createWallet();
        accounts.push({
            name: `Worker_${autoCount}`,
            token: "AUTO",
            proxy: "http://brd-customer-hl_abe74837-zone-datacenter_proxy1:f0oh54nh9r33@brd.superproxy.io:33335",
            wallet_seed: wallet.seed,
            wallet_address: wallet.address,
            withdraw_threshold: 0,
            earnings: 0
        });
    }

    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    return accounts;
}

async function generateMainWallet() {
    console.log('[INFO] Generating MAIN WALLET...');
    const wallet = await createWallet();
    console.log('========================================');
    console.log('   NEW MAIN NANO WALLET (SAVE THIS!)');
    console.log('========================================');
    console.log(`Address: ${wallet.address}`);
    console.log(`Seed:    ${wallet.seed}`);
    console.log('========================================');
    return wallet;
}

if (require.main === module) {
    const cmd = process.argv[2];
    if (cmd === 'main') {
        generateMainWallet();
    } else if (cmd === 'fill') {
        fillFleet(parseInt(process.argv[3]) || 10);
    } else {
        ensureWallets();
    }
}

module.exports = { createWallet, ensureWallets, generateMainWallet, fillFleet };

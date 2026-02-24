#!/bin/bash

# =================================================================
# NANO FLEET COMMAND - DEDICATED WORKER SETUP (Ubuntu)
# =================================================================
# Optimized for: 16GB RAM / 4 vCPU VM (Runs 100+ Workers)
# =================================================================

set -e
echo "🚀 Starting Dedicated Worker Setup..."

# Fresh Install Toggle
if [[ "$1" == "--fresh" ]]; then
    echo "🧹 --- FRESH INSTALL REQUESTED --- 🧹"
    echo "Killing all node/pm2 processes and wiping old Tapnano2 files..."
    pm2 delete all 2>/dev/null || true
    killall node 2>/dev/null || true
    # We stay in current dir if script is there, but wipe contents
    find . -maxdepth 1 ! -name "$(basename "$0")" ! -name "." -exec rm -rf {} +
    echo "Done. Proceeding with clean install..."
fi

# 1. Update & Basic Tools
echo "[1/6] Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential

# 2. Install Node.js LTS (v20)
echo "[2/6] Installing Node.js LTS (v20)..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. Install Project Dependencies
echo "[3/6] Installing NPM packages..."
cd "$(dirname "$0")"
npm install
sudo npm install -g pm2

# 4. Build Dashboard
echo "[4/6] Building Dashboard UI..."
cd dashboard
npm install
npm run build
cd ..

# 5. Configure Firewall (Dashboard Port 4000)
echo "[5/6] Configuring Firewall (Port 4000)..."
sudo ufw allow 4000/tcp
sudo ufw allow 22/tcp
sudo ufw --force enable

# 6. Finalization
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

echo ""
echo "================================================================"
echo " ✅ WORKER DEPLOYMENT READY!"
echo "================================================================"
echo ""
echo " Dashboard Access:"
echo "   http://${PUBLIC_IP}:4000"
echo ""
echo " Step 1: Open the Dashboard"
echo " Step 2: Go to 'Execution Engine' -> 'Remote Solver Config'"
echo " Step 3: Enter your Solver VM IP Address"
echo ""
echo " Start Command:"
echo "   pm2 start server.js --name workers -- --worker-only"
echo ""
echo " Monitor Logs:"
echo "   pm2 logs workers"
echo ""
echo "================================================================"

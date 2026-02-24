#!/bin/bash

# =================================================================
# NANO FLEET COMMAND - DEDICATED SOLVER SETUP (Ubuntu)
# =================================================================
# Optimized for: 32GB RAM / 16 vCPU VM
# =================================================================

set -e
echo "🚀 Starting Dedicated Solver Setup..."

# Fresh Install Toggle
if [[ "$1" == "--fresh" ]]; then
    echo "🧹 --- FRESH INSTALL REQUESTED --- 🧹"
    echo "Killing all node/pm2 processes and wiping old Tapnano2 files..."
    pm2 delete all 2>/dev/null || true
    killall node 2>/dev/null || true
    # Wipe state files that might have been tracked or left over
    rm -f settings.json accounts.json active_sessions.json rescued_wallets.json
    echo "State wiped. Proceeding with clean install..."
fi

# 1. Update & Basic Tools
echo "[1/6] Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential ca-certificates gnupg

# 2. Install Node.js LTS (v20)
echo "[2/6] Installing Node.js LTS (v20)..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. Install Google Chrome (Required for turnstile)
echo "[3/6] Installing Google Chrome stable..."
if ! command -v google-chrome &> /dev/null; then
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
    sudo apt-get update -y
    sudo apt-get install -y google-chrome-stable
fi

# 4. Install Browser Dependencies (Xvfb + Libs)
echo "[4/6] Installing browser support libraries..."
sudo apt-get install -y \
    libgbm-dev libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    libxss1 libxdamage1 libxcomposite1 \
    libpango-1.0-0 libcairo2 libcups2 \
    libxkbcommon-x11-0 libdrm2 libxrandr2 \
    xvfb fonts-liberation libappindicator3-1 \
    2>/dev/null || true

sudo apt-get install -y libasound2 2>/dev/null || sudo apt-get install -y libasound2t64 2>/dev/null || true

# 4. Install Project & PM2
echo "[4/6] Installing dependencies..."
cd "$(dirname "$0")"
npm install
sudo npm install -g pm2

# 5. Configure Firewall (Solver Port 3000)
echo "[5/6] Configuration Firewall (Port 3000)..."
sudo ufw allow 3000/tcp
sudo ufw allow 22/tcp
sudo ufw --force enable

# 6. Finalization
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

echo ""
echo "================================================================"
echo " ✅ SOLVER DEPLOYMENT READY!"
echo "================================================================"
echo ""
echo " Your Solver URL for the Worker Dashboard:"
echo "   http://${PUBLIC_IP}:3000"
echo ""
echo " Start Command:"
echo "   pm2 start server.js --name solver -- --solver-only"
echo ""
echo " Monitor Logs:"
echo "   pm2 logs solver"
echo ""
echo "================================================================"

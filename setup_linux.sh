#!/bin/bash

# =================================================================
# NANO AUTOMATION CONSOLE - LINUX DEPLOYMENT SCRIPT
# =================================================================
# This script automates the installation of Node.js, Puppeteer,
# and Firewall settings for remote access on Port 4000.
# =================================================================

echo "🚀 Starting Linux Deployment Suite..."

# 1. Update & Basic Tools
echo "[1/6] Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential

# 2. Install Node.js LTS
echo "[2/6] Installing Node.js LTS (v20)..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Install Puppeteer Dependencies (Chrome requirements for Linux)
echo "[3/6] Installing Puppeteer/Chrome system libraries, Chromium, and Xvfb..."
sudo apt-get install -y libgbm-dev libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 libxss1 libxdamage1 libxcomposite1 libpango-1.0-0 libcairo2 libcups2 libxkbcommon-x11-0 chromium-browser xvfb

# 4. Install Project Dependencies
echo "[4/6] Installing NPM packages..."
cd "$(dirname "$0")"
npm install

# 5. Configure Firewall (Remote Access)
echo "[5/6] Opening Firewall for Dashboard (Port 4000) and Solver (Port 3000)..."
sudo ufw allow 4000/tcp
sudo ufw allow 3000/tcp
sudo ufw --force enable
sudo ufw status

# 6. Install PM2 (Process Manager for 24/7 Uptime)
echo "[6/6] Setting up PM2 for background persistence..."
sudo npm install -g pm2

echo ""
echo "================================================================"
echo " ✅ DEPLOYMENT COMPLETE!"
echo "================================================================"
echo " To start the dashboard in the background, run:"
echo " pm2 start server.js --name nano-dashboard"
echo ""
echo " Your dashboard will then be accessible at:"
echo " http://$(curl -s ifconfig.me):4000"
echo "================================================================"

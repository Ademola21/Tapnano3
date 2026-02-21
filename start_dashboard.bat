@echo off
echo [INFO] Starting Nano Taps Automation Console...

:: Check for node_modules
if not exist node_modules (
    echo [INFO] Installing backend dependencies...
    call npm install
)

if not exist dashboard\node_modules (
    echo [INFO] Installing dashboard dependencies...
    cd dashboard
    call npm install
    cd ..
)

:: Ensure wallets are generated
echo [INFO] Verifying account wallets...
node wallet_mgr.js

:: Open dashboard in browser
start http://localhost:4000

:: Start the backend server
echo [INFO] Launching Backend Server...
node server.js
pause

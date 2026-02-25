const axios = require('axios');
const WebSocket = require('ws');

async function run() {
    try {
        console.log('--- STARTING LOCAL VERIFICATION (DIRECT WS) ---');
        console.log('1. Fetching session token via SOLVER...');

        let res;
        try {
            res = await axios.post('http://127.0.0.1:3000/cf-clearance-scraper', {
                url: 'https://api.thenanobutton.com/api/session',
                mode: 'source'
            }, { timeout: 60000 });
        } catch (e) {
            console.error('FAILED: Solver is not responding. Is it running on port 3000?');
            process.exit(1);
        }

        let token;
        let forcedUA = null;
        let forcedCookies = null;

        if (res.data.source) {
            console.log('Solver returned content. Extracting token and metadata...');
            const sourceObj = res.data.source;
            const html = typeof sourceObj === 'object' ? sourceObj.html : sourceObj;

            if (typeof sourceObj === 'object') {
                forcedUA = sourceObj.userAgent;
                if (sourceObj.cookies) {
                    forcedCookies = sourceObj.cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    console.log(`Extracted cookies: ${forcedCookies.substring(0, 50)}...`);
                }
            }

            const startIdx = html.indexOf('{');
            const endIdx = html.lastIndexOf('}');
            if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                const jsonStr = html.substring(startIdx, endIdx + 1);
                const parsed = JSON.parse(jsonStr);
                token = parsed.token;
            }
        }

        if (!token) {
            console.error('FAILED: Could not obtain session token from solver output.');
            process.exit(1);
        }

        console.log('2. Testing WebSocket connection with MIRRORED HEADERS...');
        console.log(`Token: ${token.slice(0, 10)}...`);
        console.log(`UA: ${forcedUA || 'Default'}`);

        const url = `wss://api.thenanobutton.com/ws?token=${token}`;
        const wsOptions = {
            headers: {
                'Origin': 'https://thenanobutton.com',
                'User-Agent': forcedUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br'
            }
        };

        if (forcedCookies) {
            wsOptions.headers['Cookie'] = forcedCookies;
        }

        const ws = new WebSocket(url, wsOptions);

        ws.on('open', () => {
            console.log('✅ SUCCESS: WebSocket connected and handshake accepted!');
            ws.send(JSON.stringify({ type: 'session', token: token }));

            // Wait 2 seconds for server to processed session, then tap
            setTimeout(() => {
                console.log('3. Sending TEST TAP (c)...');
                ws.send('c');
            }, 2000);
        });

        ws.on('message', (data) => {
            const msg = data.toString();
            console.log('RECV:', msg.substring(0, 150));

            if (msg.includes('"type":"click"') || msg.includes('"type":"update"')) {
                console.log('✅ VERIFIED: Server accepted the tap and sent telemetry/balance update.');
                ws.close();
                process.exit(0);
            } else if (msg.includes('captcha_required')) {
                console.log('⚠️  INFO: Server requested CAPTCHA. This confirms tapping was attempted.');
                ws.close();
                process.exit(0);
            }
        });

        ws.on('error', (err) => {
            console.error('❌ ERROR:', err.message);
        });

        ws.on('close', (code, reason) => {
            console.log('Connection closed.', code, reason.toString());
            process.exit(code === 1000 ? 0 : 1);
        });

        setTimeout(() => {
            console.log('Test timed out after 20s');
            ws.close();
            process.exit(1);
        }, 20000);

    } catch (err) {
        console.error('❌ FATAL TEST ERROR:', err.message);
        process.exit(1);
    }
}

run();

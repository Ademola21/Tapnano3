const bridges = {};

async function startBridge({ sessionId, url, proxy, headers, sessionToken, cookies }) {
    if (bridges[sessionId]) {
        try { await bridges[sessionId].context.close(); } catch (e) { }
        delete bridges[sessionId];
    }

    if (!global.browser) {
        throw new Error("Browser not initialized yet");
    }

    console.log(`[SOLVER-WS] Creating browser context for ${sessionId}...`);
    const context = await global.browser.createBrowserContext({
        proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
    }).catch(err => {
        console.error(`[SOLVER-WS ERR] Failed to create context: ${err.message}`);
        throw err;
    });
    console.log(`[SOLVER-WS] Context created for ${sessionId}`);
    const page = await context.newPage().catch(err => {
        console.error(`[SOLVER-WS ERR] Failed to create page: ${err.message}`);
        throw err;
    });
    console.log(`[SOLVER-WS] Page created for ${sessionId}`);

    if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies).catch(err => console.error(`[SOLVER-WS ERR] Failed to set cookies: ${err.message}`));
    }

    if (proxy?.username && proxy?.password) {
        await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    if (headers) {
        await page.setExtraHTTPHeaders(headers);
    }

    const bridge = {
        sessionId,
        context,
        page,
        messages: [],
        listeners: [],
        status: 'connecting'
    };

    bridges[sessionId] = bridge;

    // Poller to retrieve events from the iframe
    const pollInterval = setInterval(async () => {
        if (!bridges[sessionId] || bridges[sessionId].status === 'closed') {
            clearInterval(pollInterval);
            return;
        }
        try {
            const events = await page.evaluate(() => {
                const ifr = document.getElementById('ws-bridge-iframe');
                if (!ifr || !ifr.contentWindow || !ifr.contentWindow._wsEvents) return [];
                const evts = ifr.contentWindow._wsEvents;
                ifr.contentWindow._wsEvents = [];
                return evts;
            });

            for (const ev of events) {
                if (ev.type === 'event') {
                    console.log(`[SOLVER-WS EVENT] ${sessionId} | Type: ${ev.eventType} | Data: ${ev.data}`);
                    const eventMsg = { type: 'event', eventType: ev.eventType, data: ev.data };
                    if (ev.eventType === 'open') bridge.status = 'open';
                    if (ev.eventType === 'close') bridge.status = 'closed';
                    bridge.messages.push(eventMsg);
                    bridge.listeners.forEach(wsClient => {
                        if (wsClient.readyState === 1) wsClient.send(JSON.stringify(eventMsg));
                    });
                } else if (ev.type === 'message') {
                    console.log(`[SOLVER-WS MSG] ${sessionId} | Data: ${ev.data}`);
                    const msgObj = { type: 'message', data: ev.data };
                    bridge.messages.push(msgObj);
                    bridge.listeners.forEach(wsClient => {
                        if (wsClient.readyState === 1) wsClient.send(JSON.stringify(msgObj));
                    });
                    if (bridge.messages.length > 100) bridge.messages.shift();
                }
            }
        } catch (e) {
            // Context might be destroyed, ignore
        }
    }, 100);

    bridge.pollInterval = pollInterval;

    page.on('requestfailed', request => {
        console.log(`[BROWSER-NET-FAIL] ${request.url()} | Error: ${request.failure().errorText}`);
    });

    page.on('response', response => {
        if (response.url().includes('api.thenanobutton')) {
            console.log(`[BROWSER-NET-RES] ${response.url()} | Status: ${response.status()}`);
        }
    });

    try {
        // Navigate to target site first to get correct origin/context
        console.log(`[SOLVER-WS] Navigating to ${url} for ${sessionId}`);
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
            console.log(`[SOLVER-WS] Page load timeout reached, proceeding to inject anyway...`);
        }
        console.log(`[SOLVER-WS] Injection starting for ${sessionId}`);

        // Inject WebSocket logic
        console.log(`[SOLVER-WS] Injecting WebSocket logic for ${sessionId}`);

        await page.evaluate((token) => {
            try {
                const iframe = document.createElement('iframe');
                iframe.id = 'ws-bridge-iframe';
                iframe.style.display = 'none';
                document.body.appendChild(iframe);

                const win = iframe.contentWindow;
                win._wsEvents = [];
                const CleanWebSocket = win.WebSocket;

                const pushEvent = (eventType, data) => win._wsEvents.push({ type: 'event', eventType: eventType, data: data });
                const pushMessage = (data) => win._wsEvents.push({ type: 'message', data: data });

                pushEvent('info', 'Evaluate block started');

                const wsUrl = `wss://api.thenanobutton.com/ws?token=${token}`;
                pushEvent('info', 'Creating WS to ' + wsUrl);

                const ws = new CleanWebSocket(wsUrl);
                win._bridgeWs = ws; // Store in iframe win for persistence

                ws.onopen = () => {
                    pushEvent('open', null);
                };
                ws.onmessage = (e) => {
                    pushMessage(e.data);
                };
                ws.onclose = () => {
                    pushEvent('close', null);
                };
                ws.onerror = (e) => {
                    pushEvent('error', 'WS Error Event');
                };
            } catch (e) {
                console.error("[JS] WS Init Error:", e.message);
            }
        }, sessionToken);

        console.log(`[SOLVER-WS] Bridge ${sessionId} fully initialized!`);
    } catch (err) {
        console.error(`[SOLVER-WS ERR] Failed during goto/eval: ${err.message}`);
        clearInterval(pollInterval);
        throw err;
    }
    return { success: true };
}

async function sendToBridge(sessionId, data) {
    const bridge = bridges[sessionId];
    if (!bridge) throw new Error("Bridge not found");
    await bridge.page.evaluate((d) => {
        const win = document.getElementById('ws-bridge-iframe')?.contentWindow;
        if (!win || !win._wsEvents) return;
        const pushEvt = (type, data) => win._wsEvents.push({ type: 'event', eventType: type, data: data });

        if (!win._bridgeWs) {
            pushEvt('error', 'SEND_FAIL_NO_WS');
            return;
        }
        if (win._bridgeWs.readyState !== 1) {
            pushEvt('error', 'SEND_FAIL_NOT_READY_' + win._bridgeWs.readyState);
            return;
        }
        try {
            win._bridgeWs.send(d);
            pushEvt('info', 'SEND_SUCCESS');
        } catch (err) {
            pushEvt('error', 'SEND_FAIL_EXC_' + err.message);
        }
    }, data);
    return { success: true };
}

// The WebSocket server setup is handled in index.js now.
// We just need a function to attach a new WS client to an existing bridge session
function attachClientToBridge(sessionId, wsClient) {
    const bridge = bridges[sessionId];
    if (!bridge) {
        wsClient.close(1008, "Bridge not found");
        return;
    }

    bridge.listeners.push(wsClient);

    // Immediately tell the client the current status
    if (bridge.status === 'open') {
        wsClient.send(JSON.stringify({ type: 'event', eventType: 'open', data: null }));
    } else if (bridge.status === 'closed') {
        wsClient.send(JSON.stringify({ type: 'event', eventType: 'close', data: null }));
    } else {
        wsClient.send(JSON.stringify({ type: 'event', eventType: 'stream_connected', data: null }));
    }

    // Replay historical messages
    bridge.messages.forEach(msg => {
        if (wsClient.readyState === 1) {
            wsClient.send(JSON.stringify(msg));
        }
    });

    wsClient.on('message', async (message) => {
        try {
            const data = message.toString();
            try {
                const cmd = JSON.parse(data);
                if (cmd.type === 'req_http') {
                    console.log(`[SOLVER-WS] Client requested HTTP forward for sessionId ${sessionId} | URL: ${cmd.url}`);
                    const result = await forwardHttpFromBridge(sessionId, cmd);
                    console.log(`[SOLVER-WS] HTTP forward result for ${sessionId}: status=${result.status} error=${result.error}`);
                    wsClient.send(JSON.stringify({ type: 'resp_http', id: cmd.id, result }));
                    return;
                }
            } catch (e) { }

            await sendToBridge(sessionId, data);
        } catch (e) {
            console.error(`[BRIDGE ERR] Failed to proxy client message to browser: ${e.message}`);
        }
    });

    wsClient.on('close', () => {
        bridge.listeners = bridge.listeners.filter(client => client !== wsClient);
    });
}

function getBridgeStream(sessionId, req, res) {
    res.status(400).send("Stream endpoint deprecated. Use WebSocket /ws-bridge/connect/:sessionId");
}

async function stopBridge(sessionId) {
    const bridge = bridges[sessionId];
    if (bridge) {
        try { await bridge.context.close(); } catch (e) { }
        delete bridges[sessionId];
    }
    return { success: true };
}

async function forwardHttpFromBridge(sessionId, cmd) {
    const bridge = bridges[sessionId];
    if (!bridge) return { error: "Bridge not found" };
    return await bridge.page.evaluate(async (c) => {
        try {
            const options = {
                method: c.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...c.headers
                }
            };
            if (c.method === 'POST' && c.body) {
                options.body = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
            }
            const res = await fetch(c.url, options);
            let data;
            const text = await res.text();
            try { data = JSON.parse(text); } catch (e) { data = text; }
            return { status: res.status, data };
        } catch (err) {
            return { error: err.message };
        }
    }, cmd);
}

module.exports = { startBridge, sendToBridge, getBridgeStream, stopBridge, attachClientToBridge, bridges };

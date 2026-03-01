const express = require('express')
const app = express()
const server = require('http').createServer(app)
const expressWs = require('express-ws')(app, server);
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const cookieParser = require('cookie-parser');
const reqValidate = require('./module/reqValidate')

process.on('uncaughtException', (err) => {
    console.error(`[SOLVER FATAL] Uncaught Exception: ${err.message}`);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[SOLVER FATAL] Unhandled Rejection at:`, promise, `reason:`, reason);
});

global.browserLength = 0
global.browserLimit = Number(process.env.browserLimit) || 20
global.timeOut = Number(process.env.timeOut || 120000)

app.use(bodyParser.json({}))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())
if (process.env.NODE_ENV !== 'development') {
    server.listen(port, () => {
        console.log(`Server running on port ${port}`)
    })
    try {
        server.timeout = global.timeOut
    } catch (e) { }
}
if (process.env.SKIP_LAUNCH != 'true') require('./module/createBrowser')

const getSource = require('./endpoints/getSource')
const solveTurnstileMin = require('./endpoints/solveTurnstile.min')
const solveTurnstileMax = require('./endpoints/solveTurnstile.max')
const wafSession = require('./endpoints/wafSession')
const wsBridge = require('./endpoints/wsBridge')


app.post('/cf-clearance-scraper', async (req, res) => {

    const data = req.body

    const check = reqValidate(data)

    if (check !== true) return res.status(400).json({ code: 400, message: 'Bad Request', schema: check })

    if (authToken && data.authToken !== authToken) return res.status(401).json({ code: 401, message: 'Unauthorized' })

    if (global.browserLength >= global.browserLimit) return res.status(429).json({ code: 429, message: 'Too Many Requests' })

    if (process.env.SKIP_LAUNCH != 'true' && !global.browser) return res.status(500).json({ code: 500, message: 'The scanner is not ready yet. Please try again a little later.' })

    var result = { code: 500 }

    global.browserLength++

    switch (data.mode) {
        case "source":
            result = await getSource(data).then(res => {
                console.log(`[SOLVER] Source mode success. Cookies: ${res.cookies?.length || 0}, localStorage keys: ${Object.keys(res.localStorage || {}).length}`);
                return { source: res.source, cookies: res.cookies, localStorage: res.localStorage, code: 200 }
            }).catch(err => {
                console.error(`[SOLVER ERR] Source mode failed: ${err.message}`);
                return { code: 500, message: err.message }
            })
            break;
        case "turnstile-min":
            result = await solveTurnstileMin(data).then(res => { return { token: res, code: 200 } }).catch(err => { return { code: 500, message: err.message } })
            break;
        case "turnstile-max":
            result = await solveTurnstileMax(data).then(res => { return { token: res.token, cf_clearance: res.cf_clearance, cookies: res.cookies, code: 200 } }).catch(err => { return { code: 500, message: err.message } })
            break;
        case "waf-session":
            result = await wafSession(data).then(res => { return { ...res, code: 200 } }).catch(err => { return { code: 500, message: err.message } })
            break;
    }

    global.browserLength--

    res.status(result.code ?? 500).send(result)
})

app.post('/ws-bridge/start', async (req, res) => {
    try {
        const result = await wsBridge.startBridge(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.ws('/ws-bridge/connect/:sessionId', (ws, req) => {
    wsBridge.attachClientToBridge(req.params.sessionId, ws);
});

app.post('/ws-bridge/send/:sessionId', async (req, res) => {
    try {
        const result = await wsBridge.sendToBridge(req.params.sessionId, req.body.data);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/ws-bridge/stop/:sessionId', async (req, res) => {
    try {
        const result = await wsBridge.stopBridge(req.params.sessionId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.use((req, res) => { res.status(404).json({ code: 404, message: 'Not Found' }) })

if (process.env.NODE_ENV == 'development') module.exports = app

process.env.NODE_ENV = 'development'
const server = require('../src/index')
const request = require("supertest")

beforeAll(async () => {
    while (!global.browser) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}, 30000);


afterAll(async () => {
    global.finished = true
    await global.browser.close()
})


test('Scraping Page Source from Cloudflare Protection', async () => {
    return request(server)
        .post("/cf-clearance-scraper")
        .send({
            url: 'https://nopecha.com/demo/cloudflare',
            mode: "source"
        })
        .expect(200)
        .then(response => { expect(response.body.code).toEqual(200); })
}, 60000)


test('Creating a Turnstile Token With Site Key [min]', async () => {
    return request(server)
        .post("/cf-clearance-scraper")
        .send({
            url: 'https://turnstile.zeroclover.io/',
            siteKey: "0x4AAAAAAAEwzhD6pyKkgXC0",
            mode: "turnstile-min"
        })
        .expect(200)
        .then(response => { expect(response.body.code).toEqual(200); })
}, 60000)

test('Creating a Turnstile Token With Site Key [max]', async () => {
    return request(server)
        .post("/cf-clearance-scraper")
        .send({
            url: 'https://turnstile.zeroclover.io/',
            mode: "turnstile-max"
        })
        .expect(200)
        .then(response => { expect(response.body.code).toEqual(200); })
}, 60000)

test('Create Cloudflare WAF Session', async () => {
    return request(server)
        .post("/cf-clearance-scraper")
        .send({
            url: 'https://nopecha.com/demo/cloudflare',
            mode: "waf-session"
        })
        .expect(200)
        .then(response => { expect(response.body.code).toEqual(200); })
}, 60000)
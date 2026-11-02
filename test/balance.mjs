import assert from 'node:assert/strict'
import { applyBalance } from '../balance-host.js'

const originalFetch = globalThis.fetch
const originalLog = console.error
const calls = []
const start = Date.now()
const secretEmail = 'balance-test@example.invalid'
const secretPassword = 'do-not-return-this-password'
const accessToken = 'mock-access-token-never-return'

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, async json() { return body } }
}

globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options })
  if (String(url).endsWith('/api/v1/auth/login')) {
    return response(200, { code: 0, data: { access_token: accessToken } })
  }
  const path = new URL(String(url)).pathname
  if (path.endsWith('/usage/dashboard/trend')) {
    return response(200, { code: 0, data: { trend: [
      { date: new Date(start - 25 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' '), actual_cost: 99, requests: 1, total_tokens: 100 },
      { date: new Date(start - 2 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' '), actual_cost: 2, requests: 3, total_tokens: 300 },
    ] } })
  }
  if (path.endsWith('/usage')) {
    return response(200, { code: 0, data: { items: [
      { created_at: new Date(start - 25 * 60 * 60 * 1000).toISOString(), model: 'old-model', input_tokens: 1, actual_cost: 99 },
      { created_at: new Date(start - 23 * 60 * 60 * 1000).toISOString(), model: 'today-model', input_tokens: 10, output_tokens: 20, actual_cost: 1.25 },
      { created_at: new Date(start - 26 * 60 * 60 * 1000).toISOString(), model: 'future-model', input_tokens: 1, actual_cost: 50 },
    ] } })
  }
  if (path.endsWith('/keys')) return response(200, { code: 0, data: { items: [{ name: 'key-label', group: { name: 'group-label' }, key: 'must-not-return' }] } })
  return response(200, { code: 0, data: { balance: 12.5, frozen_balance: 1, total_recharged: 50, email: secretEmail, username: 'test-user' } })
}
console.error = () => {}

try {
  const routes = new Map()
  const fake = {
    credentials: { async resolve(ref) { return { value: ref === 'COLINK_PANEL_EMAIL' ? secretEmail : secretPassword } } },
    webServer: { getOrigin: () => 'http://127.0.0.1', register(def) { routes.set(def.path, def); return () => routes.delete(def.path) } },
    connection: { requestRejection(req) { return req.headers.authorization === 'denied' ? 401 : undefined } },
    effect(factory) { return factory() },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['credentials', 'webServer', 'connection'])
      callback(fake)
    },
  }
  applyBalance(ctx)
  assert.ok(routes.has('/plugins/balance/colink'))
  assert.ok(routes.has('/plugins/balance/colink/panel'))

  async function request(path, headers = {}) {
    const definition = routes.get(path.split('?')[0])
    const captured = { status: 0, headers: {}, body: '' }
    const req = { method: 'GET', headers, url: path }
    const res = { writeHead(status, responseHeaders = {}) { captured.status = status; captured.headers = responseHeaders }, end(body = '') { captured.body = String(body) } }
    await definition.handler(req, res)
    return { ...captured, json: captured.body ? JSON.parse(captured.body) : null }
  }

  const denyFake = {
    credentials: { async resolve() { throw new Error('denied route must not resolve credentials') } },
    webServer: fake.webServer,
    connection: { requestRejection() { return 401 } },
    effect(factory) { return factory() },
  }
  const denyRoutes = new Map()
  applyBalance({ inject(_names, callback) { callback({ ...denyFake, webServer: { ...fake.webServer, register(def) { denyRoutes.set(def.path, def); return () => denyRoutes.delete(def.path) } } }) } })
  const deniedRes = { status: 0, body: '', writeHead(status) { this.status = status }, end(body = '') { this.body = String(body) } }
  await denyRoutes.get('/plugins/balance/colink').handler({ method: 'GET', headers: {} }, deniedRes)
  assert.equal(deniedRes.status, 401)
  assert.deepEqual(JSON.parse(deniedRes.body), { status: 'failed' })

  const balance = await request('/plugins/balance/colink')
  assert.equal(balance.status, 200)
  assert.equal(balance.json.balance, 12.5)
  const before = calls.length
  const refreshed = await request('/plugins/balance/colink/panel?refresh=1')
  assert.equal(refreshed.status, 200)
  assert.ok(calls.length > before, 'refresh=1 must bypass the panel cache and re-read upstream')
  const panel = await request('/plugins/balance/colink/panel')
  assert.equal(panel.status, 200)
  assert.equal(panel.json.windowHours, 24)
  assert.deepEqual(panel.json.window, { cost: 1.25, requests: 1, tokens: 30 })
  assert.equal(panel.json.models.length, 1)
  assert.equal(panel.json.models[0].model, 'today-model')
  assert.equal(panel.json.hourly.reduce((sum, hour) => sum + hour.cost, 0), 2)
  assert.ok(panel.json.records.every((row) => row.model === 'today-model'))

  const serialized = JSON.stringify({ balance: balance.json, panel: panel.json })
  for (const secret of [secretEmail, secretPassword, accessToken, 'must-not-return']) assert.ok(!serialized.includes(secret), `response must not contain ${secret}`)
  assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/auth/login')).length, 1, 'shared token should avoid a second login')
  assert.ok(calls.filter((call) => !call.url.endsWith('/auth/login')).every((call) => call.options.headers?.authorization === `Bearer ${accessToken}`))
  console.log('PASS routes are authenticated and return no credentials or API keys')
  console.log('PASS panel spend includes only the rolling last 24 hours')
} finally {
  globalThis.fetch = originalFetch
  console.error = originalLog
}

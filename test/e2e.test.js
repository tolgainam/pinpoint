/**
 * The extension in a real Chromium, against the demo page and a stub bridge that records
 * what it is sent: the whole path from a click on an element to the POST the bridge gets.
 *
 * The unit tests cover each piece. This is the one that notices when the pieces stop
 * fitting: a manifest that no longer injects, a toolbar that never mounts, a Dispatch
 * that sends nothing.
 *
 * Skips, saying why, when Playwright's Chromium is not installed.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { available, listen, startDemo, extensionCopy } from './screens/shoot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = { name: 'nimbus', projectDir: '/Users/dev/nimbus' }

const browser = await available()
if (!browser.ok) console.log(`e2e skipped: ${browser.why}`)

/** A bridge that answers /health as one running session and keeps every dispatch it gets. */
function recordingBridge(version) {
  const dispatched = []
  /** A bridge started with PINPOINT_TOKEN asks every POST for it. Empty means it does not. */
  const state = { token: '' }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/health') {
      return json(200, {
        ok: true, version, projectDir: PROJECT.projectDir, pending: 0, backlog: 0, sessions: [PROJECT],
        route: { how: 'auto', projectDir: PROJECT.projectDir, detected: PROJECT.projectDir, detectedName: PROJECT.name },
      })
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      return res.write(': stub\n\n')
    }
    if (url.pathname === '/design-system') return json(200, { ok: true, detected: false })
    if (url.pathname === '/dispatch' && req.method === 'POST') {
      if (state.token && req.headers['x-pinpoint-token'] !== state.token) return json(401, { ok: false })
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        dispatched.push(JSON.parse(body))
        json(200, { ok: true, batch: 'e2e-0001', count: dispatched.at(-1).comments.length, projectDir: PROJECT.projectDir, name: PROJECT.name })
      })
      return
    }
    json(404, { ok: false })
  })
  server.keepAliveTimeout = 0
  return { server, dispatched, state }
}

let context, page, worker, demo, bridge, profile, ext, bridgeServer

before(async () => {
  if (!browser.ok) return
  const { version } = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  bridge = recordingBridge(version)
  bridgeServer = bridge.server
  const bridgePort = await listen(bridgeServer)
  demo = await startDemo()
  ext = await extensionCopy(bridgePort)
  profile = await mkdtemp(join(tmpdir(), 'pinpoint-e2e-'))
  context = await browser.chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  page = context.pages()[0] ?? await context.newPage()

  // A first install opens the welcome tab and makes it the active one, which is where the
  // icon click below would land. Close it so the demo tab is the one that hears it.
  const welcome = `chrome-extension://${new URL(worker.url()).host}/welcome.html`
  const isWelcome = p => p.url().startsWith(welcome)
  const opened = context.pages().find(isWelcome)
    ?? await context.waitForEvent('page', { predicate: isWelcome, timeout: 10000 }).catch(() => null)
  await opened?.close()
}, { timeout: 60000 })

after(async () => {
  await context?.close().catch(() => {})
  bridgeServer?.close()
  demo?.stop()
  for (const dir of [profile, ext]) if (dir) await rm(dir, { recursive: true, force: true })
})

const host = sel => page.locator(`#pinpoint-host ${sel}`)

/** The icon click, as the worker hears it: a toggle message to the active tab. */
const iconClick = () => worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
})

test('the toolbar mounts hidden, the icon shows it, and the pill names the project', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await iconClick()
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
})

test('a comment on an element is dispatched with its selector, note and page', { skip: !browser.ok, timeout: 60000 }, async () => {
  await host('.mode').click()
  const target = await page.locator('[data-testid="cta-primary"]').boundingBox()
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
  await host('.card textarea').fill('make this button larger')
  await host('.card button.primary').click()
  await host('button.primary', { hasText: 'Dispatch' }).first().click()

  const until = Date.now() + 10000
  while (!bridge.dispatched.length && Date.now() < until) await new Promise(r => setTimeout(r, 50))
  assert.equal(bridge.dispatched.length, 1, 'the bridge got no dispatch')

  const [batch] = bridge.dispatched
  assert.equal(batch.page, `http://localhost:${demo.port}`)
  assert.equal(batch.comments.length, 1)
  assert.equal(batch.comments[0].note, 'make this button larger')
  assert.match(batch.comments[0].selector, /cta-primary/)
})

test('a pin survives a reload', { skip: !browser.ok, timeout: 60000 }, async () => {
  // Saving is debounced, so wait for the page's key to reach storage before reloading it.
  const key = `pinpoint:http://localhost:${demo.port}/`
  const until = Date.now() + 5000
  while (Date.now() < until && !(await worker.evaluate(async k => (await chrome.storage.local.get(k))[k], key))) {
    await new Promise(r => setTimeout(r, 50))
  }
  await page.reload()
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await iconClick()
  await host('.pin').first().waitFor({ timeout: 15000 })
})

test('the saved bridge token is sent, and a bridge that wants one says so', { skip: !browser.ok, timeout: 60000 }, async () => {
  const welcome = await context.newPage()
  await welcome.goto(`chrome-extension://${new URL(worker.url()).host}/welcome.html`)
  const dispatch = () => welcome.evaluate(() => chrome.runtime.sendMessage({
    type: 'dispatch', payload: { page: 'http://localhost', comments: [] },
  }))
  try {
    bridge.state.token = 's3cret'
    const refused = await dispatch()
    assert.equal(refused.ok, false)
    assert.match(refused.error, /PINPOINT_TOKEN/)

    await welcome.locator('#token').fill('s3cret')
    await welcome.locator('#token-save').click()
    await welcome.locator('#token-state').filter({ hasText: 'Saved' }).waitFor()
    assert.equal((await dispatch()).ok, true)
  } finally {
    bridge.state.token = ''
    await welcome.close()
  }
})

test('screenshots asked for at once are queued, so Chrome\'s per-second quota is not hit', { skip: !browser.ok, timeout: 60000 }, async () => {
  // Stand in for Chrome's limit: a second call within 400ms of the last one throws the
  // real quota error. The headless test browser has no activeTab, so the real call is
  // replaced in the worker for this test only.
  await worker.evaluate(() => {
    globalThis.__calls = []
    chrome.tabs.captureVisibleTab = async () => {
      const now = Date.now()
      const last = globalThis.__calls.at(-1)
      globalThis.__calls.push(now)
      if (last && now - last < 400) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')
      return 'data:image/png;base64,AAAA'
    }
  })
  const welcome = await context.newPage()
  await welcome.goto(`chrome-extension://${new URL(worker.url()).host}/welcome.html`)
  try {
    const results = await welcome.evaluate(() => Promise.all([1, 2, 3, 4].map(() => chrome.runtime.sendMessage({ type: 'capture' }))))
    assert.deepEqual(results.map(r => r.ok), [true, true, true, true], JSON.stringify(results))
  } finally {
    await welcome.close()
  }
})

test('the welcome page offers lasting screenshot access and starts with it off', { skip: !browser.ok, timeout: 60000 }, async () => {
  const welcome = await context.newPage()
  await welcome.goto(`chrome-extension://${new URL(worker.url()).host}/welcome.html`)
  try {
    await welcome.locator('#shots-allow').filter({ hasText: 'Allow screenshots without clicking' }).waitFor()
    assert.equal(await welcome.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), false)
  } finally {
    await welcome.close()
  }
})

test('a page left open across an extension reload says so, instead of throwing', { skip: !browser.ok, timeout: 60000 }, async () => {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await iconClick()
  await host('.bar').waitFor({ timeout: 15000 })

  // The worker goes away and comes back as a new copy; this page keeps the old script.
  await worker.evaluate(() => chrome.runtime.reload())
  await host('.toast.show').filter({ hasText: 'Reload this page' }).waitFor({ timeout: 15000 })
  assert.deepEqual(errors.filter(e => /context invalidated/i.test(e)), [])
})

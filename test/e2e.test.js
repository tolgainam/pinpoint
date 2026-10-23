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
  /** What the extension said about itself on each call: its version header and its origin. */
  const identities = []
  const streams = new Set()
  let seq = 0
  /** Claude's side: an event on the stream the extension is listening to. */
  const emit = event => {
    const frame = `data: ${JSON.stringify({ seq: ++seq, projectDir: PROJECT.projectDir, ...event })}\n\n`
    for (const res of streams) res.write(frame)
  }
  /** A bridge started with PINPOINT_TOKEN asks every POST for it. Empty means it does not. */
  const state = { token: '' }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    identities.push({ path: url.pathname, version: req.headers['x-pinpoint-extension'], origin: req.headers.origin })
    const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/health') {
      return json(200, {
        ok: true, version, projectDir: PROJECT.projectDir, pending: 0, backlog: 0, sessions: [PROJECT],
        route: { how: 'auto', projectDir: PROJECT.projectDir, detected: PROJECT.projectDir, detectedName: PROJECT.name },
      })
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(': stub\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === '/design-system') return json(200, { ok: true, detected: false })
    if (url.pathname === '/dispatch' && req.method === 'POST') {
      if (state.token && req.headers['x-pinpoint-token'] !== state.token) return json(401, { ok: false })
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        dispatched.push(JSON.parse(body))
        json(200, { ok: true, batch: `e2e-000${dispatched.length}`, count: dispatched.at(-1).comments.length, projectDir: PROJECT.projectDir, name: PROJECT.name })
      })
      return
    }
    json(404, { ok: false })
  })
  server.keepAliveTimeout = 0
  return { server, dispatched, state, emit, identities }
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
  // The toolbar was open before the reload, so it is open after it: no icon click.
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.pin').first().waitFor({ timeout: 15000 })
})

test('the toolbar stays open through reloads until it is closed, and a closed one stays closed', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.reload()
  await host('.bar').waitFor({ timeout: 15000 })
  // Closed with the cross: a reload does not bring it back.
  await host('.bar > button').last().click()
  await host('.bar').waitFor({ state: 'hidden', timeout: 5000 })
  await page.reload()
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await page.waitForTimeout(800)
  assert.equal(await host('.bar').isVisible(), false)
  // The icon opens it again, and that is remembered too.
  await iconClick()
  await host('.bar').waitFor({ timeout: 15000 })
  await page.reload()
  await host('.bar').waitFor({ timeout: 15000 })
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

test('the composer stays on screen for an element at the bottom of the page', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ timeout: 15000 })
  // A short window puts the button near the bottom edge, with no room for the card below it.
  await page.setViewportSize({ width: 1280, height: 560 })
  await page.waitForTimeout(200)
  await host('.mode').click()
  const box = await page.locator('[data-testid="cta-secondary"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await host('.card textarea').waitFor()
  await page.waitForTimeout(300)

  const { width, height } = page.viewportSize()
  const card = await host('.card').boundingBox()
  const add = await host('.card button.primary').boundingBox()
  assert.ok(card.y >= 0 && card.y + card.height <= height, `the card runs off the screen: ${JSON.stringify(card)}`)
  assert.ok(add.y >= 0 && add.y + add.height <= height, `the Add button is out of reach: ${JSON.stringify(add)}`)
  assert.ok(card.x >= 0 && card.x + card.width <= width)
  // Above the button, not on top of it, because there was no room below.
  assert.ok(card.y + card.height <= box.y + 1, `the card covers the element it is about: card ${JSON.stringify(card)} element ${JSON.stringify(box)}`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('an answer is shown on the pin without hunting for it, and "resolved" does not hide it', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.evaluate(() => window.scrollTo(0, 0))
  await host('.mode').click()
  const box = await page.locator('[data-testid="cta-secondary"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await host('.card textarea').fill('? why is this grey')
  await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
  await host('.card button.primary').click()
  await page.keyboard.press('Escape')
  await host('button.primary', { hasText: 'Dispatch' }).first().click()
  await page.waitForFunction(() => true)
  const until = Date.now() + 8000
  while (Date.now() < until && !(bridge.dispatched.at(-1)?.comments?.[0]?.question)) await new Promise(r => setTimeout(r, 50))
  assert.ok(bridge.dispatched.at(-1)?.comments?.[0]?.question, 'the question was not dispatched')
  const batch = `e2e-000${bridge.dispatched.length}`
  await page.waitForTimeout(500)

  bridge.emit({ type: 'reply', id: `${batch}#1`, text: 'It is the secondary button style.' })
  await host('.card .answer').filter({ hasText: 'secondary button style' }).waitFor({ timeout: 8000 })

  // Claude usually resolves a question right after answering. The answer must stay.
  bridge.emit({ type: 'resolved', id: `${batch}#1`, resolution: '' })
  await page.waitForTimeout(700)
  assert.equal(await host('.card .answer').filter({ hasText: 'secondary button style' }).count(), 1)
  assert.equal(await host('.toast.show').filter({ hasText: 'resolved' }).count(), 0)
  await page.keyboard.press('Escape')
})

test('inspecting pauses over the toolbar, so no highlight hangs over the buttons', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.mode').click()
  const shown = () => page.evaluate(() => {
    const hl = document.getElementById('pinpoint-host').shadowRoot.querySelector('.highlight')
    return !!hl && getComputedStyle(hl).display !== 'none'
  })
  // Hovering the page highlights an element...
  const hero = await page.locator('[data-testid="hero-title"]').boundingBox()
  await page.mouse.move(hero.x + 20, hero.y + 10)
  await page.mouse.move(hero.x + 40, hero.y + 12)
  await page.waitForTimeout(200)
  assert.equal(await shown(), true, 'nothing was highlighted on the page')
  // ...and moving onto the toolbar puts the highlight away.
  const send = await host('button.primary').first().boundingBox()
  await page.mouse.move(send.x + send.width / 2, send.y + send.height / 2, { steps: 6 })
  await page.waitForTimeout(200)
  assert.equal(await shown(), false, 'the highlight is still up over the toolbar')
  // Back on the page it comes back.
  await page.mouse.move(hero.x + 20, hero.y + 10, { steps: 6 })
  await page.waitForTimeout(200)
  assert.equal(await shown(), true, 'inspecting did not resume on the page')
  await page.keyboard.press('Escape')
})

test('only a leading ? makes a question; the other question marks stay in the text', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.evaluate(() => window.scrollTo(0, 0))
  /** Write a note on an element, dispatch it, and return what the bridge received. */
  async function sent(selector, note) {
    const before = bridge.dispatched.length
    await host('.mode').click()
    const box = await page.locator(selector).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await host('.card textarea').fill(note)
    await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
    await host('.card button.primary').click()
    await page.keyboard.press('Escape')
    await host('button.primary', { hasText: 'Dispatch' }).first().click()
    const until = Date.now() + 8000
    while (bridge.dispatched.length === before && Date.now() < until) await new Promise(r => setTimeout(r, 50))
    assert.ok(bridge.dispatched.length > before, `nothing was dispatched for: ${note}`)
    await page.waitForTimeout(300)
    return bridge.dispatched.at(-1).comments[0]
  }

  // The first character decides. The rest, question marks included, is just the question.
  const asked = await sent('[data-testid="hero-sub"]', '? What about the changes we did ? And the color of the button ?')
  assert.equal(asked.question, true)
  assert.equal(asked.note, 'What about the changes we did ? And the color of the button ?')

  const doubled = await sent('[data-testid="hero-title"]', '?? why is this big?')
  assert.equal(doubled.question, true)
  assert.equal(doubled.note, '? why is this big?')

  // A question mark anywhere but the start changes nothing: it is an ordinary request.
  const plain = await sent('[data-testid="cta-primary"]', 'Can this button be larger? And the colour too?')
  assert.notEqual(plain.question, true)
  assert.equal(plain.note, 'Can this button be larger? And the colour too?')
})

test('a marker at the start changes the composer at once, with or without a space after it', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.evaluate(() => window.scrollTo(0, 0))
  await host('.mode').click()
  const box = await page.locator('[data-testid="hero-sub"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const area = host('.card textarea')
  const card = host('.card')
  await area.waitFor()
  await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
  const add = host('.card button.primary')
  const kind = () => card.getAttribute('data-kind')

  // Nothing special yet: a plain note, and a line that says what the markers do.
  assert.equal(await kind(), '')
  assert.match(await host('.card .intent').innerText(), /asks a question.*adds to the backlog/)

  // The marker alone already switches the mode, and asks for something after it.
  await area.fill('?')
  assert.equal(await kind(), 'question')
  assert.match(await host('.card .intent').innerText(), /You are asking a question/)
  assert.equal((await add.innerText()).trim(), 'Ask')
  assert.equal(await add.isDisabled(), true, 'a bare ? should not be sendable')

  // No space needed.
  await area.fill('?why is this grey')
  assert.equal(await kind(), 'question')
  assert.equal(await add.isDisabled(), false)

  await area.fill('!')
  assert.equal(await kind(), 'backlog')
  assert.match(await host('.card .intent').innerText(), /You are adding to the backlog/)
  assert.equal((await add.innerText()).trim(), 'Backlog')
  assert.equal(await add.isDisabled(), true)

  await area.fill('!tidy this up later')
  assert.equal(await kind(), 'backlog')
  assert.equal(await add.isDisabled(), false)

  // Only the start counts.
  await area.fill('why is this grey?')
  assert.equal(await kind(), '')

  // And it travels as a question, without the marker.
  await area.fill('?why is this grey')
  const before = bridge.dispatched.length
  await add.click()
  await page.keyboard.press('Escape')
  await host('button.primary', { hasText: 'Dispatch' }).first().click()
  const until = Date.now() + 8000
  while (bridge.dispatched.length === before && Date.now() < until) await new Promise(r => setTimeout(r, 50))
  const sent = bridge.dispatched.at(-1).comments[0]
  assert.equal(sent.question, true)
  assert.equal(sent.note, 'why is this grey')
})

test('an answer goes to the tab that asked, not to another copy of the same page', { skip: !browser.ok, timeout: 90000 }, async () => {
  const url = `http://localhost:${demo.port}/`
  await page.goto(url)
  await host('.bar').waitFor({ timeout: 15000 })

  // A second copy of the page, with its own toolbar, in another tab.
  const other = await context.newPage()
  await other.goto(url)
  await other.bringToFront()
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
  })
  await other.locator('#pinpoint-host .bar').waitFor({ timeout: 15000 })
  await page.bringToFront()

  // Ask from the first tab.
  await host('.mode').click()
  const box = await page.locator('[data-testid="cta-secondary"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await host('.card textarea').fill('? which tab asked')
  await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
  await host('.card button.primary').click()
  await page.keyboard.press('Escape')
  const before = bridge.dispatched.length
  await host('button.primary', { hasText: 'Dispatch' }).first().click()
  const until = Date.now() + 8000
  while (bridge.dispatched.length === before && Date.now() < until) await new Promise(r => setTimeout(r, 50))
  const sentBatch = bridge.dispatched.at(-1)
  assert.ok(Number.isInteger(sentBatch.source?.tabId), 'the dispatch did not name its tab')
  await page.waitForTimeout(500)

  // Claude answers; the bridge aims the event at the tab that sent the comment, as the real one does.
  bridge.emit({
    type: 'reply', id: `e2e-000${bridge.dispatched.length}#1`, text: 'Only the asking tab should show this.',
    target: sentBatch.source,
  })
  await host('.card .answer').filter({ hasText: 'Only the asking tab' }).waitFor({ timeout: 8000 })

  await other.waitForTimeout(800)
  const seenThere = await other.locator('#pinpoint-host .answer, #pinpoint-host .toast.show').filter({ hasText: 'Only the asking tab' }).count()
  assert.equal(seenThere, 0, 'the other copy of the page showed an answer meant for the first tab')
  await other.close()
  await page.keyboard.press('Escape')
})

test('the extension tells the bridge its version on every call', { skip: !browser.ok, timeout: 60000 }, async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
  const health = bridge.identities.filter(i => i.path === '/health')
  assert.ok(health.length, 'the bridge was never asked for its health')
  assert.ok(health.every(i => i.version === version), `a call carried no version: ${JSON.stringify(health.slice(-2))}`)
  // The worker's own GET calls carry no Origin; none may carry a page's.
  assert.ok(health.every(i => !i.origin || /^chrome-extension:\/\//.test(i.origin)), `a call carried a page origin: ${JSON.stringify(health.slice(-2))}`)
})

test('a capture waits for its turn before the overlay hides', { skip: !browser.ok, timeout: 60000 }, async () => {
  const welcome = await context.newPage()
  await welcome.goto(`chrome-extension://${new URL(worker.url()).host}/welcome.html`)
  try {
    const res = await welcome.evaluate(() => chrome.runtime.sendMessage({ type: 'capture-wait' }))
    assert.equal(res.ok, true)
  } finally {
    await welcome.close()
  }
})

test('a page left open across an extension reload says so, instead of throwing', { skip: !browser.ok, timeout: 60000 }, async () => {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ timeout: 15000 })

  // The worker goes away and comes back as a new copy; this page keeps the old script.
  await worker.evaluate(() => chrome.runtime.reload())
  await host('.toast.show').filter({ hasText: 'Reload this page' }).waitFor({ timeout: 15000 })
  assert.deepEqual(errors.filter(e => /context invalidated/i.test(e)), [])
})

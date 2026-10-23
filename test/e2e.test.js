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
  /** Every /design-system body, so a refresh can be told from an ordinary ask. */
  const designAsks = []
  /** What the extension said about itself on each call: its version header and its origin. */
  const identities = []
  const streams = new Set()
  let seq = 0
  /** Claude's side: an event on the stream the extension is listening to. */
  const emit = event => {
    const frame = `data: ${JSON.stringify({ seq: ++seq, projectDir: PROJECT.projectDir, ...event })}\n\n`
    for (const res of streams) res.write(frame)
  }
  /**
   * A bridge started with PINPOINT_TOKEN asks every POST for it. Empty means it does not.
   * `scope` false answers /health like a bridge from before comment-scope-v1.
   */
  const state = { token: '', palette: null, scope: true }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    identities.push({ path: url.pathname, version: req.headers['x-pinpoint-extension'], origin: req.headers.origin })
    const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/health') {
      return json(200, {
        ok: true, version, projectDir: PROJECT.projectDir, pending: 0, backlog: 0, sessions: [PROJECT],
        route: { how: 'auto', projectDir: PROJECT.projectDir, detected: PROJECT.projectDir, detectedName: PROJECT.name },
        ...(state.scope ? { capabilities: { 'comment-scope-v1': true } } : {}),
      })
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(': stub\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === '/design-system') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        let asked = {}
        try { asked = JSON.parse(body || '{}') } catch { /* recorded as empty */ }
        designAsks.push(asked)
        // The Apply to tests need a palette to pick from; everything before them sees none.
        const scales = state.palette ? { detected: true, step: 4, color: state.palette, spacing: [], type: [], radius: [] } : { detected: false }
        json(200, { ok: true, stale: false, ...scales, ...(asked.refresh ? { refreshed: true } : {}) })
      })
      return
    }
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
  return { server, dispatched, designAsks, state, emit, identities }
}

/** Named colours only: the picks and the page never need a raw value. */
const PALETTE = [
  { name: '--accent', hex: 'rebeccapurple', value: 'rebeccapurple' },
  { name: '--ink', hex: 'navy', value: 'navy' },
]

/** The cards page. */
function cardsPage(q) {
  const many = Math.min(Number(q.get('many')) || 0, 1000)
  const react = q.get('react')
  const slow = q.get('slow') === '1'
  const card = (n, cls) => `<article class="card"><h3 class="${cls}" data-n="${n}">Card ${n}</h3><p>Body ${n}</p></article>`
  const plain = n => Array.from({ length: n }, (_, i) => `<h3 data-plain="${i + 1}">Plain ${i + 1}</h3>`).join('')
  const owners = react ? `
    const type = ${react === 'min' ? "{ displayName: 't' }" : 'function CardTitle() {}'}
    const fiber = { _debugOwner: { type } }
    for (const n of document.querySelectorAll('.card h3, .promo h3')) n.__reactFiber$pp = fiber
  ` : ''
  const held = slow ? `
    const post = window.postMessage.bind(window)
    window.postMessage = function (msg, ...rest) {
      if (msg && msg.tag === 'pinpoint:probe' && msg.dir === 'res' && msg.group) { setTimeout(() => post(msg, ...rest), 600); return }
      return post(msg, ...rest)
    }
  ` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cards</title><style>
    body { font-family: sans-serif; color: black; margin: 0; padding: 16px }
    .grid { display: flex; gap: 8px }
    .card { border: 1px solid silver; padding: 8px; width: 200px }
    h3 { margin: 4px 0; padding: 4px; font-size: 16px }
    .card-title { color: black }
    .card-title--accent { color: gray }
    .plain h3, .many h3 { display: inline-block; margin-right: 8px }
  </style></head><body><main>
    <section class="grid">${card(1, 'card-title')}${card(2, 'card-title')}${card(3, 'card-title card-title--accent')}</section>
    <aside class="promo"><h3 class="card-title" data-n="promo">Promo</h3></aside>
    <section class="plain">${plain(11)}</section>
    ${many ? `<section class="many">${plain(many)}</section>` : ''}
  </main><script>${owners}${held}</script></body></html>`
}

/**
 * A single-page app that draws itself from the URL and never reloads: a hash router
 * (#/users, #/projects), a state hash on /spa/london, and /spa/users?id=N where the
 * title and the action are the same on every user and the profile line is not.
 */
function spaPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>SPA</title><style>
    body { font-family: sans-serif; color: black; margin: 0; padding: 16px }
    h2, p, button { margin: 8px 0; padding: 4px }
  </style></head><body><main id="app"></main><script>
    function draw() {
      const h = location.hash, p = location.pathname, id = new URLSearchParams(location.search).get('id')
      let html = '<h2 data-testid="other-title">Somewhere else</h2>'
      if (h.startsWith('#/users')) html = '<h2 data-testid="users-title">Users</h2><button data-testid="invite">Invite</button>'
      else if (h.startsWith('#/projects')) html = '<h2 data-testid="projects-title">Projects</h2><button data-testid="create">Create</button>'
      else if (p === '/spa/london') html = '<h2 data-testid="london-title">London</h2><p>' + h + '</p>'
      else if (p === '/spa/users') html = '<h2 class="user-title">User page</h2><button class="act">Send message</button><p class="who">Profile of ' + (id === '1' ? 'Ann' : 'Bob') + '</p>'
      document.getElementById('app').innerHTML = html
    }
    addEventListener('hashchange', draw)
    addEventListener('popstate', draw)
    draw()
  </script></body></html>`
}

let context, page, worker, demo, bridge, profile, ext, bridgeServer, cards, cardsPort

before(async () => {
  if (!browser.ok) return
  const { version } = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  bridge = recordingBridge(version)
  bridgeServer = bridge.server
  const bridgePort = await listen(bridgeServer)
  demo = await startDemo()
  cards = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(url.pathname.startsWith('/spa') ? spaPage() : cardsPage(url.searchParams))
  })
  cardsPort = await listen(cards)
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
  cards?.closeAllConnections?.()
  cards?.close()
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
  const key = `pinpoint:v2:http://localhost:${demo.port}/`
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

test('the project popover refreshes the design system on request', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
  await host('.pill').click()
  const refresh = host('.pop button').filter({ hasText: 'Refresh design system' })
  await refresh.waitFor({ timeout: 15000 })
  const before = bridge.designAsks.length
  await refresh.focus()
  await page.keyboard.press('Enter')
  await host('.toast.show').filter({ hasText: 'Design system refreshed' }).waitFor({ timeout: 15000 })
  const asks = bridge.designAsks.slice(before)
  assert.ok(asks.some(a => a.refresh === true), `no refresh reached the bridge: ${JSON.stringify(asks)}`)
  await host('.pill').click()
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

// ---------------------------------------------------------------- Apply to

/*
 * "Apply to" in the real composer, on a cards page served by this file: the owner's example
 * of three cards whose h3 shares `card-title`, one with an override class and another text
 * colour, a promo title with the same class outside the cards, and eleven plain h3s. The
 * bridge answers with a small palette from here on. Query flags add what a test needs:
 *   react=1    fake React owners (CardTitle) on the card and promo titles
 *   react=min  the same with a minified name
 *   slow=1     the main-world group answer is held back past the 250ms budget
 *   many=N     N more plain h3s, to pass the 200 cap
 */

const KEY = () => `pinpoint:v2:http://localhost:${cardsPort}/cards`

/**
 * Show the toolbar unless the tab already reopens it. The tab's remembered state arrives a
 * moment after the overlay mounts; a toggle sent before it would hide what it then shows.
 */
async function ensureShown() {
  try {
    await host('.bar').waitFor({ state: 'visible', timeout: 1500 })
  } catch {
    await iconClick()
    await host('.bar').waitFor({ state: 'visible', timeout: 5000 })
  }
}

/** Load the cards page with these flags, toolbar showing, storage for it empty. */
async function loadCards(query = '') {
  bridge.state.palette = PALETTE
  await worker.evaluate(k => chrome.storage.local.remove(k), KEY())
  await page.goto(`http://localhost:${cardsPort}/cards${query}`)
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await ensureShown()
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
  await page.evaluate(() => window.scrollTo(0, 0))
}

/** Open the composer on an element of the page. */
async function compose(selector) {
  if ((await host('.mode').innerText()).trim() !== 'Commenting') await host('.mode').click()
  const b = await page.locator(selector).first().boundingBox()
  await page.mouse.click(b.x + 12, b.y + b.height / 2)
  await host('.card textarea').waitFor()
  await host('.card input[type=checkbox]').first().uncheck()
}

/** Pick the accent from the text colour chip; the scope control then shows. */
async function pickColour() {
  await host('.card .chip').filter({ hasText: 'text' }).click()
  await host('.card .swatch').first().click()
  await host('.scope.show').waitFor({ timeout: 5000 })
}

/** kind:count for every option, in order. */
const rows = () => page.evaluate(() =>
  [...document.getElementById('pinpoint-host').shadowRoot.querySelectorAll('.scope-opt')]
    .map(r => `${r.dataset.kind}:${r.querySelector('.scope-count').textContent}`))

const checked = () => page.evaluate(() =>
  document.getElementById('pinpoint-host').shadowRoot.querySelector('.scope input:checked')?.value ?? null)

const omitted = () => host('.scope').getAttribute('data-omitted')

/** The inline colour the preview wrote on each card title, the promo and the first plain h3. */
const inline = () => page.evaluate(() => {
  const at = s => document.querySelector(s)?.style.getPropertyValue('color') ?? null
  return { c1: at('[data-n="1"]'), c2: at('[data-n="2"]'), c3: at('[data-n="3"]'), promo: at('[data-n="promo"]'), plain: at('[data-plain="1"]') }
})

const liveText = () => page.evaluate(() =>
  document.getElementById('pinpoint-host').shadowRoot.querySelector('[aria-live="polite"]')?.textContent ?? '')

async function liveSays(re, timeout = 5000) {
  const until = Date.now() + timeout
  let text = ''
  while (Date.now() < until) {
    text = await liveText()
    if (re.test(text)) return text
    await page.waitForTimeout(50)
  }
  assert.fail(`the live region never said ${re}; last: "${text}"`)
}

const focusedValue = () => page.evaluate(() => {
  const a = document.getElementById('pinpoint-host').shadowRoot.activeElement
  return a ? (a.value || a.textContent) : null
})

/** The stored comments of the cards page, once the debounced save has run. */
async function stored(n) {
  const until = Date.now() + 5000
  let list = []
  while (Date.now() < until) {
    list = (await worker.evaluate(async k => (await chrome.storage.local.get(k))[k]?.comments ?? [], KEY()))
    if (list.length >= n) return list
    await page.waitForTimeout(50)
  }
  return list
}

async function closeAll() {
  for (let i = 0; i < 3 && (await host('.card').count()); i++) await page.keyboard.press('Escape')
  if ((await host('.mode').innerText()).trim() === 'Commenting') await host('.mode').click()
}

test('no Apply to until a value is picked; then every match with its count, and Only this chosen', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards()
  await compose('[data-n="1"]')
  assert.equal(await host('.scope').isVisible(), false, 'the scope shows before any pick')
  await pickColour()
  assert.equal(await host('.scope legend').innerText(), 'APPLY TO')
  assert.deepEqual(await rows(), ['element:1', 'classes:3', 'pattern:3', 'tag:15'])
  assert.equal(await checked(), 'element')
  assert.equal((await host('.scope-opt[data-kind="pattern"] .scope-name').innerText()).trim(), 'Same container')
  assert.equal(await host('.scope-opt[data-kind="pattern"] .scope-hint').innerText(), 'article.card › h3')
  assert.equal(await host('.scope-opt[data-kind="tag"] .scope-name').innerText(), 'Every h3')
  assert.equal(await host('.scope-opt[data-kind="classes"] input').getAttribute('aria-label'), 'Same classes, h3.card-title, 3 matches')
  // No React or Vue on this page: no component role, and the reason is kept.
  await page.waitForTimeout(400)
  assert.match(await omitted(), /component:no-name/)
  // Only this previews on the target alone.
  assert.deepEqual(await inline(), { c1: 'rebeccapurple', c2: '', c3: '', promo: '', plain: '' })
})

test('choosing a group previews it on every member, warns about the one that differs, and Cancel puts it all back', { skip: !browser.ok, timeout: 60000 }, async () => {
  await host('.scope-opt[data-kind="pattern"]').click()
  assert.equal(await checked(), 'pattern')
  assert.deepEqual(await inline(), { c1: 'rebeccapurple', c2: 'rebeccapurple', c3: 'rebeccapurple', promo: '', plain: '' })
  const warn = (await host('.scope-warn.show').innerText()).replace(/\s+/g, ' ').trim()
  assert.equal(warn, '⚠ 1 of 3 matches currently uses a different text colour')
  await liveSays(/^Apply to Same container: 3 matches\. 1 of 3 matches currently uses a different text colour$/)
  // The same classes do not include the card with the override, and nobody differs.
  await host('.scope-opt[data-kind="classes"]').click()
  assert.deepEqual(await inline(), { c1: 'rebeccapurple', c2: 'rebeccapurple', c3: '', promo: 'rebeccapurple', plain: '' })
  assert.equal(await host('.scope-warn.show').count(), 0)
  await host('.card button').filter({ hasText: 'Cancel' }).click()
  assert.deepEqual(await inline(), { c1: '', c2: '', c3: '', promo: '', plain: '' })
  assert.equal(await host('.scope-outline').count(), 0)
  await closeAll()
})

test('Add stores the scope with the comment, Dispatch sends it, and the next comment starts at Only this', { skip: !browser.ok, timeout: 60000 }, async () => {
  await compose('[data-n="1"]')
  await pickColour()
  await host('.scope-opt[data-kind="classes"]').click()
  await host('.card button.primary').click()
  await host('.card').waitFor({ state: 'detached' })
  assert.deepEqual(await inline(), { c1: '', c2: '', c3: '', promo: '', plain: '' })

  const [c] = await stored(1)
  assert.ok(c.scope, 'the comment has no scope')
  const { members, observations, source, ...rest } = c.scope
  assert.deepEqual(rest, {
    version: 1, kind: 'classes', match: { tag: 'h3', classes: ['card-title'] }, hint: 'h3.card-title',
    counts: { document: 3, visible: 3, capped: false },
  })
  assert.equal(source, c.selector)
  assert.equal(members.length, 3)
  assert.equal(await page.evaluate(m => m.map(s => document.querySelector(s)?.dataset.n).join(','), members), '1,2,promo')
  assert.deepEqual(observations, [{ prop: 'color', target: c.deltas[0].from, different: 0, samples: [] }])

  const before = bridge.dispatched.length
  await host('.bar button.primary').filter({ hasText: 'Dispatch' }).click()
  const until = Date.now() + 8000
  while (bridge.dispatched.length === before && Date.now() < until) await page.waitForTimeout(50)
  assert.ok(bridge.dispatched.length > before, 'nothing was dispatched')
  const sent = bridge.dispatched.at(-1).comments[0]
  assert.equal(sent.deltas.length, 1)
  assert.deepEqual(sent.scope, c.scope, 'the bridge did not get the scope that was stored')

  // A fresh composer is back at Only this.
  await compose('[data-n="2"]')
  await pickColour()
  assert.equal(await checked(), 'element')
  await closeAll()
})

test('the keyboard reaches the radios, arrows choose and outline, and Escape returns to Comment', { skip: !browser.ok, timeout: 60000 }, async () => {
  await compose('[data-n="1"]')
  await pickColour()
  // A pick hands focus back to the note; the options are one Shift+Tab before it.
  await page.keyboard.press('Shift+Tab')
  assert.equal(await focusedValue(), 'element')
  await page.keyboard.press('ArrowDown')
  assert.equal(await checked(), 'classes')
  await liveSays(/^Apply to Same classes: 3 matches$/)
  // Keyboard focus outlines the members, like hover does.
  assert.equal(await host('.scope-outline').count(), 3)
  assert.match(await host('.scope-detail').innerText(), /h3\.card-title · 3 matches/)
  await page.keyboard.press('ArrowDown')
  assert.equal(await checked(), 'pattern')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  assert.equal(await checked(), 'element')
  await page.keyboard.press('Space')
  assert.equal(await checked(), 'element')
  // Hover outlines too.
  await host('.scope-opt[data-kind="tag"]').hover()
  assert.equal(await host('.scope-outline').count(), 15)
  await page.keyboard.press('Escape')
  assert.equal(await host('.card').count(), 0)
  assert.equal(await focusedValue(), 'Commenting')
  assert.deepEqual(await inline(), { c1: '', c2: '', c3: '', promo: '', plain: '' })
  assert.equal(await host('.scope-outline').count(), 0)
  await closeAll()
})

test('a hidden member is counted in the document but not as visible', { skip: !browser.ok, timeout: 60000 }, async () => {
  await page.evaluate(() => { document.querySelectorAll('.card')[1].style.display = 'none' })
  try {
    await compose('[data-n="1"]')
    await pickColour()
    await host('.scope-opt[data-kind="classes"]').hover()
    assert.equal(await host('.scope-detail').innerText(), 'h3.card-title · 2 visible · 3 in document')
    assert.equal(await host('.scope-opt[data-kind="classes"] input').getAttribute('aria-label'), 'Same classes, h3.card-title, 2 visible, 3 in document')
    await closeAll()
  } finally {
    await page.evaluate(() => { document.querySelectorAll('.card')[1].style.display = '' })
  }
})

test('the picks gone or the element changed: back to Only this, nothing previewed', { skip: !browser.ok, timeout: 60000 }, async () => {
  await compose('[data-n="1"]')
  // The padding chip has no scale here, so it opens the stepper.
  const padding = async () => { await host('.card .chip').filter({ hasText: 'padding' }).click(); await host('.card .stepper').waitFor() }
  await padding()
  await host('.card .stepper button').filter({ hasText: '+' }).click()
  await host('.card .stepper button').filter({ hasText: 'Use' }).click()
  await host('.scope.show').waitFor()
  await host('.scope-opt[data-kind="classes"]').click()
  assert.equal(await page.evaluate(() => document.querySelector('[data-n="2"]').style.getPropertyValue('padding')), '5px')
  // Using the current value again removes the only pick.
  await padding()
  await host('.card .stepper button').filter({ hasText: 'Use' }).click()
  assert.equal(await host('.scope').isVisible(), false)
  assert.equal(await page.evaluate(() => document.querySelector('[data-n="2"]').style.getPropertyValue('padding')), '')
  // Pick again: Only this.
  await pickColour()
  assert.equal(await checked(), 'element')
  await host('.scope-opt[data-kind="tag"]').click()
  // Walking to the parent drops the picks, and coming back starts over.
  await host('.card textarea').focus()
  await page.keyboard.press('ArrowUp')
  assert.equal(await host('.scope').isVisible(), false)
  assert.deepEqual(await inline(), { c1: '', c2: '', c3: '', promo: '', plain: '' })
  await page.keyboard.press('ArrowDown')
  await pickColour()
  assert.equal(await checked(), 'element')
  await closeAll()
})

test('a group past the cap reads 200+, can be chosen, and is never previewed or listed', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards('?many=250')
  await compose('[data-n="1"]')
  await pickColour()
  assert.deepEqual(await rows(), ['element:1', 'classes:3', 'pattern:3', 'tag:200+'])
  await host('.scope-opt[data-kind="tag"]').hover()
  assert.equal(await host('.scope-outline').count(), 0, 'a capped group was outlined')
  await host('.scope-opt[data-kind="tag"]').click()
  assert.equal(await checked(), 'tag')
  assert.equal(await host('.scope-warn.show').innerText(), 'Large group — preview unavailable. Rechecked when added.')
  assert.deepEqual(await inline(), { c1: 'rebeccapurple', c2: '', c3: '', promo: '', plain: '' })
  await liveSays(/^Apply to Every h3: 200 or more matches\. Large group/)
  await host('.card button.primary').click()
  const [c] = await stored(1)
  assert.deepEqual(c.scope.counts, { document: 200, visible: null, capped: true })
  assert.equal(c.scope.kind, 'tag')
  assert.deepEqual(c.scope.observations, [])
  assert.equal('members' in c.scope, false)
  await closeAll()
})

/** The text of the Applies to line on the open pin card, or null. */
const appliesLine = async () => (await host('.card .applies').count()) ? (await host('.card .applies').first().innerText()).trim() : null

async function openFirstPin() {
  await closeAll()
  await host('.pin').first().click()
  await host('.card .note').waitFor()
}

test('a pin card keeps the group scope as one line, for a pending comment, after dispatch and after a reload', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards()
  await compose('[data-n="1"]')
  await pickColour()
  await host('.scope-opt[data-kind="classes"]').click()
  await host('.card button.primary').click()
  await host('.card').waitFor({ state: 'detached' })
  await stored(1)
  await openFirstPin()
  assert.equal(await appliesLine(), 'Applies to: Same classes · 3 elements')
  await closeAll()

  const before = bridge.dispatched.length
  await host('.bar button.primary').filter({ hasText: 'Dispatch' }).click()
  const until = Date.now() + 8000
  while (bridge.dispatched.length === before && Date.now() < until) await page.waitForTimeout(50)
  await openFirstPin()
  assert.equal(await appliesLine(), 'Applies to: Same classes · 3 elements')
  await closeAll()

  // Saving is debounced; the record is in storage before the page goes.
  await stored(1)
  await page.reload()
  await host('.pin').first().waitFor({ timeout: 15000 })
  await openFirstPin()
  assert.equal(await appliesLine(), 'Applies to: Same classes · 3 elements')
  await closeAll()
})

test('a pin card says nothing about scope for Only this', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards()
  await compose('[data-n="1"]')
  await pickColour()
  await host('.card button.primary').click()
  await host('.card').waitFor({ state: 'detached' })
  await stored(1)
  await openFirstPin()
  assert.equal(await appliesLine(), null)
  await closeAll()
})

test('a capped group reads 200+ on the pin card', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards('?many=250')
  await compose('[data-n="1"]')
  await pickColour()
  await host('.scope-opt[data-kind="tag"]').click()
  await host('.card button.primary').click()
  await host('.card').waitFor({ state: 'detached' })
  await stored(1)
  await openFirstPin()
  assert.equal(await appliesLine(), 'Applies to: Every h3 · 200+ elements')
  await closeAll()
})

test('React owners give a component role, restricted to the tag', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards('?react=1')
  await compose('[data-n="1"]')
  await pickColour()
  await host('.scope-opt[data-kind="component"]').waitFor({ timeout: 2000 })
  assert.deepEqual(await rows(), ['element:1', 'classes:3', 'component:4', 'pattern:3', 'tag:15'])
  assert.equal(await host('.scope-opt[data-kind="component"] .scope-hint').innerText(), 'CardTitle / h3')
  await host('.scope-opt[data-kind="component"]').click()
  assert.deepEqual(await inline(), { c1: 'rebeccapurple', c2: 'rebeccapurple', c3: 'rebeccapurple', promo: 'rebeccapurple', plain: '' })
  await host('.card button.primary').click()
  const [c] = await stored(1)
  assert.deepEqual(c.scope.match, { tag: 'h3', component: 'CardTitle' })
  assert.equal(c.scope.counts.document, 4)
  assert.equal(c.scope.observations[0].different, 1)
  await closeAll()
})

test('a minified component name is not offered', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards('?react=min')
  await compose('[data-n="1"]')
  await pickColour()
  await page.waitForTimeout(400)
  assert.equal(await host('.scope-opt[data-kind="component"]').count(), 0)
  assert.match(await omitted(), /component:minified/)
  await closeAll()
})

test('a component answer slower than 250ms is given up on, and a late one is ignored', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards('?react=1&slow=1')
  await compose('[data-n="1"]')
  const t0 = Date.now()
  await pickColour()
  // The other matches do not wait for the probe.
  await host('.scope-opt[data-kind="classes"]').waitFor({ timeout: 1000 })
  assert.ok(Date.now() - t0 < 2000)
  await host('.scope[data-omitted*="component:timeout"]').waitFor({ timeout: 2000 })
  // The held answer lands at 600ms; it must not add the option afterwards.
  await page.waitForTimeout(900)
  assert.equal(await host('.scope-opt[data-kind="component"]').count(), 0)
  assert.deepEqual(await rows(), ['element:1', 'classes:3', 'pattern:3', 'tag:15'])
  await closeAll()
})

test('a frozen frame offers only Only this', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards()
  // No real capture in a headless test browser: the frame only needs a picture.
  await worker.evaluate(() => { chrome.tabs.captureVisibleTab = async () => 'data:image/png;base64,AAAA' })
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.tabs.sendMessage(tab.id, { type: 'freeze' })
  })
  await host('.frame-note').waitFor({ timeout: 5000 })
  const b = await page.locator('[data-n="1"]').boundingBox()
  await page.mouse.click(b.x + 12, b.y + b.height / 2)
  await host('.card textarea').waitFor()
  await pickColour()
  assert.deepEqual(await rows(), ['element:1'])
  assert.equal(await host('.scope-warn.show').innerText(), 'Frozen frame — only this element can be chosen.')
  await closeAll()
  await page.keyboard.press('Escape')
})

/** Wait for the toolbar's next /health, which is how it learns what the bridge can carry. */
async function nextHealth() {
  const seen = bridge.identities.filter(i => i.path === '/health').length
  const until = Date.now() + 8000
  while (bridge.identities.filter(i => i.path === '/health').length === seen && Date.now() < until) await page.waitForTimeout(50)
  // The answer still has to be painted.
  await page.waitForTimeout(200)
}

test('a bridge without comment-scope-v1 gets no Apply to and no scope, only the picks', { skip: !browser.ok, timeout: 60000 }, async () => {
  bridge.state.scope = false
  try {
    await loadCards()
    await compose('[data-n="1"]')
    await host('.card .chip').filter({ hasText: 'text' }).click()
    await host('.card .swatch').first().click()
    await page.waitForTimeout(400)
    assert.equal(await host('.scope').isVisible(), false, 'Apply to shows for a bridge that would drop it')
    // Only this still previews the pick on the element itself.
    assert.deepEqual(await inline(), { c1: 'rebeccapurple', c2: '', c3: '', promo: '', plain: '' })
    await host('.card button.primary').click()
    await host('.card').waitFor({ state: 'detached' })
    const [c] = await stored(1)
    assert.equal(c.deltas.length, 1)
    assert.equal(c.scope, undefined, 'a scope was stored for a bridge that cannot carry it')

    const before = bridge.dispatched.length
    await host('.bar button.primary').filter({ hasText: 'Dispatch' }).click()
    const until = Date.now() + 8000
    while (bridge.dispatched.length === before && Date.now() < until) await page.waitForTimeout(50)
    const sent = bridge.dispatched.at(-1).comments[0]
    assert.equal(sent.deltas.length, 1)
    assert.equal('scope' in sent, false)
  } finally {
    bridge.state.scope = true
    await closeAll()
  }
})

test('a group chosen before the bridge lost comment-scope-v1 is refused at Add, never narrowed in silence', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadCards()
  await compose('[data-n="1"]')
  await pickColour()
  await host('.scope-opt[data-kind="classes"]').click()
  bridge.state.scope = false
  try {
    await nextHealth()
    // The chosen group stays on screen, so the refusal has something to point at.
    assert.equal(await host('.scope').isVisible(), true)
    await host('.card button.primary').click()
    await host('.toast.show').filter({ hasText: 'cannot carry "Same classes"' }).waitFor({ timeout: 5000 })
    assert.equal(await host('.card').count(), 1, 'the composer closed on a refused Add')
    assert.equal(await host('.scope').isVisible(), false)
    assert.deepEqual(await stored(0), [])
    // A second Add is the user choosing Only this, in words they were shown.
    await host('.card button.primary').click()
    await host('.card').waitFor({ state: 'detached' })
    const [c] = await stored(1)
    assert.equal(c.scope, undefined)
  } finally {
    bridge.state.scope = true
    await closeAll()
  }
})

// ---------------------------------------------------------------- routes

/*
 * Pins follow the route of a single-page app. The SPA page above changes its URL with
 * the history API and the hash and never reloads.
 */

const spa = path => `http://localhost:${cardsPort}${path}`
const v2 = path => `pinpoint:v2:http://localhost:${cardsPort}${path}`

/** Every pin in the overlay, shown or not, with its name and classes. */
const pinList = (p = page) => p.evaluate(() =>
  [...(document.getElementById('pinpoint-host')?.shadowRoot.querySelectorAll('.pin') ?? [])]
    .map(n => ({ name: n.getAttribute('aria-label'), cls: n.className, title: n.title })))

async function pinsAre(want, p = page, timeout = 5000) {
  const until = Date.now() + timeout
  let got = []
  while (Date.now() < until) {
    got = (await pinList(p)).map(x => x.name)
    if (JSON.stringify(got) === JSON.stringify(want)) return got
    await p.waitForTimeout(50)
  }
  assert.deepEqual(got, want)
}

async function storedAt(key, n) {
  const until = Date.now() + 5000
  let list = []
  while (Date.now() < until) {
    list = await worker.evaluate(async k => (await chrome.storage.local.get(k))[k]?.comments ?? [], key)
    if (list.length === n) return list
    await page.waitForTimeout(50)
  }
  return list
}

/** Open the SPA at `path` with these buckets cleared, toolbar showing. */
async function loadSpa(path, clear = []) {
  await worker.evaluate(keys => chrome.storage.local.remove(keys), clear)
  await page.goto(spa(path))
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await ensureShown()
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
}

/** The name of pin 1 when it was written on another URL state of the same route. */
const marked = note => `Pin 1, change request, pending, created on another URL state: ${note}`

async function addComment(selector, note) {
  await compose(selector)
  await host('.card textarea').fill(note)
  await host('.card button.primary').click()
  await host('.card').waitFor({ state: 'detached' })
  if ((await host('.mode').innerText()).trim() === 'Commenting') await host('.mode').click()
}

test('a hash router keeps separate pins for #/users and #/projects, and back again', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadSpa('/spa#/users', [v2('/spa#/users'), v2('/spa#/projects')])
  await addComment('[data-testid="users-title"]', 'users note')
  await pinsAre(['Pin 1, change request, pending: users note'])
  // No reload: the hash router draws the projects screen.
  await page.evaluate(() => { location.hash = '#/projects' })
  await pinsAre([])
  await addComment('[data-testid="projects-title"]', 'projects note')
  await pinsAre(['Pin 1, change request, pending: projects note'])
  await page.evaluate(() => { location.hash = '#/users' })
  await pinsAre(['Pin 1, change request, pending: users note'])
  // The query inside a hash route is state: same bucket, the pin proven and marked.
  await page.evaluate(() => { location.hash = '#/users?tab=activity' })
  await pinsAre([marked('users note')])
  assert.equal((await storedAt(v2('/spa#/users'), 1))[0].note, 'users note')
  const projects = await storedAt(v2('/spa#/projects'), 1)
  assert.equal(projects[0].note, 'projects note')
  assert.equal(projects[0].createdHref, spa('/spa#/projects'))
  assert.equal(typeof projects[0].id, 'string')
  assert.equal(projects[0].evidence.test.value, 'projects-title')
})

test('a state-only hash change keeps the pins; pushState to a new path swaps buckets without a reload', { skip: !browser.ok, timeout: 60000 }, async () => {
  await loadSpa('/spa/london', [v2('/spa/london'), v2('/spa/elsewhere')])
  await addComment('[data-testid="london-title"]', 'london note')
  const pinned = ['Pin 1, change request, pending: london note']
  await pinsAre(pinned)
  // The London sequence: the same bucket throughout. The element is proven by its text, so
  // the pin stays attached, marked as written on another URL state.
  for (const h of ['#by=line&play=week', '#by=bus&play=week&wk=20260824', '#by=bus&play=month&wk=20260831']) {
    await page.evaluate(x => { location.hash = x }, h)
    await page.waitForTimeout(350)
    await pinsAre([marked('london note')])
    assert.doesNotMatch((await pinList())[0].cls, /\bdetached\b/)
  }
  // The same history functions as before Pinpoint mounted: never wrapped.
  assert.equal(await page.evaluate(() => /\[native code\]/.test(String(history.pushState)) && /\[native code\]/.test(String(history.replaceState))), true)
  // A pushState the page itself does not announce: the Navigation API or the poll sees it.
  await page.evaluate(() => history.pushState(null, '', '/spa/elsewhere'))
  await pinsAre([])
  await page.evaluate(() => history.replaceState(null, '', '/spa/london'))
  await pinsAre(pinned)
  await page.goBack()
  await pinsAre([marked('london note')])
})

test('/users?id=1 to ?id=2: a proven element attaches and is marked, the other is dimmed and detached', { skip: !browser.ok, timeout: 60000 }, async () => {
  const href = spa('/spa/users?id=1')
  const seed = [
    { id: 'act', n: 1, note: 'shared action', status: 'pending', selector: '.act', tag: 'button', text: 'Send message', createdHref: href,
      evidence: { tag: 'button', text: 'Send message', classes: ['act'] }, docX: 20, docY: 80, rect: { x: 0, y: 0, w: 10, h: 10 }, updatedAt: 1 },
    { id: 'who', n: 2, note: 'about Ann', status: 'pending', selector: '.who', tag: 'p', text: 'Profile of Ann', createdHref: href,
      evidence: { tag: 'p', text: 'Profile of Ann', classes: ['who'] }, docX: 20, docY: 120, rect: { x: 0, y: 0, w: 10, h: 10 }, updatedAt: 1 },
  ]
  await worker.evaluate(([k, comments]) => chrome.storage.local.set({ [k]: { v: 2, seq: 2, comments, removed: [] } }), [v2('/spa/users'), seed])
  await page.goto(spa('/spa/users?id=1'))
  await host('.pin').first().waitFor({ state: 'attached', timeout: 15000 })
  await pinsAre(['Pin 1, change request, pending: shared action', 'Pin 2, change request, pending: about Ann'])
  assert.ok((await pinList()).every(p => !/detached|elsewhere/.test(p.cls)))

  await page.goto(spa('/spa/users?id=2'))
  await host('.pin').first().waitFor({ state: 'attached', timeout: 15000 })
  await pinsAre([
    'Pin 1, change request, pending, created on another URL state: shared action',
    'Pin 2, change request, pending, detached, element not found here: about Ann',
  ])
  const [act, who] = await pinList()
  assert.match(act.cls, /\belsewhere\b/)
  assert.doesNotMatch(act.cls, /\bdetached\b/)
  assert.match(act.title, /^created on another URL state/)
  assert.match(who.cls, /\bdetached\b/)
  // The card says why, in words, with the URL state the comment was written on.
  await ensureShown()
  await host('.pin').first().click()
  assert.equal((await host('.card .kind.elsewhere').innerText()).trim(), 'created on another URL state: /spa/users?id=1')
  await page.keyboard.press('Escape')
})

test('pins under the old origin-and-path key move to the route bucket on first load', { skip: !browser.ok, timeout: 60000 }, async () => {
  const legacy = `pinpoint:http://localhost:${cardsPort}/spa/legacy`
  await worker.evaluate(([k, v2k]) => chrome.storage.local.remove(v2k).then(() => chrome.storage.local.set({ [k]: {
    seq: 1, comments: [{ n: 1, note: 'from before', status: 'pending', selector: '[data-testid="other-title"]', docX: 0, docY: 0 }],
  } })), [legacy, v2('/spa/legacy')])
  await page.goto(spa('/spa/legacy'))
  await host('.pin').first().waitFor({ state: 'attached', timeout: 15000 })
  await pinsAre(['Pin 1, change request, pending: from before'])
  const [moved] = await storedAt(v2('/spa/legacy'), 1)
  assert.equal(moved.note, 'from before')
  assert.match(moved.id, /^legacy-1-/)
  assert.equal(await worker.evaluate(async k => k in (await chrome.storage.local.get(k)), legacy), false)
  // A second load finds nothing to move and the same single pin.
  await page.reload()
  await host('.pin').first().waitFor({ state: 'attached', timeout: 15000 })
  await pinsAre(['Pin 1, change request, pending: from before'])
  assert.equal((await storedAt(v2('/spa/legacy'), 1)).length, 1)
})

test('two pages on one route converge through the storage change event', { skip: !browser.ok, timeout: 90000 }, async () => {
  await loadSpa('/spa/london', [v2('/spa/london')])
  const other = await context.newPage()
  try {
    await other.goto(spa('/spa/london#by=line'))
    await other.locator('#pinpoint-host').waitFor({ state: 'attached', timeout: 15000 })
    await page.bringToFront()
    await addComment('[data-testid="london-title"]', 'seen in both')
    await pinsAre([marked('seen in both')], other)
    // Removed in the first page: gone from the second as well, and not written back by it.
    await host('.pin').first().click()
    await host('.card button.danger').filter({ hasText: 'Remove' }).click()
    await pinsAre([], other)
    await page.waitForTimeout(400)
    assert.equal((await storedAt(v2('/spa/london'), 0)).length, 0)
  } finally {
    await other.close()
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

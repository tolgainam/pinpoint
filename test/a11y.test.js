/**
 * Keyboard and screen-reader use of the overlay.
 *
 * The first half checks the exact accessible names pins are read by, from a11y.js loaded
 * as a module. The second half drives the extension in Playwright's Chromium, against the
 * demo page and a stub bridge on a free port: the toolbar's one tab stop, pin navigation,
 * where Escape sends focus from each surface, the live region, forced colours, reduced
 * motion and a 200% zoom sized window.
 *
 * The browser half skips, saying why, when Playwright's Chromium is not installed.
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
import '../extension/a11y.js'
import { available, listen, startDemo, extensionCopy } from './screens/shoot.js'

const { pinName, shortNote, byPosition } = globalThis.PinpointA11y

// ---------------------------------------------------------------- names

test('a single pin is named by number, kind, state and note', () => {
  const c = { n: 3, note: 'Increase the card padding', status: 'sent', progress: { state: 'working' } }
  assert.equal(pinName([c], c), 'Pin 3, change request, working: Increase the card padding')
  const q = { n: 4, note: 'why grey?', status: 'pending', question: true }
  assert.equal(pinName([q], q), 'Pin 4, question, pending: why grey?')
  const parked = { n: 5, note: 'later', status: 'backlog', unsaved: true }
  assert.equal(pinName([parked], parked), 'Pin 5, change request, unsaved backlog: later')
  const done = { n: 6, note: 'x', status: 'resolved', progress: { state: 'working' } }
  assert.equal(pinName([done], done), 'Pin 6, change request, resolved: x')
})

test('a stack is named by its lead number, count, tally and the lead note', () => {
  const stack = [
    { n: 2, note: 'older one', status: 'sent', progress: { state: 'working' } },
    { n: 3, note: 'Increase the card padding', status: 'answered', question: true },
    { n: 4, note: 'done one', status: 'resolved' },
    { n: 5, note: 'parked one', status: 'backlog' },
  ]
  assert.equal(pinName(stack, stack[1]),
    'Pin 3, 4 comments: 1 working, 1 answered, 1 resolved, 1 backlog. Increase the card padding')
  // All resolved: the newest note is read instead of the lead's.
  const done = [{ n: 1, note: 'first', status: 'resolved' }, { n: 7, note: 'newest', status: 'resolved' }]
  assert.equal(pinName(done, done[0]), 'Pin 1, 2 comments: 2 resolved. newest')
})

test('a detached pin says so in its name; an attached one, even from another URL state, is unchanged', () => {
  const c = { n: 3, note: 'pad', status: 'pending' }
  assert.equal(pinName([c], c, 'elsewhere'), 'Pin 3, change request, pending: pad')
  assert.equal(pinName([c], c, 'detached'), 'Pin 3, change request, pending, detached, element not found here: pad')
  assert.equal(pinName([c], c, undefined), 'Pin 3, change request, pending: pad')
  const two = [c, { n: 4, note: 'more', status: 'sent' }]
  assert.equal(pinName(two, c, 'elsewhere'), 'Pin 3, 2 comments: 1 pending, 1 dispatched. pad')
})

test('notes are put on one line and cut to 100 characters', () => {
  assert.equal(shortNote('  a \n\n b\tc  '), 'a b c')
  const long = shortNote('x'.repeat(250))
  assert.equal(long.length, 100)
  assert.ok(long.endsWith('…'))
  assert.equal(shortNote('y'.repeat(100)), 'y'.repeat(100))
})

test('pins are walked top to bottom, then left to right, then by number', () => {
  const pins = [
    { n: 1, docY: 300, docX: 10 }, { n: 2, docY: 100, docX: 50 },
    { n: 3, docY: 100, docX: 10 }, { n: 5, docY: 100, docX: 10 }, { n: 4, docY: 100, docX: 10 },
  ]
  assert.deepEqual([...pins].sort(byPosition).map(p => p.n), [3, 4, 5, 2, 1])
})

// ---------------------------------------------------------------- browser

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = { name: 'nimbus', projectDir: '/Users/dev/nimbus' }
const browser = await available()
if (!browser.ok) console.log(`a11y e2e skipped: ${browser.why}`)
const skip = !browser.ok

/** /health as one session, an event stream the session side can write to, and dispatch. */
function stubBridge(version) {
  const streams = new Set()
  let seq = 0
  let batches = 0
  const emit = event => {
    const frame = `data: ${JSON.stringify({ seq: ++seq, projectDir: PROJECT.projectDir, ...event })}\n\n`
    for (const res of streams) res.write(frame)
  }
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
      res.write(': stub\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (url.pathname === '/state') return json(200, { ok: true, states: {} })
    if (url.pathname === '/design-system') return json(200, { ok: true, detected: false })
    if (url.pathname === '/dispatch' && req.method === 'POST') {
      req.resume()
      req.on('end', () => json(200, { ok: true, batch: `kb-${++batches}`, count: 1, projectDir: PROJECT.projectDir, name: PROJECT.name }))
      return
    }
    json(404, { ok: false })
  })
  server.keepAliveTimeout = 0
  return { server, emit }
}

let context, page, worker, demo, bridge, profile, ext

const at = (selector, extra = {}) => ({ selector, docX: 0, docY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, ...extra })
/** Five comments on three elements: a working one, a pending one, and a stack of four. */
const SEED = [
  { n: 1, note: 'Make the title  smaller', status: 'sent', batch: 'seed', serverN: 1, sentTo: PROJECT.projectDir, progress: { state: 'working', note: '', files: [] }, ...at('[data-testid="hero-title"]') },
  { n: 2, note: 'older one', status: 'sent', batch: 'seed', serverN: 2, sentTo: PROJECT.projectDir, progress: { state: 'working', note: '', files: [] }, ...at('[data-testid="cta-primary"]') },
  { n: 3, note: 'Increase the card padding', status: 'answered', question: true, answer: 'Because.', batch: 'seed', serverN: 3, sentTo: PROJECT.projectDir, ...at('[data-testid="cta-primary"]') },
  { n: 4, note: 'done one', status: 'resolved', batch: 'seed', serverN: 4, sentTo: PROJECT.projectDir, ...at('[data-testid="cta-primary"]') },
  { n: 5, note: 'parked one', status: 'backlog', ...at('[data-testid="cta-primary"]') },
  { n: 6, note: 'Tighten this line', status: 'pending', ...at('[data-testid="hero-sub"]') },
]

before(async () => {
  if (skip) return
  const { version } = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  bridge = stubBridge(version)
  const bridgePort = await listen(bridge.server)
  demo = await startDemo()
  ext = await extensionCopy(bridgePort)
  profile = await mkdtemp(join(tmpdir(), 'pinpoint-a11y-'))
  context = await browser.chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  page = context.pages()[0] ?? await context.newPage()
  const welcome = `chrome-extension://${new URL(worker.url()).host}/welcome.html`
  const isWelcome = p => p.url().startsWith(welcome)
  const opened = context.pages().find(isWelcome)
    ?? await context.waitForEvent('page', { predicate: isWelcome, timeout: 10000 }).catch(() => null)
  await opened?.close()
}, { timeout: 60000 })

after(async () => {
  await context?.close().catch(() => {})
  bridge?.server.closeAllConnections?.()
  bridge?.server.close()
  demo?.stop()
  for (const dir of [profile, ext]) if (dir) await rm(dir, { recursive: true, force: true })
})

const host = sel => page.locator(`#pinpoint-host ${sel}`)

/** The focus-pinpoint command, as the worker sends it to the active tab. */
const shortcut = () => worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await chrome.tabs.sendMessage(tab.id, { type: 'focus' })
})

/** What has focus inside the overlay, described: its class, text and accessible name. */
const focused = () => page.evaluate(() => {
  const a = document.getElementById('pinpoint-host').shadowRoot.activeElement
  return a ? { cls: a.className, text: a.textContent, name: a.getAttribute('aria-label') ?? '' } : null
})

/** The page's own focused element, when focus is not in the overlay. */
const pageFocused = () => page.evaluate(() => {
  const a = document.activeElement
  return a && a.id !== 'pinpoint-host' ? (a.getAttribute('data-testid') || a.tagName) : null
})

/** Into the toolbar with the shortcut, then along it to the Pins item. */
async function toPins() {
  await shortcut()
  await page.keyboard.press('Home')
  for (let i = 0; i < 8 && (await focused())?.name !== 'Pins, 3'; i++) await page.keyboard.press('ArrowRight')
  assert.equal((await focused())?.name, 'Pins, 3')
}

const liveText = () => page.evaluate(() =>
  document.getElementById('pinpoint-host').shadowRoot.querySelector('[aria-live="polite"]')?.textContent ?? '')

async function liveSays(re, timeout = 8000) {
  const until = Date.now() + timeout
  let text = ''
  while (Date.now() < until) {
    text = await liveText()
    if (re.test(text)) return text
    await page.waitForTimeout(50)
  }
  assert.fail(`the live region never said ${re}; last: "${text}"`)
}

async function load() {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
}

test('the shortcut shows the toolbar and focuses Comment; the toolbar is one tab stop', { skip, timeout: 60000 }, async () => {
  const key = `pinpoint:http://localhost:${demo.port}/`
  await worker.evaluate(async ([k, comments]) => {
    await chrome.storage.local.set({ [k]: { seq: comments.length, comments }, 'pp.tipSeen': true })
  }, [key, SEED])
  await load()
  await page.locator('[data-testid="sign-in"]').focus()
  await shortcut()
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
  assert.equal((await focused())?.text, 'Comment')

  const bar = await page.evaluate(() => {
    const bar = document.getElementById('pinpoint-host').shadowRoot.querySelector('.bar')
    const items = [...bar.children].filter(n => n.tagName === 'BUTTON')
    return {
      role: bar.getAttribute('role'),
      label: bar.getAttribute('aria-label'),
      stops: items.filter(b => b.tabIndex === 0).map(b => b.textContent),
      unnamed: items.filter(b => !(b.getAttribute('aria-label') || b.textContent.trim())).length,
      names: items.map(b => b.getAttribute('aria-label') || b.textContent.trim()),
    }
  })
  assert.equal(bar.role, 'toolbar')
  assert.equal(bar.label, 'Pinpoint')
  assert.deepEqual(bar.stops, ['Comment'])
  assert.equal(bar.unnamed, 0)
  assert.ok(bar.names.includes('Pins, 3'), `no Pins item: ${bar.names}`)
  // The keyboard model's order: Comment, Pins, then Inbox.
  const pinsAt = bar.names.indexOf('Pins, 3')
  assert.equal(bar.names[pinsAt - 1], 'Comment')
  assert.match(bar.names[pinsAt + 1], /^Open Pinpoint inbox, \d+ items? needs? attention$/)
  assert.ok(bar.names.includes('Hide Pinpoint'))

  // Arrows rove, and the one stop moves with them.
  await page.keyboard.press('ArrowRight')
  assert.equal((await focused())?.name, 'Pins, 3')
  await page.keyboard.press('ArrowLeft')
  assert.equal((await focused())?.text, 'Comment')
  await page.keyboard.press('End')
  assert.equal((await focused())?.name, 'Hide Pinpoint')
  await page.keyboard.press('Home')
  assert.match((await focused())?.name, /^Project: /)
  const stops = await page.evaluate(() => [...document.getElementById('pinpoint-host').shadowRoot.querySelectorAll('.bar > button')].filter(b => b.tabIndex === 0).length)
  assert.equal(stops, 1)
  // A keyboard focus shows the ring.
  const outline = await page.evaluate(() => getComputedStyle(document.getElementById('pinpoint-host').shadowRoot.activeElement).outlineStyle)
  assert.equal(outline, 'solid')

  // Escape on the toolbar goes back to where the keyboard was on the page.
  await page.keyboard.press('Escape')
  assert.equal(await pageFocused(), 'sign-in')
})

test('pins have exact names, rove with arrows, open with Enter and Space, and Escape walks back', { skip, timeout: 60000 }, async () => {
  const names = await page.evaluate(() =>
    [...document.getElementById('pinpoint-host').shadowRoot.querySelectorAll('.pin')].map(p => ({
      tag: p.tagName, tab: p.tabIndex, name: p.getAttribute('aria-label'),
    })))
  assert.deepEqual(names.map(p => p.tag), ['BUTTON', 'BUTTON', 'BUTTON'])
  assert.ok(names.every(p => p.tab === -1), 'a pin takes a tab stop of its own')
  // Walking order: the title, the line under it, then the button row.
  assert.deepEqual(names.map(p => p.name), [
    'Pin 1, change request, working: Make the title smaller',
    'Pin 6, change request, pending: Tighten this line',
    'Pin 3, 4 comments: 1 working, 1 answered, 1 resolved, 1 backlog. Increase the card padding',
  ])

  await toPins()
  await page.keyboard.press('ArrowDown')
  assert.match((await focused())?.name, /^Pin 1,/)
  await page.keyboard.press('ArrowRight')
  assert.match((await focused())?.name, /^Pin 6,/)
  await page.keyboard.press('End')
  assert.match((await focused())?.name, /^Pin 3,/)
  await page.keyboard.press('Home')
  assert.match((await focused())?.name, /^Pin 1,/)
  await page.keyboard.press('ArrowUp')
  assert.match((await focused())?.name, /^Pin 3,/)

  // Enter opens the card and moves focus into it; Escape returns to the pin.
  await page.keyboard.press('Enter')
  await host('.card').waitFor()
  assert.match((await focused())?.cls, /\bcard\b/)
  assert.equal(await host('.card .sect').count(), 4)
  await page.keyboard.press('Escape')
  assert.equal(await host('.card').count(), 0)
  assert.match((await focused())?.name, /^Pin 3,/)

  // Space does the same.
  await page.keyboard.press('Space')
  await host('.card').waitFor()
  await page.keyboard.press('Escape')
  assert.match((await focused())?.name, /^Pin 3,/)

  // Escape on a pin goes back to the Pins item, which now holds the stop.
  await page.keyboard.press('Escape')
  assert.equal((await focused())?.name, 'Pins, 3')
  assert.equal(await host('.bar').isVisible(), true)

  // Enter on Pins enters at the first pin.
  await page.keyboard.press('Enter')
  assert.match((await focused())?.name, /^Pin 1,/)
})

test('Tab from a pin leaves the overlay and gives the stop back to Pins', { skip, timeout: 60000 }, async () => {
  const pinsStop = () => page.evaluate(() =>
    document.getElementById('pinpoint-host').shadowRoot.querySelector('.bar .pins-nav').tabIndex)

  // Backwards: the last focusable thing on the page.
  assert.match((await focused())?.name, /^Pin 1,/)
  await page.keyboard.press('Shift+Tab')
  assert.notEqual(await pageFocused(), null, 'Shift+Tab stayed in the overlay')
  assert.equal(await pinsStop(), 0)

  // Forwards: out of the overlay too.
  await toPins()
  await page.keyboard.press('ArrowDown')
  assert.match((await focused())?.name, /^Pin 1,/)
  await page.keyboard.press('Tab')
  const after = await focused()
  assert.ok(!after || !/\bpin\b/.test(after.cls), `Tab moved to another pin: ${JSON.stringify(after)}`)
  assert.ok(!after || !/^Pin /.test(after.name))
  assert.equal(await pinsStop(), 0)
  // And Tab from the page comes back to Pins, the last active item.
  await page.locator('[data-testid="sign-in"]').focus()
  await page.evaluate(() => document.querySelector('[data-testid="cta-secondary"]').focus())
  let guard = 0
  while (!(await focused()) && guard++ < 60) await page.keyboard.press('Tab')
  assert.equal((await focused())?.name, 'Pins, 3')
})

test('Escape returns the composer to Comment and the popover to the pill', { skip, timeout: 60000 }, async () => {
  // Walking the page with Tab scrolled it.
  await page.evaluate(() => window.scrollTo(0, 0))
  await host('.mode').click()
  const box = await page.locator('[data-testid="hero-eyebrow"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await host('.card textarea').waitFor()
  assert.equal(await host('.card').getAttribute('role'), 'dialog')
  await page.keyboard.press('Escape')
  assert.equal(await host('.card').count(), 0)
  assert.equal((await focused())?.text, 'Commenting')
  // Again: comment mode ends, focus stays on Comment.
  await page.keyboard.press('Escape')
  assert.equal((await focused())?.text, 'Comment')

  // The popover opens from the pill, says so, and Escape closes only it.
  await page.keyboard.press('Home')
  assert.match((await focused())?.name, /^Project: /)
  await page.keyboard.press('Enter')
  await host('.pop.show').waitFor()
  assert.equal(await host('.pill').getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('Escape')
  await host('.pop.show').waitFor({ state: 'detached' })
  assert.equal(await host('.pill').getAttribute('aria-expanded'), 'false')
  assert.match((await focused())?.name, /^Project: /)
  assert.equal(await host('.bar').isVisible(), true)
})

test('the live region announces dispatch, answers, resolutions and errors', { skip, timeout: 60000 }, async () => {
  const region = await page.evaluate(() => {
    const r = document.getElementById('pinpoint-host').shadowRoot.querySelector('[aria-live="polite"]')
    return r && { role: r.getAttribute('role'), atomic: r.getAttribute('aria-atomic') }
  })
  assert.deepEqual(region, { role: 'status', atomic: 'true' })

  await host('.bar button.primary').click()
  await liveSays(/^Dispatched 1 to /)

  bridge.emit({ type: 'resolved', id: 'seed#1', resolution: 'title is smaller' })
  await liveSays(/#1 resolved — title is smaller/)

  bridge.emit({ type: 'reply', id: 'seed#3', text: 'It is the secondary style.' })
  await liveSays(/Answer on pin 3: It is the secondary style\./)
  await page.keyboard.press('Escape')

  bridge.emit({ type: 'reply', id: 'seed#2', text: '' })
  await liveSays(/#2 .*replied without an answer/)
})

test('reduced motion drops the pin animations and forced colours keep the focus ring', { skip, timeout: 60000 }, async () => {
  await load()
  await host('.pin').first().waitFor({ timeout: 15000 })
  await page.evaluate(() => document.getElementById('pinpoint-host').shadowRoot.querySelector('.pin').focus())
  const look = () => page.evaluate(() => {
    const root = document.getElementById('pinpoint-host').shadowRoot
    const pin = root.activeElement
    const working = root.querySelector('.pin.working')
    const s = getComputedStyle(pin)
    return {
      outline: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), transition: s.transitionDuration,
      transform: s.transform, animation: working ? getComputedStyle(working).animationName : null,
      fill: s.backgroundColor, border: s.borderTopStyle,
    }
  })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const still = await look()
  assert.equal(still.outline, 'solid')
  assert.ok(still.outlineWidth >= 2)
  assert.equal(still.transition, '0s')
  assert.equal(still.transform, 'none')
  assert.equal(still.animation, 'none')

  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
  const forced = await look()
  assert.equal(forced.outline, 'solid')
  assert.ok(forced.outlineWidth >= 2)
  assert.equal(forced.animation, 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
  const moving = await look()
  assert.notEqual(moving.animation, 'none', 'the working pulse is gone without reduced motion')
})

test('at 200% zoom no primary action is clipped', { skip, timeout: 60000 }, async () => {
  // 1280x800 at 200% zoom is a 640x400 CSS viewport.
  await page.setViewportSize({ width: 640, height: 400 })
  await page.waitForTimeout(300)
  const view = { width: 640, height: 400 }
  const inView = (b, what) => {
    assert.ok(b, `${what} has no box`)
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width + 0.5 && b.y + b.height <= view.height + 0.5,
      `${what} is clipped: ${JSON.stringify(b)}`)
  }

  const items = host('.bar > button')
  for (let i = 0; i < await items.count(); i++) inView(await items.nth(i).boundingBox(), `toolbar item ${i}`)

  // The popover fits, or scrolls inside itself, with every row reachable.
  await host('.pill').click()
  await host('.pop.show').waitFor()
  inView(await host('.pop').boundingBox(), 'the popover')
  const how = host('.pop button').filter({ hasText: 'How it works' })
  await how.scrollIntoViewIfNeeded()
  inView(await how.boundingBox(), 'How it works')
  await page.keyboard.press('Escape')

  // The stack's card scrolls inside itself, with its sections' actions reachable.
  await page.evaluate(() => window.scrollTo(0, 0))
  const stack = host('.pin.stack')
  await stack.focus()
  await page.keyboard.press('Enter')
  await host('.card').waitFor()
  await page.waitForTimeout(200)
  inView(await host('.card').boundingBox(), 'the pin card')
  const last = host('.card button.danger').last()
  await last.scrollIntoViewIfNeeded()
  inView(await last.boundingBox(), 'the last Remove')
  await page.keyboard.press('Escape')

  // The composer keeps Add and Cancel on screen.
  await host('.mode').click()
  const box = await page.locator('[data-testid="hero-title"]').boundingBox()
  await page.mouse.click(box.x + 20, box.y + Math.min(10, box.height / 2))
  await host('.card textarea').waitFor()
  await page.waitForTimeout(200)
  inView(await host('.card').boundingBox(), 'the composer')
  inView(await host('.card button.primary').boundingBox(), 'Add')
  inView(await host('.card button').filter({ hasText: 'Cancel' }).boundingBox(), 'Cancel')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 800 })
})

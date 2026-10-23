#!/usr/bin/env node
/**
 * Store screenshots that tell the story of the two-way link to Claude Code: pin and
 * dispatch, ask a question and get the answer on the pin, park a note on the backlog, and
 * watch a fix land. Each one carries a caption strip above the page.
 *
 *   node scripts/store-shots.js 1280x800 store/chrome/screenshots
 *
 * `npm run store:shots` runs this and then scripts/store-tiles.js, which also scales the set
 * down for Opera (store/screenshots).
 *
 * It reuses the test harness: the real extension in Playwright's Chromium, the demo page,
 * and a stub bridge. The stub answers the way the real one does and plays Claude's side: the
 * same `reply`, `progress` and `resolved` events the bridge sends over its event stream.
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { available, listen, startDemo, extensionCopy } from '../test/screens/shoot.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [sizeArg = '1280x800', outArg = 'store/chrome/screenshots'] = process.argv.slice(2)
const OUT = join(ROOT, outArg)
const [WIDTH, HEIGHT] = sizeArg.split('x').map(Number)
/** The caption strip, and the page under it. */
const STRIP = WIDTH >= 1000 ? 96 : 72
const PAGE = { width: WIDTH, height: HEIGHT - STRIP }
const PROJECT = { name: 'nimbus', projectDir: '/Users/dev/nimbus' }

const CAPTIONS = {
  '1-dispatch': ['Pin it. Dispatch it to Claude Code.', 'The element, its styles and a screenshot arrive in your session.'],
  '2-ask': ['Ask a question from the page.', 'Start a note with ? and Claude answers. No files change.'],
  '3-answer': ['The answer lands on your pin.', 'Claude Code replies through its channel, right where you asked.'],
  '4-backlog': ['Park it for later.', 'Start a note with ! and it joins your repo’s backlog.'],
  '5-fixed': ['Claude fixes it. The pin turns green.', 'It edits your code, checks the element again and marks it done.'],
}

const browser = await available()
if (!browser.ok) {
  console.error(`store-shots: ${browser.why}`)
  process.exit(1)
}

const { version } = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'))

// ---------------------------------------------------------------- the stub bridge

const streams = new Set()
let seq = 0
/** Claude's side: an event on the stream the extension is already listening to. */
const emit = event => {
  const frame = `data: ${JSON.stringify({ seq: ++seq, projectDir: PROJECT.projectDir, ...event })}\n\n`
  for (const res of streams) res.write(frame)
}

const bridge = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const body = cb => { let b = ''; req.on('data', d => { b += d }); req.on('end', () => cb(JSON.parse(b || '{}'))) }
  if (url.pathname === '/health') {
    return json(200, {
      ok: true, version, projectDir: PROJECT.projectDir, pending: 0, backlog: 0, sessions: [PROJECT],
      route: { how: 'auto', projectDir: PROJECT.projectDir, detected: PROJECT.projectDir, detectedName: PROJECT.name },
      capabilities: { 'comment-scope-v1': true },
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
    return body(p => json(200, { ok: true, batch: 'story-0001', count: p.comments?.length ?? 0, projectDir: PROJECT.projectDir, name: PROJECT.name }))
  }
  if (url.pathname === '/backlog' && req.method === 'POST') {
    return body(() => json(200, { ok: true, id: 'story-backlog-1', projectDir: PROJECT.projectDir, name: PROJECT.name }))
  }
  json(404, { ok: false })
})
bridge.keepAliveTimeout = 0

// ---------------------------------------------------------------- the shots

const bridgePort = await listen(bridge)
const demo = await startDemo()
const ext = await extensionCopy(bridgePort)
const profile = await mkdtemp(join(tmpdir(), 'pinpoint-store-'))
let context
try {
  await mkdir(OUT, { recursive: true })
  context = await browser.chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: PAGE,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-GB',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--hide-scrollbars'],
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const page = context.pages()[0] ?? await context.newPage()

  const welcome = `chrome-extension://${new URL(worker.url()).host}/welcome.html`
  const isWelcome = p => p.url().startsWith(welcome)
  const opened = context.pages().find(isWelcome) ?? await context.waitForEvent('page', { predicate: isWelcome, timeout: 10000 }).catch(() => null)
  await opened?.close()

  const host = sel => page.locator(`#pinpoint-host ${sel}`)
  const rest = async () => { await page.mouse.move(PAGE.width - 2, PAGE.height - 2); await page.waitForTimeout(350) }

  // The caption strip is drawn by a second page around the screenshot of the first.
  const frame = await (await browser.chromium.launch({ channel: 'chromium' })).newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  const shot = async name => {
    const [title, sub] = CAPTIONS[name]
    const png = (await page.screenshot({ animations: 'disabled', caret: 'hide' })).toString('base64')
    await frame.setContent(`<!doctype html><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      .c { box-sizing: border-box; height: ${STRIP}px; padding: 0 ${WIDTH >= 1000 ? 40 : 24}px; display: flex; flex-direction: column; justify-content: center; border-bottom: 1px solid #e0e0e0; }
      .t { font-size: ${WIDTH >= 1000 ? 28 : 21}px; font-weight: 700; letter-spacing: -0.02em; color: #0a0a0a; }
      .s { font-size: ${WIDTH >= 1000 ? 16 : 13}px; color: #5c5c5c; margin-top: 4px; }
      img { display: block; width: ${PAGE.width}px; height: ${PAGE.height}px; }
    </style><div class="c"><div class="t">${title}</div><div class="s">${sub}</div></div><img src="data:image/png;base64,${png}">`)
    await frame.screenshot({ path: join(OUT, `${name}.png`) })
  }

  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
  })
  await host('.bar').waitFor({ timeout: 15000 })
  await host('.pill-label').filter({ hasText: PROJECT.name }).waitFor({ timeout: 15000 })
  await host('.tip-x').click({ timeout: 3000 }).catch(() => {})
  await page.evaluate(() => window.scrollTo(0, 140))

  /** Comment mode, a click on the element, a note, and Add (or Ask, or Backlog). */
  async function comment(selector, note, { shotName } = {}) {
    await host('.mode').click()
    const box = await page.locator(selector).first().boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await host('.card textarea').fill(note, { timeout: 8000 }).catch(err => {
      throw new Error(`no composer for "${note}" at ${selector} (${JSON.stringify(box)}): ${err.message.split('\n')[0]}`)
    })
    // A headless browser has no icon click behind it, so a capture would end in an error toast.
    await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
    await page.waitForTimeout(450)
    if (shotName) { await page.mouse.move(PAGE.width - 2, 2); await shot(shotName) }
    await host('.card button.primary').click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }

  await comment('[data-testid="cta-primary"]', 'Make this button larger')
  await comment('[data-testid="hero-sub"]', 'Tighten the line height')
  await comment('[data-testid="cta-secondary"]', '? Why is this button grey? Is it the secondary style?', { shotName: '2-ask' })
  await rest()
  await shot('1-dispatch')

  await comment('[data-testid="stats-band"]', '! Check the stats band spacing on mobile', { shotName: '4-backlog' })
  await rest()

  // Dispatch: three comments, numbered 1 to 3 by the bridge, as the real one does.
  await host('button.primary', { hasText: 'Dispatch' }).first().click()
  await page.waitForTimeout(500)

  // Claude answers the question, on pin 3.
  emit({ type: 'reply', id: 'story-0001#3', text: 'It is the secondary button style from the theme. The primary one is the purple above it. I left it as it is.' })
  await page.waitForTimeout(500)
  await host('.pin').nth(2).click()
  await page.waitForTimeout(500)
  await shot('3-answer')
  await page.keyboard.press('Escape')

  // Claude works on pin 1, then closes it.
  emit({ type: 'progress', id: 'story-0001#1', state: 'working', note: 'editing Button.tsx' })
  await page.waitForTimeout(400)
  emit({ type: 'progress', id: 'story-0001#1', state: 'edited', note: 'padding 14px 28px, font 16px', files: ['src/Button.tsx +4 -2'] })
  await page.waitForTimeout(400)
  emit({ type: 'resolved', id: 'story-0001#1', resolution: 'Raised the padding to 14px 28px and the font to 16px in Button.tsx' })
  await page.waitForTimeout(600)
  await host('.pin').nth(0).click()
  await page.waitForTimeout(500)
  await shot('5-fixed')

  console.log(`store-shots: wrote ${Object.keys(CAPTIONS).length} screenshots to ${OUT}`)
  await frame.context().browser().close()
} finally {
  await context?.close().catch(() => {})
  bridge.close()
  demo.stop()
  await rm(profile, { recursive: true, force: true })
  await rm(ext, { recursive: true, force: true })
}
process.exit(0)

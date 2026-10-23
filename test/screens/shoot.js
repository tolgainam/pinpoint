/**
 * Takes the reference screenshots: the unpacked extension loaded into Playwright's
 * Chromium, on the demo page, talking to a stub bridge.
 *
 * Used by test/screens.test.js, which compares against the PNGs next to this file, and by
 * scripts/screens-update.js, which rewrites them. Nothing here decides pass or fail.
 *
 * The extension is copied to a temp folder with its bridge port rewritten, so the stub
 * never fights a real bridge on 8788 and the shipped worker needs no test-only hook.
 *
 * Baselines are per platform (one reference picture per screen and OS): text renders
 * differently on each, and no tolerance small enough to catch a real change also hides
 * a different font rasteriser.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

export const SCREENS_DIR = HERE
export const NAMES = ['toolbar', 'tip', 'popover', 'mismatch', 'offline', 'composer', 'welcome']
export const baselinePath = name => join(HERE, `${name}.${process.platform}.png`)

const VIEWPORT = { width: 1280, height: 800 }

/**
 * Playwright's own Chromium, or a reason it cannot run. A missing browser is a skip, not
 * a failure: `npm test` has to work on a fresh clone before anyone downloads 150MB.
 */
export async function available() {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { return { ok: false, why: 'playwright is not installed (npm ci)' } }
  const exe = chromium.executablePath()
  if (!exe || !existsSync(exe)) return { ok: false, why: 'Playwright Chromium is not installed (npx playwright install chromium)' }
  return { ok: true, chromium }
}

/**
 * How different two PNGs are. THRESHOLD is pixelmatch's per-pixel colour distance (its
 * default of 0.1 let a nudge of the accent through); the ratio is how many pixels may
 * differ at all before it counts as a change. Both are small: the same Chromium on the
 * same machine renders these byte for byte, so the slack is only for antialiasing noise,
 * never for a colour or a spacing step.
 */
export const MAX_DIFF_RATIO = 0.001
const THRESHOLD = 0.02

export async function compare(actual, expected) {
  const { PNG } = await import('pngjs')
  const { default: pixelmatch } = await import('pixelmatch')
  const a = PNG.sync.read(actual)
  const b = PNG.sync.read(expected)
  if (a.width !== b.width || a.height !== b.height) {
    return { same: false, why: `size ${a.width}x${a.height}, baseline ${b.width}x${b.height}`, diff: null }
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: THRESHOLD })
  const ratio = pixels / (a.width * a.height)
  return {
    same: ratio <= MAX_DIFF_RATIO,
    why: `${pixels} pixels differ (${(ratio * 100).toFixed(2)}%, allowed ${(MAX_DIFF_RATIO * 100).toFixed(2)}%)`,
    diff: PNG.sync.write(diff),
  }
}

// ---------------------------------------------------------------- servers

export const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

/**
 * Just enough bridge for the toolbar: /health with two sessions, or a 503 when offline,
 * an /events stream that stays open and says nothing, and an empty design system.
 *
 * It answers with the extension's own version, so the toolbar shows no version mark
 * until a shot sets `state.version` to something else on purpose.
 */
function stubBridge(version) {
  const state = { online: true, version }
  const sessions = [
    { name: 'nimbus', projectDir: '/Users/dev/nimbus' },
    { name: 'rigboard', projectDir: '/Users/dev/rigboard' },
  ]
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/health') {
      if (!state.online) return res.writeHead(503).end('offline')
      return json(200, {
        ok: true, version: state.version, projectDir: sessions[0].projectDir, pending: 0, backlog: 0, sessions,
        route: { how: 'auto', projectDir: sessions[0].projectDir, detected: sessions[0].projectDir, detectedName: 'nimbus' },
        capabilities: { 'comment-scope-v1': true },
      })
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(': stub\n\n')
      return
    }
    if (url.pathname === '/design-system') return json(200, { ok: true, detected: false })
    json(404, { ok: false })
  })
  server.keepAliveTimeout = 0
  return { server, state }
}

/** The demo page, on a free port so a demo you already have running is left alone. */
export async function startDemo() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise(r => probe.close(r))
  const child = spawn(process.execPath, [join(ROOT, 'demo', 'serve.js')], {
    env: { ...process.env, DEMO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`demo server exited (${code})`)))
    child.stdout.on('data', d => { if (String(d).includes('demo on')) resolve() })
  })
  return { port, stop: () => child.kill() }
}

/** The extension as shipped, except for the one line naming the bridge. */
export async function extensionCopy(bridgePort) {
  const dir = await mkdtemp(join(tmpdir(), 'pinpoint-ext-'))
  await cp(join(ROOT, 'extension'), dir, { recursive: true })
  const worker = join(dir, 'worker.js')
  const src = await readFile(worker, 'utf8')
  const out = src.replace("'http://127.0.0.1:8788'", `'http://127.0.0.1:${bridgePort}'`)
  if (out === src) throw new Error('could not find the bridge URL in worker.js')
  await writeFile(worker, out)
  return dir
}

// ---------------------------------------------------------------- shots

/**
 * No motion and no caret, inside the shadow root too: a page-level stylesheet never
 * reaches in there, so it is added to the overlay's own root.
 */
const STILL = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }'

/** The union of some overlay elements' boxes plus a margin, so shadows are in frame. */
async function clipOf(page, selectors, pad = 16) {
  const boxes = []
  for (const sel of selectors) {
    const box = await page.locator(sel).first().boundingBox()
    if (box) boxes.push(box)
  }
  if (!boxes.length) throw new Error(`nothing to shoot for ${selectors.join(', ')}`)
  const x = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.x)) - pad))
  const y = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.y)) - pad))
  const right = Math.min(VIEWPORT.width, Math.ceil(Math.max(...boxes.map(b => b.x + b.width)) + pad))
  const bottom = Math.min(VIEWPORT.height, Math.ceil(Math.max(...boxes.map(b => b.y + b.height)) + pad))
  return { x, y, width: right - x, height: bottom - y }
}

const shot = async (page, selectors) =>
  page.screenshot({ clip: await clipOf(page, selectors), animations: 'disabled', caret: 'hide' })

/** @returns {Promise<Record<string, Buffer>>} one PNG per name in NAMES */
export async function shootAll(chromium) {
  const { version } = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  const { server, state } = stubBridge(version)
  const bridgePort = await listen(server)
  const demo = await startDemo()
  const ext = await extensionCopy(bridgePort)
  const profile = await mkdtemp(join(tmpdir(), 'pinpoint-profile-'))
  let context
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      locale: 'en-GB',
      timezoneId: 'UTC',
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--font-render-hinting=none', '--hide-scrollbars'],
    })
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    const extId = new URL(worker.url()).host
    const welcomeUrl = `chrome-extension://${extId}/welcome.html`
    const page = context.pages()[0] ?? await context.newPage()

    // A first install opens the welcome tab. Closed here, so the toggle below reaches the
    // demo tab, and opened again at the end on purpose, once the bridge is offline.
    const isWelcome = p => p.url().startsWith(welcomeUrl)
    const opened = context.pages().find(isWelcome)
      ?? await context.waitForEvent('page', { predicate: isWelcome, timeout: 10000 }).catch(() => null)
    if (!opened) throw new Error('the welcome tab did not open on install')
    await opened.close()

    const label = page.locator('#pinpoint-host .pill-label')
    const settle = async text => {
      await label.filter({ hasText: text }).waitFor({ timeout: 15000 })
      await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(150)
    }

    // The icon click, as the worker hears it: a toggle message to the active tab. The
    // toolbar starts hidden on every page load, and this is what shows it.
    const iconClick = () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
    })
    const tipFlag = () => worker.evaluate(async key => (await chrome.storage.local.get(key))[key], 'pp.tipSeen')

    await page.goto(`http://localhost:${demo.port}/`)
    await page.locator('#pinpoint-host .bar').waitFor({ state: 'attached', timeout: 15000 })
    // Nothing of the tip before the first click: not on screen, and not flagged either,
    // which is what the welcome page's step 3 reads.
    await page.waitForTimeout(500)
    if (await page.locator('#pinpoint-host .tip.show').count()) throw new Error('the tip showed before the toolbar did')
    if ((await tipFlag()) !== undefined) throw new Error('pp.tipSeen was set before the toolbar was shown')
    await iconClick()
    await page.locator('#pinpoint-host .bar').waitFor({ timeout: 15000 })
    await page.evaluate(css => {
      const s = document.createElement('style')
      s.textContent = css
      document.getElementById('pinpoint-host').shadowRoot.append(s)
    }, STILL)

    const out = {}
    await settle('nimbus')
    // A fresh profile has never seen the toolbar, so the first-show tip is up. Shot, then
    // dismissed with its x, which is also what keeps it out of every shot after this one.
    await page.locator('#pinpoint-host .tip.show').waitFor({ timeout: 5000 })
    out.tip = await shot(page, ['#pinpoint-host .bar', '#pinpoint-host .tip'])
    if ((await tipFlag()) !== 'shown') throw new Error('pp.tipSeen is not "shown" after the first show')
    await page.locator('#pinpoint-host .tip-x').click()
    await page.locator('#pinpoint-host .tip').waitFor({ state: 'hidden', timeout: 5000 })
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2)
    await page.waitForTimeout(150)
    out.toolbar = await shot(page, ['#pinpoint-host .bar'])

    await page.locator('#pinpoint-host .pill').click()
    await page.locator('#pinpoint-host .pop.show').waitFor()
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2)
    await page.waitForTimeout(150)
    out.popover = await shot(page, ['#pinpoint-host .bar', '#pinpoint-host .pop'])
    await page.keyboard.press('Escape')

    // Comment mode comes from the Comment button; the icon only shows and hides the toolbar.
    await page.locator('#pinpoint-host .mode').click()
    const target = await page.locator('[data-testid="cta-primary"]').boundingBox()
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
    await page.locator('#pinpoint-host .card').waitFor()
    await page.locator('#pinpoint-host .card .chips > *').first().waitFor({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(300)
    out.composer = await shot(page, ['#pinpoint-host .card', '#pinpoint-host .highlight', '#pinpoint-host .highlight .tag'])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // A bridge one minor version ahead: the pill gains its mark on the next ping, and
    // the popover the extension-older line above "How it works".
    const [maj, min] = version.split('.').map(Number)
    state.version = `${maj}.${min + 1}.0`
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2)
    await page.locator('#pinpoint-host .pill-warn').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('#pinpoint-host .pill').click()
    await page.locator('#pinpoint-host .pop.show .pop-version').waitFor({ state: 'visible' })
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2)
    await page.waitForTimeout(150)
    out.mismatch = await shot(page, ['#pinpoint-host .bar', '#pinpoint-host .pop'])
    await page.keyboard.press('Escape')
    // Escape leaves keyboard focus, and its ring, on the pill; the Offline shot is the
    // toolbar at rest, as it was before this step existed.
    await page.evaluate(() => document.getElementById('pinpoint-host').shadowRoot.activeElement?.blur())

    // Offline last: the next 5s ping is what notices, so this one waits for it. No
    // version check while Offline, so the mark goes with it.
    state.online = false
    await settle('Offline')
    out.offline = await shot(page, ['#pinpoint-host .bar'])

    // The welcome page with no bridge: the not-connected box. Step 3 is ticked, since
    // the toolbar has been on screen by now.
    // Shot at a narrow width, whole page, so it reads the way it does in a small window.
    const welcome = await context.newPage()
    await welcome.setViewportSize({ width: 600, height: 800 })
    await welcome.goto(welcomeUrl)
    await welcome.locator('#bridge[data-state="offline"]').waitFor({ timeout: 10000 })
    await welcome.locator('#step-toolbar.done').waitFor({ timeout: 5000 })
    await welcome.evaluate(css => {
      const s = document.createElement('style')
      s.textContent = css
      document.head.append(s)
    }, STILL)
    await welcome.evaluate(() => document.fonts.ready)
    await welcome.waitForTimeout(150)
    out.welcome = await welcome.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' })

    return out
  } finally {
    await context?.close().catch(() => {})
    demo.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(ext, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  }
}

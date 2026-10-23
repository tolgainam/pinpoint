/**
 * An answer that arrives while the bridge restarts. The real server and the real extension, in
 * Chromium.
 *
 * The bridge numbers its events from 1 on every start. The extension remembers the last number it
 * saw and asks for everything after it, so after a restart it asked for "everything after 3" of a
 * bridge that had sent one, and the answer that landed while its worker was reconnecting never
 * showed until the extension was reloaded. Events now carry the run they belong to.
 *
 * Skips, saying why, when Playwright's Chromium is not installed.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { available, startDemo, extensionCopy } from './screens/shoot.js'
import { freePort } from './port.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = await freePort()
const browser = await available()
if (!browser.ok) console.log(`restart test skipped: ${browser.why}`)

const project = mkdtempSync(join(tmpdir(), 'pinpoint-restart-project-'))
const queue = mkdtempSync(join(tmpdir(), 'pinpoint-restart-queue-'))
let client, context, page, worker, demo, ext, profile

async function startBridge() {
  const c = new Client({ name: 'restart-test', version: '0' }, { capabilities: {} })
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'server', 'pinpoint.js')],
    env: { ...process.env, PINPOINT_PORT: String(PORT), PINPOINT_QUEUE: queue, PINPOINT_PROJECT_DIR: project, PINPOINT_LSOF: '/usr/bin/false' },
    stderr: 'ignore',
  }))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return c } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('the bridge did not start')
}

before(async () => {
  if (!browser.ok) return
  client = await startBridge()
  demo = await startDemo()
  ext = await extensionCopy(PORT)
  profile = await mkdtemp(join(tmpdir(), 'pinpoint-restart-profile-'))
  context = await browser.chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  page = context.pages()[0] ?? await context.newPage()
  const welcome = `chrome-extension://${new URL(worker.url()).host}/welcome.html`
  const isWelcome = p => p.url().startsWith(welcome)
  const opened = context.pages().find(isWelcome) ?? await context.waitForEvent('page', { predicate: isWelcome, timeout: 10000 }).catch(() => null)
  await opened?.close()
}, { timeout: 90000 })

after(async () => {
  await context?.close().catch(() => {})
  await client?.close().catch(() => {})
  demo?.stop()
  for (const dir of [profile, ext, project, queue]) if (dir) await rm(dir, { recursive: true, force: true })
})

test('an answer that lands while the bridge restarts still reaches the pin', { skip: !browser.ok, timeout: 120000 }, async () => {
  const host = s => page.locator(`#pinpoint-host ${s}`)
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ state: 'attached', timeout: 15000 })
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
  })
  await host('.pill-label').waitFor({ timeout: 15000 })
  await host('.tip-x').click({ timeout: 2000 }).catch(() => {})

  // A question, dispatched to the first run of the bridge.
  await host('.mode').click()
  const box = await page.locator('[data-testid="cta-secondary"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await host('.card textarea').fill('? why is this grey')
  await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
  await host('.card button.primary').click()
  await page.keyboard.press('Escape')
  await host('button.primary', { hasText: 'Dispatch' }).first().click()
  await page.waitForTimeout(800)
  const brief = (await client.callTool({ name: 'list_comments', arguments: {} })).content.map(c => c.text).join('\n')
  const id = (brief.match(/### \[([\w-]+#\d+)\]/) ?? [])[1]
  assert.ok(id, 'the question was not queued')

  // Let the worker see a few events, so the number it remembers is higher than a new run reaches.
  for (let i = 0; i < 3; i++) await client.callTool({ name: 'reply', arguments: { text: `warm-up ${i}` } })
  await page.waitForTimeout(1200)

  // The bridge goes away and comes back as a new run. The answer is sent at once, before the
  // worker has found the new stream: that is the one the old numbering lost.
  await client.close()
  await page.waitForTimeout(1500)
  client = await startBridge()
  await client.callTool({ name: 'reply', arguments: { id, text: 'It is the secondary style, sent across a restart.' } })

  await host('.card .answer').filter({ hasText: 'sent across a restart' }).waitFor({ timeout: 20000 })
})

test('an answer the page never heard is read from the bridge when the tab is looked at again', { skip: !browser.ok, timeout: 120000 }, async () => {
  const host = s => page.locator(`#pinpoint-host ${s}`)
  await page.goto(`http://localhost:${demo.port}/`)
  await host('.bar').waitFor({ timeout: 15000 })
  // The earlier test's answer was shown but not saved before this page loaded, so the page
  // asks the bridge for it and opens its card. Close it, as a user would.
  await page.waitForTimeout(1500)
  if (await host('.card').count()) await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // A question, dispatched and sitting unanswered.
  await host('.mode').click()
  const box = await page.locator('[data-testid="cta-primary"]').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await host('.card textarea').fill('? what does this button do')
  await host('.card input[type=checkbox]').first().uncheck().catch(() => {})
  await host('.card button.primary').click()
  await page.keyboard.press('Escape')
  await host('button.primary', { hasText: 'Dispatch' }).first().click()
  await page.waitForTimeout(800)
  const brief = (await client.callTool({ name: 'list_comments', arguments: {} })).content.map(c => c.text).join('\n')
  // The heading line carries the note; the line above each batch quotes it too, so match the heading.
  const id = (brief.match(/### \[([\w-]+#\d+)\][^\n]*what does this button do/) ?? [])[1]
  assert.ok(id, 'the question was not queued')

  // The answer lands on disk and no event reaches the page: the way a missed event looks from
  // the page. A session that answered while the bridge was down would leave exactly this.
  const [batch, n] = id.split('#')
  const file = join(queue, batch, 'batch.json')
  const b = JSON.parse(await readFile(file, 'utf8'))
  b.comments.find(c => c.n === Number(n)).answer = 'It starts the free plan. Nobody told the page.'
  await writeFile(file, JSON.stringify(b, null, 2))
  assert.equal(await host('.card .answer').count(), 0)

  // The user comes back to the tab.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await host('.card .answer').filter({ hasText: 'Nobody told the page' }).waitFor({ timeout: 10000 })
})

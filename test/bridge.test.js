/**
 * The bridge end to end: MCP over stdio and HTTP on the same process, which is how it
 * actually runs.
 *
 * The parts Phase D added are all handshakes — a tool call that waits for the page to
 * answer, an event the page has to hear, a file that has to exist afterwards — and a
 * handshake is exactly the thing a unit test cannot tell you is working.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8811
const BRIDGE = `http://127.0.0.1:${PORT}`
/** The smallest real PNG, so the write path is exercised without carrying an image around. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let client
let projectDir
let queueDir
/** Every SSE event the bridge has broadcast since the stream opened. */
const events = []
let stream

const post = (path, body) => fetch(BRIDGE + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
  body: JSON.stringify(body),
}).then(r => r.json())

const call = (name, args = {}) => client.callTool({ name, arguments: args })
const textOf = res => res.content.map(c => c.text).join('\n')
const history = () => (existsSync(join(projectDir, '.pinpoint', 'history.md'))
  ? readFileSync(join(projectDir, '.pinpoint', 'history.md'), 'utf8')
  : '')

/** Events are asynchronous by nature; poll for the one we are waiting on rather than sleep. */
async function waitFor(predicate, what, ms = 4000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const hit = events.find(predicate)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(events.map(e => e.type))}`)
}

/** The extension's SSE connection, read the way the service worker reads it. */
async function openStream() {
  const res = await fetch(`${BRIDGE}/events?since=0`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const line = frame.split('\n').find(l => l.startsWith('data: '))
          if (line) { try { events.push(JSON.parse(line.slice(6))) } catch { /* not ours */ } }
        }
      }
    } catch { /* closed with the server */ }
  })()
  return reader
}

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'pinpoint-project-'))
  queueDir = mkdtempSync(join(tmpdir(), 'pinpoint-queue-'))

  client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'server', 'pinpoint.js')],
    env: {
      ...process.env,
      PINPOINT_PORT: String(PORT),
      PINPOINT_QUEUE: queueDir,
      PINPOINT_PROJECT_DIR: projectDir,
      // Routing is covered by routing.test.js. Here, a dev server that happens to be on
      // :3000 must not decide where the batch goes, so lsof finds nothing.
      PINPOINT_LSOF: '/usr/bin/false',
      // Long enough that a slow machine does not fail the handshake, short enough that a
      // genuinely missing answer does not stall the suite.
      PINPOINT_RECAPTURE_MS: '3000',
    },
  }))

  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BRIDGE}/health`)).ok) break } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }
  stream = await openStream()
})

after(async () => {
  try { await stream?.cancel() } catch { /* already gone */ }
  try { await client?.close() } catch { /* already gone */ }
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(queueDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- the loop

test('an empty queue says so rather than erroring', async () => {
  assert.match(textOf(await call('list_comments')), /No pending comments/)
})

test('every Phase D tool is advertised', async () => {
  const { tools } = await client.listTools()
  const names = tools.map(t => t.name)
  for (const name of ['list_comments', 'resolve_comment', 'reply', 'report_progress']) {
    assert.ok(names.includes(name), `missing ${name}`)
  }
})

test('reply refuses an empty answer and says how to call it, and takes the usual other names', async () => {
  const empty = await call('reply', { id: '20260101-000000-abcd#1' })
  assert.equal(empty.isError, true)
  assert.match(textOf(empty), /needs `text`/)
  assert.equal((await call('reply', { id: '20260101-000000-abcd#1', text: '   ' })).isError, true)

  // Claude's own calls used `message` about as often as `text`. Both arrive.
  await call('reply', { id: '20260101-000000-abcd#1', message: 'Sent as message.' })
  await waitFor(e => e.type === 'reply' && e.text === 'Sent as message.', 'the reply sent as message')

  const before = events.length
  const ok = await call('reply', { id: '20260101-000000-abcd#1', answer: 'It is the secondary style.' })
  assert.notEqual(ok.isError, true)
  const sent = await waitFor(e => e.type === 'reply' && e.text === 'It is the secondary style.', 'the reply event')
  assert.equal(events.length > before, true)
  assert.equal(sent.id, '20260101-000000-abcd#1')
})

test('resolve_comment takes the note under the names Claude uses for it', async () => {
  const res = await post('/dispatch', {
    origin: 'http://localhost:3000',
    url: 'http://localhost:3000/',
    comments: [{ note: 'tighten this', selector: '[data-testid="cta"]', rect: { x: 4, y: 4, w: 80, h: 30 } }],
  })
  assert.equal(res.ok, true)
  // Claude's own calls came as {id, note} as well as {id, resolution}.
  await call('resolve_comment', { id: `${res.batch}#1`, note: 'Raised the padding to 14px' })
  assert.match(history(), /Raised the padding to 14px/)
})

test('a dispatched batch reaches list_comments and the history file', async () => {
  const res = await post('/dispatch', {
    origin: 'http://localhost:3000',
    url: 'http://localhost:3000/',
    comments: [
      { note: 'too tight', selector: '[data-testid="cta"]', rect: { x: 4, y: 4, w: 80, h: 30 }, shot: PNG },
      { note: 'what is this', selector: '[data-testid="cta"]', question: true, rect: { x: 4, y: 4, w: 80, h: 30 } },
    ],
  })
  assert.equal(res.ok, true)

  const brief = textOf(await call('list_comments'))
  assert.match(brief, /too tight/)
  assert.match(brief, /this is a question/)
  // Claude Code shows one line per channel event, taken from the start of the content.
  // It has to say where the comments are from and how many, in plain text.
  assert.match(brief.split('\n')[0], /^\[Pinpoint localhost:3000\] 2 comments · “too tight” \+1 more$/)

  const log = history()
  assert.match(log, new RegExp(res.batch))
  assert.match(log, /too tight/)
  // The question is marked as one in the log too, so the record says what was asked for.
  assert.match(log, /❓/)
})

test('report_progress lands on the comment and on the wire', async () => {
  const batch = (await call('list_comments'), lastBatchId())
  const id = `${batch}#1`
  const out = textOf(await call('report_progress', {
    id, state: 'edited', note: 'changed the padding', files: ['demo/style.css +2 -1'],
  }))
  assert.match(out, /edited/)

  const ev = await waitFor(e => e.type === 'progress' && e.id === id, 'a progress event')
  assert.equal(ev.state, 'edited')
  assert.deepEqual(ev.files, ['demo/style.css +2 -1'])

  // Kept on disk as well, so a service worker that was asleep still catches up.
  assert.equal(readBatch(batch).comments[0].progress.state, 'edited')
})

test('report_progress refuses an id that does not exist', async () => {
  const res = await call('report_progress', { id: 'nope#1', state: 'working' })
  assert.equal(res.isError, true)
})

test('resolving asks the page for an after-shot and reports what came back', async () => {
  const batch = lastBatchId()
  const id = `${batch}#1`

  const resolving = call('resolve_comment', { id, resolution: 'padding is now 16px' })
  const ask = await waitFor(e => e.type === 'recapture' && e.id === id, 'a recapture request')
  // The page is told which element and where, so it can re-measure rather than guess.
  assert.equal(ask.selector, '[data-testid="cta"]')
  assert.deepEqual(ask.rect, { x: 4, y: 4, w: 80, h: 30 })

  await post('/recapture', { id, shot: PNG })
  const out = textOf(await resolving)
  assert.match(out, /Resolved/)
  assert.match(out, /after-01\.png/)
  assert.match(out, /read it and check/)

  assert.ok(existsSync(join(queueDir, batch, 'after-01.png')), 'the crop was not written')
  assert.match(history(), /✓ .*#1 — padding is now 16px/)
})

test('a page that cannot answer leaves the fix unverified rather than failing the resolve', async () => {
  const batch = lastBatchId()
  const id = `${batch}#2`
  const resolving = call('resolve_comment', { id, resolution: 'answered in the pin' })
  await waitFor(e => e.type === 'recapture' && e.id === id, 'a recapture request')
  await post('/recapture', { id, error: 'the element is no longer on the page' })

  const out = textOf(await resolving)
  assert.match(out, /Resolved/)
  assert.match(out, /unverified/)
  assert.match(out, /no longer on the page/)
})

test('a follow-up carries the previous round into the brief', async () => {
  const first = lastBatchId()
  const res = await post('/dispatch', {
    origin: 'http://localhost:3000',
    url: 'http://localhost:3000/',
    comments: [{
      note: 'still 2px off',
      selector: '[data-testid="cta"]',
      rect: { x: 4, y: 4, w: 80, h: 30 },
      followUpOf: `${first}#1`,
      round: 2,
    }],
  })
  assert.equal(res.ok, true)

  const brief = textOf(await call('list_comments'))
  assert.match(brief, /follow-up \(round 2\)/)
  assert.match(brief, /too tight/)                    // what was asked the first time
  assert.match(brief, /padding is now 16px/)          // what was done about it
  assert.match(brief, /not enough/)                   // and what that means now
  assert.match(history(), /↩ #1 still 2px off/)
})

test('a follow-up whose original has been pruned still says what it is', async () => {
  const res = await post('/dispatch', {
    origin: 'http://localhost:3000',
    comments: [{ note: 'orphan round', selector: '.x', followUpOf: '19990101-000000-zzzz#1', round: 2 }],
  })
  assert.equal(res.ok, true)
  assert.match(textOf(await call('list_comments')), /no longer in the queue/)
})

test('the design-system endpoint answers with mergeable scales', async () => {
  const out = await post('/design-system', {
    designSystem: { vars: { '--brand': '#123456' }, fingerprints: ['shadcn'] },
  })
  assert.equal(out.ok, true)
  assert.equal(out.color.some(t => t.name === '--brand' && t.hex === '#123456'), true)
})

test('a recapture nobody is waiting for is ignored, not an error', async () => {
  const out = await post('/recapture', { id: 'nobody#1', shot: PNG })
  assert.equal(out.ok, true)
  assert.match(out.ignored, /nothing was waiting/)
})

// ---------------------------------------------------------------- helpers

function lastBatchId() {
  return readdirSync(queueDir).sort().at(-1)
}

function readBatch(id) {
  return JSON.parse(readFileSync(join(queueDir, id, 'batch.json'), 'utf8'))
}

// Last on purpose: the suite shares one queue and the tests above key off the newest
// batch, so anything that dispatches another one has to come after them.
test('what the page logged is stated once for the batch, not once per comment', async () => {
  const res = await post('/dispatch', {
    origin: 'http://localhost:3000',
    url: 'http://localhost:3000/fixtures/tailwind/',
    // Page-level: sent alongside the comments rather than inside any of them, because
    // neither element caused it.
    debug: [
      { at: 120, kind: 'network', text: '404 POST /api/waitlist' },
      { at: 121, kind: 'error', text: 'could not join the waitlist', stack: 'at HTMLButtonElement.<anonymous>' },
    ],
    comments: [
      { note: 'padding is off the scale', selector: '[data-testid="tw-off-scale"]' },
      { note: 'this band is too loud', selector: '[data-testid="tw-cta-band"]' },
    ],
  })
  assert.equal(res.ok, true)

  const brief = textOf(await call('list_comments'))
  assert.match(brief, /the page logged 2 things/)
  assert.match(brief, /404 POST \/api\/waitlist/)
  assert.match(brief, /at HTMLButtonElement/)
  // Once. Repeating it under each comment is what made it read as evidence about the
  // element, which is the whole reason it moved off the comment in the first place.
  assert.equal(brief.match(/404 POST \/api\/waitlist/g).length, 1)
  // And it is above the comments, not buried among them. The opening line quotes the first
  // note for the terminal, so "above the comments" means above their sections.
  assert.ok(brief.indexOf('404 POST') < brief.indexOf('### [' + res.batch))
})

test('health says which extension version talked last, and only believes an extension origin', async () => {
  const health = () => fetch(`${BRIDGE}/health`, { headers: { Origin: 'http://localhost:3000' } }).then(r => r.json())
  // A web page claiming to be the extension is not believed.
  await fetch(`${BRIDGE}/health`, { headers: { Origin: 'http://localhost:3000', 'X-Pinpoint-Extension': '9.9.9' } })
  assert.notEqual((await health()).extension?.version, '9.9.9')

  // The extension itself is.
  await fetch(`${BRIDGE}/health`, { headers: { Origin: 'chrome-extension://abcdefghijklmnop', 'X-Pinpoint-Extension': '0.4.2' } })
  const seen = (await health()).extension
  assert.equal(seen.version, '0.4.2')
  assert.equal(seen.browser, 'chromium')
  assert.ok(seen.secondsAgo < 5)

  await fetch(`${BRIDGE}/health`, { headers: { Origin: 'moz-extension://11111111-2222-3333-4444-555555555555', 'X-Pinpoint-Extension': '0.4.2' } })
  assert.equal((await health()).extension.browser, 'firefox')

  // The worker's GET calls carry no Origin. The browser is then read from its user agent.
  await fetch(`${BRIDGE}/health`, { headers: { 'X-Pinpoint-Extension': '0.4.3', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/138.0 Safari/537.36 OPR/120.0' } })
  const opera = (await health()).extension
  assert.equal(opera.version, '0.4.3')
  assert.equal(opera.browser, 'opera')
})

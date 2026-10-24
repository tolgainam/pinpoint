/**
 * POST /inbox and the reply tool's requiresResponse on a real bridge: MCP over stdio and
 * HTTP on one process, its own queue, home and peer key, and a token, so the route is
 * checked behind the same gate as the other page-facing POSTs.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { freePort } from './port.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = await freePort()
const BRIDGE = `http://127.0.0.1:${PORT}`
const TOKEN = 'inbox-test-token'
const PAGE = 'http://localhost:3000'

let client
let dir
let queueDir
const events = []
let stream

const headers = (extra = {}) => ({ 'Content-Type': 'application/json', Origin: PAGE, 'X-Pinpoint-Token': TOKEN, ...extra })
const post = (path, body, extra) => fetch(BRIDGE + path, { method: 'POST', headers: headers(extra), body: JSON.stringify(body) })
const inbox = async (rows, extra) => (await post('/inbox', { rows }, extra)).json()
const call = (name, args = {}) => client.callTool({ name, arguments: args })
const batchJson = id => JSON.parse(readFileSync(join(queueDir, id, 'batch.json'), 'utf8'))
const state = async ids => (await (await fetch(`${BRIDGE}/state?ids=${encodeURIComponent(ids.join(','))}`, { headers: { Origin: PAGE } })).json()).states

async function waitFor(predicate, what, ms = 4000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const hit = events.find(predicate)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

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

/** A dispatched batch of `n` comments from PAGE, as the extension's worker sends it. */
async function dispatch(notes) {
  const res = await post('/dispatch', {
    origin: PAGE, url: `${PAGE}/settings`, page: PAGE,
    comments: notes.map((note, i) => ({ note, question: note.startsWith('?'), selector: `[data-n="${i}"]`, rect: { x: 0, y: 0, w: 10, h: 10 } })),
  })
  assert.equal(res.status, 200)
  return (await res.json()).batch
}

const row = (id, batch, extra = {}) => ({
  id, key: `pinpoint:v2:${PAGE}/settings`, origin: PAGE, kind: 'question', state: 'Dispatched', note: 'why', batch, ...extra,
})

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pinpoint-inbox-'))
  queueDir = join(dir, 'queue')
  mkdirSync(join(dir, 'project'), { recursive: true })
  mkdirSync(queueDir, { recursive: true })
  client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'server', 'pinpoint.js')],
    env: {
      ...process.env,
      PINPOINT_PORT: String(PORT),
      PINPOINT_QUEUE: queueDir,
      PINPOINT_PROJECT_DIR: join(dir, 'project'),
      PINPOINT_PEER_KEY: join(dir, 'peer.key'),
      PINPOINT_LSOF: '/usr/bin/false',
      PINPOINT_TOKEN: TOKEN,
      PINPOINT_RECAPTURE_MS: '300',
      HOME: dir,
    },
    stderr: 'ignore',
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
  rmSync(dir, { recursive: true, force: true })
})

test('/health advertises project-inbox-v1 beside comment-scope-v1', async () => {
  const health = await (await fetch(`${BRIDGE}/health`, { headers: { Origin: PAGE } })).json()
  assert.equal(health.capabilities['project-inbox-v1'], true)
  assert.equal(health.capabilities['comment-scope-v1'], true)
})

test('the reply tool offers requiresResponse as an optional boolean and says when to set it', async () => {
  const { tools } = await client.listTools()
  const reply = tools.find(t => t.name === 'reply')
  assert.equal(reply.inputSchema.properties.requiresResponse.type, 'boolean')
  assert.ok(!(reply.inputSchema.required ?? []).includes('requiresResponse'))
  assert.match(reply.description, /requiresResponse/)
  assert.match(reply.description, /question or needs a decision/)
})

test('/inbox answers saved answers, resolutions and progress from the batch files, and writes nothing', async () => {
  const batch = await dispatch(['? which colour', 'make it larger', '? why is it grey', 'tighten'])
  await call('reply', { id: `${batch}#1`, text: 'Accent or ink? Pick one.', requiresResponse: true })
  await call('reply', { id: `${batch}#3`, text: 'It is the muted style.' })
  await call('report_progress', { id: `${batch}#4`, state: 'edited', note: 'padding', files: ['src/Card.tsx +2 -1'] })
  await call('resolve_comment', { id: `${batch}#2`, resolution: 'Raised the size' })

  const snapshot = () => readdirSync(queueDir).flatMap(d => readdirSync(join(queueDir, d)).map(f => `${d}/${f}:${statSync(join(queueDir, d, f)).mtimeMs}`)).sort()
  const before = snapshot()
  const got = await inbox([row('q1', `${batch}#1`), row('fix', `${batch}#2`), row('q3', `${batch}#3`), row('edit', `${batch}#4`), row('none', `${batch}#99`)])
  assert.equal(got.ok, true)
  const by = Object.fromEntries(got.items.map(i => [i.id, i]))
  assert.equal(by.q1.status, 'answered')
  assert.equal(by.q1.answer, 'Accent or ink? Pick one.')
  assert.equal(by.q1.requiresResponse, true)
  assert.equal(by.q3.requiresResponse, false, 'absent means false')
  assert.equal(by.fix.status, 'resolved')
  assert.equal(by.fix.resolution, 'Raised the size')
  assert.equal(by.edit.status, 'progress')
  assert.deepEqual(by.edit.progress, { state: 'edited', note: 'padding', files: ['src/Card.tsx +2 -1'] })
  assert.equal(by.none.found, false)
  // No paths, no screenshots, no project leaves this route.
  assert.doesNotMatch(JSON.stringify(got), /shot-|\.png|projectDir|\/queue\//)
  assert.deepEqual(snapshot(), before, '/inbox wrote to the queue')
})

test('/inbox is behind the same gate as the other page-facing POSTs', async () => {
  const batch = await dispatch(['? asked'])
  const rows = [row('q', `${batch}#1`)]
  const noToken = await post('/inbox', { rows }, { 'X-Pinpoint-Token': 'wrong' })
  assert.equal(noToken.status, 401)
  const foreign = await post('/inbox', { rows }, { Origin: 'https://example.com' })
  assert.equal(foreign.status, 403)
  const notJson = await fetch(`${BRIDGE}/inbox`, { method: 'POST', headers: headers({ 'Content-Type': 'text/plain' }), body: '{}' })
  assert.equal(notJson.status, 415)
  const broken = await fetch(`${BRIDGE}/inbox`, { method: 'POST', headers: headers(), body: '{rows:' })
  assert.equal(broken.status, 400)
  // A GET is not the route.
  assert.equal((await fetch(`${BRIDGE}/inbox`, { headers: { Origin: PAGE } })).status, 404)
  // From the extension's worker: an extension Origin and the tab's page in the body.
  const viaWorker = await (await post('/inbox', { rows, page: PAGE }, { Origin: 'chrome-extension://abcdefghijklmnop' })).json()
  assert.equal(viaWorker.items[0].found, true)
  // A local page cannot ask about another origin's comments by claiming that page.
  const claimed = await (await post('/inbox', { rows: [row('q', `${batch}#1`, { origin: 'http://localhost:4000' })], page: 'http://localhost:4000' })).json()
  assert.deepEqual(claimed.items, [])
  assert.equal(claimed.dropped, 1)
})

test('/inbox caps rows at 100 and drops malformed ones without failing', async () => {
  const batch = await dispatch(['? one'])
  const many = Array.from({ length: 150 }, (_, i) => row(`r${i}`, `${batch}#1`))
  const capped = await inbox(many)
  assert.equal(capped.items.length, 100)
  assert.equal(capped.truncated, true)
  const mixed = await inbox([null, 'x', 42, { id: 'no origin' }, row('bad id!', `${batch}#1`), row('ok', '../../etc/passwd#1'), row('good', `${batch}#1`, { note: `a\u0000b`.repeat(200) })])
  assert.equal(mixed.ok, true)
  assert.equal(mixed.dropped, 5)
  assert.deepEqual(mixed.items.map(i => [i.id, i.found]), [['ok', false], ['good', true]])
  assert.deepEqual(await inbox('not a list'), { ok: true, items: [], dropped: 0, truncated: false })
})

test('requiresResponse is stored with the answer, returned by /state and /inbox, and absent means false', async () => {
  const batch = await dispatch(['? first', '? second', '? third'])
  const [a, b, c] = [1, 2, 3].map(n => `${batch}#${n}`)

  // The alias picker is unaffected: an answer under `message` still lands, with the flag.
  await call('reply', { id: a, message: 'Which of the two?', requiresResponse: true })
  const sent = await waitFor(e => e.type === 'reply' && e.id === a, 'the reply event')
  assert.equal(sent.text, 'Which of the two?')
  assert.equal(sent.requiresResponse, true)
  assert.equal(batchJson(batch).comments[0].requiresResponse, true)
  assert.equal(batchJson(batch).comments[0].answer, 'Which of the two?')

  // Absent, or anything but a literal true, is false.
  await call('reply', { id: b, text: 'Here is your answer.' })
  await call('reply', { id: c, answer: 'Also an answer.', requiresResponse: 'true' })
  assert.equal(batchJson(batch).comments[1].requiresResponse, false)
  assert.equal(batchJson(batch).comments[2].requiresResponse, false)
  assert.equal(batchJson(batch).comments[2].answer, 'Also an answer.')

  const st = await state([a, b, c])
  assert.equal(st[a].requiresResponse, true)
  assert.equal(st[b].requiresResponse, false)
  assert.equal(st[c].requiresResponse, false)
  const got = await inbox([row('a', a), row('b', b), row('c', c)])
  assert.deepEqual(got.items.map(i => i.requiresResponse), [true, false, false])

  // A later plain answer clears it.
  await call('reply', { id: a, text: 'Never mind, I went with accent.' })
  assert.equal((await state([a]))[a].requiresResponse, false)

  // An empty answer is still refused, flag or not.
  const empty = await call('reply', { id: a, requiresResponse: true })
  assert.equal(empty.isError, true)
  // A status line without an id carries no flag.
  await call('reply', { text: 'status only', requiresResponse: true })
  const status = await waitFor(e => e.type === 'reply' && e.text === 'status only', 'the status line')
  assert.equal('requiresResponse' in status, false)
})

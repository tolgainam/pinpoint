/**
 * The project lock across real processes: two writers appending to one history at once,
 * a holder that dies holding it, and a live holder that must not be robbed.
 *
 * Each run is fresh temp folders and child processes running test/lock-writer.js, so
 * nothing here needs a port. PINPOINT_LOCK_RUNS raises the number of append races; a
 * release runs it at 25.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withProjectLock, appendHistory, ProjectBusyError, lockPathOf } from '../server/project-files.js'

const WRITER = join(dirname(fileURLToPath(import.meta.url)), 'lock-writer.js')
const RUNS = Number(process.env.PINPOINT_LOCK_RUNS ?? 10)
const PER_CHILD = 200

const project = () => mkdtempSync(join(tmpdir(), 'pinpoint-lock-'))
/** What .pinpoint holds besides the history: a lock, a temp or a quarantine left behind. */
const leftovers = dir => readdirSync(join(dir, '.pinpoint')).filter(n => n !== 'history.md')

function child(...args) {
  const p = spawn(process.execPath, [WRITER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  p.stdout.on('data', d => { out += d })
  p.stderr.on('data', d => { err += d })
  p.done = new Promise(resolve => p.on('exit', (code, signal) => resolve({ code, signal, out, err })))
  p.said = word => new Promise((resolve, reject) => {
    const check = () => { if (out.includes(word)) resolve() }
    p.stdout.on('data', check)
    p.done.then(r => reject(new Error(`child exited before "${word}": ${JSON.stringify(r)}`)))
  })
  return p
}

test(`two processes x ${PER_CHILD} history appends lose nothing, ${RUNS} runs`, { timeout: RUNS * 20_000 }, async t => {
  const started = Date.now()
  for (let run = 0; run < RUNS; run++) {
    const dir = project()
    try {
      const [a, b] = await Promise.all([
        child('append', dir, 'a', String(PER_CHILD)).done,
        child('append', dir, 'b', String(PER_CHILD)).done,
      ])
      assert.equal(a.code, 0, a.err)
      assert.equal(b.code, 0, b.err)

      const lines = readFileSync(join(dir, '.pinpoint', 'history.md'), 'utf8').split('\n')
      assert.equal(lines.filter(l => l === '## day').length, 1, 'one day heading')
      const entries = lines.filter(l => /^- [ab] \d+$/.test(l))
      assert.equal(entries.length, 2 * PER_CHILD, `run ${run}: every append is there`)
      assert.equal(new Set(entries).size, entries.length, `run ${run}: no duplicates`)
      for (const tag of ['a', 'b']) {
        const order = entries.filter(l => l.startsWith(`- ${tag} `)).map(l => Number(l.split(' ')[2]))
        assert.deepEqual(order, [...Array(PER_CHILD).keys()], `run ${run}: ${tag} in its own order`)
      }
      assert.deepEqual(leftovers(dir), [], 'no lock, temp or quarantine left')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  t.diagnostic(`${RUNS} runs of 2 x ${PER_CHILD} in ${Date.now() - started} ms`)
})

test('a holder killed with the lock held is recovered through its dead pid', async () => {
  const dir = project()
  try {
    const p = child('die', dir)
    await p.said('held')
    const r = await p.done
    assert.equal(r.signal, 'SIGKILL')
    assert.ok(existsSync(lockPathOf(dir)), 'the dead holder left its lock')

    // Well inside the 30 s age limit, so only the pid can say it is stale.
    const t = Date.now()
    await appendHistory(dir, ['- after the crash'], '## day', { waitMs: 1000 })
    assert.ok(Date.now() - t < 1000)
    assert.match(readFileSync(join(dir, '.pinpoint', 'history.md'), 'utf8'), /after the crash/)
    assert.deepEqual(leftovers(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live holder is not robbed: a short wait ends busy and writes nothing', async () => {
  const dir = project()
  try {
    const p = child('hold', dir, '3000')
    await p.said('held')
    const t = Date.now()
    await assert.rejects(
      appendHistory(dir, ['- should not land'], '## day', { waitMs: 300 }),
      err => err instanceof ProjectBusyError && err.code === 'EBUSY_PROJECT' && err.retryable === true,
    )
    assert.ok(Date.now() - t < 1500, 'gave up near the wait, not at the holder\'s release')
    assert.ok(!existsSync(join(dir, '.pinpoint', 'history.md')))

    // Once the holder lets go, the same write goes through.
    assert.equal((await p.done).code, 0)
    await withProjectLock(dir, () => {}, { waitMs: 300 })
    assert.deepEqual(readdirSync(join(dir, '.pinpoint')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

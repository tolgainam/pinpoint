/**
 * The backlog and history files in one process: how the backlog is parsed and spliced, and
 * the lock and atomic replace that every write goes through. The same lock across real
 * processes is project-lock.test.js.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync,
  utimesSync, statSync, appendFileSync, chmodSync, lstatSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  BACKLOG_SEED, sectionRange, parseItems, titleOf, idOf, findItem, ensureSection,
  ProjectBusyError, withProjectLock, updateText, lockPathOf,
  appendOpen, startItem, finishItem, appendHistory,
} from '../server/project-files.js'

const project = () => mkdtempSync(join(tmpdir(), 'pinpoint-files-'))
const backlog = dir => join(dir, '.pinpoint', 'backlog.md')
const read = file => readFileSync(file, 'utf8')
/** Anything in .pinpoint that is not one of the two files: a lock, a temp, a quarantine. */
const leftovers = dir => readdirSync(join(dir, '.pinpoint')).filter(n => !['backlog.md', 'history.md'].includes(n))
const writeLock = (dir, rec) => {
  mkdirSync(join(dir, '.pinpoint'), { recursive: true })
  writeFileSync(lockPathOf(dir), typeof rec === 'string' ? rec : JSON.stringify({ version: 1, hostname: hostname(), createdAt: Date.now(), ...rec }))
}
/** A pid that was real a moment ago and is not any more. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

function withProject(fn) {
  return async () => {
    const dir = project()
    try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

const item = (title, id, ...extra) => [`- [ ] **${title}**`, `  - id: \`${id}\``, ...extra]

// ---------------------------------------------------------------- format

test('items own their indented and blank lines, and a flush-left line ends the run', () => {
  const lines = [
    '## Open', '',
    '- [ ] **First** — /a', '  - id: `bk-1`', '  - my own note', '',
    '- [x] Second — with a dash', '',
    '---', 'A paragraph.',
    '## Done', '',
  ]
  const open = sectionRange(lines, '## Open')
  assert.deepEqual(open, { start: 0, end: 10 })
  const items = parseItems(lines, open.start + 1, open.end)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], { from: 2, to: 5, body: ['- [ ] **First** — /a', '  - id: `bk-1`', '  - my own note'] })
  assert.deepEqual(items[1].body, ['- [x] Second — with a dash'])
  assert.equal(titleOf(items[0].body), 'First')
  assert.equal(titleOf(items[1].body), 'Second')
  assert.equal(idOf(items[0].body), 'bk-1')
  assert.equal(idOf(items[1].body), undefined)
  assert.equal(sectionRange(lines, '## Missing'), null)
})

test('a reference is an id, then a 1-based position, then a title substring', () => {
  const items = [{ body: item('Fix the header', 'bk-a') }, { body: item('Footer spacing', '2') }]
  assert.equal(findItem(items, 'bk-a'), 0)
  // An id that looks like a number wins over the position.
  assert.equal(findItem(items, '2'), 1)
  assert.equal(findItem(items, '1'), 0)
  assert.equal(findItem(items, 'FOOTER'), 1)
  assert.equal(findItem(items, ''), -1)
  assert.equal(findItem(items, 'nothing like it'), -1)
})

test('a missing heading is added at the end, not guessed into place', () => {
  const lines = ['# Mine', 'text']
  const range = ensureSection(lines, '## Done')
  assert.deepEqual(lines, ['# Mine', 'text', '', '## Done', ''])
  assert.deepEqual(range, { start: 3, end: 5 })
})

// ---------------------------------------------------------------- operations

test('parking seeds the file, then appends after the last open item', withProject(async dir => {
  const file = backlog(dir)
  await appendOpen(file, item('One', 'bk-1'))
  assert.ok(read(file).startsWith(BACKLOG_SEED.split('\n')[0]))
  await appendOpen(file, item('Two', 'bk-2'))
  const text = read(file)
  assert.ok(text.indexOf('**One**') < text.indexOf('**Two**'))
  assert.ok(text.indexOf('**Two**') < text.indexOf('\n## Done'))
  assert.doesNotMatch(text, /\n{3,}/)
  // A new file is the project's alone; one that exists keeps the mode it had.
  assert.equal(statSync(file).mode & 0o777, 0o600)
  chmodSync(file, 0o644)
  await appendOpen(file, item('Three', 'bk-3'))
  assert.equal(statSync(file).mode & 0o777, 0o644)
  assert.deepEqual(leftovers(dir), [])
}))

test('what a person wrote around the items stays where it was', withProject(async dir => {
  const file = backlog(dir)
  mkdirSync(join(dir, '.pinpoint'))
  writeFileSync(file, '# Mine\n\n## Open\n\n- [ ] Hand-written\n  - a sub-bullet\n\n## Ideas\n\nkeep me\n')
  await appendOpen(file, item('Pinned', 'bk-1'))
  await finishItem(file, 'Hand-written', 'did it', '2026-01-02 03:04')
  assert.equal(read(file), [
    '# Mine', '', '## Open', '', '- [ ] **Pinned**', '  - id: `bk-1`', '', '## Ideas', '', 'keep me', '',
    '## Done', '', '- [x] Hand-written', '  - a sub-bullet', '  - done: 2026-01-02 03:04 — did it', '',
  ].join('\n'))
}))

test('starting stamps an item once and hands back what it was; finishing moves it to Done', withProject(async dir => {
  const file = backlog(dir)
  await appendOpen(file, item('One', 'bk-1'))
  await appendOpen(file, item('Two', 'bk-2'))

  const got = await startItem(file, 'bk-2', '2026-01-02 03:04')
  assert.equal(got.index, 1)
  assert.deepEqual(got.item.body, item('Two', 'bk-2'))
  assert.match(read(file), /\*\*Two\*\*\n {2}- id: `bk-2`\n {2}- status: in progress \(since 2026-01-02 03:04\)/)
  const again = await startItem(file, 'bk-2', 'later')
  assert.equal(again.index, 1)
  assert.equal(read(file).match(/in progress/g).length, 1)

  const moved = await finishItem(file, 'bk-2', 'shipped', '2026-01-02 04:00')
  assert.deepEqual(moved, { title: 'Two', id: 'bk-2' })
  const text = read(file)
  const done = text.slice(text.indexOf('\n## Done'))
  assert.match(done, /- \[x\] \*\*Two\*\*\n {2}- id: `bk-2`\n {2}- done: 2026-01-02 04:00 — shipped/)
  assert.doesNotMatch(text, /in progress/)

  assert.equal(await startItem(file, 'bk-9', 'x'), null)
  assert.equal(await finishItem(file, 'bk-9', '', 'x'), null)
  assert.deepEqual(leftovers(dir), [])
}))

test('no backlog file: nothing to start or finish, and no folder made to find that out', withProject(async dir => {
  assert.equal(await startItem(backlog(dir), '1', 'x'), null)
  assert.equal(await finishItem(backlog(dir), '1', '', 'x'), null)
  assert.ok(!existsSync(join(dir, '.pinpoint')))
}))

test('two sessions finishing different items at once each get their own', withProject(async dir => {
  const file = backlog(dir)
  for (const n of [1, 2, 3, 4]) await appendOpen(file, item(`Item ${n}`, `bk-${n}`))
  // Both listed the backlog before either wrote. By position, the second one's "3" now
  // points at item 4; resolved inside the lock, by id, each lands on its own.
  const [a, b] = await Promise.all([
    finishItem(file, 'bk-1', 'by a', 't'),
    finishItem(file, 'bk-3', 'by b', 't'),
  ])
  assert.equal(a.id, 'bk-1')
  assert.equal(b.id, 'bk-3')
  const text = read(file)
  const open = text.slice(text.indexOf('\n## Open'), text.indexOf('\n## Done'))
  const done = text.slice(text.indexOf('\n## Done'))
  assert.match(open, /Item 2/)
  assert.match(open, /Item 4/)
  assert.doesNotMatch(open, /Item [13]/)
  assert.match(done, /Item 1\*\*\n {2}- id: `bk-1`\n {2}- done: t — by a/)
  assert.match(done, /Item 3\*\*\n {2}- id: `bk-3`\n {2}- done: t — by b/)
  assert.deepEqual(leftovers(dir), [])
}))

test('history gets one heading a day and lines in the order they were written', withProject(async dir => {
  await Promise.all([1, 2, 3].map(n => appendHistory(dir, [`- line ${n}`], '## 2026-01-02', { waitMs: 15000 })))
  await appendHistory(dir, [], '## 2026-01-02')
  await appendHistory(dir, ['- next day'], '## 2026-01-03')
  const text = read(join(dir, '.pinpoint', 'history.md'))
  assert.ok(text.startsWith('# Pinpoint history'))
  assert.equal(text.match(/## 2026-01-02/g).length, 1)
  // The three were started together, so the file holds them in lock order, which the
  // jittered retry makes any order. Each exactly once, under the one heading.
  const day = text.match(/## 2026-01-02\n((?:- line \d\n){3})\n## 2026-01-03\n- next day\n$/)
  assert.ok(day, text)
  assert.deepEqual(day[1].trim().split('\n').sort(), ['- line 1', '- line 2', '- line 3'])
  assert.deepEqual(leftovers(dir), [])
}))

// ---------------------------------------------------------------- the lock

test('a lock left by a dead process on this host is recovered at once', withProject(async dir => {
  writeLock(dir, { token: 'dead', pid: deadPid() })
  const t = Date.now()
  assert.equal(await withProjectLock(dir, () => 'ran', { waitMs: 1000 }), 'ran')
  assert.ok(Date.now() - t < 500)
  assert.deepEqual(leftovers(dir), [])
}))

test('a lock older than the limit is recovered whoever holds it', withProject(async dir => {
  // Alive, and on another host, so only its age can make it stale.
  writeLock(dir, { token: 'old', pid: process.pid, hostname: 'elsewhere' })
  const long = (Date.now() - 60_000) / 1000
  utimesSync(lockPathOf(dir), long, long)
  assert.equal(await withProjectLock(dir, () => 'ran', { waitMs: 1000 }), 'ran')
  assert.deepEqual(leftovers(dir), [])
}))

test('a live, young lock is never taken: the wait ends busy and the lock is untouched', withProject(async dir => {
  writeLock(dir, { token: 'theirs', pid: process.pid })
  const before = read(lockPathOf(dir))
  let ran = false
  await assert.rejects(
    withProjectLock(dir, () => { ran = true }, { waitMs: 150 }),
    err => err instanceof ProjectBusyError && err.code === 'EBUSY_PROJECT' && err.retryable === true,
  )
  assert.equal(ran, false)
  assert.equal(read(lockPathOf(dir)), before)
}))

test('a garbled lock is busy while young and recovered once old', withProject(async dir => {
  writeLock(dir, '{not json')
  await assert.rejects(withProjectLock(dir, () => {}, { waitMs: 100 }), ProjectBusyError)
  const long = (Date.now() - 60_000) / 1000
  utimesSync(lockPathOf(dir), long, long)
  await withProjectLock(dir, () => {}, { waitMs: 500 })
  assert.deepEqual(leftovers(dir), [])
}))

test('release leaves alone a lock whose token is no longer ours', withProject(async dir => {
  await withProjectLock(dir, () => {
    // As if ours had been recovered from under us and someone else took the path.
    writeLock(dir, { token: 'someone-else', pid: process.pid })
  })
  assert.equal(JSON.parse(read(lockPathOf(dir))).token, 'someone-else')
}))

test('the lock is released when the work throws, and nothing is left behind', withProject(async dir => {
  await assert.rejects(withProjectLock(dir, () => { throw new Error('boom') }), /boom/)
  assert.ok(!existsSync(lockPathOf(dir)))
  await assert.rejects(appendOpen(join(dir, '.pinpoint', 'backlog.md'), null), TypeError)
  assert.deepEqual(leftovers(dir), [])
}))

test('a link or a folder at the lock path is refused, not followed or removed', withProject(async dir => {
  mkdirSync(join(dir, '.pinpoint'))
  const target = join(dir, 'elsewhere.txt')
  writeFileSync(target, 'do not touch')
  symlinkSync(target, lockPathOf(dir))
  await assert.rejects(withProjectLock(dir, () => {}), err => err.code === 'EPINPOINT_LOCK')
  assert.ok(lstatSync(lockPathOf(dir)).isSymbolicLink())
  assert.equal(read(target), 'do not touch')

  // A dangling link is no different.
  rmSync(target)
  await assert.rejects(withProjectLock(dir, () => {}), err => err.code === 'EPINPOINT_LOCK')
  assert.ok(lstatSync(lockPathOf(dir)).isSymbolicLink())

  rmSync(lockPathOf(dir))
  mkdirSync(lockPathOf(dir))
  await assert.rejects(withProjectLock(dir, () => {}), err => err.code === 'EPINPOINT_LOCK')
  assert.ok(statSync(lockPathOf(dir)).isDirectory())
}))

// ---------------------------------------------------------------- atomic replace

test('an edit made between the read and the rename is kept, and the change redone on top', withProject(async dir => {
  const file = join(dir, '.pinpoint', 'history.md')
  mkdirSync(join(dir, '.pinpoint'))
  writeFileSync(file, 'start\n')
  let reads = 0
  const out = updateText(file, '', text => { reads++; return `${text}ours\n` }, {
    beforeCommit: attempt => { if (attempt === 0) appendFileSync(file, 'an editor\n') },
  })
  assert.equal(reads, 2)
  assert.equal(out, 'start\nan editor\nours\n')
  assert.equal(read(file), out)
  assert.deepEqual(leftovers(dir), [])
}))

test('a file that keeps changing is given up on after the retries, with the edits intact', withProject(async dir => {
  const file = join(dir, '.pinpoint', 'history.md')
  mkdirSync(join(dir, '.pinpoint'))
  writeFileSync(file, 'start\n')
  assert.throws(() => updateText(file, '', text => `${text}ours\n`, {
    retries: 2,
    beforeCommit: attempt => appendFileSync(file, `edit ${attempt}\n`),
  }), /kept changing/)
  assert.equal(read(file), 'start\nedit 0\nedit 1\nedit 2\n')
  assert.deepEqual(leftovers(dir), [])
}))

test('no change means no write, and a failing change leaves the file as it was', withProject(async dir => {
  const file = join(dir, '.pinpoint', 'history.md')
  mkdirSync(join(dir, '.pinpoint'))
  writeFileSync(file, 'start\n')
  const { mtimeMs } = statSync(file)
  assert.equal(updateText(file, '', () => null), null)
  assert.equal(statSync(file).mtimeMs, mtimeMs)
  assert.throws(() => updateText(file, '', () => 42), TypeError)
  assert.throws(() => updateText(file, '', () => 'x', { beforeCommit: () => { throw new Error('disk full') } }), /disk full/)
  assert.equal(read(file), 'start\n')
  assert.deepEqual(leftovers(dir), [])
}))

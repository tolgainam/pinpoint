/**
 * The two files Pinpoint writes into a project, .pinpoint/backlog.md and .pinpoint/history.md,
 * and the lock that keeps two writers from losing each other's changes.
 *
 * What is promised: Pinpoint processes that write at the same moment (two sessions, a bridge
 * and a session, a bridge and its successor) do not lose a write, on a local filesystem. Every
 * change takes the project lock, reads the newest file, and replaces it whole with one rename.
 *
 * What is not: a network mount (NFS, SMB, a synced folder) may not honour exclusive create or
 * rename the way a local disk does, so there it is best effort. An editor that saves the file
 * without the lock is noticed when the file changed between the read and the rename, and the
 * change is redone on top of the edit; a save in the last instant before the rename can still
 * be lost, and nothing short of every editor taking the lock could prevent that.
 *
 * No side effects at import: the lock tests run this module in child processes.
 */
import {
  openSync, closeSync, writeSync, fsyncSync, fchmodSync, readFileSync, statSync, lstatSync,
  renameSync, unlinkSync, linkSync, mkdirSync, existsSync, constants,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------- backlog format

/**
 * The backlog is a markdown file a human owns, not a database this server owns. So every
 * operation here is a surgical splice of whole lines: an item keeps whatever sub-bullets
 * someone typed under it, sections we didn't write are left exactly where they are, and
 * a hand-written item is a first-class citizen the tools can list and close.
 */

export const BACKLOG_SEED = `# Pinpoint backlog

Things worth doing, in the order they're worth doing. Pinpoint appends browser-pinned
items to \`## Open\` and moves finished ones to \`## Done\`; everything else is yours.

**Format:** one checkbox per item. Sub-bullets are free-form; \`id\`, \`selector\`, and
\`shot\` appear on items Pinpoint wrote itself.

---

## Open

## Done
`

/** The line range a `## ` heading owns: itself, up to the next heading or end of file. */
export function sectionRange(lines, heading) {
  const start = lines.findIndex(l => l.trim() === heading)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

/**
 * Checkbox items in a line range. An item owns every indented or blank line after it,
 * which is what lets hand-written sub-bullets travel with the item when it moves. A
 * flush-left non-blank line that is not a checkbox (a `---` rule, a paragraph) ends the
 * run and stays put.
 */
export function parseItems(lines, start, end) {
  const items = []
  let cur = null
  for (let i = start; i < end; i++) {
    const line = lines[i]
    if (/^- \[[ xX]\]/.test(line)) {
      cur = { from: i, to: i + 1, body: [line] }
      items.push(cur)
    } else if (cur && (!line.trim() || /^\s/.test(line))) {
      cur.body.push(line)
      cur.to = i + 1
    } else if (line.trim()) {
      cur = null
    }
  }
  // Trailing blanks belong to the gap between items, not to the item.
  for (const it of items) {
    while (it.body.length > 1 && !it.body[it.body.length - 1].trim()) { it.body.pop(); it.to-- }
  }
  return items
}

export const titleOf = body => {
  const first = body[0].replace(/^- \[[ xX]\]\s*/, '')
  const bold = first.match(/\*\*(.+?)\*\*/)
  return (bold ? bold[1] : first.split(' — ')[0]).trim()
}

export const idOf = body => (body.join('\n').match(/^\s*- id: `?([\w-]+)`?\s*$/m) ?? [])[1]

/** Guarantee a heading exists, appending it at the end rather than guessing where it goes. */
export function ensureSection(lines, heading) {
  let range = sectionRange(lines, heading)
  if (range) return range
  if (lines.length && lines[lines.length - 1].trim()) lines.push('')
  lines.push(heading, '')
  return sectionRange(lines, heading)
}

/** Resolve a user-supplied reference: Pinpoint id, 1-based position, or title substring. */
export function findItem(items, ref) {
  const q = String(ref ?? '').trim()
  if (!q) return -1
  const byId = items.findIndex(it => idOf(it.body) === q)
  if (byId !== -1) return byId
  const n = Number(q)
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1
  const low = q.toLowerCase()
  return items.findIndex(it => titleOf(it.body).toLowerCase().includes(low))
}

/** Splicing leaves the odd double gap behind; collapsing runs keeps the diff readable. */
function joinLines(lines) {
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

/**
 * The record of what was asked and what came of it. Like the backlog it belongs to the
 * project rather than to the queue: the queue is pruned after a day, and "what did I ask
 * for last week, and what happened" is a question that outlives that by a lot.
 */
export const historyFile = dir => join(dir, '.pinpoint', 'history.md')

export const HISTORY_SEED = `# Pinpoint history

What was pinned, and what came of it. Appended by Pinpoint, newest at the bottom; the
queue in ~/.claude is pruned after a day, this is not. Delete it whenever you like — it
is a log, nothing reads it back.

`

// ---------------------------------------------------------------- the lock

/** Another writer held the lock for the whole wait. Nothing was written; try again. */
export class ProjectBusyError extends Error {
  constructor(message = 'project files busy, try again') {
    super(message)
    this.name = 'ProjectBusyError'
    this.code = 'EBUSY_PROJECT'
    this.retryable = true
  }
}

const HOST = hostname()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const token = () => randomBytes(8).toString('hex')
/** Read without following a link, where the platform can say so. */
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

export const lockPathOf = dir => join(dir, '.pinpoint', '.write.lock')

/** A lock path that is a link or a directory is someone else's doing. Never follow or remove it. */
function refuseOdd(path, st) {
  if (st.isSymbolicLink() || !st.isFile()) {
    const err = /** @type {Error & { code?: string }} */ (new Error(`${path} is not a regular file; remove it by hand if it is not yours`))
    err.code = 'EPINPOINT_LOCK'
    throw err
  }
}

/** The holder's record, with its mtime, or null when the file is gone. Unparseable is `{}`. */
function readLock(path) {
  let st
  try { st = lstatSync(path) } catch (err) { if (err.code === 'ENOENT') return null; throw err }
  refuseOdd(path, st)
  let rec = {}
  try {
    const fd = openSync(path, NOFOLLOW)
    try { rec = JSON.parse(readFileSync(fd, 'utf8')) } finally { closeSync(fd) }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err.code === 'ELOOP') refuseOdd(path, lstatSync(path))
    // Half written or garbled: busy, until its age says otherwise.
  }
  return { rec: rec && typeof rec === 'object' ? rec : {}, mtimeMs: st.mtimeMs }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code !== 'ESRCH' }
}

/**
 * Stale means its holder cannot be running: a process on this host that is gone, or a lock
 * older than any critical section could be. A live holder on this host with a young lock is
 * never stale, however long the wait.
 */
function isStale({ rec, mtimeMs }, staleMs) {
  if (rec.hostname === HOST && Number.isInteger(rec.pid) && rec.pid > 0 && !pidAlive(rec.pid)) return true
  return Date.now() - mtimeMs > staleMs
}

/**
 * Move a stale lock out of the way in one rename, so of two processes that both saw it stale
 * only one gets it. A failed rename means the other one did. Should the file moved turn out
 * not to be the stale one seen a moment ago, it is put back if the path is still free.
 */
function recover(path, seen) {
  const q = `${path}.stale-${process.pid}-${token()}`
  try { renameSync(path, q) } catch { return }
  let moved = null
  try { moved = JSON.parse(readFileSync(q, 'utf8')) } catch { /* garbled, like the one seen */ }
  if (seen.rec.token && moved?.token !== seen.rec.token) {
    try { linkSync(q, path) } catch { /* a new holder already; theirs stands */ }
  }
  try { unlinkSync(q) } catch { /* gone already */ }
}

function tryAcquire(path, mine, staleMs) {
  try {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify({ version: 1, token: mine, pid: process.pid, hostname: HOST, createdAt: Date.now() }))
    } catch (err) {
      // A lock nobody can read the owner of would only block everyone until it ages out.
      closeSync(fd)
      try { unlinkSync(path) } catch { /* already gone */ }
      throw err
    }
    closeSync(fd)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  const seen = readLock(path)
  if (seen && isStale(seen, staleMs)) recover(path, seen)
  return false
}

/** Only ever our own: a lock recovered from under us and taken by someone else is theirs. */
function release(path, mine) {
  try {
    const held = readLock(path)
    // @ts-expect-error readLock's record type is not declared
    if (held?.rec.token === mine) unlinkSync(path)
  } catch { /* nothing of ours left to remove */ }
}

/**
 * Run `fn` holding the project's write lock. The wait is short and bounded because the work
 * inside is: a small text file read, spliced and renamed. Screenshots are written before.
 * @template T
 * @param {string} dir the project directory
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProjectLock(dir, fn, { waitMs = 2000, staleMs = 30000 } = {}) {
  const path = lockPathOf(dir)
  mkdirSync(dirname(path), { recursive: true })
  const mine = token()
  const until = Date.now() + waitMs
  for (let delay = 5; !tryAcquire(path, mine, staleMs); delay = Math.min(delay * 2, 100)) {
    if (Date.now() >= until) throw new ProjectBusyError()
    // Jittered, so two waiters that collided once do not collide on every retry.
    await sleep(Math.min(delay / 2 + Math.random() * delay, Math.max(1, until - Date.now())))
  }
  try {
    return await fn()
  } finally {
    release(path, mine)
  }
}

// ---------------------------------------------------------------- atomic replace

/** What a file looks like from outside: enough to tell that someone wrote it since. */
function identity(file) {
  try {
    const st = statSync(file)
    return { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode & 0o777 }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

const same = (a, b) => a === b || (!!a && !!b && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size)

function fsyncDir(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (err) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(err.code)) throw err
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Replace `file` with what `mutate` makes of it, whole, in one rename. Call it holding the
 * lock: the lock keeps Pinpoint writers apart, and the identity check here notices a writer
 * that did not take it, in which case the change is redone on top of theirs.
 *
 * Order: stat, read (the seed when missing), mutate, write and fsync a temp file beside it,
 * stat again, rename over the target if nothing changed, fsync the directory.
 * `mutate` returns the new text, or null for no change, in which case nothing is written.
 * `beforeCommit` is for tests: it runs between the temp write and the recheck.
 * @param {string} file
 * @param {string} seed
 * @param {(text: string) => string | null} mutate
 * @param {{ retries?: number, beforeCommit?: (attempt: number) => void }} [opts]
 * @returns {string | null} the text written, or null when there was no change
 */
export function updateText(file, seed, mutate, { retries = 3, beforeCommit } = {}) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    // Before the read, so a write landing between the two is seen as a change, not missed.
    const before = identity(file)
    let text
    try { text = readFileSync(file, 'utf8') } catch (err) {
      if (err.code !== 'ENOENT') throw err
      text = seed
    }
    const next = mutate(text)
    if (next == null) return null

    const tmp = `${file}.${process.pid}-${token()}.tmp`
    try {
      const mode = before?.mode ?? 0o600
      const fd = openSync(tmp, 'wx', mode)
      try {
        fchmodSync(fd, mode)
        writeSync(fd, next)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      beforeCommit?.(attempt)
      if (!same(before, identity(file))) {
        unlinkSync(tmp)
        if (attempt >= retries) throw new Error(`${file} kept changing while it was being written`)
        continue
      }
      renameSync(tmp, file)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* never made, or already moved */ }
      throw err
    }
    fsyncDir(dir)
    return next
  }
}

// ---------------------------------------------------------------- operations

/** `<dir>/.pinpoint/<name>` belongs to the project at `<dir>`. */
const projectOf = file => dirname(dirname(file))

/** A new open item, after the last one. Written on behalf of whichever project the page belongs to. */
export async function appendOpen(file, block) {
  await withProjectLock(projectOf(file), () => {
    updateText(file, BACKLOG_SEED, text => {
      const lines = text.split('\n')
      const range = ensureSection(lines, '## Open')
      const items = parseItems(lines, range.start + 1, range.end)
      const at = items.length ? items[items.length - 1].to : range.start + 1
      lines.splice(at, 0, '', ...block)
      return joinLines(lines)
    })
  })
}

const IN_PROGRESS = /^\s*- status: in progress/

/** The open items of `text`, or null when it has no `## Open`. */
function openItems(lines) {
  const range = sectionRange(lines, '## Open')
  return range ? parseItems(lines, range.start + 1, range.end) : null
}

/**
 * Stamp an open item so a second session — or tomorrow's you — can see it is taken. The
 * reference is resolved against the file as it is inside the lock, not as it was when the
 * caller last listed it.
 * @returns {Promise<{index: number, item: {from: number, to: number, body: string[]}} | null>}
 *   the item as it was before the stamp
 */
export async function startItem(file, ref, stamp) {
  // No backlog, no item: not worth making a .pinpoint folder to find that out.
  if (!existsSync(file)) return null
  return withProjectLock(projectOf(file), () => {
    let found = null
    updateText(file, '', text => {
      found = null
      const lines = text.split('\n')
      const items = openItems(lines)
      const index = items ? findItem(items, ref) : -1
      if (index === -1) return null
      const item = items[index]
      found = { index, item: { ...item, body: [...item.body] } }
      if (item.body.some(l => IN_PROGRESS.test(l))) return null
      lines.splice(item.to, 0, `  - status: in progress (since ${stamp})`)
      return joinLines(lines)
    })
    return found
  })
}

/**
 * Move one open item into `## Done`, ticked and dated, found by its reference inside the lock.
 * @returns {Promise<{title: string, id?: string} | null>}
 */
export async function finishItem(file, ref, outcome, stamp) {
  if (!existsSync(file)) return null
  return withProjectLock(projectOf(file), () => {
    let moved = null
    updateText(file, '', text => {
      moved = null
      const lines = text.split('\n')
      const items = openItems(lines)
      const index = items ? findItem(items, ref) : -1
      if (index === -1) return null
      const item = items[index]

      const body = item.body.filter(l => !IN_PROGRESS.test(l))
      body[0] = body[0].replace(/^- \[[ xX]\]/, '- [x]')
      body.push(`  - done: ${stamp}${outcome ? ` — ${outcome}` : ''}`)

      lines.splice(item.from, item.to - item.from)
      const done = ensureSection(lines, '## Done')
      const doneItems = parseItems(lines, done.start + 1, done.end)
      const at = doneItems.length ? doneItems[doneItems.length - 1].to : done.end
      lines.splice(at, 0, '', ...body)
      moved = { title: titleOf(item.body), id: idOf(item.body) }
      return joinLines(lines)
    })
    return moved
  })
}

/**
 * Append lines to the project's history under `dayHeading`, adding the heading if this is
 * the first entry of the day.
 *
 * Append-only and strictly chronological, which is the whole design. Writing a batch and
 * then going back to annotate it when it resolves would mean splicing a file a human also
 * edits; a resolution written as its own line, later in the file, says the same thing and
 * cannot corrupt anything.
 */
export async function appendHistory(dir, lines, dayHeading, lockOptions) {
  if (!lines.length) return
  await withProjectLock(dir, () => {
    updateText(historyFile(dir), HISTORY_SEED, text => {
      if (!text.includes(dayHeading)) text += `${text.endsWith('\n') ? '' : '\n'}\n${dayHeading}\n`
      return `${text}${text.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`
    })
  }, lockOptions)
}

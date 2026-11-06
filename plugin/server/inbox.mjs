/**
 * The toolbar inbox's Project view, bridge side: the rows a page sends to POST /inbox,
 * checked and bounded, and what the bridge knows about each from the batch files.
 *
 * The page lists the project's comments from its own storage, route by route, and asks the
 * bridge only for what may have changed while those routes were not open: an answer, a
 * resolution, progress, and whether the answer asks the user something. Every row is
 * page-controlled text, so each field is checked for shape, stripped of control characters
 * and capped; a row that is not an object or has no usable id is dropped, never fatal. The
 * answer goes back to the page only. Nothing here reaches a model prompt, and nothing is
 * written.
 *
 * `requiresResponse` is the `reply` tool's optional flag. A model passes argument names
 * unreliably, so only a literal `true` under one of the names below counts; anything else,
 * including absence, is false.
 *
 * No side effects at import: the bridge and the tests both load this.
 */

/** The bridge advertises this in /health; the extension refreshes Project rows only when it does. */
export const INBOX_CAPABILITY = 'project-inbox-v1'

/** Rows read from one request; the rest are counted as truncated, not read. */
export const MAX_ROWS = 100
const MAX_ID = 80
const MAX_KEY = 1100
const MAX_ORIGIN = 200
const MAX_STATE = 40
const MAX_NOTE = 200
const MAX_HREF = 500
/** An answer is shown in full on the pin card; this only stops an absurd one. */
const MAX_ANSWER = 4000
const MAX_LINE = 200
const MAX_FILES = 12
const MAX_FILE = 160

/** The same shape /state accepts: a batch id and a number, the only shape allowed near a path. */
export const COMMENT_ID = /^[\w-]{6,64}#\d{1,4}$/
const ROW_ID = /^[\w.:-]{1,80}$/
const ORIGIN = /^https?:\/\/[^\s/?#]{1,180}$/
const KINDS = new Set(['change', 'question', 'parked'])

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** One line of page text: no control characters, single spaces, at most `max` characters. */
export function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

/** A time in ms since the epoch, or 0. */
const stamp = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), 8.64e15) : 0)

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** True only when the model said exactly true under one of these names. */
export function pickFlag(args, names = ['requiresResponse', 'requires_response']) {
  for (const k of names) if (args?.[k] === true) return true
  return false
}

/**
 * One row as the page sent it, or null when it cannot be used. `page` is the origin of the
 * tab that asked, when known: a row of another origin is not this page's to ask about.
 */
export function sanitiseRow(row, page = null) {
  if (!isObject(row)) return null
  const id = typeof row.id === 'string' && ROW_ID.test(row.id) ? row.id : null
  if (!id) return null
  const origin = typeof row.origin === 'string' && row.origin.length <= MAX_ORIGIN && ORIGIN.test(row.origin) ? row.origin : null
  if (!origin || (page && origin !== page)) return null
  const out = { id, origin }
  const key = clean(row.key, MAX_KEY)
  if (key) out.key = key
  if (KINDS.has(row.kind)) out.kind = row.kind
  const state = clean(row.state, MAX_STATE)
  if (state) out.state = state
  const note = clean(row.note, MAX_NOTE)
  if (note) out.note = note
  const href = clean(row.createdHref, MAX_HREF)
  if (href) out.createdHref = href
  if (stamp(row.seenAt)) out.seenAt = stamp(row.seenAt)
  if (stamp(row.updatedAt)) out.updatedAt = stamp(row.updatedAt)
  // A malformed batch id costs the row its bridge state, not the row.
  if (typeof row.batch === 'string' && COMMENT_ID.test(row.batch)) out.batch = row.batch
  return out
}

/**
 * The rows of a request body: `{ rows, dropped, truncated }`. Read up to MAX_ROWS, drop
 * what is malformed or repeated, and say how many went.
 */
export function sanitiseRows(rows, page = null) {
  if (!Array.isArray(rows)) return { rows: [], dropped: 0, truncated: false }
  const out = []
  const ids = new Set()
  let dropped = 0
  for (const r of rows.slice(0, MAX_ROWS)) {
    const s = sanitiseRow(r, page)
    if (!s || ids.has(s.id)) { dropped++; continue }
    ids.add(s.id)
    out.push(s)
  }
  return { rows: out, dropped, truncated: rows.length > MAX_ROWS }
}

/**
 * What the bridge knows about one row, from the comment in its batch file. `found` is false
 * when the row names no batch, or one the bridge no longer has (pruned, or another origin's).
 *   status  resolved | answered | progress | sent
 */
export function answerOf(row, comment) {
  const out = { id: row.id }
  if (row.batch) out.batch = row.batch
  if (!isObject(comment)) return { ...out, found: false, requiresResponse: false }
  out.found = true
  const answer = typeof comment.answer === 'string' ? comment.answer.slice(0, MAX_ANSWER) : ''
  const resolved = comment.status === 'resolved'
  out.status = resolved ? 'resolved' : answer ? 'answered' : comment.progress ? 'progress' : 'sent'
  if (answer) out.answer = answer
  if (typeof comment.answeredAt === 'string') out.answeredAt = comment.answeredAt.slice(0, 40)
  if (resolved && typeof comment.resolution === 'string' && comment.resolution) out.resolution = comment.resolution.slice(0, MAX_ANSWER)
  if (!resolved && isObject(comment.progress)) {
    const p = comment.progress
    out.progress = {
      state: p.state === 'edited' ? 'edited' : 'working',
      note: clean(p.note, MAX_LINE),
      files: Array.isArray(p.files) ? p.files.slice(0, MAX_FILES).map(f => clean(f, MAX_FILE)).filter(Boolean) : [],
    }
  }
  // Only an answer can ask for input, and only one that said so.
  out.requiresResponse = !!answer && comment.requiresResponse === true
  return out
}

/**
 * The page a batch came from. A dispatch through the extension carries the extension's own
 * Origin, so the page's URL is the better witness; a batch with neither says nothing.
 */
export function pageOriginOf(b) {
  if (!isObject(b)) return null
  try { if (typeof b.url === 'string' && b.url) return new URL(b.url).origin } catch { /* fall through */ }
  return typeof b.origin === 'string' && ORIGIN.test(b.origin) ? b.origin : null
}

/**
 * The whole answer to POST /inbox. `body` is the parsed request, `page` the asking tab's
 * origin when known, `read(batchId)` the batch or null. A batch of another origin is not
 * read into the answer: the row asked about its own page's comment, and that is all it gets.
 */
export function inboxAnswer(body, page, read) {
  const { rows, dropped, truncated } = sanitiseRows(isObject(body) ? body.rows : null, page)
  const batches = new Map()
  const items = rows.map(row => {
    if (!row.batch) return answerOf(row, null)
    const [batchId, nRaw] = row.batch.split('#')
    if (!batches.has(batchId)) {
      let b = null
      try { b = read(batchId) } catch { b = null }
      batches.set(batchId, b)
    }
    const b = batches.get(batchId)
    const from = pageOriginOf(b)
    const sameOrigin = b && (!from || from === row.origin)
    const c = sameOrigin && Array.isArray(b.comments) ? b.comments.find(x => x?.n === Number(nRaw)) : null
    return answerOf(row, c ?? null)
  })
  return { ok: true, items, dropped, truncated }
}

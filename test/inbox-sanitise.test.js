/**
 * The bridge's side of POST /inbox, from server/inbox.js: the rows a page sends, checked and
 * capped, and the answer built from the batch files. Pure, so it needs no bridge;
 * test/inbox-bridge.test.js runs the same route on a real one.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INBOX_CAPABILITY, MAX_ROWS, clean, pickFlag, sanitiseRow, sanitiseRows, answerOf, inboxAnswer, pageOriginOf,
} from '../server/inbox.js'

const O = 'http://localhost:5173'
const row = (extra = {}) => ({
  id: 'c-1', key: `pinpoint:v2:${O}/settings`, origin: O, kind: 'question', state: 'Dispatched',
  note: 'why is this grey', createdHref: `${O}/settings?tab=2`, seenAt: 10, updatedAt: 20, batch: '20261024-101010-abcd#1', ...extra,
})

test('the capability name is the one the extension looks for', () => {
  assert.equal(INBOX_CAPABILITY, 'project-inbox-v1')
  assert.equal(MAX_ROWS, 100)
})

test('a valid row comes back as it went in', () => {
  assert.deepEqual(sanitiseRow(row()), row())
})

test('page strings lose control characters and are capped', () => {
  const r = sanitiseRow(row({ note: `one\nline\u0000two\u2028three ${'x'.repeat(400)}`, state: 'S'.repeat(90), key: 'k'.repeat(5000) }))
  assert.match(r.note, /^one line two three x+$/)
  assert.equal(r.note.length, 200)
  assert.equal(r.state.length, 40)
  assert.ok(r.key.length <= 1100)
  assert.equal(clean(42, 10), '')
  assert.equal(clean(' a \t b ', 10), 'a b')
})

test('a malformed row is dropped; a malformed field costs only that field', () => {
  for (const bad of [null, 'row', 7, [], {}, row({ id: '' }), row({ id: 'has space' }), row({ id: 'x'.repeat(81) }), row({ origin: 'javascript:alert(1)' }), row({ origin: undefined })]) {
    assert.equal(sanitiseRow(bad), null, JSON.stringify(bad))
  }
  const r = sanitiseRow(row({ batch: '../../etc/passwd#1', kind: 'other', seenAt: -1, updatedAt: 'soon' }))
  assert.equal(r.batch, undefined)
  assert.equal(r.kind, undefined)
  assert.equal(r.seenAt, undefined)
  assert.equal(r.updatedAt, undefined)
  assert.equal(r.id, 'c-1')
})

test('a row of another origin than the asking page is not that page\'s to ask about', () => {
  assert.equal(sanitiseRow(row(), 'http://localhost:3000'), null)
  assert.ok(sanitiseRow(row(), O))
})

test('rows: capped at 100, repeats and malformed ones dropped and counted', () => {
  const many = Array.from({ length: 130 }, (_, i) => row({ id: `c-${i}` }))
  const got = sanitiseRows(many)
  assert.equal(got.rows.length, 100)
  assert.equal(got.truncated, true)
  const mixed = sanitiseRows([row(), row(), null, row({ id: 'c-2' }), { id: 'c-3' }])
  assert.deepEqual(mixed.rows.map(r => r.id), ['c-1', 'c-2'])
  assert.equal(mixed.dropped, 3)
  assert.deepEqual(sanitiseRows('nope'), { rows: [], dropped: 0, truncated: false })
})

test('requiresResponse counts only as a literal true', () => {
  assert.equal(pickFlag({ requiresResponse: true }), true)
  assert.equal(pickFlag({ requires_response: true }), true)
  for (const v of [undefined, false, 'true', 1, 'yes', null, {}]) assert.equal(pickFlag({ requiresResponse: v }), false, String(v))
  assert.equal(pickFlag(undefined), false)
})

test('the answer per row: status, answer, resolution, progress and requiresResponse', () => {
  const r = sanitiseRow(row())
  assert.deepEqual(answerOf(r, null), { id: 'c-1', batch: r.batch, found: false, requiresResponse: false })
  assert.deepEqual(answerOf(r, { n: 1, status: 'pending' }), { id: 'c-1', batch: r.batch, found: true, status: 'sent', requiresResponse: false })
  const answered = answerOf(r, { n: 1, status: 'pending', answer: 'Which one?', answeredAt: '2026-10-24T10:00:00.000Z', requiresResponse: true })
  assert.equal(answered.status, 'answered')
  assert.equal(answered.answer, 'Which one?')
  assert.equal(answered.requiresResponse, true)
  // Stored before the flag existed: false.
  assert.equal(answerOf(r, { n: 1, answer: 'yes' }).requiresResponse, false)
  // No answer, no question, whatever the flag says.
  assert.equal(answerOf(r, { n: 1, requiresResponse: true }).requiresResponse, false)
  const working = answerOf(r, { n: 1, progress: { state: 'edited', note: 'a\nb', files: ['x.js', 3], at: 'x' } })
  assert.deepEqual(working.progress, { state: 'edited', note: 'a b', files: ['x.js'] })
  assert.equal(working.status, 'progress')
  const done = answerOf(r, { n: 1, status: 'resolved', resolution: 'Raised the padding', progress: { state: 'edited' } })
  assert.equal(done.status, 'resolved')
  assert.equal(done.resolution, 'Raised the padding')
  assert.equal(done.progress, undefined)
  // Never a path, a screenshot or the page's own facts.
  const full = answerOf(r, { n: 1, answer: 'a', shot: 'shot-01.png', selector: '.x', html: '<b>', projectDir: '/p' })
  assert.deepEqual(Object.keys(full).sort(), ['answer', 'batch', 'found', 'id', 'requiresResponse', 'status'])
})

test('the whole answer reads each batch once and only for its own page', () => {
  const reads = []
  const batches = {
    '20261024-101010-abcd': { url: `${O}/settings`, origin: 'chrome-extension://abc', comments: [{ n: 1, answer: 'yes' }, { n: 2, status: 'resolved' }] },
    '20261024-101010-wxyz': { url: 'http://localhost:3000/', comments: [{ n: 1, answer: 'not yours' }] },
  }
  const read = id => { reads.push(id); return batches[id] ?? null }
  const body = { rows: [
    row(), row({ id: 'c-2', batch: '20261024-101010-abcd#2' }), row({ id: 'c-3', batch: '20261024-101010-wxyz#1' }),
    row({ id: 'c-4', batch: '20261024-101010-gone#1' }), row({ id: 'c-5', batch: undefined }), 'junk',
  ] }
  const got = inboxAnswer(body, O, read)
  assert.equal(got.ok, true)
  assert.equal(got.dropped, 1)
  assert.equal(got.truncated, false)
  assert.deepEqual(got.items.map(i => [i.id, i.found, i.status ?? null]), [
    ['c-1', true, 'answered'], ['c-2', true, 'resolved'], ['c-3', false, null], ['c-4', false, null], ['c-5', false, null],
  ])
  assert.deepEqual(reads, ['20261024-101010-abcd', '20261024-101010-wxyz', '20261024-101010-gone'])
  // A reader that throws is a missing batch, not a failed request.
  assert.equal(inboxAnswer({ rows: [row()] }, O, () => { throw new Error('disk') }).items[0].found, false)
  assert.deepEqual(inboxAnswer(null, O, read), { ok: true, items: [], dropped: 0, truncated: false })
})

test('a batch\'s page is its URL, then an http origin, else unknown', () => {
  assert.equal(pageOriginOf({ url: `${O}/a?b=1`, origin: 'chrome-extension://x' }), O)
  assert.equal(pageOriginOf({ origin: O }), O)
  assert.equal(pageOriginOf({ origin: 'chrome-extension://x' }), null)
  assert.equal(pageOriginOf(null), null)
})

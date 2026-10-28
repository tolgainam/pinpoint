/**
 * The toolbar inbox's Project view, from extension/inbox.js loaded as a module: which
 * buckets are the project's other routes, what the view lists and in what order, the rows
 * sent to POST /inbox, the events a fresh answer stands for, and Mark seen written into
 * another route's bucket through route.js's store and merge.
 * test/e2e.test.js drives the same view in a real browser.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../extension/route.js'
import '../extension/inbox.js'

const I = globalThis.PinpointInbox
const R = globalThis.PinpointRoute
const O = 'http://localhost:5173'
const key = route => `pinpoint:v2:${O}${route}`
const c = (extra = {}) => ({ id: 'a', n: 1, note: 'pad', selector: '.x', status: 'sent', batch: 'b-000001', serverN: 1, ...extra })

/** chrome.storage.local, as far as route.js uses it. */
function memory(initial = {}) {
  const data = structuredClone(initial)
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]))
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v) },
    async remove(k) { for (const x of [].concat(k)) delete data[x] },
  }
}

// ---------------------------------------------------------------- buckets

test('only this origin\'s other route buckets are the project\'s, by route', () => {
  const rec = comments => ({ v: 2, seq: comments.length, comments, removed: [] })
  const all = {
    [key('/settings')]: rec([c({ id: 's1' })]),
    [key('/spa#/users')]: rec([c({ id: 'u1' })]),
    [key('/here')]: rec([c({ id: 'h1' })]),
    // Another port is another origin, even though the text starts the same.
    [`pinpoint:v2:${O}0/settings`]: rec([c({ id: 'x' })]),
    'pinpoint:v2:http://127.0.0.1:5173/settings': rec([c({ id: 'y' })]),
    // Legacy keys, settings and empty buckets are not routes with comments.
    [`pinpoint:${O}/old`]: rec([c({ id: 'z' })]),
    'pinpoint:prefs': { wantShot: true },
    [key('/empty')]: rec([]),
    [key('/broken')]: { comments: 'nope' },
  }
  const got = I.buckets(all, O, key('/here'))
  assert.deepEqual(got.map(b => b.route), ['/settings', '/spa#/users'])
  assert.deepEqual(got.map(b => b.comments[0].id), ['s1', 'u1'])
  assert.equal(I.routeOfKey(key('/a#/b'), O), '/a#/b')
  assert.equal(I.routeOfKey(`pinpoint:v2:${O}0/a`, O), null)
  assert.equal(I.routeOfKey(key('/a'), ''), null)
})

// ---------------------------------------------------------------- the view

test('the Project view groups like This page, needs attention first, and leaves done and undispatched out', () => {
  const list = [
    { key: key('/b'), route: '/b', comments: [
      c({ id: 'sent', n: 1, note: 'tighten' }),
      c({ id: 'input', n: 2, question: true, status: 'answered', answer: 'Which one?', requiresResponse: true, activityAt: 9 }),
      c({ id: 'plain', n: 3, status: 'pending', batch: undefined, serverN: undefined }),
      c({ id: 'done', n: 4, status: 'resolved', activityAt: 5, seenAt: 6 }),
      c({ id: 'seen', n: 5, question: true, status: 'answered', answer: 'yes', activityAt: 5, seenAt: 6 }),
    ] },
    { key: key('/a'), route: '/a', comments: [
      c({ id: 'parked', n: 1, status: 'backlog', backlogId: 'bk-1', batch: undefined }),
      c({ id: 'answered', n: 2, question: true, status: 'answered', answer: 'It is grey.', activityAt: 8 }),
      c({ id: 'failed', n: 3, status: 'pending', deliveryError: 'bridge down', batch: undefined }),
      c({ id: 'theirs', n: 4, sentTo: '/other/project' }),
    ] },
  ]
  const v = I.projectView(list, { origin: O, keep: x => x.sentTo !== '/other/project' })
  assert.deepEqual(v.sections.map(s => s.id), ['attention', 'progress', 'parked'])
  const [attention, progress, parked] = v.sections
  assert.deepEqual(attention.rows.map(r => r.ref), [`${key('/a')}#failed`, `${key('/b')}#input`, `${key('/a')}#answered`])
  assert.equal(v.count, 3)
  assert.deepEqual(progress.rows.map(r => r.ref), [`${key('/b')}#sent`])
  assert.deepEqual(parked.rows.map(r => r.ref), [`${key('/a')}#parked`])

  const input = attention.rows[1]
  assert.equal(input.state, 'Needs your input')
  assert.equal(input.route, '/b')
  assert.equal(input.answer, 'Which one?')
  assert.equal(input.seen, true)
  assert.equal(input.href, `${O}/b`)
  assert.equal(input.name, 'Pin 2 on /b, question, needs your input: pad')
  // A failure is not cleared by looking.
  assert.equal(attention.rows[0].seen, false)
  assert.equal(attention.rows[0].state, 'Not delivered')
})

test('Copy route uses the URL the comment was written on, never another origin\'s', () => {
  assert.equal(I.hrefOf(c({ createdHref: `${O}/users?id=2#/x` }), O, '/users'), `${O}/users?id=2#/x`)
  assert.equal(I.hrefOf(c({ createdHref: 'https://evil.invalid/users' }), O, '/users'), `${O}/users`)
  assert.equal(I.hrefOf(c({ createdHref: 'not a url' }), O, '/spa#/users'), `${O}/spa#/users`)
})

test('each Project section is capped and says how many more there are', () => {
  const comments = Array.from({ length: 60 }, (_, i) => c({ id: `s${i}`, n: i + 1 }))
  const v = I.projectView([{ key: key('/x'), route: '/x', comments }], { origin: O })
  assert.equal(v.sections[0].rows.length, I.CAP)
  assert.equal(v.sections[0].total, 60)
  assert.equal(v.sections[0].more, 10)
})

// ---------------------------------------------------------------- rows for the bridge

test('POST /inbox rows: dispatched and open only, compact, capped at 100', () => {
  const comments = [
    c({ id: 'a', note: 'x'.repeat(500), shot: 'data:image/png;base64,AAAA', createdHref: `${O}/b`, seenAt: 3, updatedAt: 4 }),
    c({ id: 'r', status: 'resolved' }),
    c({ id: 'p', status: 'pending', batch: undefined, serverN: undefined }),
    c({ id: 'k', status: 'backlog', backlogId: 'bk-1' }),
  ]
  const rows = I.inboxRows([{ key: key('/b'), route: '/b', comments }], { origin: O })
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.deepEqual(Object.keys(row).sort(), ['batch', 'createdHref', 'id', 'key', 'kind', 'note', 'origin', 'seenAt', 'state', 'updatedAt'])
  assert.equal(row.batch, 'b-000001#1')
  assert.equal(row.origin, O)
  assert.ok(row.note.length <= 200)
  const many = Array.from({ length: 150 }, (_, i) => c({ id: `m${i}` }))
  assert.equal(I.inboxRows([{ key: key('/m'), route: '/m', comments: many }], { origin: O }).length, I.MAX_ASK)
  assert.equal(I.MAX_ASK, 100)
})

test('a fresh answer, progress or resolution becomes the events the page would have heard', () => {
  const item = extra => ({ id: 'a', batch: 'b-000001#1', found: true, requiresResponse: false, ...extra })
  assert.deepEqual(I.freshEvents(c(), item({ status: 'sent' })), [])
  assert.deepEqual(I.freshEvents(c(), item({ found: false })), [])
  assert.deepEqual(I.freshEvents(c(), item({ status: 'answered', answer: 'Which one?', requiresResponse: true })),
    [{ type: 'reply', id: 'b-000001#1', text: 'Which one?', requiresResponse: true }])
  // An answer the page already has is not news again.
  assert.deepEqual(I.freshEvents(c({ status: 'answered', answer: 'same' }), item({ status: 'answered', answer: 'same' })), [])
  assert.deepEqual(I.freshEvents(c(), item({ status: 'progress', progress: { state: 'edited', note: 'n', files: ['a.js'] } })),
    [{ type: 'progress', id: 'b-000001#1', state: 'edited', note: 'n', files: ['a.js'] }])
  assert.deepEqual(I.freshEvents(c(), item({ status: 'resolved', resolution: 'done' })), [{ type: 'resolved', id: 'b-000001#1', resolution: 'done' }])
  assert.deepEqual(I.freshEvents(c({ status: 'resolved' }), item({ status: 'resolved' })), [])
})

test('route.js keeps requiresResponse from a reply, and a later plain answer clears it', () => {
  const x = c()
  assert.equal(R.applyEvent(x, { type: 'reply', id: 'b-000001#1', text: 'Which one?', requiresResponse: true }), true)
  assert.equal(x.requiresResponse, true)
  assert.equal(I.reason({ ...x, activityAt: 2 }), 'input')
  R.applyEvent(x, { type: 'reply', id: 'b-000001#1', text: 'Done, it is the first.' })
  assert.equal('requiresResponse' in x, false)
  // Anything but a literal true is a plain answer.
  R.applyEvent(x, { type: 'reply', id: 'b-000001#1', text: 'again', requiresResponse: 'true' })
  assert.equal('requiresResponse' in x, false)
})

// ---------------------------------------------------------------- writes into another bucket

test('Mark seen on a Project row is a merge-by-id write into that route\'s bucket, seenAt the maximum', async () => {
  const k = key('/b')
  const base = c({ id: 'q', status: 'answered', answer: 'a', activityAt: 500, updatedAt: 100 })
  const other = c({ id: 'o', n: 2, updatedAt: 100 })
  const storage = memory({ [k]: { v: 2, seq: 2, comments: [base, other], removed: [] } })
  const store = R.store(storage)
  const changed = await store.update(k, list => {
    const s = list.find(x => x.id === 'q')
    if (!s) return false
    I.markSeen(s, 300)
    return true
  })
  assert.equal(changed, true)
  const after = storage.data[k]
  assert.equal(after.comments.find(x => x.id === 'q').seenAt, 500, 'seenAt covers the activity')
  assert.equal(after.comments.find(x => x.id === 'q').updatedAt, 100, 'seeing is not an edit')
  assert.deepEqual(after.comments.find(x => x.id === 'o'), other, 'the other comment is untouched')
  assert.equal(I.reason(after.comments.find(x => x.id === 'q')), null)

  // A tab on that route writing its older copy afterwards keeps the maximum.
  const stale = { ...base, seenAt: 200 }
  await store.save(k, { seq: 2, comments: [stale, other], removed: [] })
  assert.equal(storage.data[k].comments.find(x => x.id === 'q').seenAt, 500)

  // A comment that is gone is not written back.
  assert.equal(await store.update(k, list => !!list.find(x => x.id === 'missing')), false)
})

test('a fresh answer applied to another bucket reads as unseen there, and needs your input when it asks', async () => {
  const k = key('/b')
  const storage = memory({ [k]: { v: 2, seq: 1, comments: [c({ id: 'q', question: true, updatedAt: 1 })], removed: [] } })
  const store = R.store(storage)
  const item = { id: 'q', batch: 'b-000001#1', found: true, status: 'answered', answer: 'Which colour?', requiresResponse: true }
  await store.update(k, list => {
    let any = false
    for (const ev of I.freshEvents(list.find(x => x.id === 'q'), item)) {
      if (R.applyEvent(list[0], ev)) { I.touch(list[0], ev.type, 1000); list[0].updatedAt = 1000; any = true }
    }
    return any
  })
  const [q] = storage.data[k].comments
  assert.equal(q.answer, 'Which colour?')
  assert.equal(q.requiresResponse, true)
  const v = I.projectView([{ key: k, route: '/b', comments: [q] }], { origin: O })
  assert.equal(v.count, 1)
  assert.equal(v.sections[0].rows[0].state, 'Needs your input')
})

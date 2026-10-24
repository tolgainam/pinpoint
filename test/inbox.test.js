/**
 * The toolbar inbox's This page view, from extension/inbox.js loaded as a module: every row
 * of the needs-attention table, the badge count and its accessible name, the order rows are
 * listed in, and seenAt converging on the maximum through route.js's merge.
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
const HERE = 'http://localhost:5173/users?id=1'
const ctx = (place = 'attached', href = HERE) => ({ place, href })
const c = (extra = {}) => ({ id: 'a', n: 1, note: 'pad', selector: '.x', status: 'pending', createdHref: HERE, ...extra })

// ---------------------------------------------------------------- the table

test('every row of the needs-attention table', () => {
  const rows = [
    ['pending, never dispatched', c(), null],
    ['dispatch failed', c({ deliveryError: 'bridge down' }), 'failed'],
    ['dispatch failed, seen: still failed', c({ deliveryError: 'x', activityAt: 1, seenAt: 9 }), 'failed'],
    ['sent, no new activity', c({ status: 'sent' }), null],
    ['progress working', c({ status: 'sent', progress: { state: 'working' }, activityAt: 5 }), null],
    ['progress edited, unseen', c({ status: 'sent', progress: { state: 'edited' }, activityAt: 5, seenAt: 4 }), 'edited'],
    ['progress edited, seen', c({ status: 'sent', progress: { state: 'edited' }, activityAt: 5, seenAt: 5 }), null],
    ['answered, unseen', c({ status: 'answered', question: true, answer: 'yes', activityAt: 5 }), 'answered'],
    ['answered, seen', c({ status: 'answered', question: true, answer: 'yes', activityAt: 5, seenAt: 6 }), null],
    ['answered with requiresResponse, unseen', c({ status: 'answered', answer: 'y', requiresResponse: true, activityAt: 5 }), 'input'],
    ['answered with requiresResponse, seen', c({ status: 'answered', answer: 'y', requiresResponse: true, activityAt: 5, seenAt: 6 }), null],
    ['answered with requiresResponse anything but true', c({ status: 'answered', answer: 'y', requiresResponse: 'yes', activityAt: 5 }), 'answered'],
    ['resolved, unseen', c({ status: 'resolved', activityAt: 5 }), 'resolved'],
    ['resolved, seen', c({ status: 'resolved', activityAt: 5, seenAt: 5 }), null],
    ['resolved question with its answer, unseen', c({ status: 'resolved', question: true, answer: 'y', activityAt: 5 }), 'answered'],
    ['backlog, saved', c({ status: 'backlog', backlogId: 'bk1' }), null],
    ['backlog, unsaved', c({ status: 'backlog', unsaved: true }), 'unsaved'],
    ['backlog, unsaved, seen: still unsaved', c({ status: 'backlog', unsaved: true, activityAt: 1, seenAt: 2 }), 'unsaved'],
    ['backlog completed, unseen', c({ status: 'resolved', backlogId: 'bk1', activityAt: 5 }), 'completed'],
    ['backlog completed, seen', c({ status: 'resolved', backlogId: 'bk1', activityAt: 5, seenAt: 7 }), null],
    ['no activityAt (stored before the inbox): nothing unseen', c({ status: 'resolved' }), null],
  ]
  for (const [what, comment, want] of rows) assert.equal(I.reason(comment, ctx()), want, what)
})

test('detached counts only on its own creation URL, unresolved, and never for a frozen-frame pin', () => {
  assert.equal(I.reason(c(), ctx('detached')), 'detached')
  assert.equal(I.reason(c({ status: 'sent' }), ctx('detached')), 'detached')
  assert.equal(I.reason(c({ createdHref: undefined }), ctx('detached')), 'detached', 'saved before createdHref: its own')
  assert.equal(I.reason(c(), ctx('detached', 'http://localhost:5173/users?id=2')), null, 'another URL state: informational')
  assert.equal(I.reason(c({ status: 'resolved', activityAt: 1, seenAt: 2 }), ctx('detached')), null)
  assert.equal(I.reason(c({ transient: true }), ctx('detached')), null)
  assert.equal(I.reason(c(), ctx('elsewhere')), null)
  assert.equal(I.reason(c(), ctx('changed')), null)
  // A detached pin with something new says what is new first.
  assert.equal(I.reason(c({ status: 'answered', answer: 'y', activityAt: 2 }), ctx('detached')), 'answered')
})

test('only input, answered, edited, resolved and completed clear on seen', () => {
  assert.deepEqual(I.REASON_ORDER.filter(I.clearsOnSeen), ['input', 'answered', 'edited', 'resolved', 'completed'])
})

// ---------------------------------------------------------------- badge

test('the badge counts comments needing attention, once each, and nothing for ordinary work', () => {
  const list = [
    c({ id: 'p', n: 1 }),
    c({ id: 's', n: 2, status: 'sent' }),
    c({ id: 'w', n: 3, status: 'sent', progress: { state: 'working' }, activityAt: 9 }),
    c({ id: 'r', n: 4, status: 'resolved', activityAt: 3, seenAt: 3 }),
    c({ id: 'b', n: 5, status: 'backlog', backlogId: 'bk' }),
  ]
  assert.equal(I.badge(list, () => ctx()), 0)
  const more = [...list,
    c({ id: 'q', n: 6, status: 'answered', question: true, answer: 'a', activityAt: 9 }),
    c({ id: 'f', n: 7, deliveryError: 'nope' }),
  ]
  assert.equal(I.badge(more, () => ctx()), 2)
  // An answered comment that is also detached is one comment, not two reasons.
  assert.equal(I.badge([c({ status: 'answered', answer: 'a', activityAt: 9 })], () => ctx('detached')), 1)
  // The same id twice (two copies mid-merge) counts once.
  assert.equal(I.badge([more[5], { ...more[5] }], () => ctx()), 1)
})

test('the Inbox button says the count in its name, and shows a number only when there is one', () => {
  assert.deepEqual(I.buttonLabel(0), { text: 'Inbox', badge: '', name: 'Open Pinpoint inbox, 0 items need attention' })
  assert.deepEqual(I.buttonLabel(1), { text: 'Inbox', badge: '1', name: 'Open Pinpoint inbox, 1 item needs attention' })
  assert.deepEqual(I.buttonLabel(3), { text: 'Inbox', badge: '3', name: 'Open Pinpoint inbox, 3 items need attention' })
})

// ---------------------------------------------------------------- the view

test('rows say number, kind, state, a short note and the element; sections keep their order', () => {
  const list = [
    c({ id: 'done', n: 2, status: 'resolved', activityAt: 3, seenAt: 4, note: 'Button now uses accent' }),
    c({ id: 'work', n: 5, status: 'sent', progress: { state: 'working' }, note: 'Header spacing', component: 'Header' }),
    c({ id: 'park', n: 6, status: 'backlog', backlogId: 'bk', note: 'Revisit the empty state' }),
    c({ id: 'fail', n: 7, deliveryError: 'Bridge offline', note: 'Use the compact card' }),
    c({ id: 'ask', n: 3, status: 'answered', question: true, answer: 'Because it is busy.', activityAt: 5, note: 'Why is this disabled?' }),
    c({ id: 'new', n: 8, note: 'x'.repeat(200) }),
  ]
  const v = I.view(list, () => ctx())
  assert.equal(v.count, 2)
  assert.deepEqual(v.sections.map(s => `${s.title} (${s.total})`),
    ['Needs attention (2)', 'Not dispatched (1)', 'In progress (1)', 'Parked (1)', 'Recently done (1)'])
  const [attention, pending, progress, parked, done] = v.sections
  // Broken before new: the failed dispatch first, then the answer.
  assert.deepEqual(attention.rows.map(r => [r.n, r.state]), [[7, 'Not delivered'], [3, 'Answered']])
  const ask = attention.rows[1]
  assert.equal(ask.kind, 'question')
  assert.equal(ask.answer, 'Because it is busy.')
  assert.equal(ask.seen, true)
  assert.equal(ask.name, 'Pin 3, question, answered: Why is this disabled?')
  assert.equal(attention.rows[0].seen, false, 'a failed dispatch is not cleared by looking')
  assert.equal(attention.rows[0].detail, 'Bridge offline')
  assert.equal(pending.rows[0].note.length, 80)
  assert.ok(pending.rows[0].note.endsWith('…'))
  assert.deepEqual([progress.rows[0].state, progress.rows[0].hint], ['Working', '<Header>'])
  assert.deepEqual([parked.rows[0].kind, parked.rows[0].state], ['parked', 'Backlog'])
  assert.deepEqual([done.rows[0].n, done.rows[0].state, done.rows[0].hint], [2, 'Resolved', '.x'])
})

test('attention lists failed, unsaved, answered, edited, resolved, completed, detached; done is newest first', () => {
  const list = [
    c({ id: '1', n: 1, selector: '.gone' }),
    c({ id: '2', n: 2, status: 'resolved', backlogId: 'b', activityAt: 2 }),
    c({ id: '3', n: 3, status: 'resolved', activityAt: 2 }),
    c({ id: '4', n: 4, status: 'sent', progress: { state: 'edited' }, activityAt: 2 }),
    c({ id: '5', n: 5, status: 'answered', answer: 'a', activityAt: 2 }),
    c({ id: '6', n: 6, status: 'backlog', unsaved: true }),
    c({ id: '7', n: 7, deliveryError: 'x' }),
  ]
  const v = I.view(list, x => ctx(x.selector === '.gone' ? 'detached' : 'attached'))
  assert.deepEqual(v.sections[0].rows.map(r => r.reason), ['failed', 'unsaved', 'answered', 'edited', 'resolved', 'completed', 'detached'])
  const done = I.view([
    c({ id: 'old', n: 1, status: 'resolved', updatedAt: 10 }),
    c({ id: 'new', n: 2, status: 'resolved', updatedAt: 20 }),
  ]).sections[0]
  assert.deepEqual(done.rows.map(r => r.id), ['new', 'old'])
})

test('a section shows at most 50 rows and says how many more there are', () => {
  const list = Array.from({ length: 53 }, (_, i) => c({ id: `p${i}`, n: i + 1 }))
  const [s] = I.view(list).sections
  assert.equal(s.total, 53)
  assert.equal(s.rows.length, I.CAP)
  assert.equal(s.more, 3)
  assert.deepEqual(I.view([]).sections, [])
})

// ---------------------------------------------------------------- seen

test('touch stamps activity; a question resolved after its answer is not news', () => {
  const x = I.touch(c({ status: 'sent' }), 'progress', 100)
  assert.equal(x.activityAt, 100)
  assert.equal(I.touch(x, 'reply', 50).activityAt, 100, 'never backwards')
  const q = c({ status: 'resolved', question: true, answer: 'a', activityAt: 7 })
  assert.equal(I.touch(q, 'resolved', 200).activityAt, 7)
  assert.equal(I.touch(c({ status: 'resolved' }), 'resolved', 200).activityAt, 200)
})

test('markSeen clears unseen and never moves seenAt back', () => {
  const x = c({ status: 'answered', answer: 'a', activityAt: 500 })
  assert.equal(I.unseen(x), true)
  I.markSeen(x, 100)
  assert.equal(x.seenAt, 500, 'a clock behind the activity still covers it')
  assert.equal(I.unseen(x), false)
  I.markSeen(x, 50)
  assert.equal(x.seenAt, 500)
})

test('two tabs on one route converge on the maximum seenAt, and seeing does not count as an edit', () => {
  const base = { id: 'q', n: 1, note: 'why', status: 'answered', answer: 'a', activityAt: 100, updatedAt: 100 }
  const tabA = { ...base, seenAt: 300 }
  const tabB = { ...base, seenAt: 200 }
  const stored = { seq: 1, comments: [{ ...base }], removed: [] }
  const fromA = R.merge(stored, { seq: 1, comments: [tabA], removed: [] }, 1000)
  assert.equal(fromA.comments[0].seenAt, 300)
  // B writes later with an older seenAt: the maximum stays.
  const fromB = R.merge(fromA, { seq: 1, comments: [tabB], removed: [] }, 1000)
  assert.equal(fromB.comments[0].seenAt, 300)
  assert.equal(I.reason(fromB.comments[0], ctx()), null)
  // A seenAt is not part of what makes a comment changed, so it never bumps updatedAt.
  assert.equal(R.signature(tabA), R.signature(tabB))
  // New activity after both have seen it reads as unseen again in either tab.
  const later = { ...fromB.comments[0], activityAt: 400, updatedAt: 400 }
  const fromC = R.merge(fromB, { seq: 1, comments: [later], removed: [] }, 1000)
  assert.equal(fromC.comments[0].seenAt, 300)
  assert.equal(I.reason(fromC.comments[0], ctx()), 'answered')
})

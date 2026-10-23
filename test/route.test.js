/**
 * Route-aware pins, from extension/route.js loaded as a module: the storage key, the
 * evidence a stored pin needs to attach, stable ids, the merge by id, and the move from the
 * legacy key. test/e2e.test.js covers the same feature in a real browser.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../extension/route.js'

const R = globalThis.PinpointRoute
const DAY = 24 * 60 * 60 * 1000

/** A location-like object from an href, as the browser would give it. */
const at = href => {
  const u = new URL(href)
  return { origin: u.origin, pathname: u.pathname, hash: u.hash, href: u.href }
}
const suffix = href => R.keyFor(at(href)).slice(`${R.PREFIX}http://localhost:5173`.length)

// ---------------------------------------------------------------- key

test('every row of the route table', () => {
  const rows = [
    ['/london#by=line&play=week', '/london'],
    ['/users?id=1', '/users'],
    ['/users?id=2', '/users'],
    ['/app#/users?tab=activity', '/app#/users'],
    ['/app#!/users/42?tab=activity', '/app#!/users/42'],
    ['/docs#install', '/docs'],
  ]
  for (const [url, want] of rows) assert.equal(suffix(`http://localhost:5173${url}`), want, url)
})

test('the key carries the prefix, the origin with its port, and the path', () => {
  assert.equal(R.keyFor(at('http://localhost:5173/a/b')), 'pinpoint:v2:http://localhost:5173/a/b')
  assert.notEqual(R.keyFor(at('http://localhost:5173/a')), R.keyFor(at('http://localhost:5174/a')))
  assert.notEqual(R.keyFor(at('http://localhost:5173/a')), R.keyFor(at('http://127.0.0.1:5173/a')))
  assert.equal(R.legacyKeyFor(at('http://localhost:5173/a?x=1#/b')), 'pinpoint:http://localhost:5173/a')
})

test('hash routes: slash and hash-bang are distinct, the query inside the hash is left out', () => {
  assert.equal(R.routeHash('#/users'), '#/users')
  assert.equal(R.routeHash('#!/users'), '#!/users')
  assert.notEqual(suffix('http://localhost:5173/#/users'), suffix('http://localhost:5173/#!/users'))
  assert.equal(R.routeHash('#/users?tab=a&b=c'), '#/users')
  assert.equal(R.routeHash('#!/users/42?'), '#!/users/42')
  assert.equal(R.routeHash('#/'), '#/')
  assert.notEqual(suffix('http://localhost:5173/#/users'), suffix('http://localhost:5173/#/projects'))
})

test('state hashes, anchors and empty fragments add nothing', () => {
  for (const h of ['', '#', '#by=line&play=week&wk=20260824', '#section-2', '#install', '#!', '#!foo', '#users/1', '#?tab=1', '# /x']) {
    assert.equal(R.routeHash(h), '', JSON.stringify(h))
  }
  // The London sequence: by, play and wk change; the key does not.
  const base = R.keyFor(at('http://localhost:5173/london'))
  for (const h of ['#by=line', '#by=line&play=week', '#by=bus&play=week&wk=20260824', '#by=bus&play=month&wk=20260831']) {
    assert.equal(R.keyFor(at(`http://localhost:5173/london${h}`)), base, h)
  }
  assert.equal(R.keyFor(at('http://localhost:5173/users?id=1')), R.keyFor(at('http://localhost:5173/users?id=2')))
})

test('trailing slashes, case and encoding are kept as the browser gives them', () => {
  assert.notEqual(suffix('http://localhost:5173/users/'), suffix('http://localhost:5173/users'))
  assert.notEqual(suffix('http://localhost:5173/Users'), suffix('http://localhost:5173/users'))
  assert.notEqual(suffix('http://localhost:5173/app#/users/'), suffix('http://localhost:5173/app#/users'))
  assert.equal(suffix('http://localhost:5173/a%20b'), '/a%20b')
  // Unicode in the path arrives percent-encoded from URL; in a hash it is kept as given.
  assert.equal(suffix('http://localhost:5173/café'), '/caf%C3%A9')
  assert.equal(R.routeHash('#/café/\u{1F600}?q=1'), '#/café/\u{1F600}')
  assert.equal(R.keyFor({ origin: 'http://localhost:5173', pathname: '/x', hash: '#/über' }), 'pinpoint:v2:http://localhost:5173/x#/über')
})

test('a very long href gives a bounded, stable key that still tells routes apart', () => {
  const long = 'x'.repeat(5000)
  const a = R.keyFor(at(`http://localhost:5173/${long}a`))
  const b = R.keyFor(at(`http://localhost:5173/${long}b`))
  assert.ok(a.length <= R.MAX_KEY, `${a.length}`)
  assert.equal(a, R.keyFor(at(`http://localhost:5173/${long}a`)))
  assert.notEqual(a, b)
  assert.ok(a.startsWith('pinpoint:v2:http://localhost:5173/xxx'))
  // A long query or state hash is not part of the key at all.
  assert.equal(R.keyFor(at(`http://localhost:5173/u?${long}#k=${long}`)), 'pinpoint:v2:http://localhost:5173/u')
})

test('urlState is everything after the origin', () => {
  assert.equal(R.urlState('http://localhost:5173/users?id=1#x'), '/users?id=1#x')
  assert.equal(R.urlState('not a url'), 'not a url')
})

// ---------------------------------------------------------------- evidence

const facts = (o = {}) => ({ tag: 'button', text: 'Save', ...o })
const made = (href, ev, extra = {}) => ({ createdHref: href, evidence: R.evidence(ev), selector: 'x', ...extra })
const ONE = 'http://localhost:5173/users?id=1'
const TWO = 'http://localhost:5173/users?id=2'

test('the same URL with matching identity attaches; changed text is attached and marked, not detached', () => {
  assert.equal(R.placeOf(made(ONE, facts()), ONE, facts()), 'attached')
  assert.equal(R.placeOf(made(ONE, facts()), ONE, facts({ text: 'Saved!' })), 'changed')
  assert.equal(R.placeOf(made(ONE, facts({ text: '' })), ONE, facts({ text: 'any' })), 'attached')
})

test('another URL state: a tag and non-empty text match attach and are marked', () => {
  assert.equal(R.placeOf(made(ONE, facts()), TWO, facts()), 'elsewhere')
  assert.equal(R.placeOf(made(ONE, facts({ text: '  Save\n ' })), TWO, facts({ text: 'Save' })), 'elsewhere')
  assert.equal(R.placeOf(made(ONE, facts()), TWO, facts({ text: 'Delete' })), 'detached')
})

test('another URL state with no saved text needs a stable id, test attribute or accessible name', () => {
  const empty = { tag: 'div', text: '' }
  assert.equal(R.placeOf(made(ONE, { ...empty, id: 'chart' }), TWO, { ...empty, id: 'chart' }), 'elsewhere')
  const test = { name: 'data-testid', value: 'chart' }
  assert.equal(R.placeOf(made(ONE, { ...empty, test }), TWO, { ...empty, test }), 'elsewhere')
  assert.equal(R.placeOf(made(ONE, { ...empty, label: 'Chart', role: 'img' }), TWO, { ...empty, label: 'Chart', role: 'img' }), 'elsewhere')
  assert.equal(R.placeOf(made(ONE, { ...empty, label: 'Chart', role: 'img' }), TWO, { ...empty, label: 'Chart', role: 'button' }), 'detached')
  // Only a positional selector or generic classes: no proof of identity.
  assert.equal(R.placeOf(made(ONE, { ...empty, classes: ['box'] }), TWO, { ...empty, classes: ['box'] }), 'detached')
  assert.equal(R.placeOf(made(ONE, empty), TWO, empty), 'detached')
})

test('a missing node, another tag or a conflicting stable identity is detached', () => {
  assert.equal(R.placeOf(made(ONE, facts()), ONE, null), 'detached')
  assert.equal(R.placeOf(made(ONE, facts()), ONE, facts({ tag: 'a' })), 'detached')
  assert.equal(R.placeOf(made(ONE, facts({ id: 'save' })), ONE, facts({ id: 'cancel' })), 'detached')
  const t = v => ({ name: 'data-testid', value: v })
  assert.equal(R.placeOf(made(ONE, facts({ test: t('a') })), ONE, facts({ test: t('b') })), 'detached')
})

test('a comment saved before evidence existed falls back to describe() fields and attaches on its selector', () => {
  const legacy = { selector: '#x', tag: 'h1', text: 'Hello', elementId: 'x' }
  assert.equal(R.placeOf(legacy, TWO, { tag: 'h1', text: 'Hello', id: 'x' }), 'attached')
  assert.equal(R.placeOf({ selector: '#x' }, TWO, { tag: 'p', text: '' }), 'attached')
  assert.equal(R.placeOf(legacy, TWO, { tag: 'p', text: 'Hello' }), 'detached')
})

test('evidence is bounded', () => {
  const ev = R.evidence({ tag: 'p', text: 'x '.repeat(500), label: 'l'.repeat(999), classes: Array.from({ length: 20 }, (_, i) => `c${i}`) })
  assert.ok(ev.text.length <= 200)
  assert.ok(ev.label.length <= 200)
  assert.equal(ev.classes.length, 8)
  assert.equal(ev.id, undefined)
})

// ---------------------------------------------------------------- ids

test('ids: legacy comments get stable derived ids, real ones are kept, duplicates told apart', () => {
  const a = [{ n: 1, note: 'a', selector: '#a' }, { n: 2, note: 'b', selector: '#b', id: 'kept' }]
  const b = [{ n: 1, note: 'a', selector: '#a' }]
  R.ensureIds(a)
  R.ensureIds(b)
  assert.equal(a[0].id, b[0].id)
  assert.match(a[0].id, /^legacy-1-[0-9a-f]{8}$/)
  assert.equal(a[1].id, 'kept')
  assert.equal(a[0].updatedAt, 0)
  const twins = R.ensureIds([{ n: 1, note: 'same' }, { n: 1, note: 'same' }])
  assert.notEqual(twins[0].id, twins[1].id)
  assert.notEqual(R.newId(), R.newId())
})

// ---------------------------------------------------------------- merge

const c = (id, updatedAt, extra = {}) => ({ id, n: 1, note: id, updatedAt, ...extra })

test('merge by id: the later updatedAt wins, seenAt takes the maximum, the local side wins a tie', () => {
  const now = 1_000_000
  const stored = { seq: 2, comments: [c('a', 10, { note: 'stored a', seenAt: 50 }), c('b', 30, { note: 'stored b', seenAt: 5 })] }
  const local = { seq: 3, comments: [c('a', 20, { note: 'local a', seenAt: 7 }), c('b', 25, { note: 'local b', seenAt: 60 }), c('c', 1, { n: 3 })] }
  const out = R.merge(stored, local, now)
  const by = Object.fromEntries(out.comments.map(x => [x.id, x]))
  assert.equal(by.a.note, 'local a')
  assert.equal(by.a.seenAt, 50)
  assert.equal(by.b.note, 'stored b')
  assert.equal(by.b.seenAt, 60)
  assert.ok(by.c)
  assert.equal(out.seq, 3)
  const tie = R.merge({ comments: [c('t', 5, { note: 'stored' })] }, { comments: [c('t', 5, { note: 'local' })] }, now)
  assert.equal(tie.comments[0].note, 'local')
})

test('a removed id stays removed for 7 days, then the entry expires', () => {
  const now = 100 * DAY
  const out = R.merge({ comments: [c('x', 1)], removed: [] }, { comments: [], removed: [{ id: 'x', at: now }] }, now)
  assert.deepEqual(out.comments, [])
  assert.deepEqual(out.removed, [{ id: 'x', at: now }])
  // A stale copy of x saved within the week does not come back.
  const later = R.merge(out, { comments: [c('x', 99)] }, now + 6 * DAY)
  assert.deepEqual(later.comments, [])
  // After the week the entry is pruned.
  assert.deepEqual(R.pruneRemoved([[{ id: 'x', at: now }]], now + 7 * DAY + 1), [])
  assert.equal(R.pruneRemoved([[{ id: 'x', at: now }], [{ id: 'x', at: now + 5 }]], now)[0].at, now + 5)
})

/** chrome.storage.local, in memory, with values copied like the real one. */
function memoryStorage(seed = {}, { failSet = false } = {}) {
  const data = structuredClone(seed)
  const pick = keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])]))
  return {
    data,
    fail: failSet,
    async get(keys) { return pick(keys) },
    async set(obj) {
      if (this.fail) throw new Error('quota')
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v)
    },
    async remove(k) { delete data[k] },
  }
}

test('two tabs: a stale tab saving its old list neither resurrects a removed comment nor drops a new one', async () => {
  const KEY = 'pinpoint:v2:http://localhost:5173/a'
  const storage = memoryStorage({ [KEY]: { v: 2, seq: 2, comments: [c('x', 1), c('y', 1, { n: 2 })], removed: [] } })
  const tabA = { store: R.store(storage), track: R.tracker(), comments: [], seq: 0 }
  const tabB = { store: R.store(storage), track: R.tracker(), comments: [], seq: 0 }
  for (const t of [tabA, tabB]) {
    const got = t.track.absorb(await t.store.load(KEY, 'legacy'), t.comments, t.seq)
    t.comments = got.comments
    t.seq = got.seq
  }
  // A removes x and adds z.
  tabA.comments = tabA.comments.filter(x => x.id !== 'x')
  tabA.comments.push({ id: 'z', n: 3, note: 'z' })
  await tabA.store.save(KEY, tabA.track.local(tabA.comments, 3))
  // B never heard about it and edits y, then saves everything it still holds.
  tabB.comments.find(x => x.id === 'y').note = 'edited in B'
  const written = await tabB.store.save(KEY, tabB.track.local(tabB.comments, tabB.seq, Date.now() + 5))
  const ids = written.comments.map(x => x.id).sort()
  assert.deepEqual(ids, ['y', 'z'])
  assert.equal(written.comments.find(x => x.id === 'y').note, 'edited in B')
  assert.deepEqual(written.removed.map(r => r.id), ['x'])
  // A takes B's write in: it keeps its own objects and sees B's edit.
  const zA = tabA.comments.find(x => x.id === 'z')
  const yA = tabA.comments.find(x => x.id === 'y')
  const took = tabA.track.absorb(storage.data[KEY], tabA.comments, 3)
  assert.equal(took.changed, true)
  assert.equal(took.comments.find(x => x.id === 'z'), zA)
  assert.equal(took.comments.find(x => x.id === 'y'), yA)
  assert.equal(yA.note, 'edited in B')
  // Taking the same record again changes nothing.
  assert.equal(tabA.track.absorb(storage.data[KEY], took.comments, 3).changed, false)
})

test('an edit gets a fresh updatedAt; moving a pin does not', () => {
  const t = R.tracker()
  const list = [{ id: 'a', n: 1, note: 'a', docX: 1 }]
  t.local(list, 1, 100)
  assert.equal(list[0].updatedAt, 100)
  list[0].docX = 50
  t.local(list, 1, 200)
  assert.equal(list[0].updatedAt, 100)
  list[0].status = 'sent'
  t.local(list, 1, 300)
  assert.equal(list[0].updatedAt, 300)
})

// ---------------------------------------------------------------- migration

const LEGACY = 'pinpoint:http://localhost:5173/app'
const V2 = 'pinpoint:v2:http://localhost:5173/app'
const old = () => ({ seq: 2, comments: [{ n: 1, note: 'one', selector: '#a' }, { n: 2, note: 'two', selector: '#b' }] })

test('migration copies the legacy key into an empty bucket, then removes the legacy key', async () => {
  const storage = memoryStorage({ [LEGACY]: old() })
  const rec = await R.store(storage).load(V2, LEGACY)
  assert.equal(rec.comments.length, 2)
  assert.equal(rec.migratedFrom, LEGACY)
  assert.ok(rec.comments.every(x => /^legacy-/.test(x.id)))
  assert.equal(storage.data[V2].comments.length, 2)
  assert.equal(LEGACY in storage.data, false)
})

test('migration is idempotent: the legacy key coming back again merges to the same ids', async () => {
  const storage = memoryStorage({ [LEGACY]: old() })
  const s = R.store(storage)
  const first = await s.load(V2, LEGACY)
  storage.data[LEGACY] = old()
  const second = await s.load(V2, LEGACY)
  assert.deepEqual(second.comments.map(x => x.id), first.comments.map(x => x.id))
  assert.equal(storage.data[V2].comments.length, 2)
  // And a third load with nothing legacy left reads the bucket as it is.
  const third = await s.load(V2, LEGACY)
  assert.equal(third.comments.length, 2)
})

test('migration merges into a populated bucket rather than over it, and keeps a removal', async () => {
  const ids = R.ensureIds(old().comments).map(x => x.id)
  const storage = memoryStorage({
    [LEGACY]: old(),
    [V2]: { v: 2, seq: 1, comments: [c('new', 5)], removed: [{ id: ids[1], at: Date.now() }] },
  })
  const rec = await R.store(storage).load(V2, LEGACY)
  assert.deepEqual(rec.comments.map(x => x.id).sort(), [ids[0], 'new'].sort())
})

test('a failed migration write loses nothing: the legacy key stays and the page still sees the comments', async () => {
  const storage = memoryStorage({ [LEGACY]: old() }, { failSet: true })
  const rec = await R.store(storage).load(V2, LEGACY)
  assert.equal(rec.comments.length, 2)
  assert.equal(storage.data[LEGACY].comments.length, 2)
  assert.equal(V2 in storage.data, false)
  // The next load, with storage working, completes it.
  storage.fail = false
  await R.store(storage).load(V2, LEGACY)
  assert.equal(storage.data[V2].comments.length, 2)
  assert.equal(LEGACY in storage.data, false)
})

test('a write over quota drops the screenshots and keeps the notes', async () => {
  const storage = memoryStorage()
  let first = true
  const set = storage.set.bind(storage)
  storage.set = async obj => {
    if (first) { first = false; throw new Error('quota') }
    return set(obj)
  }
  await R.store(storage).save(V2, { seq: 1, comments: [c('a', 1, { shot: 'data:image/png;base64,AAAA' })] })
  assert.equal(storage.data[V2].comments[0].shot, undefined)
  assert.equal(storage.data[V2].comments[0].note, 'a')
})

// ---------------------------------------------------------------- events for another route

test('an event for a comment of another bucket is applied there', async () => {
  const OTHER = 'pinpoint:v2:http://localhost:5173/app#/projects'
  const storage = memoryStorage({ [OTHER]: { v: 2, seq: 1, comments: [c('a', 1, { batch: 'b1', serverN: 1, status: 'sent' })], removed: [] } })
  const s = R.store(storage)
  const ev = { type: 'resolved', id: 'b1#1', resolution: 'done' }
  const ok = await s.update(OTHER, list => {
    const hit = list.find(x => R.names(x, ev.id))
    return !!hit && R.applyEvent(hit, ev)
  })
  assert.equal(ok, true)
  assert.equal(storage.data[OTHER].comments[0].status, 'resolved')
  assert.equal(storage.data[OTHER].comments[0].resolution, 'done')
  assert.equal(R.applyEvent({ status: 'sent' }, { type: 'reply', text: '  ' }), false)
  assert.equal(R.names({ backlogId: 'bk1' }, 'bk1'), true)
})

// ---------------------------------------------------------------- watching

test('watch coalesces signals into one change, polls only while visible, and never touches history', async () => {
  const listeners = {}
  const win = {
    location: { href: 'http://localhost/a' },
    addEventListener: (t, f) => { (listeners[t] ??= []).push(f) },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== f) },
    history: { pushState() {}, replaceState() {} },
  }
  const doc = { visibilityState: 'visible', ...{ addEventListener: win.addEventListener, removeEventListener: win.removeEventListener } }
  const push = win.history.pushState
  const seen = []
  const w = R.watch({ win, doc, onChange: (now, was) => seen.push([now, was]), interval: 10 })
  assert.equal(w.polling, true)
  win.location.href = 'http://localhost/b'
  for (const f of [...listeners.popstate, ...listeners.hashchange]) f()
  w.check()
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(seen, [['http://localhost/b', 'http://localhost/a']])
  // Only the poll sees this one.
  win.location.href = 'http://localhost/c'
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.at(-1)[0], 'http://localhost/c')
  // Hidden: no poll. Visible again: one comparison at once.
  doc.visibilityState = 'hidden'
  for (const f of listeners.visibilitychange) f()
  assert.equal(w.polling, false)
  win.location.href = 'http://localhost/d'
  await new Promise(r => setTimeout(r, 40))
  assert.equal(seen.length, 2)
  doc.visibilityState = 'visible'
  for (const f of listeners.visibilitychange) f()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(seen.at(-1)[0], 'http://localhost/d')
  assert.equal(win.history.pushState, push)
  w.stop()
  assert.equal(w.polling, false)
})

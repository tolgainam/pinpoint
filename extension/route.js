/**
 * Pinpoint route identity: which storage bucket a page's pins live in, whether a stored pin
 * may attach to the element it finds, and how two copies of one bucket are merged.
 *
 * Loaded before content.js and left on the isolated world's global as `PinpointRoute`, like
 * status.js, a11y.js and scope.js. Everything but `watch` is pure, so the Node tests import
 * this file and check every rule without a browser.
 *
 * The rules, as built:
 *   key        `pinpoint:v2:<origin><pathname><routeHash>`. `routeHash` is the hash only
 *              when it is a route: `#/path` or `#!/path`, with any `?query` inside the hash
 *              left out. Every other fragment (`#by=line&play=week`, `#section-2`, an empty
 *              hash) is state or an anchor and adds nothing. `location.search` never counts.
 *              Nothing is decoded, case-folded or trimmed: the browser's text is the input.
 *              A key longer than MAX_KEY keeps its head and ends in a hash of the whole.
 *   evidence   a bucket holds every URL state of one route, so `/users?id=1` and
 *              `/users?id=2` share pins. A pin attaches only when the element its selector
 *              finds agrees with what was saved about it; see `placeOf`.
 *   merge      every comment has a stable `id`. A save reads the stored record first and
 *              merges by id: the later `updatedAt` wins, `seenAt` takes the maximum, and an
 *              id on the `removed` list (kept REMOVED_TTL) never comes back.
 *   legacy     the key before this one, `pinpoint:<origin><pathname>`, is merged into the
 *              route bucket of the first page that loads it, then removed once that write
 *              has landed. Legacy comments get ids derived from their content, so doing it
 *              twice gives the same record.
 */
;(function () {
  const PREFIX = 'pinpoint:v2:'
  /** Longer keys keep this many characters and end in a hash of the whole key. */
  const MAX_KEY = 1024
  const REMOVED_TTL = 7 * 24 * 60 * 60 * 1000
  /** How many removed ids a record keeps at most, newest first. */
  const MAX_REMOVED = 500
  const MAX_TEXT = 200
  const MAX_FIELD = 200
  const MAX_CLASSES = 8
  const POLL_MS = 250

  // ------------------------------------------------------------ key

  /** FNV-1a over UTF-16 units, as 8 hex digits. Stable across runs and builds. */
  function hash(text) {
    let h = 0x811c9dc5
    const s = String(text)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  /** The route part of a `location.hash`, or '' when the hash is state or an anchor. */
  function routeHash(hashText) {
    const h = String(hashText ?? '')
    const lead = h.startsWith('#/') ? 2 : h.startsWith('#!/') ? 3 : 0
    if (!lead) return ''
    const q = h.indexOf('?', lead)
    return q === -1 ? h : h.slice(0, q)
  }

  function cap(key) {
    return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 10)}~${hash(key)}`
  }

  /** The storage key for a location-like `{ origin, pathname, hash }`. */
  const keyFor = loc => cap(`${PREFIX}${loc.origin}${loc.pathname}${routeHash(loc.hash)}`)

  /** The key builds before 0.8.0 used: origin and path, nothing else. */
  const legacyKeyFor = loc => `pinpoint:${loc.origin}${loc.pathname}`

  /** What a card shows of a URL: everything after the origin. */
  function urlState(href) {
    try {
      const u = new URL(href)
      return `${u.pathname}${u.search}${u.hash}`
    } catch { return String(href ?? '') }
  }

  // ------------------------------------------------------------ ids

  function newId() {
    try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID() } catch { /* fall through */ }
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /** An id for a comment saved before ids existed: the same comment always gets the same one. */
  const legacyId = c => `legacy-${Number(c?.n) || 0}-${hash([c?.selector, c?.note, c?.batch, c?.serverN, c?.backlogId].join('\u0000'))}`

  /**
   * Gives every comment an id, in place. A comment without one is legacy: it gets a derived
   * id and updatedAt 0, so any real edit wins over it in a merge.
   */
  function ensureIds(list) {
    const seen = new Set()
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object') continue
      if (typeof c.id !== 'string' || !c.id) c.id = legacyId(c)
      // Two legacy comments with the same content would collide; the second is told apart.
      while (seen.has(c.id)) c.id = `${c.id}-${hash(c.id)}`
      seen.add(c.id)
      if (typeof c.updatedAt !== 'number') c.updatedAt = 0
    }
    return list
  }

  /** What counts as a change to a comment: everything but where its pin last stood and the stamps. */
  function signature(c) {
    const { updatedAt, seenAt, docX, docY, shot, ...rest } = c
    return `${JSON.stringify(rest)}|${typeof shot === 'string' ? shot.length : 0}`
  }

  // ------------------------------------------------------------ merge

  /** Union of removed lists, newest `at` per id, nothing older than the TTL. */
  function pruneRemoved(lists, now) {
    const by = new Map()
    for (const list of lists) {
      for (const r of Array.isArray(list) ? list : []) {
        if (!r || typeof r.id !== 'string') continue
        const at = Number(r.at) || 0
        if (now - at > REMOVED_TTL) continue
        if (!by.has(r.id) || by.get(r.id) < at) by.set(r.id, at)
      }
    }
    return [...by].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, MAX_REMOVED)
  }

  const order = (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || (Number(a.n) || 0) - (Number(b.n) || 0)

  /**
   * Merge what is stored with what this page holds. Both are `{ seq, comments, removed }`.
   * Returns the record to write. Comment objects are passed through, never copied, so the
   * caller can tell which side won by identity. On equal `updatedAt` the local side wins:
   * it is the one doing the writing.
   */
  function merge(stored, local, now = Date.now()) {
    const s = stored && typeof stored === 'object' ? stored : {}
    const l = local && typeof local === 'object' ? local : {}
    const sList = ensureIds(Array.isArray(s.comments) ? s.comments : [])
    const lList = ensureIds(Array.isArray(l.comments) ? l.comments : [])
    const removed = pruneRemoved([s.removed, l.removed], now)
    const gone = new Set(removed.map(r => r.id))
    const by = new Map()
    for (const c of sList) if (!gone.has(c.id)) by.set(c.id, c)
    for (const c of lList) {
      if (gone.has(c.id)) continue
      const other = by.get(c.id)
      if (!other) { by.set(c.id, c); continue }
      const win = (Number(c.updatedAt) || 0) >= (Number(other.updatedAt) || 0) ? c : other
      const seen = Math.max(Number(c.seenAt) || 0, Number(other.seenAt) || 0)
      if (seen) win.seenAt = seen
      by.set(c.id, win)
    }
    const comments = [...by.values()].sort(order)
    const seq = Math.max(Number(s.seq) || 0, Number(l.seq) || 0, ...comments.map(c => Number(c.n) || 0))
    const out = { v: 2, seq, comments, removed }
    const from = l.migratedFrom ?? s.migratedFrom
    if (from) out.migratedFrom = from
    return out
  }

  /** Make `target` read exactly like `source`, keeping the object. */
  function adopt(target, source) {
    if (target === source) return target
    for (const k of Object.keys(target)) if (!(k in source)) delete target[k]
    Object.assign(target, source)
    return target
  }

  /**
   * What to do about the legacy key on load. Returns `{ record, write, removeLegacy }`.
   * Legacy comments are merged into whatever the v2 bucket holds, never over it; their ids
   * are derived, so a second run changes nothing, and one removed since stays removed.
   */
  function migrate(legacy, current, legacyKey, now = Date.now()) {
    const has = current && typeof current === 'object'
    if (!legacy || typeof legacy !== 'object' || !Array.isArray(legacy.comments)) {
      return { record: has ? merge(current, null, now) : null, write: false, removeLegacy: false }
    }
    const old = ensureIds(legacy.comments.filter(c => c && typeof c === 'object'))
    const record = merge({ seq: legacy.seq, comments: old }, has ? current : null, now)
    record.migratedFrom = legacyKey
    return { record, write: true, removeLegacy: true }
  }

  /**
   * What one page knows about its bucket between saves: which ids it last saw (one missing
   * now was removed here), the removed list, and each comment's signature (one that differs
   * was edited here and gets a fresh `updatedAt`). content.js keeps one per page.
   */
  function tracker() {
    let known = new Set()
    let removed = []
    const sigs = new Map()

    /** Stamp what the page holds and describe it as a record to merge. */
    function local(comments, seq, now = Date.now()) {
      ensureIds(comments)
      for (const c of comments) {
        const s = signature(c)
        if (sigs.get(c.id) === s) continue
        if (sigs.has(c.id) || !c.updatedAt) c.updatedAt = now
        sigs.set(c.id, s)
      }
      const ids = new Set(comments.map(c => c.id))
      const gone = [...known].filter(id => !ids.has(id)).map(id => ({ id, at: now }))
      for (const g of gone) sigs.delete(g.id)
      removed = pruneRemoved([removed, gone], now)
      known = ids
      return { seq, comments, removed }
    }

    const view = list => list.map(c => `${c.id}\u0000${signature(c)}`).join('\n')

    /**
     * Take a stored record in. Returns the page's new list, keeping every object the page
     * already had (its fields replaced when the stored copy won), and whether it changed.
     */
    function absorb(record, comments, seq, now = Date.now()) {
      const before = view(local(comments, seq, now).comments)
      const merged = merge(record, { seq, comments, removed }, now)
      const mine = new Map(comments.map(c => [c.id, c]))
      const out = merged.comments.map(c => (mine.has(c.id) ? adopt(mine.get(c.id), c) : c))
      for (const c of out) sigs.set(c.id, signature(c))
      removed = merged.removed
      known = new Set(out.map(c => c.id))
      return { comments: out, seq: merged.seq, changed: view(out) !== before }
    }

    return {
      local,
      absorb,
      reset() { known = new Set(); removed = []; sigs.clear() },
      get removed() { return removed },
    }
  }

  /**
   * Reads and writes of route buckets, one at a time per page. `storage` is
   * chrome.storage.local or anything with the same promise-returning get/set/remove.
   */
  function store(storage) {
    let chain = Promise.resolve()
    const queue = fn => (chain = chain.catch(() => {}).then(fn))

    /** Over quota: screenshots are the bulky part and the least costly to lose. */
    async function write(key, record) {
      try {
        await storage.set({ [key]: record })
        return record
      } catch {
        const lean = { ...record, comments: record.comments.map(({ shot, ...rest }) => rest) }
        await storage.set({ [key]: lean })
        return lean
      }
    }

    return {
      /** Merge `local` into what is stored under `key`, write it, resolve to what was written. */
      save: (key, local) => queue(async () => write(key, merge((await storage.get(key))[key], local))),
      /**
       * The record of `key`, with the legacy key merged in. The legacy key is removed only
       * once the merged record is read back holding every one of its comments, so a failed
       * write loses nothing and the next load tries again with the same ids.
       */
      load: (key, legacyKey) => queue(async () => {
        const got = await storage.get([key, legacyKey])
        const plan = migrate(got[legacyKey], got[key], legacyKey)
        if (!plan.write) return plan.record
        try {
          await write(key, plan.record)
          const back = (await storage.get(key))[key]
          const ids = new Set((back?.comments ?? []).map(c => c?.id))
          if (plan.removeLegacy && plan.record.comments.every(c => ids.has(c.id))) await storage.remove(legacyKey)
        } catch { /* the legacy key stays for the next load */ }
        return plan.record
      }),
      /** Change a bucket this page is not showing. `fn(comments)` returns whether it changed any. */
      update: (key, fn) => queue(async () => {
        const rec = (await storage.get(key))[key]
        if (!rec || !Array.isArray(rec.comments)) return false
        ensureIds(rec.comments)
        if (!fn(rec.comments)) return false
        await write(key, merge(null, rec))
        return true
      }),
      /** Resolves once every queued read and write has finished. */
      idle: () => chain.catch(() => {}),
    }
  }

  // ------------------------------------------------------------ evidence

  const short = (v, n = MAX_FIELD) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)
  const normText = t => String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT)

  /**
   * The bounded fingerprint a comment keeps of its element. `facts` is what content.js
   * read off it: tag, id, test attribute, role, aria-label, text and stable classes.
   */
  function evidence(facts) {
    const f = facts || {}
    const out = { tag: short(f.tag, 40) }
    if (f.id) out.id = short(f.id)
    if (f.test && f.test.name && f.test.value) out.test = { name: short(f.test.name, 40), value: short(f.test.value) }
    if (f.role) out.role = short(f.role, 40)
    if (f.label) out.label = short(f.label)
    const text = normText(f.text)
    if (text) out.text = text
    if (Array.isArray(f.classes) && f.classes.length) out.classes = f.classes.slice(0, MAX_CLASSES).map(c => short(c, 40))
    return out
  }

  /** The evidence of a comment saved before evidence existed, from what describe() kept. */
  function evidenceOf(c) {
    if (c?.evidence && typeof c.evidence === 'object') return c.evidence
    return evidence({ tag: c?.tag, id: c?.elementId, role: c?.role, label: c?.ariaLabel, text: c?.text })
  }

  /**
   * Where a stored comment stands against the element its selector found now.
   *   attached   same URL state (or one saved before it was recorded), identity agrees
   *   changed    as attached, but the element's text differs from what was saved
   *   elsewhere  another URL state of this route, and the element is proven the same one:
   *              tag and saved non-empty text match, or with no saved text a stable id,
   *              test attribute or accessible name (label and role) does
   *   detached   nothing found, the tag or a stable identity conflicts, or another URL
   *              state with only a positional selector or generic classes to go on
   */
  function placeOf(comment, href, live) {
    if (!live) return 'detached'
    const ev = evidenceOf(comment)
    const tag = live.tag ? String(live.tag).toLowerCase() : ''
    if (ev.tag && tag && ev.tag !== tag) return 'detached'
    if (ev.id && live.id && ev.id !== live.id) return 'detached'
    const liveTest = live.test && live.test.name === ev.test?.name ? live.test.value : undefined
    if (ev.test && liveTest !== undefined && liveTest !== ev.test.value) return 'detached'
    const text = normText(live.text)
    const same = !comment.createdHref || comment.createdHref === href
    if (same) return !ev.text || ev.text === text ? 'attached' : 'changed'
    if (ev.text) return ev.text === text && (!ev.tag || ev.tag === tag) ? 'elsewhere' : 'detached'
    if (ev.id && ev.id === live.id) return 'elsewhere'
    if (ev.test && liveTest === ev.test.value) return 'elsewhere'
    if (ev.label && ev.label === live.label && (ev.role ?? '') === (live.role ?? '')) return 'elsewhere'
    return 'detached'
  }

  // ------------------------------------------------------------ bridge events elsewhere

  /**
   * Apply a bridge event to a comment of a bucket this page is not showing. The same
   * effects as the live handler in content.js, without the toasts and the card.
   * Returns whether anything changed.
   */
  function applyEvent(c, ev) {
    if (!c || !ev || c.status === 'resolved') return false
    if (ev.type === 'reply') {
      if (!String(ev.text ?? '').trim()) return false
      c.answer = ev.text
      c.status = 'answered'
      return true
    }
    if (ev.type === 'progress') {
      c.progress = { state: ev.state, note: ev.text ?? ev.note ?? '', files: ev.files ?? [] }
      return true
    }
    if (ev.type === 'resolved' || ev.type === 'backlog-done') {
      c.status = 'resolved'
      const why = ev.type === 'resolved' ? ev.resolution : ev.outcome
      if (why) c.resolution = why
      return true
    }
    return false
  }

  /** Whether comment `c` is the one an event id names. */
  const names = (c, id) => !!id && ((c.batch && `${c.batch}#${c.serverN}` === id) || c.backlogId === id)

  // ------------------------------------------------------------ watching the URL

  /**
   * Call `onChange(href, previous)` once per change of `location.href`. History functions
   * are never wrapped: the Navigation API where it exists, `popstate`, `hashchange`, and a
   * comparison every POLL_MS while the tab is visible, which also sees a pushState the
   * other signals miss. Signals in one tick are coalesced into one microtask.
   */
  function watch({ win, doc, onChange, interval = POLL_MS }) {
    let last = win.location.href
    let queued = false
    let timer = null
    const check = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        const now = win.location.href
        if (now === last) return
        const was = last
        last = now
        try { onChange(now, was) } catch { /* the next change tries again */ }
      })
    }
    const start = () => { if (timer == null) timer = setInterval(check, interval) }
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null } }
    const onVisibility = () => {
      if (doc.visibilityState === 'visible') { check(); start() } else stop()
    }
    const nav = win.navigation
    try { nav?.addEventListener?.('currententrychange', check) } catch { /* no Navigation API */ }
    win.addEventListener('popstate', check)
    win.addEventListener('hashchange', check)
    doc.addEventListener('visibilitychange', onVisibility)
    if (doc.visibilityState === 'visible') start()
    return {
      check,
      get polling() { return timer != null },
      stop() {
        stop()
        try { nav?.removeEventListener?.('currententrychange', check) } catch { /* gone */ }
        win.removeEventListener('popstate', check)
        win.removeEventListener('hashchange', check)
        doc.removeEventListener('visibilitychange', onVisibility)
      },
    }
  }

  globalThis.PinpointRoute = {
    PREFIX, MAX_KEY, REMOVED_TTL, MAX_REMOVED, POLL_MS,
    hash, routeHash, keyFor, legacyKeyFor, urlState,
    newId, legacyId, ensureIds, signature,
    pruneRemoved, merge, adopt, migrate, tracker, store,
    evidence, evidenceOf, placeOf, normText,
    applyEvent, names, watch,
  }
})()

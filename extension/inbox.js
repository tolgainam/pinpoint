/**
 * Pinpoint inbox, "This page" view: which of this route's comments need attention, the
 * count on the toolbar's Inbox button, and the panel that lists them.
 *
 * Loaded before content.js and left on the isolated world's global as `PinpointInbox`, like
 * a11y.js and route.js. The projection half is pure, so the Node tests import this file and
 * check every row of the table; the panel half only runs when content.js calls it.
 *
 * The projection, as built. `unseen` means `activityAt > seenAt`. `activityAt` is stamped by
 * content.js when the bridge says something new about a comment (an answer, progress, a
 * resolution, a finished backlog item); a comment without one has nothing unseen, so pins
 * stored before this existed do not all ask for attention at once.
 *
 *   stored or derived state                             needs attention   clears when
 *   pending, never dispatched                           no                (Dispatch counts it)
 *   pending with `deliveryError` (dispatch failed)      yes  "failed"     a dispatch succeeds, or removal
 *   sent, no new activity                               no
 *   progress working                                    no
 *   progress edited, unseen                             yes  "edited"     the pin card or Mark seen
 *   answered, unseen                                    yes  "answered"   the pin card or Mark seen
 *   resolved, unseen                                    yes  "resolved"   the pin card or Mark seen
 *     (a question with its answer reads "answered"; a finished backlog item "completed")
 *   backlog, saved                                      no
 *   backlog, `unsaved` (the write failed)               yes  "unsaved"    Retry succeeds, or removal
 *   detached on its own creation URL, unresolved        yes  "detached"   it attaches again, resolves, or removal
 *   detached only because this is another URL state     no                (informational)
 *   removed                                             not listed
 *
 * The badge is the number of comments with a reason, not the number of reasons. Seen is
 * stored as `seenAt` on the comment and merged by maximum across tabs (route.js merge).
 * `requiresResponse` is not read here: absent means false, so an answer is seen like any other.
 */
;(function () {
  // ------------------------------------------------------------ projection (pure)

  /** Each section shows at most this many rows, then a line with how many more there are. */
  const CAP = 50
  const MAX_NOTE = 80
  const MAX_HINT = 60
  const MAX_ANSWER = 400

  const time = v => Number(v) || 0
  const unseen = c => time(c.activityAt) > time(c.seenAt)

  /**
   * Why comment `c` needs attention, or null. `ctx.place` is how it stands on this URL
   * state (route.js placeOf: attached, changed, elsewhere, detached) and `ctx.href` the
   * page's URL now.
   */
  function reason(c, ctx = {}) {
    if (!c || typeof c !== 'object') return null
    if (c.status === 'pending' && c.deliveryError) return 'failed'
    if (c.status === 'backlog' && c.unsaved) return 'unsaved'
    const fresh = unseen(c)
    if (c.status === 'answered' && fresh) return 'answered'
    if (c.status === 'resolved') {
      if (!fresh) return null
      return c.question && c.answer ? 'answered' : c.backlogId ? 'completed' : 'resolved'
    }
    if (c.status === 'sent' && c.progress?.state === 'edited' && fresh) return 'edited'
    // A frozen-frame pin never had a live element to lose.
    const own = !c.createdHref || c.createdHref === ctx.href
    if (ctx.place === 'detached' && own && !c.transient) return 'detached'
    return null
  }

  /** Reasons the user clears by looking; the others clear only when the problem is fixed. */
  const SEEN_CLEARS = new Set(['answered', 'edited', 'resolved', 'completed'])
  const clearsOnSeen = r => SEEN_CLEARS.has(r)

  /** The order reasons are listed in: what is broken first, then what is new. */
  const REASON_ORDER = ['failed', 'unsaved', 'answered', 'edited', 'resolved', 'completed', 'detached']
  const REASON_LABEL = {
    failed: 'Not delivered',
    unsaved: 'Not saved to backlog',
    answered: 'Answered',
    edited: 'Edited',
    resolved: 'Resolved',
    completed: 'Backlog done',
    detached: 'Detached',
  }

  /** The words a row uses for a comment that needs nothing: the pin's own vocabulary. */
  function stateLabel(c) {
    if (c.status === 'resolved') return 'Resolved'
    if (c.status === 'answered') return 'Answered'
    if (c.status === 'backlog') return 'Backlog'
    if (c.progress?.state === 'working') return 'Working'
    if (c.progress?.state === 'edited') return 'Edited'
    if (c.status === 'pending') return 'Pending'
    return 'Dispatched'
  }

  /** change, question or parked. A finished backlog item is still a parked one. */
  const kindOf = c => (c.status === 'backlog' || c.backlogId ? 'parked' : c.question ? 'question' : 'change')
  const KIND_WORD = { change: 'change request', question: 'question', parked: 'parked' }

  const line = (v, n) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
  }

  /** Which element, in a few characters: the component when known, otherwise the selector. */
  const hintOf = c => line(c.component ? `<${c.component}>` : c.selector, MAX_HINT)

  /** The sections of the This page view, in order. */
  const SECTIONS = [
    { id: 'attention', title: 'Needs attention' },
    { id: 'pending', title: 'Not dispatched' },
    { id: 'progress', title: 'In progress' },
    { id: 'parked', title: 'Parked' },
    { id: 'done', title: 'Recently done' },
  ]

  function sectionOf(c, why) {
    if (why) return 'attention'
    if (c.status === 'pending') return 'pending'
    if (c.status === 'backlog') return 'parked'
    if (c.status === 'resolved' || c.status === 'answered') return 'done'
    return 'progress'
  }

  /** One row: everything the panel shows and says about a comment, nothing it has to work out. */
  function rowOf(c, why) {
    const state = why ? REASON_LABEL[why] : stateLabel(c)
    const kind = kindOf(c)
    const note = line(c.note, MAX_NOTE)
    const row = {
      id: c.id,
      n: Number(c.n) || 0,
      kind,
      state,
      reason: why,
      note,
      hint: hintOf(c),
      seen: !!why && clearsOnSeen(why),
      name: `Pin ${Number(c.n) || 0}, ${KIND_WORD[kind]}, ${state.toLowerCase()}${note ? `: ${note}` : ''}`,
    }
    if (why === 'answered' && c.answer) row.answer = line(c.answer, MAX_ANSWER)
    if (why === 'failed') row.detail = line(c.deliveryError, MAX_HINT)
    return row
  }

  const byNumber = (a, b) => a.n - b.n
  const newest = (a, b) => b.at - a.at || b.n - a.n

  /**
   * The This page view of `list` (the comments of this route the page shows). `ctxOf(c)`
   * gives the context `reason` needs. Returns `{ count, sections }`, where each section is
   * `{ id, title, total, rows, more }` and sections with nothing in them are left out.
   * @param {any[]} list
   * @param {(c: any) => ({ place?: string, href?: string } | undefined)} [ctxOf]
   */
  function view(list, ctxOf = undefined) {
    const by = new Map(SECTIONS.map(s => [s.id, []]))
    let count = 0
    const ids = new Set()
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object' || ids.has(c.id)) continue
      ids.add(c.id)
      const why = reason(c, ctxOf?.(c) ?? {})
      if (why) count++
      const row = rowOf(c, why)
      row.at = Math.max(time(c.activityAt), time(c.updatedAt))
      by.get(sectionOf(c, why)).push(row)
    }
    by.get('attention').sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) || newest(a, b))
    for (const id of ['pending', 'progress', 'parked']) by.get(id).sort(byNumber)
    by.get('done').sort(newest)
    const sections = []
    for (const s of SECTIONS) {
      const rows = by.get(s.id)
      if (!rows.length) continue
      for (const r of rows) delete r.at
      sections.push({ id: s.id, title: s.title, total: rows.length, rows: rows.slice(0, CAP), more: Math.max(0, rows.length - CAP) })
    }
    return { count, sections }
  }

  /** The number of comments needing attention. */
  const badge = (list, ctxOf) => view(list, ctxOf).count

  /** The Inbox button, shown and spoken. */
  const buttonLabel = n => ({
    text: 'Inbox',
    badge: n > 0 ? String(n) : '',
    name: `Open Pinpoint inbox, ${n} ${n === 1 ? 'item needs' : 'items need'} attention`,
  })

  /**
   * The bridge said something new about `c`: stamp it so it reads as unseen. A question
   * resolved after its answer is not news; the answer was, and it was stamped when it came.
   */
  function touch(c, type, now = Date.now()) {
    if (!c) return c
    if (type === 'resolved' && c.question && c.answer) return c
    c.activityAt = Math.max(now, time(c.activityAt))
    return c
  }

  /** The user has seen `c`: never earlier than what they saw, so the merge keeps the latest. */
  function markSeen(c, now = Date.now()) {
    if (!c) return c
    c.seenAt = Math.max(now, time(c.activityAt), time(c.seenAt))
    return c
  }

  // ------------------------------------------------------------ panel (DOM)

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  /**
   * The panel. `onJump(id)` goes to a comment's pin, `onSeen(id)` marks it seen. Built once;
   * `paint(model)` fills it from `view()` and keeps focus on the comment it was on.
   *
   * Keyboard: Up/Down move through every button in the list, Home/End jump to the first and
   * last. Escape is content.js's, in its one Escape handler, and returns to the Inbox button.
   */
  function panel({ onJump, onSeen, onClose }) {
    const node = el('div', 'inbox')
    node.setAttribute('role', 'dialog')
    node.setAttribute('aria-label', 'Pinpoint inbox')
    const head = el('div', 'inbox-head')
    // The one view this release has. A second view (Project) arrives as a view switch here,
    // shown only when the bridge advertises it.
    const title = el('div', 'inbox-title', 'This page')
    title.id = 'pp-inbox-title'
    const close = el('button', 'inbox-close', '✕')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close inbox')
    close.onclick = () => onClose?.()
    head.append(title, el('span', 'spacer'), close)
    const body = el('div', 'inbox-body')
    node.append(head, body)

    const buttons = () => [...body.querySelectorAll('button')]

    node.addEventListener('keydown', ev => {
      const list = buttons()
      const i = list.indexOf(ev.target)
      if (i < 0 || !list.length) return
      let to = null
      if (ev.key === 'ArrowDown') to = list[Math.min(i + 1, list.length - 1)]
      else if (ev.key === 'ArrowUp') to = list[Math.max(i - 1, 0)]
      else if (ev.key === 'Home') to = list[0]
      else if (ev.key === 'End') to = list[list.length - 1]
      else return
      ev.preventDefault()
      ev.stopPropagation()
      to.focus({ preventScroll: false })
    })

    function paint(model) {
      // Keep the keyboard on the comment it was on, wherever its row went.
      const was = node.contains(node.getRootNode().activeElement) ? node.getRootNode().activeElement : null
      const keep = was?.dataset?.id ? { id: was.dataset.id, act: was.dataset.act } : null
      const scroll = body.scrollTop
      body.textContent = ''
      if (!model.sections.length) body.append(el('div', 'inbox-empty', 'No comments on this page.'))
      for (const s of model.sections) {
        const sect = el('section', `inbox-sect ${s.id}`)
        const h = el('h3', 'inbox-group', `${s.title} (${s.total})`)
        h.id = `pp-inbox-${s.id}`
        const ul = el('ul', 'inbox-list')
        ul.setAttribute('aria-labelledby', h.id)
        for (const r of s.rows) {
          const li = el('li', `inbox-item${r.reason ? ` ${r.reason}` : ''}`)
          const go = el('button', 'inbox-row')
          go.type = 'button'
          go.dataset.id = r.id
          go.dataset.act = 'jump'
          go.setAttribute('aria-label', r.name)
          const top = el('span', 'inbox-line')
          top.append(el('span', 'inbox-n', `#${r.n}`), el('span', `inbox-kind ${r.kind}`, r.kind), el('span', 'inbox-state', r.state))
          go.append(top, el('span', 'inbox-note', r.note || '(no note)'))
          if (r.hint) go.append(el('span', 'inbox-hint', r.hint))
          go.onclick = () => onJump(r.id)
          li.append(go)
          if (r.answer) li.append(el('div', 'inbox-answer', r.answer))
          if (r.detail) li.append(el('div', 'inbox-detail', r.detail))
          if (r.seen) {
            const seen = el('button', 'inbox-seen', 'Mark seen')
            seen.type = 'button'
            seen.dataset.id = r.id
            seen.dataset.act = 'seen'
            seen.setAttribute('aria-label', `Mark pin ${r.n} seen`)
            seen.onclick = () => onSeen(r.id)
            li.append(seen)
          }
          ul.append(li)
        }
        sect.append(h, ul)
        if (s.more) sect.append(el('div', 'inbox-more', `${s.more} more not shown`))
        body.append(sect)
      }
      body.scrollTop = scroll
      if (keep) {
        const all = buttons()
        const again = all.find(b => b.dataset.id === keep.id && b.dataset.act === keep.act) ??
          all.find(b => b.dataset.id === keep.id) ?? all[0] ?? close
        again.focus({ preventScroll: true })
      }
    }

    return {
      node,
      paint,
      /** The first row, or Close when the list is empty: where focus goes on open. */
      first: () => buttons()[0] ?? close,
      isOpen: () => node.classList.contains('show'),
      show(on) { node.classList.toggle('show', !!on) },
      /**
       * Above the bar, below it when there is no room above. Capped to the room on its side,
       * so at 200% zoom it scrolls inside itself instead of running off the screen.
       */
      place(barRect) {
        const m = 8
        node.style.maxHeight = ''
        const natural = node.offsetHeight || 240
        const above = barRect.top - 2 * m
        const below = innerHeight - barRect.bottom - 2 * m
        const up = above >= Math.min(natural, 240) || above >= below
        const room = Math.max(120, up ? above : below)
        node.style.maxHeight = `${room}px`
        const h = Math.min(natural, room)
        const w = node.offsetWidth || 320
        node.style.left = `${Math.max(m, Math.min(barRect.left, innerWidth - w - m))}px`
        node.style.top = `${up ? Math.max(m, barRect.top - h - m) : barRect.bottom + m}px`
      },
    }
  }

  globalThis.PinpointInbox = {
    CAP, SECTIONS, REASON_LABEL, REASON_ORDER,
    reason, clearsOnSeen, unseen, stateLabel, kindOf, hintOf, rowOf, view, badge, buttonLabel,
    touch, markSeen,
    panel,
  }
})()

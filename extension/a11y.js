/**
 * Pinpoint keyboard and screen-reader support: the names pins are read by, the order they
 * are walked in, the toolbar's single tab stop, and the live region that says what happened.
 *
 * Loaded before content.js and left on the isolated world's global as `PinpointA11y`, like
 * status.js. The naming and ordering half is pure, so the Node tests import this file as
 * a module and check the exact strings; the DOM half only runs when content.js calls it.
 *
 * The keyboard model, as built:
 *   - The toolbar is one tab stop (role=toolbar, roving tabindex). Tab enters at the item
 *     that was active last, Comment by default. Left/Right move, Home/End jump, disabled
 *     items are skipped.
 *   - The Pins item (shown when there are pins) enters pin navigation: Enter or Down to the
 *     first pin, Up to the last. Pins never take a tab stop of their own (tabindex=-1).
 *   - On a pin: arrows move in document order (top, then left, then pin number), Home/End
 *     jump, Enter/Space open the card, Escape goes back to Pins, and Tab hands the stop back
 *     to Pins and lets the browser carry focus out of the overlay.
 */
;(function () {
  // ------------------------------------------------------------ names (pure)

  const MAX_NOTE = 100

  /** One line, at most MAX_NOTE characters including the ellipsis. */
  const shortNote = note => {
    const s = String(note ?? '').replace(/\s+/g, ' ').trim()
    return s.length > MAX_NOTE ? `${s.slice(0, MAX_NOTE - 1).trimEnd()}…` : s
  }

  /** What a comment is, in words. A parked comment is still a request or a question. */
  const kindWord = c => (c.question ? 'question' : 'change request')

  /** Where a comment is, in the words the card uses. Progress counts only while unresolved. */
  function stateWord(c) {
    if (c.status === 'resolved') return 'resolved'
    if (c.status === 'answered') return 'answered'
    if (c.status === 'backlog') return c.unsaved ? 'unsaved backlog' : 'backlog'
    if (c.progress?.state === 'working') return 'working'
    if (c.progress?.state === 'edited') return 'edited'
    if (c.status === 'pending') return 'pending'
    return 'dispatched'
  }

  /** The order a stack's tally is read in: in flight first, done and parked last. */
  const STATE_ORDER = ['pending', 'dispatched', 'working', 'edited', 'answered', 'resolved', 'backlog', 'unsaved backlog']

  /**
   * A pin's accessible name.
   *   single: "Pin 3, change request, working: Increase the card padding"
   *   stack:  "Pin 3, 4 comments: 1 working, 1 answered, 1 resolved, 1 backlog. Increase the card padding"
   * The number is the lead comment's, which is the one the pin shows. The note is the lead's
   * when it is unresolved, otherwise the newest comment's. Selectors and URLs stay out.
   */
  function pinName(stack, lead) {
    const list = Array.isArray(stack) && stack.length ? stack : [lead]
    const head = lead ?? list[0]
    const newest = list.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a), list[0])
    const note = shortNote((head.status !== 'resolved' ? head : newest).note)
    if (list.length === 1) {
      return `Pin ${head.n}, ${kindWord(head)}, ${stateWord(head)}${note ? `: ${note}` : ''}`
    }
    const tally = new Map()
    for (const c of list) tally.set(stateWord(c), (tally.get(stateWord(c)) ?? 0) + 1)
    const parts = STATE_ORDER.filter(s => tally.has(s)).map(s => `${tally.get(s)} ${s}`)
    return `Pin ${head.n}, ${list.length} comments: ${parts.join(', ')}.${note ? ` ${note}` : ''}`
  }

  /** Document position, top then left, then pin number: the order pins are walked in. */
  const byPosition = (a, b) =>
    (Number(a.docY) || 0) - (Number(b.docY) || 0) ||
    (Number(a.docX) || 0) - (Number(b.docX) || 0) ||
    (Number(a.n) || 0) - (Number(b.n) || 0)

  /** The toolbar's Pins item, spoken and shown. */
  const pinsLabel = n => ({ text: `Pins ${n}`, name: `Pins, ${n}` })

  // ------------------------------------------------------------ DOM

  const usable = b => !!b && b.isConnected && !b.disabled && b.style.display !== 'none'

  /**
   * The toolbar as one composite tab stop. `items()` is every action in order, `fallback()`
   * the one Tab lands on when the last active item has gone or been disabled.
   */
  function toolbar(bar, { items, fallback, root, onKey }) {
    let active = null
    /** The item that last had focus, kept when focus fell off it rather than moved on. */
    let focused = null

    const list = () => items().filter(usable)

    function sync() {
      const all = items()
      const live = all.filter(usable)
      const was = active
      if (!live.includes(active)) active = live.includes(fallback()) ? fallback() : live[0] ?? null
      for (const b of all) b.tabIndex = b === active ? 0 : -1
      // Dispatching disables Dispatch while it has focus; the focus goes with the stop
      // instead of dropping to the page.
      const lost = document.activeElement === document.body ||
        (document.activeElement === root.host && !root.activeElement)
      if (was && was !== active && focused === was && lost && active) active.focus({ preventScroll: true })
    }

    function setActive(b) {
      if (!b) return
      active = b
      for (const x of items()) x.tabIndex = x === active ? 0 : -1
    }

    function move(to) {
      if (!to) return
      setActive(to)
      to.focus({ preventScroll: true })
    }

    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', 'Pinpoint')
    bar.setAttribute('aria-orientation', 'horizontal')

    bar.addEventListener('focusin', ev => {
      const t = ev.target
      if (items().includes(t)) { setActive(t); focused = t }
    })
    bar.addEventListener('focusout', ev => { if (ev.relatedTarget) focused = null })

    bar.addEventListener('keydown', ev => {
      const t = ev.target
      if (!items().includes(t)) return
      if (onKey?.(ev, t)) { ev.preventDefault(); ev.stopPropagation(); return }
      const live = list()
      const i = live.indexOf(t)
      let to = null
      if (ev.key === 'ArrowRight') to = live[(i + 1) % live.length]
      else if (ev.key === 'ArrowLeft') to = live[(i - 1 + live.length) % live.length]
      else if (ev.key === 'Home') to = live[0]
      else if (ev.key === 'End') to = live[live.length - 1]
      else return
      ev.preventDefault()
      ev.stopPropagation()
      move(to)
    })

    // Items come and go (Clear, the error count, Pins) and Dispatch is disabled and enabled
    // by the script. Whatever changes, there is exactly one stop and it is usable.
    new MutationObserver(sync).observe(bar, { childList: true, subtree: false, attributes: true, attributeFilter: ['disabled', 'style'], })
    for (const b of items()) new MutationObserver(sync).observe(b, { attributes: true, attributeFilter: ['disabled', 'style'] })

    sync()
    return {
      sync,
      setActive,
      /** Focus whichever item holds the stop. */
      enter() { sync(); active?.focus({ preventScroll: true }) },
      /** Watch an item added after the toolbar was built, so disabling it moves the stop. */
      watch(b) { new MutationObserver(sync).observe(b, { attributes: true, attributeFilter: ['disabled', 'style'] }) },
      get active() { return active },
    }
  }

  /**
   * Arrow keys across the pins. `pins()` is the pin buttons in walking order; `exit(how)`
   * is called with 'escape' or 'tab' when focus leaves pin navigation.
   */
  function pinNav(layer, { pins, exit }) {
    layer.setAttribute('role', 'group')
    layer.setAttribute('aria-label', 'Pins')
    layer.addEventListener('keydown', ev => {
      const list = pins()
      const i = list.indexOf(ev.target)
      if (i < 0) return
      if (ev.key === 'Tab') { exit('tab', ev); return }
      let to = null
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') to = list[(i + 1) % list.length]
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') to = list[(i - 1 + list.length) % list.length]
      else if (ev.key === 'Home') to = list[0]
      else if (ev.key === 'End') to = list[list.length - 1]
      else return
      ev.preventDefault()
      ev.stopPropagation()
      focusPin(to)
    })
  }

  /** Focus a pin, scrolling its element into view first when it is off screen. */
  function focusPin(pin, reposition) {
    if (!pin) return
    const r = pin.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      scrollBy({ top: r.top - innerHeight / 3, left: 0, behavior: 'instant' })
      reposition?.()
    }
    pin.focus({ preventScroll: true })
  }

  /**
   * One polite live region. Every toast is mirrored into it, so dispatch results, answers,
   * resolutions and errors are read out without moving focus. Emptied first, so the same
   * message twice is still announced twice.
   */
  function liveRegion(parent) {
    const region = document.createElement('div')
    region.className = 'sr-only'
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    parent.append(region)
    let timer
    return {
      region,
      announce(text) {
        clearTimeout(timer)
        region.textContent = ''
        timer = setTimeout(() => { region.textContent = String(text ?? '') }, 60)
      },
    }
  }

  /**
   * Move focus back into the overlay after a surface closes, but only when focus is already
   * ours or nowhere. A card closed by clicking the page must not pull focus off the page.
   */
  function returnFocus(root, target) {
    if (!target || !target.isConnected) return false
    const a = document.activeElement
    if (a && a !== document.body && a !== root.host) return false
    target.focus({ preventScroll: true })
    return true
  }

  globalThis.PinpointA11y = {
    pinName, shortNote, stateWord, kindWord, byPosition, pinsLabel, MAX_NOTE,
    toolbar, pinNav, focusPin, liveRegion, returnFocus,
  }
})()

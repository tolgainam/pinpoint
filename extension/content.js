/**
 * Pinpoint overlay.
 *
 * Mounts a comment toolbar into a shadow root on any localhost page. You toggle comment
 * mode, click elements, write notes, and hit Dispatch; the batch goes to the service
 * worker, which posts it to the local bridge and into a Claude Code session.
 *
 * Two rules shape the whole file:
 *   - the host page's DOM is never mutated (highlights and pins are our own absolutely
 *     positioned elements, not outlines applied to page nodes)
 *   - the host page's CSS can never reach us, and ours can never reach it (shadow root)
 */
;(async function () {
  if (window.__PINPOINT__) return
  window.__PINPOINT__ = true

  const KEY = `pinpoint:${location.origin}${location.pathname}`
  const BAR_KEY = 'pinpoint:bar'
  const MAX_TEXT = 200
  const MAX_HTML = 600

  // ---------------------------------------------------------------- state

  /** @type {{n:number, note:string, selector:string, docX:number, docY:number, status:'pending'|'sent'}[]} */
  let comments = []
  let seq = 0
  let mode = false
  let connected = false
  let frozen = null          // element awaiting a note
  let openCard = null        // the composer or pin card currently on screen

  // ---------------------------------------------------------------- shadow root

  const host = document.createElement('div')
  host.id = 'pinpoint-host'
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'

  const root = host.attachShadow({ mode: 'open' })
  const css = await fetch(chrome.runtime.getURL('overlay.css')).then(r => r.text()).catch(() => '')
  const style = document.createElement('style')
  style.textContent = css
  root.append(style)

  const layer = el('div', 'layer')
  root.append(layer)
  document.documentElement.append(host)

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  // ---------------------------------------------------------------- selector

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-component']
  /** Hashed class names from CSS-in-JS: stable within a build, meaningless across one. */
  const GENERATED_CLASS = /^(css|sc|emotion|jsx|styled|makeStyles)[-_]|^[A-Za-z]+__[A-Za-z0-9]{5,}$|^[a-z]{1,4}-[a-z0-9]{6,}$/
  /** Runtime-generated ids: React useId, Radix, Headless UI. */
  const GENERATED_ID = /^(:r|radix-|headlessui-|mui-|react-aria)|\d{5,}/

  const esc = v => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^\w-]/g, '\\$&'))

  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1 } catch { return false }
  }

  /** A selector that identifies this element on its own, or null. */
  function anchorFor(node) {
    for (const a of TEST_ATTRS) {
      const v = node.getAttribute?.(a)
      if (v) {
        const s = `[${a}="${v.replace(/["\\]/g, '\\$&')}"]`
        if (unique(s)) return s
      }
    }
    if (node.id && !GENERATED_ID.test(node.id)) {
      const s = '#' + esc(node.id)
      if (unique(s)) return s
    }
    return null
  }

  function segment(node) {
    const cls = Array.from(node.classList || [])
      .filter(c => c && c.length < 30 && !GENERATED_CLASS.test(c))
      .slice(0, 2)
    let seg = node.tagName.toLowerCase() + cls.map(c => '.' + esc(c)).join('')

    const parent = node.parentElement
    if (parent) {
      const sibs = Array.from(parent.children).filter(s => s.tagName === node.tagName)
      if (sibs.length > 1) {
        // Only pay for :nth-of-type when the classes did not already single it out.
        let same = sibs
        try { same = sibs.filter(s => s.matches(seg)) } catch { /* fall back to all siblings */ }
        if (same.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`
      }
    }
    return seg
  }

  /**
   * Prefer identity that survives a re-render: a test id, then a hand-written id, then
   * the shortest `>` chain that happens to be unique. Anchoring on an ancestor's test id
   * keeps the result short and readable, which matters because Claude greps for it.
   */
  function buildSelector(target) {
    const direct = anchorFor(target)
    if (direct) return direct

    const parts = []
    let node = target
    for (let depth = 0; node && node.nodeType === 1 && node !== document.documentElement; depth++) {
      const anchor = depth > 0 ? anchorFor(node) : null
      if (anchor && parts.length) {
        const sel = `${anchor} > ${parts.join(' > ')}`
        if (unique(sel)) return sel
      }
      parts.unshift(segment(node))
      const sel = parts.join(' > ')
      if (unique(sel)) return sel
      if (parts.length >= 6) break
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  // ---------------------------------------------------------------- component probe

  /** Ask the main-world probe which component rendered this. Never blocks for long. */
  function probeComponent(selector, x, y) {
    return new Promise(resolve => {
      const id = Math.random().toString(36).slice(2)
      const done = value => {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve(value)
      }
      const timer = setTimeout(() => done(null), 250)
      function onMessage(ev) {
        const d = ev.data
        if (ev.source !== window || !d || d.tag !== 'pinpoint:probe' || d.dir !== 'res' || d.id !== id) return
        done(d.component || null)
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ tag: 'pinpoint:probe', dir: 'req', id, selector, x, y }, location.origin)
    })
  }

  // ---------------------------------------------------------------- element capture

  function describe(target) {
    const rect = target.getBoundingClientRect()
    const cls = typeof target.className === 'string' ? target.className.trim() : ''
    return {
      selector: buildSelector(target),
      tag: target.tagName.toLowerCase(),
      elementId: target.id || undefined,
      classes: cls ? cls.slice(0, 200) : undefined,
      role: target.getAttribute('role') || undefined,
      ariaLabel: target.getAttribute('aria-label') || undefined,
      text: (target.innerText || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) || undefined,
      html: target.outerHTML.slice(0, MAX_HTML),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      docX: Math.round(rect.left + scrollX),
      docY: Math.round(rect.top + scrollY),
    }
  }

  // ---------------------------------------------------------------- highlight

  const highlight = el('div', 'highlight')
  const tagLabel = el('div', 'tag')
  highlight.append(tagLabel)
  layer.append(highlight)

  function showHighlight(target, isFrozen) {
    const r = target.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.left = `${r.left}px`
    highlight.style.top = `${r.top}px`
    highlight.style.width = `${r.width}px`
    highlight.style.height = `${r.height}px`
    highlight.classList.toggle('frozen', !!isFrozen)
    const id = target.id && !GENERATED_ID.test(target.id) ? `#${target.id}` : ''
    tagLabel.textContent = `${target.tagName.toLowerCase()}${id}  ${Math.round(r.width)}×${Math.round(r.height)}`
  }

  function hideHighlight() {
    highlight.style.display = 'none'
  }

  // ---------------------------------------------------------------- comment mode

  const capture = el('div', 'layer capture')
  capture.style.display = 'none'
  layer.append(capture)

  /** The topmost page element under the cursor, ignoring our own overlay. */
  function elementUnder(x, y) {
    const stack = document.elementsFromPoint(x, y)
    return stack.find(n => n !== host) || null
  }

  capture.addEventListener('mousemove', ev => {
    if (openCard) return
    const target = elementUnder(ev.clientX, ev.clientY)
    if (target) showHighlight(target, false)
    else hideHighlight()
  })

  capture.addEventListener('click', ev => {
    ev.preventDefault()
    ev.stopPropagation()
    if (openCard) { closeCard(); return }
    const target = elementUnder(ev.clientX, ev.clientY)
    if (!target) return
    frozen = target
    showHighlight(target, true)
    openComposer(target, ev.clientX, ev.clientY)
  })

  function setMode(on) {
    mode = on
    capture.style.display = on ? 'block' : 'none'
    modeBtn.classList.toggle('on', on)
    modeBtn.textContent = on ? 'Commenting' : 'Comment'
    if (!on) { closeCard(); hideHighlight(); frozen = null }
  }

  // ---------------------------------------------------------------- cards

  function closeCard() {
    openCard?.remove()
    openCard = null
    frozen = null
    if (mode) hideHighlight()
  }

  /** Keep a card fully on screen no matter which corner the element sits in. */
  function placeCard(card, x, y) {
    const w = 300
    const h = card.offsetHeight || 160
    card.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`
    card.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`
  }

  function openComposer(target, x, y) {
    const card = el('div', 'card')
    const meta = el('div', 'meta', '…')
    const box = el('textarea')
    box.placeholder = 'What is wrong here?'

    const row = el('div', 'row')
    const hint = el('span', 'meta', '⌘↵ to add')
    const cancel = el('button', '', 'Cancel')
    const add = el('button', 'primary', 'Add')
    row.append(hint, el('span', 'spacer'), cancel, add)
    card.append(meta, box, row)
    layer.append(card)
    openCard = card
    placeCard(card, x + 12, y + 12)
    box.focus()

    const captured = describe(target)
    meta.textContent = captured.selector
    probeComponent(captured.selector, x, y).then(component => {
      if (!component) return
      captured.component = component
      meta.textContent = `<${component}>  ${captured.selector}`
    })

    const submit = () => {
      const note = box.value.trim()
      if (!note) { box.focus(); return }
      comments.push({ ...captured, n: ++seq, note, status: 'pending' })
      closeCard()
      save()
      render()
    }

    add.onclick = submit
    cancel.onclick = closeCard
    box.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit() }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeCard() }
    })
  }

  function openPinCard(comment, x, y) {
    const card = el('div', 'card')
    card.append(
      el('div', 'meta', `${comment.component ? `<${comment.component}>  ` : ''}${comment.selector}`),
      el('div', 'note', comment.note),
    )

    const row = el('div', 'row')
    const status = el('span', 'meta', comment.status === 'sent' ? 'dispatched' : 'pending')
    const remove = el('button', 'danger', 'Remove')
    row.append(status, el('span', 'spacer'), remove)
    card.append(row)

    remove.onclick = () => {
      comments = comments.filter(c => c !== comment)
      closeCard()
      save()
      render()
    }

    layer.append(card)
    openCard = card
    placeCard(card, x + 12, y + 12)
  }

  // ---------------------------------------------------------------- pins

  const pins = el('div', 'layer')
  layer.append(pins)

  /** Pin elements, one per comment, rebuilt only when the list itself changes. */
  let pinNodes = []

  function renderPins() {
    pins.textContent = ''
    pinNodes = comments.map(c => {
      const pin = el('div', 'pin', String(c.n))
      pin.classList.toggle('sent', c.status === 'sent')
      pin.title = c.note
      pin.addEventListener('click', ev => {
        ev.preventDefault()
        ev.stopPropagation()
        if (openCard) { closeCard(); return }
        openPinCard(c, ev.clientX, ev.clientY)
      })
      pins.append(pin)
      return { pin, comment: c }
    })
    positionPins()
  }

  /**
   * Re-resolve each element from its selector before positioning: an app that re-renders
   * replaces nodes, and a pin stuck to a stale rect is worse than no pin. When the element
   * is genuinely gone the pin stays at its last document position, dimmed.
   */
  function positionPins() {
    for (const { pin, comment } of pinNodes) {
      let live = null
      try { live = document.querySelector(comment.selector) } catch { /* stale selector */ }
      if (live) {
        const r = live.getBoundingClientRect()
        comment.docX = Math.round(r.left + scrollX)
        comment.docY = Math.round(r.top + scrollY)
        pin.classList.remove('detached')
      } else {
        pin.classList.add('detached')
      }
      pin.style.left = `${comment.docX - scrollX}px`
      pin.style.top = `${comment.docY - scrollY}px`
    }
  }

  let queued = false
  function schedulePins() {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; positionPins() })
  }

  addEventListener('scroll', schedulePins, { passive: true, capture: true })
  addEventListener('resize', () => { schedulePins(); clampBar() }, { passive: true })

  // ---------------------------------------------------------------- toolbar

  const bar = el('div', 'bar')
  const grip = el('div', 'grip', '⌖')
  const dot = el('div', 'dot')
  const modeBtn = el('button', 'mode', 'Comment')
  const count = el('div', 'count', '0')
  const sendBtn = el('button', 'primary', 'Dispatch')
  const clearBtn = el('button', '', '✕')
  clearBtn.title = 'Clear all pins on this page'
  bar.append(grip, dot, modeBtn, count, sendBtn, clearBtn)
  layer.append(bar)

  const toast = el('div', 'toast')
  layer.append(toast)

  let toastTimer
  function say(text, bad) {
    toast.textContent = text
    toast.classList.toggle('bad', !!bad)
    toast.classList.add('show')
    const r = bar.getBoundingClientRect()
    toast.style.left = `${Math.max(8, r.left)}px`
    toast.style.top = `${Math.max(8, r.top - 36)}px`
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200)
  }

  modeBtn.onclick = () => setMode(!mode)
  clearBtn.onclick = () => {
    if (!comments.length) return
    comments = []
    seq = 0
    closeCard()
    save()
    render()
  }

  // Drag by the grip only, so the buttons stay clickable.
  let drag = null
  grip.addEventListener('pointerdown', ev => {
    const r = bar.getBoundingClientRect()
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top }
    grip.setPointerCapture(ev.pointerId)
  })
  grip.addEventListener('pointermove', ev => {
    if (!drag) return
    setBarPos(ev.clientX - drag.dx, ev.clientY - drag.dy)
  })
  grip.addEventListener('pointerup', ev => {
    if (!drag) return
    drag = null
    grip.releasePointerCapture(ev.pointerId)
    const r = bar.getBoundingClientRect()
    chrome.storage.local.set({ [BAR_KEY]: { x: r.left, y: r.top } })
  })

  function setBarPos(x, y) {
    const r = bar.getBoundingClientRect()
    bar.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`
    bar.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`
  }

  function clampBar() {
    const r = bar.getBoundingClientRect()
    setBarPos(r.left, r.top)
  }

  // ---------------------------------------------------------------- render

  function render() {
    const pending = comments.filter(c => c.status === 'pending').length
    count.textContent = String(pending)
    sendBtn.disabled = pending === 0
    sendBtn.textContent = pending ? `Dispatch ${pending}` : 'Dispatch'
    renderPins()
    // Mirror the count onto the toolbar icon, so a tab you scrolled away from still shows it.
    chrome.runtime.sendMessage({ type: 'count', n: pending }).catch(() => {})
  }

  // ---------------------------------------------------------------- dispatch

  sendBtn.onclick = async () => {
    const outgoing = comments.filter(c => c.status === 'pending')
    if (!outgoing.length) return

    sendBtn.disabled = true
    sendBtn.textContent = 'Sending…'

    const payload = {
      origin: location.origin,
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      dpr: devicePixelRatio,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      comments: outgoing.map(c => ({
        note: c.note,
        selector: c.selector,
        tag: c.tag,
        elementId: c.elementId,
        classes: c.classes,
        role: c.role,
        ariaLabel: c.ariaLabel,
        text: c.text,
        html: c.html,
        rect: c.rect,
        component: c.component,
      })),
    }

    let res
    try {
      res = await chrome.runtime.sendMessage({ type: 'dispatch', payload })
    } catch (err) {
      res = { ok: false, error: String(err) }
    }

    if (res?.ok) {
      // The server numbers comments by their position in what we just sent, so record
      // that mapping — Phase 4 resolves pins by "<batch>#<n>".
      outgoing.forEach((c, i) => {
        c.status = 'sent'
        c.batch = res.batch
        c.serverN = i + 1
      })
      say(`Dispatched ${outgoing.length} to Claude Code`)
      setMode(false)
      save()
    } else {
      say(res?.error || 'dispatch failed', true)
    }
    render()
  }

  // ---------------------------------------------------------------- health

  async function ping() {
    let res
    try {
      res = await chrome.runtime.sendMessage({ type: 'ping' })
    } catch {
      res = null
    }
    connected = !!res?.connected
    dot.classList.toggle('on', connected)
    dot.title = connected ? `bridge up · ${res.projectDir ?? ''}` : 'bridge down — is a Claude Code session running?'
  }

  // ---------------------------------------------------------------- storage

  let saveTimer
  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [KEY]: { seq, comments } })
    }, 150)
  }

  async function load() {
    const got = await chrome.storage.local.get([KEY, BAR_KEY])
    const saved = got[KEY]
    if (saved) {
      comments = Array.isArray(saved.comments) ? saved.comments : []
      seq = Number(saved.seq) || comments.length
    }
    const pos = got[BAR_KEY]
    if (pos) setBarPos(pos.x, pos.y)
    else setBarPos((innerWidth - bar.getBoundingClientRect().width) / 2, innerHeight - 56)
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    // ping-content is how the worker checks whether this page already has us, before
    // it decides to inject. It must answer, or the worker injects a second copy.
    if (msg?.type === 'ping-content') { respond({ ok: true }); return false }
    if (msg?.type === 'toggle') { setMode(!mode); respond({ ok: true, mode }); return false }
    return false
  })

  addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return
    if (openCard) { closeCard(); return }
    if (mode) setMode(false)
  }, true)

  await load()
  render()
  ping()
  setInterval(ping, 5000)
})()

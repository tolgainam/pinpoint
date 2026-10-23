/**
 * Pinpoint main-world probe.
 *
 * Framework internals (React fibers, Vue instances) are expando properties the page
 * puts on DOM nodes, and a content script runs in an isolated world where those are
 * invisible. So this tiny script runs in the page's own world and answers questions
 * over postMessage.
 *
 * It never receives a DOM node — content.js sends a selector (plus a point as a
 * fallback) and this resolves it here. Nothing is written to the page. "Apply to" asks
 * one batched `group` question: which elements of the same tag the same component rendered.
 *
 * It also keeps a small ring buffer of console errors, uncaught exceptions, and failed
 * requests. Running in the page's own world at document_start is the only place that
 * can see those, and the buffer is why "this button does nothing" can arrive with the
 * stack trace that already explains it. Nothing is sent anywhere unless a comment asks
 * for it.
 */
;(() => {
  // executeScript can re-run this on a page that already has it; a second listener
  // would answer every probe twice.
  if (window.__PINPOINT_PROBE__) return
  window.__PINPOINT_PROBE__ = true

  const TAG = 'pinpoint:probe'

  // ---------------------------------------------------------------- ring buffer

  const RING = 20
  const MAX_TEXT = 300
  const MAX_STACK = 400
  const t0 = Date.now()

  /** @type {{at:number, kind:string, text:string, stack?:string, n?:number}[]} */
  const ring = []

  /**
   * A render loop that throws fills twenty slots with one message, so repeats are
   * counted rather than pushed. That single decision is what makes twenty entries
   * enough to be worth reading.
   */
  function record(kind, text, stack) {
    if (!text) return
    text = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    if (!text) return
    const seen = ring.find(e => e.kind === kind && e.text === text)
    if (seen) {
      seen.n = (seen.n || 1) + 1
      seen.at = Date.now() - t0
      return
    }
    ring.push({ at: Date.now() - t0, kind, text, stack: stack || undefined })
    if (ring.length > RING) ring.shift()
  }

  /** Only the frames that name project code are worth the bytes. */
  function trimStack(stack) {
    if (typeof stack !== 'string') return undefined
    return stack.split('\n').slice(1, 5).map(l => l.trim()).join('\n').slice(0, MAX_STACK) || undefined
  }

  function describeArg(a) {
    if (a instanceof Error) return `${a.name}: ${a.message}`
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }

  // Console. The original is always called, with the original `this`, so a page that
  // reads console output back (or patches it again itself) is unaffected.
  for (const level of ['error', 'warn']) {
    const original = console[level]
    if (typeof original !== 'function') continue
    console[level] = function (...args) {
      try {
        const err = args.find(a => a instanceof Error)
        record(level, args.map(describeArg).join(' '), trimStack(err?.stack))
      } catch { /* never let instrumentation break logging */ }
      return original.apply(this, args)
    }
  }

  // Uncaught exceptions, and — in the capture phase, which is the only place they
  // surface — assets that failed to load.
  window.addEventListener('error', ev => {
    try {
      const el = ev.target
      if (el && el !== window && el.tagName) {
        record('resource', `failed to load <${el.tagName.toLowerCase()}> ${el.src || el.href || ''}`)
        return
      }
      record('exception', ev.message, trimStack(ev.error?.stack))
    } catch { /* ignore */ }
  }, true)

  window.addEventListener('unhandledrejection', ev => {
    try {
      const r = ev.reason
      record('rejection', r instanceof Error ? `${r.name}: ${r.message}` : describeArg(r), trimStack(r?.stack))
    } catch { /* ignore */ }
  })

  // Network. Both wrappers delegate to the original and pass its result or its error
  // through untouched — the buffer is a side effect, never a change in behaviour.
  const nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      let method = 'GET'
      let url = ''
      try {
        const input = args[0]
        url = typeof input === 'string' ? input : input?.url ?? String(input)
        method = String(args[1]?.method || input?.method || 'GET').toUpperCase()
      } catch { /* exotic input; log what we have */ }
      // `this` is undefined when called bare, and fetch refuses that.
      return nativeFetch.apply(this || window, args).then(
        res => {
          if (!res.ok) record('network', `${res.status} ${method} ${url}`)
          return res
        },
        err => {
          record('network', `failed ${method} ${url} — ${err?.message || err}`)
          throw err
        },
      )
    }
  }

  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__pinpoint = { method: String(method || 'GET').toUpperCase(), url: String(url) } } catch { /* frozen */ }
    return xhrOpen.call(this, method, url, ...rest)
  }
  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__pinpoint
    if (meta) {
      this.addEventListener('load', () => {
        if (this.status >= 400) record('network', `${this.status} ${meta.method} ${meta.url}`)
      })
      this.addEventListener('error', () => record('network', `failed ${meta.method} ${meta.url}`))
    }
    return xhrSend.apply(this, args)
  }

  /** Names that tell you nothing about where the code lives. */
  const NOISE = /^(Fragment|Suspense|SuspenseList|StrictMode|Profiler|Provider|Consumer|Context|ForwardRef|Memo|Anonymous|Root|App)$/

  function nameOfType(type) {
    if (!type) return null
    if (typeof type === 'string') return null                 // host element, e.g. 'div'
    if (typeof type === 'function') return type.displayName || type.name || null
    if (typeof type === 'object') {
      return (
        type.displayName ||
        nameOfType(type.render) ||                            // forwardRef
        nameOfType(type.type) ||                              // memo
        null
      )
    }
    return null
  }

  function reactName(el) {
    let fiber = null
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        fiber = el[k]
        break
      }
    }
    if (!fiber) return null

    // React 19 dropped _debugSource, so file:line is gone — but the owner chain still
    // carries the component that rendered this element, which is enough to grep for.
    let node = fiber._debugOwner || fiber.return
    for (let hops = 0; node && hops < 40; hops++) {
      const name = nameOfType(node.type ?? node.elementType)
      if (name && !NOISE.test(name)) return name
      node = node._debugOwner || node.return
    }
    return null
  }

  function vueName(el) {
    let node = el
    for (let hops = 0; node && hops < 40; hops++) {
      const vc = node.__vueParentComponent || node.__vue__
      if (vc) {
        const t = vc.type || vc.$options
        const name = t && (t.name || t.__name || t._componentTag)
        if (name && !NOISE.test(name)) return name
      }
      node = node.parentElement
    }
    return null
  }

  function describe(el) {
    try {
      return reactName(el) || vueName(el) || null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- component group

  /**
   * A structural selector for a node: tag and child position from <html> down. Not for
   * reading, only for resolving the same live node again from the isolated world, which
   * cannot be handed a node across worlds.
   */
  function pathOf(n) {
    const parts = []
    for (; n && n.nodeType === 1 && n.parentElement; n = n.parentElement) {
      const i = Array.prototype.indexOf.call(n.parentElement.children, n) + 1
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i})`)
    }
    return parts.length ? `html > ${parts.join(' > ')}` : ''
  }

  /**
   * "Same component role", in one request rather than one per node: every element with the
   * target's tag whose nearest named component is the target's. Answers within its own
   * budget, below the 250ms the isolated world waits, and says `incomplete` rather than
   * sending a partial list when it runs out. The isolated world checks every path still
   * resolves to the same tag and decides whether the name is worth showing.
   */
  function group(d) {
    let el = null
    try { el = typeof d.selector === 'string' && d.selector ? document.querySelector(d.selector) : null } catch { /* bad selector */ }
    if (!el) return { name: null, reason: 'unresolved' }
    const name = describe(el)
    if (!name) return { name: null }
    const cap = Math.max(1, Math.min(Number(d.cap) || 200, 500))
    const budget = Math.max(10, Math.min(Number(d.budget) || 200, 240))
    const t0 = performance.now()
    const all = document.getElementsByTagName(el.tagName)
    const members = []
    for (let i = 0; i < all.length; i++) {
      if ((i & 15) === 15 && performance.now() - t0 > budget) return { name, incomplete: true }
      const n = all[i]
      if (n !== el && describe(n) !== name) continue
      members.push(pathOf(n))
      if (members.length >= cap) return { name, capped: true }
    }
    return { name, members }
  }

  window.addEventListener('message', ev => {
    if (ev.source !== window) return
    const d = ev.data
    if (!d || d.tag !== TAG || d.dir !== 'req') return

    if (d.kind === 'debug') {
      window.postMessage({ tag: TAG, dir: 'res', id: d.id, debug: ring.slice() }, '*')
      return
    }

    if (d.kind === 'group') {
      let answer
      try { answer = group(d) } catch { answer = { name: null } }
      window.postMessage({ tag: TAG, dir: 'res', id: d.id, group: answer }, '*')
      return
    }

    let el = null
    if (typeof d.selector === 'string' && d.selector) {
      try { el = document.querySelector(d.selector) } catch { /* selector we built is bad */ }
    }
    if (!el && Number.isFinite(d.x) && Number.isFinite(d.y)) {
      el = document.elementFromPoint(d.x, d.y)
    }

    window.postMessage({ tag: TAG, dir: 'res', id: d.id, component: el ? describe(el) : null }, '*')
  })
})()

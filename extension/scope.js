/**
 * Pinpoint "Apply to": which rendered elements one comment's picked values are meant for.
 *
 * Loaded before content.js and left on the isolated world's global as `PinpointScope`, like
 * status.js and a11y.js. Nothing here touches the page or reads layout by itself: the group
 * builder walks only `tagName`, `className`, `parentElement`, `children` and the document's
 * `getElementsByTagName`, and anything that needs the browser (visibility, computed style,
 * selectors, the main-world component probe) is handed in by content.js. That is what lets
 * the Node tests import this file and run every match definition on a tiny fake tree.
 *
 * The matches, as built. They are not a ladder: two of them can overlap without one
 * containing the other, so they are ordered from specific to general and any two that find
 * exactly the same nodes collapse into the first.
 *   element    the picked element only.
 *   classes    same tag and exactly the same set of stable classes (set equality, so a
 *              node with one extra class is not a member). Omitted with no stable class.
 *   component  same tag, rendered by the same React/Vue component. Comes from one batched
 *              main-world request; see `componentOption`. Omitted when the name is missing
 *              or minified, the request ran out of time, or its answer does not resolve
 *              back to live nodes.
 *   pattern    "Same container": the same role across repeated containers. The nearest
 *              ancestor whose tag and stable classes repeat in the document, and a short
 *              relative path below it that finds exactly one node in every copy.
 *              Omitted when nothing repeats or the path is ambiguous.
 *   tag        every element with the target's tag.
 * Light DOM of the top document only: no iframes, shadow roots or pseudo-elements, and
 * only nodes that are mounted now.
 *
 * Counting stops at CAP. A capped group reads "200+", is selectable, and is never
 * previewed or listed, because the first 200 nodes are not the group.
 */
;(function () {
  const CAP = 200
  /** Selector hints carried for a group, so the brief can point at a few real members. */
  const MAX_MEMBERS = 10
  const MAX_CLASSES = 8
  const MAX_HINT = 200
  const MAX_VALUE = 120
  const MAX_SAMPLES = 3
  /** How long the synchronous matches may take together before the rest are left out. */
  const BUDGET_MS = 40

  /**
   * Hashed class names from CSS-in-JS: stable within a build, meaningless across one.
   *
   * The short-prefix arm requires a digit in the tail. Without one it also swallowed
   * ordinary hyphenated names — `hero-actions`, `card-header`, `nav-wrapper` all match
   * "up to four letters, hyphen, six or more alphanumerics" — which quietly cost every
   * selector and breadcrumb the most descriptive class on the element.
   */
  const GENERATED_CLASS = /^(css|sc|emotion|jsx|styled|makeStyles)[-_]|^[A-Za-z]+__[A-Za-z0-9]{5,}$|^[a-z]{1,4}-(?=[a-z0-9]{6,}$)[a-z]*\d[a-z0-9]*$/

  /** Tags that are a repeated container on their own, without a class to name them. */
  const REPEAT_TAGS = new Set(['li', 'tr', 'article'])

  /** Most kinds in order, specific to general. Also the order they are shown in. */
  const KINDS = ['element', 'classes', 'component', 'pattern', 'tag']

  const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now())
  const tagOf = node => String(node?.tagName ?? '').toLowerCase()

  /** The classes that survive the generated-name filter, sorted and unique. */
  function stableClasses(node) {
    const raw = typeof node?.className === 'string' ? node.className
      : typeof node?.getAttribute === 'function' ? (node.getAttribute('class') ?? '') : ''
    const out = new Set()
    for (const c of raw.split(/\s+/)) if (c && c.length < 30 && !GENERATED_CLASS.test(c)) out.add(c)
    return [...out].sort()
  }

  /** A key that is equal exactly when tag and stable class set are equal. */
  const signature = node => `${tagOf(node)}|${stableClasses(node).join(' ')}`

  /** `h3.card-title`, at most two classes: the readable half of a signature. */
  const labelOf = (tag, classes, max = 2) => tag + classes.slice(0, max).map(c => `.${c}`).join('')

  /** Two node lists hold exactly the same nodes. */
  function sameNodes(a, b) {
    if (!a || !b || a.length !== b.length) return false
    const set = new Set(a)
    return b.every(n => set.has(n))
  }

  /**
   * A component name worth matching on. Minified builds name everything `t`, `Ae`, `n9`:
   * a match on those would join unrelated elements, so they count as no name at all.
   */
  function usefulComponentName(name) {
    if (typeof name !== 'string') return false
    const s = name.trim()
    if (s.length < 3 || s.length > 60) return false
    if (/^[A-Za-z_$][A-Za-z0-9_$]?\d+$/.test(s)) return false
    return /^[A-Za-z_$][\w$.-]*$/.test(s)
  }

  // ------------------------------------------------------------ walking

  /** Descendants of `root` in document order, by plain recursion over `children`. */
  function* descendants(root) {
    const stack = [...(root.children ?? [])].reverse()
    while (stack.length) {
      const n = stack.pop()
      yield n
      const kids = n.children ?? []
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
  }

  /** The document's elements with this tag, minus anything Pinpoint owns. */
  function byTag(doc, tag, exclude) {
    const list = doc.getElementsByTagName(tag)
    const skip = exclude && tagOf(exclude) === tag && exclude.isConnected !== false ? exclude : null
    return { list, exclude: skip, length: list.length - (skip ? 1 : 0) }
  }

  /**
   * Walk a tag's elements, keeping those `keep` accepts, until CAP or the clock runs out.
   * @returns {{nodes: any[], capped: boolean, late: boolean}}
   */
  function collect(doc, tag, keep, ctx) {
    const { list, exclude } = byTag(doc, tag, ctx.exclude)
    /** @type {any[]} */
    const nodes = []
    for (let i = 0; i < list.length; i++) {
      if ((i & 63) === 63 && ctx.late()) return { nodes, capped: false, late: true }
      const n = list[i]
      if (n === exclude || !keep(n)) continue
      nodes.push(n)
      if (nodes.length >= CAP) return { nodes, capped: true, late: false }
    }
    return { nodes, capped: false, late: false }
  }

  // ------------------------------------------------------------ the matches

  function elementOption(target) {
    return { kind: 'element', label: 'Only this', hint: tagOf(target), match: { tag: tagOf(target) }, nodes: [target], capped: false }
  }

  function classesOption(target, ctx) {
    const classes = stableClasses(target)
    if (!classes.length) return { omit: 'no-classes' }
    const tag = tagOf(target)
    const key = signature(target)
    const got = collect(ctx.doc, tag, n => signature(n) === key, ctx)
    if (got.late) return { omit: 'budget' }
    return {
      kind: 'classes', label: 'Same classes', hint: labelOf(tag, classes),
      match: { tag, classes: classes.slice(0, MAX_CLASSES) },
      nodes: got.capped ? null : got.nodes, count: got.nodes.length, capped: got.capped,
    }
  }

  function tagOption(target, ctx) {
    const tag = tagOf(target)
    const { length } = byTag(ctx.doc, tag, ctx.exclude)
    if (length >= CAP) return { kind: 'tag', label: `Every ${tag}`, hint: tag, match: { tag }, nodes: null, count: CAP, capped: true }
    const got = collect(ctx.doc, tag, () => true, ctx)
    if (got.late) return { omit: 'budget' }
    return { kind: 'tag', label: `Every ${tag}`, hint: tag, match: { tag }, nodes: got.nodes, count: got.nodes.length, capped: false }
  }

  /** A container worth repeating on: stable classes, or a tag that is a repeat by nature. */
  const containerish = node => stableClasses(node).length > 0 || REPEAT_TAGS.has(tagOf(node))

  /**
   * The ways the target can be found again under one container, shortest first:
   *   its tag anywhere below;
   *   the chain of tags from the container down to it, child by child;
   *   its tag and exact stable classes anywhere below.
   * Each is kept only if it finds exactly one node in every container.
   */
  function relativeWays(container, target) {
    const tag = tagOf(target)
    const chain = []
    for (let n = target; n && n !== container; n = n.parentElement) chain.unshift(tagOf(n))
    const key = signature(target)
    const classes = stableClasses(target)
    const ways = [
      { relative: [{ tag }], child: false, text: tag, find: c => [...descendants(c)].filter(n => tagOf(n) === tag) },
    ]
    if (chain.length > 1) {
      ways.push({
        relative: chain.map(t => ({ tag: t })), child: true, text: chain.join(' › '),
        find: c => {
          let level = [c]
          for (const t of chain) level = level.flatMap(n => [...(n.children ?? [])].filter(k => tagOf(k) === t))
          return level
        },
      })
    }
    if (classes.length) {
      ways.push({
        relative: [{ tag, classes: classes.slice(0, MAX_CLASSES) }], child: false, text: labelOf(tag, classes),
        find: c => [...descendants(c)].filter(n => signature(n) === key),
      })
    }
    return ways
  }

  function patternOption(target, ctx) {
    const stop = ctx.doc.body ?? null
    let container = null
    let containers = null
    let capped = false
    for (let a = target.parentElement, depth = 0; a && a !== stop && a.parentElement && depth < 8; a = a.parentElement, depth++) {
      if (!containerish(a)) continue
      const key = signature(a)
      const got = collect(ctx.doc, tagOf(a), n => signature(n) === key, ctx)
      if (got.late) return { omit: 'budget' }
      if (got.nodes.length < 2) continue
      container = a
      containers = got.nodes
      capped = got.capped
      break
    }
    if (!container) return { omit: 'no-repeat' }

    for (const way of relativeWays(container, target)) {
      const nodes = []
      let ok = true
      for (const c of containers) {
        if (ctx.late()) return { omit: 'budget' }
        const found = way.find(c)
        if (found.length !== 1) { ok = false; break }
        nodes.push(found[0])
      }
      // A capped list of containers may not reach the target's own; it is still one of them.
      if (!ok || (!capped && !nodes.includes(target)) || new Set(nodes).size !== nodes.length) continue
      const ctag = tagOf(container)
      const cclasses = stableClasses(container)
      return {
        kind: 'pattern', label: 'Same container', hint: `${labelOf(ctag, cclasses)} › ${way.text}`,
        match: { tag: tagOf(target), container: { tag: ctag, classes: cclasses.slice(0, MAX_CLASSES) }, relative: way.relative, child: way.child },
        nodes: capped ? null : nodes, count: capped ? CAP : nodes.length, capped,
        detail: 'same role across repeated containers',
      }
    }
    return { omit: 'ambiguous' }
  }

  /**
   * The component match, from the main-world probe's answer. `answer` is what probe.js sent
   * back (or null when it did not answer within its budget); `resolve` turns one of its
   * selectors back into a live node. Every member must resolve, to the target's tag, and the
   * target itself must be among them; otherwise the evidence is not good enough to show.
   */
  function componentOption(target, answer, resolve) {
    if (!answer) return { omit: 'timeout' }
    if (answer.incomplete) return { omit: 'budget' }
    const name = typeof answer.name === 'string' ? answer.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
    if (!name) return { omit: 'no-name' }
    if (!usefulComponentName(name)) return { omit: 'minified' }
    const tag = tagOf(target)
    const hint = `${name} / ${tag}`.slice(0, MAX_HINT)
    const match = { tag, component: name }
    if (answer.capped) return { kind: 'component', label: 'Same component role', hint, match, nodes: null, count: CAP, capped: true }
    const paths = Array.isArray(answer.members) ? answer.members.slice(0, CAP) : []
    const nodes = []
    for (const p of paths) {
      const n = typeof p === 'string' ? resolve(p) : null
      if (!n || tagOf(n) !== tag) return { omit: 'unresolved' }
      nodes.push(n)
    }
    if (!nodes.includes(target) || new Set(nodes).size !== nodes.length) return { omit: 'unresolved' }
    return { kind: 'component', label: 'Same component role', hint, match, nodes, count: nodes.length, capped: false }
  }

  /** Add the count, and how many of the members are visible, to a computed option. */
  function finish(opt, visible) {
    if (!opt || opt.omit) return opt
    if (opt.nodes) {
      opt.count = opt.nodes.length
      opt.visible = visible ? opt.nodes.filter(n => { try { return !!visible(n) } catch { return false } }).length : opt.count
    } else {
      opt.visible = null
    }
    return opt
  }

  /**
   * One match, freshly computed. `kind` is any of KINDS but component, which is async and
   * comes from `componentOption`.
   * `ctx` carries doc, and optionally visible, exclude, budgetMs and clock.
   */
  function compute(kind, target, ctx) {
    const clock = ctx.clock ?? now
    const start = clock()
    const budget = ctx.budgetMs ?? BUDGET_MS
    const full = { ...ctx, late: ctx.late ?? (() => clock() - start > budget) }
    const opt =
      kind === 'element' ? elementOption(target)
        : kind === 'classes' ? classesOption(target, full)
          : kind === 'pattern' ? patternOption(target, full)
            : kind === 'tag' ? tagOption(target, full)
              : { omit: 'unknown' }
    return finish(opt, ctx.visible)
  }

  /**
   * Every synchronous match for the target, sharing one time budget.
   * @returns {{options: any[], omitted: Record<string,string>}}
   */
  function build(target, ctx) {
    const clock = ctx.clock ?? now
    const start = clock()
    const budget = ctx.budgetMs ?? BUDGET_MS
    const late = () => clock() - start > budget
    const options = []
    const omitted = {}
    for (const kind of ['element', 'classes', 'pattern', 'tag']) {
      if (ctx.frozen && kind !== 'element') { omitted[kind] = 'frozen'; continue }
      const opt = late() && kind !== 'element' ? { omit: 'budget' } : compute(kind, target, { ...ctx, late })
      if (opt.omit) omitted[kind] = opt.omit
      else options.push(opt)
    }
    if (ctx.frozen) omitted.component = 'frozen'
    return { options, omitted }
  }

  /**
   * What the list shows: in KINDS order, no group of one besides Only this, and no two
   * options with the same nodes. The first of two identical ones stays, unless the other is
   * the one already chosen: a choice never disappears under the user's pointer.
   */
  function collapse(options, keep) {
    const sorted = [...options].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
    const out = []
    const dropped = {}
    for (const opt of sorted) {
      if (opt.kind !== 'element' && !opt.capped && opt.count <= 1) { dropped[opt.kind] = 'one'; continue }
      const twin = out.find(o => !o.capped && !opt.capped && sameNodes(o.nodes, opt.nodes))
      if (!twin) { out.push(opt); continue }
      if (opt.kind === keep && twin.kind !== 'element') {
        out[out.indexOf(twin)] = opt
        dropped[twin.kind] = `same-as-${opt.kind}`
      } else {
        dropped[opt.kind] = `same-as-${twin.kind}`
      }
    }
    return { options: out, dropped }
  }

  // ------------------------------------------------------------ words

  /** The count beside an option. */
  const countText = opt => (opt.capped ? `${CAP}+` : String(opt.count))

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

  /** The count in full, the way the spec words it: `N`, `N visible · M in document`, `200+`. */
  function detailCount(opt) {
    if (opt.capped) return `${CAP}+ in document`
    if (opt.visible != null && opt.visible < opt.count) return `${opt.visible} visible · ${opt.count} in document`
    return plural(opt.count, 'match', 'matches')
  }

  /** The same, for a screen reader: no symbols. */
  function countPhrase(opt) {
    if (opt.capped) return `${CAP} or more matches`
    if (opt.visible != null && opt.visible < opt.count) return `${opt.visible} visible, ${opt.count} in document`
    return plural(opt.count, 'match', 'matches')
  }

  const CAPPED_NOTE = 'Large group — preview unavailable. Rechecked when added.'
  const FROZEN_NOTE = 'Frozen frame — only this element can be chosen.'

  /** What a picked property is called in a sentence. */
  const PROP_WORDS = {
    color: 'text colour',
    'background-color': 'background colour',
    padding: 'padding',
    gap: 'gap',
    'font-size': 'text size',
    'border-radius': 'radius',
  }

  /**
   * One observation per picked property: how many members of the group currently compute
   * a different value from the target, and the commonest of those values. `read(node, prop)`
   * returns a member's original value, normalised the way captured styles are; the target's
   * own value is the delta's `from`.
   */
  function observe(deltas, nodes, target, read) {
    return deltas.map(d => {
      const want = String(d.from ?? '').slice(0, MAX_VALUE)
      const tally = new Map()
      let different = 0
      for (const n of nodes) {
        if (n === target) continue
        let v
        try { v = String(read(n, d.prop) ?? '').slice(0, MAX_VALUE) } catch { v = '' }
        if (v === want) continue
        different++
        tally.set(v, (tally.get(v) ?? 0) + 1)
      }
      const samples = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, MAX_SAMPLES).map(([value, count]) => ({ value, count }))
      return { prop: String(d.prop), target: want, different, samples }
    })
  }

  /** "2 of 6 matches currently use a different text colour", one per property that differs. */
  function warnings(observations, count) {
    return observations.filter(o => o.different > 0).map(o =>
      `${o.different} of ${count} matches currently ${o.different === 1 ? 'uses' : 'use'} a different ${PROP_WORDS[o.prop] ?? o.prop}`)
  }

  // ------------------------------------------------------------ the record

  const bound = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n)

  /**
   * The `scope` a comment carries. Shape (version 1):
   *   { version: 1, kind, match, hint, source, counts: {document, visible, capped},
   *     observations: [{prop, target, different, samples: [{value, count}]}], members? }
   * `visible` is null for a capped group, which was not enumerated. `members` is a few
   * selector hints for a group (never for Only this, never for a capped group). Every string
   * is bounded here so the record cannot grow with the page.
   */
  function toScope(opt, { source, observations = [], members = [] }) {
    const kind = KINDS.includes(opt.kind) ? opt.kind : 'element'
    const scope = {
      version: 1,
      kind,
      match: clean(opt.match),
      hint: bound(kind === 'element' ? source : opt.hint, MAX_HINT),
      source: bound(source, 300),
      counts: {
        document: Math.max(0, Math.min(CAP, Number(opt.count) || (kind === 'element' ? 1 : 0))),
        visible: opt.capped ? null : Math.max(0, Math.min(CAP, Number(opt.visible ?? opt.count) || 0)),
        capped: !!opt.capped,
      },
      observations: opt.capped || kind === 'element' ? [] : observations.slice(0, 8).map(o => ({
        prop: bound(o.prop, 40),
        target: bound(o.target, MAX_VALUE),
        different: Math.max(0, Number(o.different) || 0),
        samples: (o.samples ?? []).slice(0, MAX_SAMPLES).map(s => ({ value: bound(s.value, MAX_VALUE), count: Math.max(0, Number(s.count) || 0) })),
      })),
    }
    if (kind !== 'element' && !opt.capped && members.length) scope.members = members.slice(0, MAX_MEMBERS).map(m => bound(m, 300))
    return scope
  }

  /** The match object, bounded: short strings, at most MAX_CLASSES classes. */
  function clean(match) {
    const out = {}
    for (const [k, v] of Object.entries(match ?? {})) {
      if (typeof v === 'string') out[k] = bound(v, 60)
      else if (typeof v === 'boolean') out[k] = v
      else if (Array.isArray(v)) out[k] = v.slice(0, MAX_CLASSES).map(x => (typeof x === 'string' ? bound(x, 60) : clean(x)))
      else if (v && typeof v === 'object') out[k] = clean(v)
    }
    return out
  }

  // ------------------------------------------------------------ DOM: the composer control

  /**
   * The "Apply to" fieldset in the composer, and everything it does to the page while it is
   * open. content.js owns the comment; this owns the group.
   *
   * Shown only while the comment has a picked value. Native radios in a fieldset, so Tab
   * enters at the chosen one, the arrows move and choose, Space chooses, and Escape belongs
   * to the composer (which closes and returns to Comment). A choice is announced with its
   * count and any warning. Hover or keyboard focus on an option outlines its members with
   * boxes of our own, never by touching the page's nodes. Choosing a group previews every
   * picked value on all of its members as an inline style, read all first and written after,
   * and put back on every way out. A capped group gets neither outline nor preview.
   *
   * deps: el(tag, cls, text), doc, exclude (our host), layer (for outlines), visible(node),
   *   read(node, prop) -> normalised computed value, probe(target) -> Promise<answer|null>,
   *   resolve(selector) -> node, selectorOf(node), announce(text), focused() -> the
   *   overlay's focused element
   */
  function composer(deps) {
    const { el } = deps
    const box = el('fieldset', 'scope')
    const legend = el('legend', 'scope-legend', 'Apply to')
    const list = el('div', 'scope-list')
    const detail = el('div', 'scope-detail')
    const warn = el('div', 'scope-warn')
    box.append(legend, list, detail, warn)
    const outlines = el('div', 'scope-outlines')
    deps.layer.append(outlines)

    let target = null
    let deltas = []
    let frozen = false
    let source = ''
    let chosen = 'element'
    /** kind -> option, the latest computed; the component one arrives later. */
    let options = new Map()
    let componentOpt = null
    let omitted = {}
    let shown = []
    let probing = null
    let active = null           // kind under the pointer or the keyboard
    let alive = true
    /** node -> Map(prop -> {value, priority}), what the group preview overwrote. */
    const saved = new Map()

    const ctxOf = () => ({ doc: deps.doc, exclude: deps.exclude, visible: deps.visible, frozen })

    function restore() {
      for (const [node, props] of saved) {
        for (const [prop, was] of props) {
          if (was.value) node.style.setProperty(prop, was.value, was.priority)
          else node.style.removeProperty(prop)
        }
      }
      saved.clear()
      clearOutlines()
    }

    function clearOutlines() { outlines.textContent = ''; outlines._nodes = null }

    function outline(opt) {
      clearOutlines()
      if (!opt || opt.capped || !opt.nodes) return
      outlines._nodes = opt.nodes
      reposition()
    }

    /** Boxes at the members' current rects; called again on scroll. */
    function reposition() {
      const nodes = outlines._nodes
      if (!nodes) return
      outlines.textContent = ''
      for (const n of nodes) {
        if (!n.isConnected) continue
        const r = n.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const b = el('div', 'scope-outline')
        b.style.left = `${r.left}px`
        b.style.top = `${r.top}px`
        b.style.width = `${r.width}px`
        b.style.height = `${r.height}px`
        outlines.append(b)
      }
    }

    /** All synchronous matches again, plus the component one if it came, collapsed. */
    function recompute() {
      if (!target) return
      const got = build(target, ctxOf())
      options = new Map(got.options.map(o => [o.kind, o]))
      omitted = { ...got.omitted, ...(componentOpt?.omit ? { component: componentOpt.omit } : {}) }
      if (componentOpt && !componentOpt.omit) options.set('component', componentOpt)
      const { options: list2, dropped } = collapse([...options.values()], chosen)
      Object.assign(omitted, dropped)
      shown = list2
      // The page moved on and the chosen group went with it. Said out loud, never silent.
      if (!shown.some(o => o.kind === chosen)) {
        chosen = 'element'
        deps.announce('Apply to: that group is no longer on the page, back to Only this')
      }
    }

    const option = kind => shown.find(o => o.kind === kind) ?? null

    /** The group preview for the chosen option, and the warning that goes with it. */
    function applyPreview() {
      restore()
      const opt = option(chosen)
      paintNote(opt, null)
      if (!opt || opt.kind === 'element' || opt.capped || !opt.nodes || !deltas.length) return
      // Every read first, then every write: one style recalc, not one per member.
      const members = opt.nodes.filter(n => n !== target && n.isConnected)
      const observations = observe(deltas, opt.nodes, target, deps.read)
      for (const n of members) {
        let props = saved.get(n)
        if (!props) saved.set(n, (props = new Map()))
        for (const d of deltas) {
          if (!props.has(d.prop)) props.set(d.prop, { value: n.style.getPropertyValue(d.prop), priority: n.style.getPropertyPriority(d.prop) })
        }
      }
      for (const n of members) for (const d of deltas) n.style.setProperty(d.prop, d.to, 'important')
      paintNote(opt, observations)
      if (active) outline(option(active))
    }

    /** Under the list: the capped or frozen note, or what differs inside the group. */
    function paintNote(opt, observations) {
      warn.textContent = ''
      warn.className = 'scope-warn'
      let text = ''
      if (frozen) { text = FROZEN_NOTE; warn.classList.add('note') }
      else if (opt?.capped) { text = CAPPED_NOTE; warn.classList.add('note') }
      else if (observations) text = warnings(observations, opt.count).join('. ')
      if (!text) return
      // A warning is said in words and marked with an icon, never by its colour alone.
      if (!warn.classList.contains('note')) {
        const icon = el('span', 'scope-warn-icon', '⚠')
        icon.setAttribute('aria-hidden', 'true')
        warn.append(icon)
      }
      warn.append(el('span', 'scope-warn-text', text))
      warn.classList.add('show')
    }

    function paintDetail() {
      const opt = option(active ?? chosen)
      detail.textContent = opt ? (opt.kind === 'element' ? `this ${opt.hint} only` : `${opt.hint} · ${detailCount(opt)}`) : ''
      detail.title = opt?.detail ?? ''
    }

    /** Only this and Every h3 already say their tag; the hint would only repeat it. */
    const rowHint = opt => (opt.kind === 'element' || opt.kind === 'tag' ? '' : opt.hint)

    /** The radios. Rebuilt only when the set of options changes, so focus stays put. */
    function paintRows() {
      const kinds = shown.map(o => o.kind).join(' ')
      box.dataset.omitted = Object.entries(omitted).map(([k, v]) => `${k}:${v}`).join(' ')
      if (list.dataset.kinds !== kinds) {
        const had = list.contains(deps.focused?.()) ? deps.focused().value : null
        list.textContent = ''
        list.dataset.kinds = kinds
        for (const opt of shown) {
          const row = el('label', 'scope-opt')
          row.dataset.kind = opt.kind
          const radio = el('input')
          radio.type = 'radio'
          radio.name = 'pp-scope'
          radio.value = opt.kind
          row.append(radio, el('span', 'scope-name', opt.label), el('span', 'scope-hint', rowHint(opt)), el('span', 'scope-count', ''))
          row.addEventListener('pointerenter', () => hover(opt.kind))
          row.addEventListener('pointerleave', () => unhover())
          radio.addEventListener('focus', () => hover(opt.kind))
          radio.addEventListener('blur', () => unhover())
          radio.addEventListener('change', () => { if (radio.checked) choose(opt.kind) })
          list.append(row)
        }
        if (had) list.querySelector(`input[value="${had}"]`)?.focus({ preventScroll: true })
      }
      for (const row of list.children) {
        const opt = option(row.dataset.kind)
        if (!opt) continue
        const radio = row.querySelector('input')
        radio.checked = opt.kind === chosen
        row.classList.toggle('on', opt.kind === chosen)
        row.classList.toggle('capped', !!opt.capped)
        row.querySelector('.scope-count').textContent = countText(opt)
        radio.setAttribute('aria-label', [opt.label, rowHint(opt), countPhrase(opt)].filter(Boolean).join(', '))
      }
      paintDetail()
    }

    function hover(kind) {
      active = kind
      // A fresh count for what is about to be chosen: the page may have moved on.
      if (kind !== 'component' && kind !== chosen && !frozen) {
        const fresh = compute(kind, target, ctxOf())
        const i = shown.findIndex(o => o.kind === kind)
        if (fresh && !fresh.omit && i >= 0) { shown[i] = fresh; options.set(kind, fresh); paintRows() }
      }
      outline(option(kind))
      paintDetail()
    }

    function unhover() {
      active = null
      const f = deps.focused?.()
      if (f && list.contains(f)) { active = f.value; outline(option(active)) } else clearOutlines()
      paintDetail()
    }

    function choose(kind) {
      chosen = kind
      recompute()
      paintRows()
      applyPreview()
      const opt = option(chosen)
      if (!opt) return
      const note = warn.classList.contains('show') ? warn.querySelector('.scope-warn-text')?.textContent ?? '' : ''
      deps.announce(`Apply to ${opt.label}: ${countPhrase(opt)}${note ? `. ${note}` : ''}`)
    }

    function startProbe() {
      if (frozen || !deps.probe) return
      const asked = target
      probing = deps.probe(asked).then(answer => {
        if (!alive || asked !== target || !deltas.length) return
        componentOpt = finish(componentOption(asked, answer, deps.resolve), deps.visible)
        recompute()
        paintRows()
        if (chosen !== 'element') applyPreview()
      }).catch(() => {})
    }

    /**
     * After every change to the picks or the element. No picks: hidden, back to Only this,
     * nothing previewed. A new element: back to Only this and every match asked again.
     */
    function sync(state) {
      const moved = state.target !== target
      deltas = state.deltas
      frozen = !!state.frozen
      source = state.source ?? ''
      if (!deltas.length || moved) {
        restore()
        chosen = 'element'
        componentOpt = null
        target = state.target
        active = null
      }
      if (!deltas.length) {
        box.classList.remove('show')
        shown = []
        list.textContent = ''
        list.dataset.kinds = ''
        warn.textContent = ''
        warn.className = 'scope-warn'
        return
      }
      const fresh = !box.classList.contains('show') || moved
      box.classList.add('show')
      if (fresh) { componentOpt = null; startProbe() }
      recompute()
      paintRows()
      applyPreview()
    }

    /**
     * Just before Add, with every preview already put back: the chosen group measured again,
     * and the `scope` record built from it. A group that is no longer on the page is not
     * swapped for Only this behind the user's back; Add is refused and the list redrawn.
     */
    async function finalize() {
      restore()
      if (!deltas.length || !target) return { ok: true, scope: undefined }
      let opt
      if (chosen === 'component') {
        componentOpt = finish(componentOption(target, await deps.probe(target), deps.resolve), deps.visible)
        opt = componentOpt
      } else {
        opt = compute(chosen, target, ctxOf())
      }
      if (!opt || opt.omit || (opt.kind !== 'element' && !opt.capped && opt.count <= 1)) {
        const label = option(chosen)?.label ?? chosen
        recompute()
        paintRows()
        return { ok: false, error: `"${label}" no longer matches anything else on this page. Choose again, then add.` }
      }
      const observations = opt.capped || opt.kind === 'element' ? [] : observe(deltas, opt.nodes, target, deps.read)
      const members = opt.nodes && opt.kind !== 'element' ? opt.nodes.slice(0, MAX_MEMBERS).map(n => { try { return deps.selectorOf(n) } catch { return '' } }).filter(Boolean) : []
      return { ok: true, scope: toScope(opt, { source, observations, members }) }
    }

    return {
      node: box,
      sync,
      restore,
      reapply: applyPreview,
      finalize,
      reposition,
      get chosen() { return chosen },
      destroy() { alive = false; restore(); outlines.remove() },
    }
  }

  globalThis.PinpointScope = {
    CAP, MAX_MEMBERS, BUDGET_MS, KINDS, GENERATED_CLASS, CAPPED_NOTE, FROZEN_NOTE, PROP_WORDS,
    stableClasses, signature, labelOf, sameNodes, usefulComponentName,
    compute, build, componentOption, finish, collapse,
    countText, detailCount, countPhrase, observe, warnings, toScope,
    composer,
  }
})()

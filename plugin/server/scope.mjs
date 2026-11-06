/**
 * "Apply to" on the bridge: the `scope` a comment carries, checked and bounded, and the lines
 * the brief says about it.
 *
 * Everything in a scope came from the page: the tag and class names, the component name, the
 * selector hints, the sampled values. The page is the user's own app, but it is still text a
 * model will read, so it is treated like any other untrusted input. A scope that is not
 * exactly the shape version 1 describes is dropped whole, and the comment then reads as Only
 * this, as it would from an extension that never sent one. The dispatch itself never fails
 * over a scope.
 *
 * No side effects at import: the bridge and the tests both load this.
 */

/** The bridge advertises this in /health; the extension shows group choices only when it does. */
export const SCOPE_CAPABILITY = 'comment-scope-v1'

export const SCOPE_VERSION = 1
export const SCOPE_KINDS = /** @type {const} */ (['element', 'classes', 'component', 'pattern', 'tag'])

/** The extension stops counting here; a capped count means "at least this many". */
export const SCOPE_CAP = 200

const MAX_CLASSES = 8
const MAX_CLASS = 60
const MAX_RELATIVE = 6
const MAX_HINT = 200
const MAX_SELECTOR = 300
const MAX_VALUE = 120
const MAX_OBSERVATIONS = 8
const MAX_SAMPLES = 3
const MAX_MEMBERS = 10

/**
 * Characters that never belong in one line of a brief: C0 and C1 controls (newlines among
 * them), the Unicode line and paragraph separators, zero-width characters and the bidi
 * overrides that can make text read differently from what it is.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * Every page string is shown inside a code span, where Markdown is literal text and the
 * backtick is the one delimiter that can end the span early. So the backtick goes from all
 * of them, and `<` too, so nothing can open or close a tag around the brief. Selector hints
 * keep what CSS needs (`>`, `[]`, `~`, `+`, quotes); values also lose `>` and the backslash,
 * and keep `#` and `%`, which colours and sizes need.
 */
const SELECTOR_DROP = /[`<]/g
const INLINE_DROP = /[`<>\\]/g

const TAG = /^[a-z][a-z0-9-]{0,30}$/
const COMPONENT = /^[A-Za-z_$][\w$.-]{0,59}$/
const PROP = /^-{0,2}[a-z][a-z0-9-]{0,39}$/

/** One line, no invisible characters, single spaces, at most `max` characters. */
function line(value, max, drop) {
  if (typeof value !== 'string') return ''
  return value.replace(INVISIBLE, ' ').replace(drop, '').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

const selectorText = (v, max = MAX_SELECTOR) => line(v, max, SELECTOR_DROP)
const inlineText = (v, max = MAX_VALUE) => line(v, max, INLINE_DROP)

/** A whole number in [0, max]; anything that is not a finite number is 0. */
function count(value, max = SCOPE_CAP) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
  return Math.max(0, Math.min(max, n))
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

function tagOf(v) {
  return typeof v === 'string' && TAG.test(v) ? v : null
}

/** Class names: no spaces, no backticks, no `<`, bounded in length and in number. */
function classesOf(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const c of v.slice(0, MAX_CLASSES)) {
    if (typeof c !== 'string') continue
    const clean = selectorText(c, MAX_CLASS)
    if (clean && !/\s/.test(clean) && !out.includes(clean)) out.push(clean)
  }
  return out
}

/** `{tag, classes?}`, or null when the tag is not a tag. */
function signatureOf(v) {
  if (!isObject(v)) return null
  const tag = tagOf(v.tag)
  if (!tag) return null
  const classes = classesOf(v.classes)
  return classes.length ? { tag, classes } : { tag }
}

/**
 * The match, per kind, with only the fields that kind defines. Null when it is unusable;
 * the scope is then dropped rather than guessed at.
 */
function matchOf(kind, v) {
  if (!isObject(v)) return null
  const tag = tagOf(v.tag)
  if (!tag) return null
  if (kind === 'element' || kind === 'tag') return { tag }
  if (kind === 'classes') {
    const classes = classesOf(v.classes)
    return classes.length ? { tag, classes } : null
  }
  if (kind === 'component') {
    const name = typeof v.component === 'string' ? v.component.trim() : ''
    return COMPONENT.test(name) ? { tag, component: name } : null
  }
  // pattern: the repeated container, and the path from it to the target.
  const container = signatureOf(v.container)
  if (!container) return null
  const relative = Array.isArray(v.relative) ? v.relative.slice(0, MAX_RELATIVE).map(signatureOf) : []
  if (!relative.length || relative.some(r => !r)) return null
  return { tag, container, relative, child: v.child === true }
}

function observationOf(v) {
  if (!isObject(v) || typeof v.prop !== 'string' || !PROP.test(v.prop)) return null
  const samples = Array.isArray(v.samples)
    ? v.samples.slice(0, MAX_SAMPLES).filter(isObject).map(s => ({ value: inlineText(s.value), count: count(s.count) }))
    : []
  return { prop: v.prop, target: inlineText(v.target), different: count(v.different), samples }
}

/**
 * @typedef {{
 *   version: 1,
 *   kind: 'element'|'classes'|'component'|'pattern'|'tag',
 *   match: Record<string, any>,
 *   hint: string,
 *   source: string,
 *   counts: { document: number, visible: number|null, capped: boolean },
 *   observations: { prop: string, target: string, different: number, samples: { value: string, count: number }[] }[],
 *   members?: string[],
 * }} Scope
 */

/**
 * The page's scope, checked and bounded, or undefined when there is none or it is not one.
 *
 * Kept: a known version, a known kind, the match fields that kind defines, short one-line
 * strings, whole-number counts within the cap, a few observations with a few samples each,
 * a few member hints. Dropped: every other field, and the whole scope when the version,
 * the kind or the match is wrong.
 *
 * @param {unknown} raw
 * @returns {Scope|undefined}
 */
export function sanitiseScope(raw) {
  if (!isObject(raw)) return undefined
  const s = /** @type {Record<string, any>} */ (raw)
  // `v` is the spec's spelling and `version` the extension's; either, but only version 1.
  const version = 'version' in s ? s.version : s.v
  if (version !== SCOPE_VERSION) return undefined
  const kind = SCOPE_KINDS.find(k => k === s.kind)
  if (!kind) return undefined
  const match = matchOf(kind, s.match)
  if (!match) return undefined

  const c = isObject(s.counts) ? s.counts : {}
  const capped = c.capped === true && kind !== 'element'
  const document = kind === 'element' ? 1 : capped ? SCOPE_CAP : count(c.document)
  const visible = capped || c.visible === null || c.visible === undefined ? null : count(c.visible, document)
  const source = selectorText(s.source)

  /** @type {Scope} */
  const scope = {
    version: SCOPE_VERSION,
    kind,
    match,
    hint: selectorText(kind === 'element' ? (s.hint || source) : s.hint, MAX_HINT) || match.tag,
    source,
    counts: { document, visible, capped },
    observations: kind === 'element' || capped || !Array.isArray(s.observations)
      ? []
      : s.observations.slice(0, MAX_OBSERVATIONS).map(observationOf).filter(Boolean),
  }
  if (kind !== 'element' && !capped && Array.isArray(s.members)) {
    const members = s.members.slice(0, MAX_MEMBERS).map(m => selectorText(m)).filter(Boolean)
    if (members.length) scope.members = members
  }
  return scope
}

// ---------------------------------------------------------------- the brief

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** What the group is, in the brief's words, with its hint in a code span. */
function groupPhrase(scope) {
  const hint = `\`${scope.hint}\``
  if (scope.kind === 'classes') return `same stable classes ${hint} (the same tag with exactly this set of classes)`
  if (scope.kind === 'component') return `same component role ${hint} (this tag, rendered by the same component)`
  if (scope.kind === 'pattern') return `same container ${hint} (the same role inside each repeated container)`
  return `every \`${scope.match.tag}\``
}

function countPhrase(counts) {
  if (counts.capped) return `${SCOPE_CAP} or more matches in this document (counting stopped at ${SCOPE_CAP}, so this is a lower bound and no members were listed)`
  const visible = counts.visible != null && counts.visible < counts.document ? `, ${counts.visible} of them visible` : ''
  return `${plural(counts.document, 'match', 'matches')} in this document${visible}`
}

/** "color: 2 of 6 matches currently compute `#6b7280` (2) instead of `#111111`". */
function observationPhrase(o, total) {
  const seen = o.samples.filter(s => s.value).map(s => `\`${s.value}\` (${s.count})`).join(', ')
  const verb = o.different === 1 ? 'computes' : 'compute'
  return `${o.prop}: ${o.different} of the ${total} matches currently ${verb}${seen ? ` ${seen}` : ' another value'} instead of the picked element's \`${o.target || 'value'}\``
}

/**
 * The scope as brief facts, one string per line, without the list marker. Empty for Only
 * this and for no scope, so those comments read exactly as they did before scope existed.
 *
 * Every page-supplied piece sits inside a code span, and the instructions around it are
 * ours: the group is evidence about rendered nodes and the hint is only a hint.
 *
 * @param {Scope|undefined} scope
 * @param {{ earlierRound?: boolean }} [opts]  true on a follow-up that carries no new picks:
 *   the scope then describes what the earlier round was asked to cover.
 * @returns {string[]}
 */
export function scopeFacts(scope, { earlierRound = false } = {}) {
  if (!scope || scope.kind === 'element') return []
  const tag = scope.match.tag
  const label = earlierRound ? '**apply scope (from the earlier round)**' : '**apply scope**'
  const facts = [
    `${label} — the picked values are for ${groupPhrase(scope)}; ${countPhrase(scope.counts)}.`,
  ]
  const differ = scope.observations.filter(o => o.different > 0)
  if (differ.length) {
    facts.push(`**values differ inside the group** — ${differ.map(o => observationPhrase(o, scope.counts.document)).join('; ')}. Not proof of a wrong match: state, media queries and inheritance can explain it.`)
  }
  if (scope.members?.length) {
    facts.push(`**group members (selector hints)** — ${scope.members.map(m => `\`${m}\``).join(', ')}`)
  }
  const broaden = scope.kind === 'tag'
    ? `The base tag-wide \`${tag}\` rule is intended here; check for unrelated uses before editing.`
    : `Do not broaden it into the base \`${tag}\` rule or a global token, and do not change other instances just because they share a source file.`
  facts.push(
    '**scope guardrail** — this group is a set of rendered nodes seen on the current page, not a source-code rule, and the hint above is only a hint. '
    + 'Find the class, component, variant or rule that produces exactly these nodes and make the change once there, in the shared source, rather than editing each node. '
    + `${broaden} Other routes and nodes not mounted now were not counted. `
    + 'If no single shared source produces this group, say so (reply, or in the resolution) instead of patching nodes one by one. When you resolve it, say which scope you implemented and which files you changed.',
  )
  return facts
}

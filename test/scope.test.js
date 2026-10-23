/**
 * "Apply to" groups, from extension/scope.js loaded as a module, on a small fake tree.
 *
 * The group builder only walks tagName, className, parentElement, children and the
 * document's getElementsByTagName, so every match definition, the cap, the time budget,
 * collapsing, the words and the stored record are checked here without a browser.
 * test/e2e.test.js covers the same feature in the real composer.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../extension/scope.js'

const S = globalThis.PinpointScope

/** `h('article.card', h('h3.card-title'))`: a node with a tag, classes and children. */
function h(sel, ...kids) {
  const [tag, ...cls] = sel.split('.')
  const n = { tagName: tag.toUpperCase(), className: cls.join(' '), children: [], parentElement: null, isConnected: true }
  for (const k of kids) { k.parentElement = n; n.children.push(k) }
  return n
}

function all(n) { return [n, ...n.children.flatMap(all)] }

/** A document around a body: getElementsByTagName in document order, like the real one. */
function docOf(body) {
  const html = h('html', body)
  return { body, documentElement: html, getElementsByTagName: tag => all(html).filter(n => n.tagName.toLowerCase() === tag) }
}

/**
 * The owner's example: three cards whose titles share `card-title`, one with an extra
 * override class; a promo title with the same class outside the cards; eleven plain h3s.
 */
function cards({ plain = 11 } = {}) {
  const titles = [h('h3.card-title'), h('h3.card-title'), h('h3.card-title.card-title--accent')]
  const promo = h('h3.card-title')
  const body = h('body',
    h('main',
      h('section.grid', ...titles.map(t => h('article.card', t, h('p')))),
      h('aside.promo', promo),
      h('section.plain', ...Array.from({ length: plain }, () => h('h3'))),
    ),
  )
  return { doc: docOf(body), titles, promo, body }
}

const kinds = r => r.options.map(o => `${o.kind}:${S.countText(o)}`)

test('stable classes drop generated names, and are sorted and unique', () => {
  assert.deepEqual(S.stableClasses({ className: 'b a css-1x2y3z sc-AbCdE a Button__abc12 x-a1b2c3' }), ['a', 'b'])
  assert.deepEqual(S.stableClasses({ className: '' }), [])
  // Ordinary hyphenated names stay: they are the most descriptive ones.
  assert.deepEqual(S.stableClasses({ className: 'card-header hero-actions' }), ['card-header', 'hero-actions'])
})

test('every match and its count on the cards page', () => {
  const { doc, titles } = cards()
  const r = S.build(titles[0], { doc })
  assert.deepEqual(kinds(r), ['element:1', 'classes:3', 'pattern:3', 'tag:15'])
  const by = Object.fromEntries(r.options.map(o => [o.kind, o]))
  assert.equal(by.classes.hint, 'h3.card-title')
  assert.deepEqual(by.classes.match, { tag: 'h3', classes: ['card-title'] })
  assert.equal(by.pattern.label, 'Same container')
  assert.equal(by.pattern.hint, 'article.card › h3')
  assert.deepEqual(by.pattern.match, { tag: 'h3', container: { tag: 'article', classes: ['card'] }, relative: [{ tag: 'h3' }], child: false })
  // The override class is a different set, so it is not a same-classes member...
  assert.equal(by.classes.nodes.includes(titles[2]), false)
  // ...but it is the same role in the same repeated card.
  assert.deepEqual(by.pattern.nodes, titles)
  assert.equal(by.tag.label, 'Every h3')
})

test('same classes is set equality, not a CSS subset match', () => {
  const { doc, titles } = cards()
  const r = S.build(titles[2], { doc })
  const classes = r.options.find(o => o.kind === 'classes')
  // Only the one with exactly card-title + card-title--accent: a group of one, so it is
  // dropped once the list is collapsed.
  assert.equal(classes.count, 1)
  assert.deepEqual(S.collapse(r.options).options.map(o => o.kind), ['element', 'pattern', 'tag'])
})

test('an element with no stable class has no same-classes option', () => {
  const { doc, body } = cards()
  const plain = body.children[0].children[2].children[0]
  const r = S.build(plain, { doc })
  assert.equal(r.omitted.classes, 'no-classes')
})

test('same container needs a repeating ancestor and exactly one target per copy', () => {
  // Nothing repeats above the target.
  const lone = h('h3.title')
  const one = docOf(h('body', h('div.page', lone)))
  assert.equal(S.build(lone, { doc: one }).omitted.pattern, 'no-repeat')

  // Two h3s in every card: the tag alone is ambiguous, and so is the chain, so it is left out.
  const t = h('h3')
  const twice = docOf(h('body', h('article.card', t, h('h3')), h('article.card', h('h3'), h('h3'))))
  assert.equal(S.build(t, { doc: twice }).omitted.pattern, 'ambiguous')

  // A heading in both header and footer: the tag is ambiguous, the child chain is not.
  const head = h('h3')
  const split = docOf(h('body',
    h('article.card', h('header', head), h('footer', h('h3'))),
    h('article.card', h('header', h('h3')), h('footer', h('h3'))),
  ))
  const p = S.build(head, { doc: split }).options.find(o => o.kind === 'pattern')
  assert.equal(p.hint, 'article.card › header › h3')
  assert.equal(p.match.child, true)
  assert.equal(p.count, 2)

  // A card without a title breaks "exactly one in every copy".
  const first = h('h3')
  const missing = docOf(h('body', h('li', first), h('li', h('p')), h('li', h('h3'))))
  assert.equal(S.build(first, { doc: missing }).omitted.pattern, 'ambiguous')
})

test('a classless li, tr or article still counts as a repeated container', () => {
  const a = h('span')
  const doc = docOf(h('body', h('ul', h('li', a), h('li', h('span')), h('li', h('span')))))
  const p = S.build(a, { doc }).options.find(o => o.kind === 'pattern')
  assert.equal(p.hint, 'li › span')
  assert.equal(p.count, 3)
})

test('counting stops at 200, and a capped group has no node list', () => {
  const { doc, titles } = cards({ plain: 250 })
  const tag = S.build(titles[0], { doc }).options.find(o => o.kind === 'tag')
  assert.equal(tag.capped, true)
  assert.equal(tag.count, S.CAP)
  assert.equal(tag.nodes, null)
  assert.equal(tag.visible, null)
  assert.equal(S.countText(tag), '200+')
  assert.equal(S.detailCount(tag), '200+ in document')
  assert.equal(S.countPhrase(tag), '200 or more matches')

  const many = Array.from({ length: 230 }, () => h('i.dot'))
  const big = docOf(h('body', ...many))
  const classes = S.build(many[0], { doc: big }).options.find(o => o.kind === 'classes')
  assert.equal(classes.capped, true)
  assert.equal(classes.nodes, null)
})

test('the host Pinpoint mounts is never counted', () => {
  const t = h('div.x')
  const hostNode = h('div')
  const body = h('body', t, h('div'))
  const doc = docOf(body)
  doc.documentElement.children.push(hostNode)
  hostNode.parentElement = doc.documentElement
  const tag = S.build(t, { doc, exclude: hostNode }).options.find(o => o.kind === 'tag')
  assert.equal(tag.count, 2)
  assert.equal(tag.nodes.includes(hostNode), false)
})

test('a match that runs out of time is left out, not shown half counted', () => {
  const { doc, titles } = cards()
  let t = 0
  // Every reading of the clock is 30ms later: element is free, the rest miss the budget.
  const r = S.build(titles[0], { doc, clock: () => (t += 30), budgetMs: 40 })
  assert.deepEqual(r.options.map(o => o.kind), ['element'])
  assert.equal(r.omitted.classes, 'budget')
  assert.equal(r.omitted.tag, 'budget')
})

test('a frozen frame offers only Only this', () => {
  const { doc, titles } = cards()
  const r = S.build(titles[0], { doc, frozen: true })
  assert.deepEqual(r.options.map(o => o.kind), ['element'])
  assert.equal(r.omitted.component, 'frozen')
})

test('visible and document counts are told apart', () => {
  const { doc, titles } = cards()
  const hidden = new Set([titles[1]])
  const classes = S.build(titles[0], { doc, visible: n => !hidden.has(n) }).options.find(o => o.kind === 'classes')
  assert.equal(classes.visible, 2)
  assert.equal(S.detailCount(classes), '2 visible · 3 in document')
  assert.equal(S.countPhrase(classes), '2 visible, 3 in document')
  assert.equal(S.detailCount({ count: 3, visible: 3 }), '3 matches')
  assert.equal(S.detailCount({ count: 1, visible: 1 }), '1 match')
})

test('identical node sets collapse to the first, unless the later one is chosen', () => {
  const a = h('h3.t'); const b = h('h3.t')
  const nodes = [a, b]
  const opts = [
    { kind: 'tag', nodes, count: 2, capped: false },
    { kind: 'classes', nodes, count: 2, capped: false },
    { kind: 'element', nodes: [a], count: 1, capped: false },
  ]
  const plainList = S.collapse(opts)
  assert.deepEqual(plainList.options.map(o => o.kind), ['element', 'classes'])
  assert.equal(plainList.dropped.tag, 'same-as-classes')
  const kept = S.collapse(opts, 'tag')
  assert.deepEqual(kept.options.map(o => o.kind), ['element', 'tag'])
  // Two capped groups cannot be compared, so both stay.
  const capped = S.collapse([{ kind: 'element', nodes: [a], count: 1 }, { kind: 'classes', nodes: null, count: 200, capped: true }, { kind: 'tag', nodes: null, count: 200, capped: true }])
  assert.deepEqual(capped.options.map(o => o.kind), ['element', 'classes', 'tag'])
})

test('component names: minified and missing ones are no evidence', () => {
  for (const ok of ['CardTitle', 'card-title', 'Nav.Item', 'Btn']) assert.equal(S.usefulComponentName(ok), true, ok)
  for (const bad of ['t', 'Ae', 'n9', 'e12', '', null, 'x'.repeat(61), 'has space']) assert.equal(S.usefulComponentName(bad), false, String(bad))
})

test('the component match resolves every member back to a live node, or is left out', () => {
  const { titles, promo } = cards()
  const table = new Map([['p1', titles[0]], ['p2', titles[1]], ['p3', promo]])
  const resolve = p => table.get(p) ?? null
  assert.deepEqual(S.componentOption(titles[0], null, resolve), { omit: 'timeout' })
  assert.deepEqual(S.componentOption(titles[0], { name: null }, resolve), { omit: 'no-name' })
  assert.deepEqual(S.componentOption(titles[0], { name: 't', members: ['p1'] }, resolve), { omit: 'minified' })
  assert.deepEqual(S.componentOption(titles[0], { name: 'CardTitle', incomplete: true }, resolve), { omit: 'budget' })
  assert.deepEqual(S.componentOption(titles[0], { name: 'CardTitle', members: ['p1', 'gone'] }, resolve), { omit: 'unresolved' })
  // The target itself must be among the members.
  assert.deepEqual(S.componentOption(titles[0], { name: 'CardTitle', members: ['p2', 'p3'] }, resolve), { omit: 'unresolved' })
  const ok = S.componentOption(titles[0], { name: 'CardTitle', members: ['p1', 'p2', 'p3'] }, resolve)
  assert.equal(ok.kind, 'component')
  assert.equal(ok.hint, 'CardTitle / h3')
  assert.deepEqual(ok.match, { tag: 'h3', component: 'CardTitle' })
  assert.equal(ok.count, 3)
  const capped = S.componentOption(titles[0], { name: 'CardTitle', capped: true }, resolve)
  assert.equal(capped.capped, true)
  assert.equal(capped.nodes, null)
})

test('observations count members whose value differs from the target, with samples', () => {
  const { titles } = cards()
  const values = new Map([[titles[0], 'ink'], [titles[1], 'ink'], [titles[2], 'grey']])
  const obs = S.observe([{ prop: 'color', from: 'ink', to: 'accent' }, { prop: 'padding', from: '4px', to: '8px' }], titles, titles[0],
    (n, prop) => (prop === 'color' ? values.get(n) : '4px'))
  assert.deepEqual(obs, [
    { prop: 'color', target: 'ink', different: 1, samples: [{ value: 'grey', count: 1 }] },
    { prop: 'padding', target: '4px', different: 0, samples: [] },
  ])
  assert.deepEqual(S.warnings(obs, 3), ['1 of 3 matches currently uses a different text colour'])
  assert.deepEqual(S.warnings([{ prop: 'background-color', different: 2 }], 6), ['2 of 6 matches currently use a different background colour'])
})

test('the stored scope has the version 1 shape, bounded', () => {
  const { doc, titles } = cards()
  const classes = S.build(titles[0], { doc }).options.find(o => o.kind === 'classes')
  const observations = [{ prop: 'color', target: 'ink', different: 0, samples: [] }]
  const scope = S.toScope(classes, { source: 'article.card:nth-of-type(1) > h3.card-title', observations, members: ['a', 'b', 'c'] })
  assert.deepEqual(scope, {
    version: 1,
    kind: 'classes',
    match: { tag: 'h3', classes: ['card-title'] },
    hint: 'h3.card-title',
    source: 'article.card:nth-of-type(1) > h3.card-title',
    counts: { document: 3, visible: 3, capped: false },
    observations,
    members: ['a', 'b', 'c'],
  })
  // Only this: the selector is its hint, and it carries no members or observations.
  const only = S.toScope(S.build(titles[0], { doc }).options[0], { source: 'x > h3', observations, members: ['a'] })
  assert.deepEqual(only, { version: 1, kind: 'element', match: { tag: 'h3' }, hint: 'x > h3', source: 'x > h3', counts: { document: 1, visible: 1, capped: false }, observations: [] })
  // A capped group is "at least 200", with nothing listed.
  const capped = S.toScope({ kind: 'tag', match: { tag: 'h3' }, hint: 'h3', count: 200, capped: true, nodes: null }, { source: 's', observations, members: ['a'] })
  assert.deepEqual(capped.counts, { document: 200, visible: null, capped: true })
  assert.deepEqual(capped.observations, [])
  assert.equal('members' in capped, false)
  // Page text cannot grow the record or smuggle in a new line.
  const long = S.toScope({ kind: 'classes', match: { tag: 'h3', classes: Array.from({ length: 20 }, (_, i) => `c${i}`) }, hint: 'x'.repeat(500), count: 2, visible: 2, nodes: [] }, { source: 'a\nb', members: Array.from({ length: 30 }, () => 'm') })
  assert.equal(long.hint.length, 200)
  assert.equal(long.match.classes.length, 8)
  assert.equal(long.members.length, S.MAX_MEMBERS)
  assert.equal(long.source, 'a b')
})

/**
 * The design-system probe, against one fixture project per stack in the matrix.
 *
 * Fixtures are real files rather than strings on purpose: the probe's job is finding
 * things on disk, and a test that hands it the file it was going to look for has skipped
 * the half most likely to break.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  probeProject, cssVars, flattenLiteral, categorise, toPx, spacingStep, normaliseColour,
} from '../server/design-system.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const probe = name => probeProject(join(FIXTURES, name))

const names = list => list.map(t => t.name)
const value = (list, name) => list.find(t => t.name === name)?.value
const libraries = result => result.libraries.map(l => l.name)

// ---------------------------------------------------------------- per stack

test('Tailwind v4 — theme read from the @theme block', () => {
  const r = probe('tailwind4')
  assert.ok(libraries(r).includes('Tailwind CSS v4'), `got ${libraries(r)}`)
  assert.equal(value(r.tokens.color, '--color-brand-500'), '#6366f1')
  // An oklch() value is a colour even though nothing here can convert it.
  assert.ok(names(r.tokens.color).includes('--color-surface'))
  assert.equal(value(r.tokens.spacing, '--spacing-6'), '24px')
  assert.equal(value(r.tokens.radius, '--radius-lg'), '12px')
  assert.ok(names(r.tokens.type).includes('--font-display'))
  assert.equal(r.spacingStep, 4)
})

test('Tailwind v3 — theme read from the JS config, nested and flattened', () => {
  const r = probe('tailwind3')
  assert.ok(libraries(r).includes('Tailwind CSS v3'), `got ${libraries(r)}`)
  assert.equal(value(r.tokens.color, 'brand-500'), '#6366f1')
  // A leaf directly under a group keeps the group's own name.
  assert.equal(value(r.tokens.color, 'ink'), '#0b0b0f')
  assert.equal(value(r.tokens.spacing, '6'), '24px')
  assert.equal(value(r.tokens.radius, 'card'), '14px')
  // fontSize is written as [size, {lineHeight}] — the size is the token.
  assert.equal(value(r.tokens.type, 'body'), '15px')
  assert.ok(r.sources.some(s => s.includes('tailwind.config.js')))
})

test('Tailwind v4 and v3 are told apart, not merged', () => {
  assert.ok(!libraries(probe('tailwind4')).includes('Tailwind CSS v3'))
  assert.ok(!libraries(probe('tailwind3')).includes('Tailwind CSS v4'))
})

test('shadcn/ui — components.json plus bare HSL triples', () => {
  const r = probe('shadcn')
  assert.ok(libraries(r).includes('shadcn/ui'), `got ${libraries(r)}`)
  assert.ok(names(r.tokens.color).includes('--primary'))
  assert.ok(names(r.tokens.color).includes('--muted-foreground'))
  // `--radius: 0.5rem` is radius, not spacing.
  assert.equal(value(r.tokens.radius, '--radius'), '0.5rem')
  // The light block wins: .dark restates the same names with different values.
  assert.equal(value(r.tokens.color, '--background'), '0 0% 100%')
})

test('MUI — createTheme literal', () => {
  const r = probe('mui')
  assert.ok(libraries(r).includes('MUI'), `got ${libraries(r)}`)
  assert.equal(value(r.tokens.color, 'primary-main'), '#1976d2')
  assert.equal(value(r.tokens.color, 'error-main'), '#d32f2f')
  assert.equal(value(r.tokens.radius, 'borderRadius'), '8')
})

test('Chakra — extendTheme literal', () => {
  const r = probe('chakra')
  assert.ok(libraries(r).includes('Chakra UI'), `got ${libraries(r)}`)
  assert.equal(value(r.tokens.color, 'brand-500'), '#0087d1')
  assert.equal(value(r.tokens.spacing, '4'), '16px')
  assert.equal(value(r.tokens.radius, 'card'), '12px')
})

test('Mantine — named from the dependency, tokens left to the runtime probe', () => {
  const r = probe('mantine')
  assert.ok(libraries(r).includes('Mantine'), `got ${libraries(r)}`)
  assert.ok(r.detected)
})

test('Ant Design — ConfigProvider token literal', () => {
  const r = probe('antd')
  assert.ok(libraries(r).includes('Ant Design'), `got ${libraries(r)}`)
  assert.equal(value(r.tokens.color, 'colorPrimary'), '#1677ff')
})

test('Bootstrap — --bs-* variables', () => {
  const r = probe('bootstrap')
  assert.ok(libraries(r).includes('Bootstrap'), `got ${libraries(r)}`)
  assert.equal(value(r.tokens.color, '--bs-primary'), '#0d6efd')
  assert.equal(value(r.tokens.radius, '--bs-border-radius'), '0.375rem')
})

test('daisyUI — recognised alongside the Tailwind it plugs into', () => {
  const r = probe('daisyui')
  assert.ok(libraries(r).includes('daisyUI'), `got ${libraries(r)}`)
  assert.ok(libraries(r).includes('Tailwind CSS v3'))
})

test('hand-rolled CSS variables — no library, still a design system', () => {
  const r = probe('vanilla')
  assert.deepEqual(libraries(r), [])
  assert.ok(r.detected)
  assert.equal(value(r.tokens.color, '--accent'), '#7c5cff')
  assert.equal(value(r.tokens.spacing, '--space-2'), '8px')
  assert.equal(r.spacingStep, 4)
})

test('a project with no design system degrades to nothing, not an error', () => {
  const r = probe('empty')
  assert.equal(r.detected, false)
  assert.deepEqual(libraries(r), [])
  assert.deepEqual(r.tokens.color, [])
  assert.equal(r.spacingStep, null)
})

test('a directory that does not exist is a shrug', () => {
  const r = probeProject(join(FIXTURES, 'no-such-project'))
  assert.equal(r.detected, false)
})

test('the real project probes itself without throwing', () => {
  const r = probeProject(join(FIXTURES, '..', '..'))
  assert.equal(typeof r.detected, 'boolean')
})

// ---------------------------------------------------------------- units

test('cssVars reads every theme block shape', () => {
  const vars = cssVars(`
    @theme { --a: 1px; }
    :root { --b: #fff; }
    html { --c: 2rem; }
    :host { --d: red; }
    [data-theme="dark"] { --e: blue; }
    .card { --f: 3px; }
  `)
  assert.deepEqual([...vars.keys()], ['--a', '--b', '--c', '--d', '--e'])
  // A rule that is not a theme block is not a source of tokens.
  assert.equal(vars.has('--f'), false)
})

test('cssVars survives nesting and comments without a CSS parser', () => {
  const vars = cssVars(`
    :root {
      --a: 1px;
      @media (min-width: 40rem) { --b: 2px; }
      --c: 3px;
    }
    .after { color: red }
  `)
  assert.equal(vars.get('--a'), '1px')
  assert.equal(vars.get('--c'), '3px')
})

test('cssVars keeps the first declaration when a dark block restates it', () => {
  const vars = cssVars(':root { --bg: white } .dark { --bg: black }')
  assert.equal(vars.get('--bg'), 'white')
})

test('flattenLiteral joins nested keys and unwraps DEFAULT', () => {
  const flat = flattenLiteral(`
    brand: { DEFAULT: '#111', 500: '#222' },
    ink: "#333",
    size: 8,
  `)
  assert.equal(flat.find(t => t.name === 'brand')?.value, '#111')
  assert.equal(flat.find(t => t.name === 'brand-500')?.value, '#222')
  assert.equal(flat.find(t => t.name === 'ink')?.value, '#333')
  assert.equal(flat.find(t => t.name === 'size')?.value, '8')
})

test('flattenLiteral skips what it cannot read rather than guessing', () => {
  const flat = flattenLiteral(`
    good: '#111',
    computed: someFunction(),
    spread: ...base,
    also: withVariable,
  `)
  assert.deepEqual(flat.map(t => t.name), ['good'])
})

test('categorise puts each token in the drawer its name implies', () => {
  assert.equal(categorise('--color-brand-500', '#fff'), 'color')
  assert.equal(categorise('--spacing-4', '16px'), 'spacing')
  assert.equal(categorise('--radius-lg', '12px'), 'radius')
  assert.equal(categorise('--font-display', 'Inter'), 'type')
  assert.equal(categorise('--muted-foreground', '215 16% 47%'), 'color')
  // A type-prefixed name holding a colour is a colour.
  assert.equal(categorise('--text-muted', '#888'), 'color')
  // Radius before spacing: both are lengths.
  assert.equal(categorise('--rounded-sm', '2px'), 'radius')
  // Value decides when the name says nothing.
  assert.equal(categorise('--thing', '#abc'), 'color')
  assert.equal(categorise('--thing', '10px'), 'spacing')
  assert.equal(categorise('--thing', 'ease-in-out'), null)
})

test('toPx normalises the units a scale is written in', () => {
  assert.equal(toPx('16px'), 16)
  assert.equal(toPx('1rem'), 16)
  assert.equal(toPx('0.5rem'), 8)
  assert.equal(toPx('12'), 12)
  assert.equal(toPx('auto'), null)
  assert.equal(toPx('calc(100% - 4px)'), null)
})

test('spacingStep finds the step a scale is built on', () => {
  assert.equal(spacingStep(['4px', '8px', '16px', '24px']), 4)
  assert.equal(spacingStep(['0.25rem', '0.5rem', '1rem']), 4)
  assert.equal(spacingStep(['5px', '10px', '15px']), 5)
  // Too few values to call it a scale.
  assert.equal(spacingStep(['4px', '8px']), null)
  // No common factor is no scale, not a scale of 1.
  assert.equal(spacingStep(['3px', '7px', '11px']), null)
})

test('normaliseColour makes two spellings of one colour compare equal', () => {
  assert.equal(normaliseColour('#FFF'), '#ffffff')
  assert.equal(normaliseColour('#7c5cff'), '#7c5cff')
  assert.equal(normaliseColour('rgb(124, 92, 255)'), '#7c5cff')
  assert.equal(normaliseColour('rgba(124 92 255 / 0.5)'), '#7c5cff')
  // shadcn's bare HSL triple, the form with no function around it.
  assert.equal(normaliseColour('0 0% 100%'), '#ffffff')
  assert.equal(normaliseColour('hsl(210 40% 98%)'), '#f8fafc')
  assert.equal(normaliseColour('oklch(0.98 0.01 250)'), null)
  assert.equal(normaliseColour('nonsense'), null)
})

// ---------------------------------------------------------------- mapping values back

import { tokenIndex, annotate, summaryLine, guardrailLine } from '../server/design-system.js'

const index = name => tokenIndex(probe(name))

test('a colour that is in the palette comes back as its token name', () => {
  const i = index('tailwind4')
  assert.equal(annotate('background-color', '#6366f1', i), '--color-brand-500')
  // Same colour, different spelling.
  assert.equal(annotate('color', 'rgb(99, 102, 241)', i), '--color-brand-500')
  assert.equal(annotate('border-color', '#312E81', i), '--color-brand-900')
})

test('a colour that is in no palette is called out', () => {
  const i = index('tailwind4')
  assert.equal(annotate('background-color', '#ff0000', i), '⚠ not in the palette')
})

test('transparent and currentColor are absences, not violations', () => {
  const i = index('tailwind4')
  assert.equal(annotate('border-color', 'transparent', i), null)
  assert.equal(annotate('color', 'currentColor', i), null)
})

test('shadcn HSL triples resolve to their token', () => {
  const i = index('shadcn')
  // shadcn declares --foreground and --primary as the same triple. One colour cannot map
  // back to two names, so the first declared wins — a stable answer beats a clever one.
  assert.equal(annotate('background-color', '#0f172a', i), '--foreground')
  assert.equal(annotate('color', '#f8fafc', i), '--primary-foreground')
})

test('a length on the scale comes back as its token', () => {
  const i = index('tailwind4')
  assert.equal(annotate('padding', '24px', i), '24px = --spacing-6')
  assert.equal(annotate('border-radius', '12px', i), '12px = --radius-lg')
})

test('a shorthand annotates each distinct part', () => {
  const i = index('tailwind4')
  assert.equal(annotate('padding', '8px 16px', i), '8px = --spacing-2; 16px = --spacing-4')
  // Repeated values are said once.
  assert.equal(annotate('padding', '8px 8px', i), '8px = --spacing-2')
})

test('a type size is never called off the spacing scale', () => {
  const i = index('tailwind4')
  // 13px is not a multiple of 4, but a type scale is a set of ratios, not a grid.
  assert.equal(annotate('font-size', '13px', i), null)
  assert.equal(annotate('border-radius', '9px', i), null)
  // It still resolves when it *is* a token.
  assert.equal(annotate('font-size', '14px', i), '14px = --text-sm')
})

test('fixture directories are not mistaken for the project', () => {
  // This repo carries a Tailwind v4 fixture. Probing the repo must not report the repo
  // as a Tailwind project on the strength of it.
  const r = probeProject(join(FIXTURES, '..', '..'))
  assert.ok(!r.sources.some(s => s.includes('fixtures')), `leaked: ${r.sources}`)
  assert.ok(!libraries(r).includes('Tailwind CSS v4'), `got ${libraries(r)}`)
})

test('a length off the scale names the neighbours it should have been', () => {
  const i = index('tailwind4')
  const note = annotate('padding', '13px', i)
  assert.match(note, /off the 4px scale/)
  assert.match(note, /--spacing-2 \(8px\)/)
  assert.match(note, /--spacing-4 \(16px\)/)
})

test('a length on the scale but not a named token stays quiet', () => {
  // 20px is 5 × 4px: on the scale, just not one of the four tokens declared.
  assert.equal(annotate('padding', '20px', index('tailwind4')), null)
})

test('zero and auto are never off-scale', () => {
  const i = index('tailwind4')
  assert.equal(annotate('margin', '0px', i), null)
  assert.equal(annotate('margin', 'auto', i), null)
})

test('properties outside the two families are left alone', () => {
  const i = index('tailwind4')
  assert.equal(annotate('display', 'flex', i), null)
  assert.equal(annotate('box-shadow', '#6366f1 0 0 0 1px', i), null)
})

test('with no design system nothing is annotated and nothing is claimed', () => {
  const summary = probe('empty')
  const i = tokenIndex(summary)
  assert.equal(annotate('padding', '13px', i), null)
  assert.equal(annotate('color', '#ff0000', i), null)
  assert.equal(summaryLine(summary), null)
  assert.equal(guardrailLine(summary), null)
})

test('the summary line names the library, the scale, and where it was read', () => {
  const line = summaryLine(probe('tailwind4'))
  assert.match(line, /Tailwind CSS v4/)
  assert.match(line, /4px scale/)
  assert.match(line, /src\/app\.css/)
})

test('the summary line says so when there is no library, only variables', () => {
  assert.match(summaryLine(probe('vanilla')), /no component library detected/)
})

test('the guardrail prefers utility classes on Tailwind and tokens elsewhere', () => {
  assert.match(guardrailLine(probe('tailwind4')), /utility classes/)
  assert.match(guardrailLine(probe('vanilla')), /the tokens above/)
})

// ---------------------------------------------------------------- the runtime half

import { withRuntime } from '../server/design-system.js'

test('runtime variables fill in a stack the files could not describe', () => {
  const merged = withRuntime(probe('mantine'), {
    vars: { '--mantine-color-blue-6': '#228be6', '--mantine-spacing-md': '16px' },
    fingerprints: [],
  })
  assert.equal(value(merged.tokens.color, '--mantine-color-blue-6'), '#228be6')
  assert.equal(annotate('color', '#228be6', tokenIndex(merged)), '--mantine-color-blue-6')
})

test('a static token keeps its place when the page reports the same name', () => {
  const merged = withRuntime(probe('vanilla'), { vars: { '--accent': '#000000' } })
  // The file said #7c5cff and the file is the thing you can edit.
  assert.equal(value(merged.tokens.color, '--accent'), '#7c5cff')
})

test('fingerprints name a library the files never mentioned', () => {
  const merged = withRuntime(probe('empty'), { vars: {}, fingerprints: ['shadcn', 'radix'] })
  assert.deepEqual(libraries(merged), ['shadcn/ui', 'Radix UI'])
  assert.equal(merged.detected, true)
})

test('fingerprints never duplicate a library the files already found', () => {
  const merged = withRuntime(probe('mui'), { fingerprints: ['mui'] })
  assert.deepEqual(libraries(merged), ['MUI'])
})

test('an unknown fingerprint is ignored rather than invented', () => {
  const merged = withRuntime(probe('empty'), { fingerprints: ['not-a-library'] })
  assert.deepEqual(libraries(merged), [])
})

test('runtime variables can establish a scale the files did not', () => {
  const merged = withRuntime(probe('empty'), {
    vars: { '--space-1': '4px', '--space-2': '8px', '--space-4': '16px' },
  })
  assert.equal(merged.spacingStep, 4)
})

test('withRuntime with nothing to add changes nothing', () => {
  const base = probe('vanilla')
  assert.deepEqual(withRuntime(base, null), base)
  assert.deepEqual(libraries(withRuntime(base, { vars: {}, fingerprints: [] })), [])
})

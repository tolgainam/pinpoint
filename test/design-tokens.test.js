/**
 * The overlay's design tokens: no raw values outside extension/tokens.css, and every
 * token the overlay uses is one that file defines.
 *
 * The first test is `npm run check:design` run as part of `npm test`, so a raw colour
 * fails the suite and not only a script nobody remembers to run.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, scan } from '../scripts/check-design.js'

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension')
const values = (src, kind = 'css') => scan(src, kind).map(f => f.value)

test('no raw design values outside extension/tokens.css', () => {
  assert.deepEqual(check(), [])
})

test('every var(--pp-*) the extension uses is defined', () => {
  const defined = new Set()
  const used = new Set()
  for (const name of readdirSync(EXT).filter(n => /\.(css|js)$/.test(n))) {
    const src = readFileSync(join(EXT, name), 'utf8')
    for (const [, v] of src.matchAll(/(--pp-[a-z0-9-]+)\s*:/g)) defined.add(v)
    for (const [, v] of src.matchAll(/var\((--pp-[a-z0-9-]+)/g)) used.add(v)
  }
  assert.deepEqual([...used].filter(v => !defined.has(v)), [])
})

test('check: catches hex, rgb(), hsl() and raw px on design properties', () => {
  assert.deepEqual(values('.a { color: #fff; }'), ['#fff'])
  assert.deepEqual(values('.a { background: rgb(0 0 0 / 0.4); }'), ['rgb(0 0 0 / 0.4)'])
  assert.deepEqual(values('.a { border-color: hsl(10 20% 30%); }'), ['hsl(10 20% 30%)'])
  assert.deepEqual(values('.a { padding: 6px 8px; }'), ['padding: 6px', 'padding: 8px'])
  assert.deepEqual(values('.a { font-size: 11px; border-radius: 7px; }'), ['font-size: 11px', 'border-radius: 7px'])
  assert.deepEqual(values('.a { box-shadow: 0 6px 24px var(--pp-x); }'), ['box-shadow: 6px', 'box-shadow: 24px'])
})

test('check: allows 0, 1px hairlines, percentages, layout and comments', () => {
  assert.deepEqual(values('.a { padding: 0 1px; margin: 0px; border-radius: 50%; width: 22px; top: -22px; }'), [])
  assert.deepEqual(values('/* was #fff with 12px padding */ .a { color: var(--pp-fg); }'), [])
  assert.deepEqual(values('.a { gap: var(--pp-space-8); }'), [])
})

test('check: the escape works only with a reason', () => {
  assert.deepEqual(values('.a { margin: -11px; } /* design-ok: centres the pin */'), [])
  assert.deepEqual(values('.a { margin: -11px; } /* design-ok: */'), ['margin: -11px'])
})

test('check: JS is read for its string literals only', () => {
  assert.deepEqual(values("el.style.cssText = 'color:#f00;padding:4px'", 'js'), ['#f00', 'padding: 4px'])
  assert.deepEqual(values('el.style.left = `${x}px` // was #fff', 'js'), [])
  assert.deepEqual(values("const A = '#d97757' /* design-ok: badge API needs a literal */", 'js'), [])
})

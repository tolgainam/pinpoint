#!/usr/bin/env node
/**
 * Fails on raw design values outside extension/tokens.css.
 *
 * A raw value is a hex colour, an rgb()/hsl() literal, or a px length on a property the
 * tokens cover: font size, line height, letter spacing, padding, margin, gap, radius and
 * shadow. Layout geometry (width, top, a computed `${x}px`) is not a design value and is
 * left alone. Checked: extension/*.css, and the string literals in extension/*.js.
 *
 * Allowed without comment: 0, 1px hairlines, percentages. Anything else needs
 * `/* design-ok: reason *\/` on the same line, and the reason is not optional.
 *
 *   npm run check:design
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXT = join(ROOT, 'extension')
const TOKENS = 'tokens.css'

const COLOUR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?)\([^)]*\)?/g
const LENGTH_PROPS = /(?:^|[^a-z-])(font-size|line-height|letter-spacing|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap|border(?:-[a-z]+)*-radius|box-shadow)\s*:\s*([^;{}'"`]*)/g
const PX = /(?<![\w.-])-?(\d*\.?\d+)px\b/g
const ESCAPE = /\/\*\s*design-ok:\s*\S[^*]*\*\//

/**
 * Comments out, line numbers kept. A colour named in a comment is documentation, and a
 * `/* design-ok *\/` is read off the raw line before this runs.
 */
function stripComments(src, js) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  if (js) out = out.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length))
  return out
}

/** The string literals on one line of JS, which is where a style would be written. */
const stringsOf = line => [...line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2])

function lengthsIn(text) {
  const found = []
  for (const [, prop, value] of text.matchAll(LENGTH_PROPS)) {
    for (const [px, n] of value.matchAll(PX)) {
      if (Number(n) === 0 || Number(n) === 1) continue
      found.push(`${prop}: ${px}`)
    }
  }
  return found
}

const coloursIn = text => [...text.matchAll(COLOUR)].map(m => m[0])

/**
 * @param {string} src  file contents
 * @param {'css'|'js'} kind
 * @returns {{line: number, value: string}[]}
 */
export function scan(src, kind) {
  const raw = src.split('\n')
  const clean = stripComments(src, kind === 'js').split('\n')
  const found = []
  clean.forEach((line, i) => {
    if (ESCAPE.test(raw[i])) return
    const parts = kind === 'js' ? stringsOf(line) : [line]
    for (const part of parts) {
      for (const value of [...coloursIn(part), ...lengthsIn(part)]) found.push({ line: i + 1, value })
    }
  })
  return found
}

/** Every finding under extension/, as `file:line value`. */
export function check(dir = EXT) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const kind = name.endsWith('.css') ? 'css' : name.endsWith('.js') ? 'js' : null
    if (!kind || name === TOKENS) continue
    const path = join(dir, name)
    for (const f of scan(readFileSync(path, 'utf8'), kind)) out.push(`${relative(ROOT, path)}:${f.line} ${f.value}`)
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = check()
  if (found.length) {
    console.error(found.join('\n'))
    console.error(`\ncheck:design: ${found.length} raw value(s) outside extension/${TOKENS}. Use a var(--pp-*) token, or add /* design-ok: reason */ on the line.`)
    process.exit(1)
  }
  console.log(`check:design: no raw values outside extension/${TOKENS}`)
}

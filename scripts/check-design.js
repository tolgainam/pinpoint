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

/** Blanks a span but keeps its newlines, so every offset keeps its line number. */
const blank = text => text.replace(/[^\n]/g, ' ')

/** A `/` after one of these starts a regex literal rather than a division. */
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|void|yield|await))$/

/**
 * One pass over the source that tells comments and strings apart together, so a "/*"
 * inside a string is text and a quote inside a comment is not a string. The result is
 * the same length as the input with its newlines kept, so line numbers still hold. A
 * colour named in a comment is documentation; `/* design-ok *\/` is read off the raw
 * line instead.
 *
 * CSS keeps everything but its comments. JS keeps only the contents of its string
 * literals, which is where a style would be written: code, comments, regex literals and
 * the code inside a template's `${...}` become spaces, and each literal's quotes become
 * `;` so a declaration never runs on from one string into the next. A template literal
 * spanning lines is checked on each of its lines.
 */
export function textOf(src, kind) {
  const js = kind === 'js'
  let out = ''
  let i = 0

  function comment() {
    let stop
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      stop = end === -1 ? src.length : end + 2
    } else if (js && src.startsWith('//', i)) {
      const end = src.indexOf('\n', i)
      stop = end === -1 ? src.length : end
    } else return false
    out += blank(src.slice(i, stop))
    i = stop
    return true
  }

  /** A '...' or "..." string; its body is kept. */
  function quoted() {
    const q = src[i]
    out += js ? ';' : q
    i++
    while (i < src.length && src[i] !== q && src[i] !== '\n') {
      const n = src[i] === '\\' ? 2 : 1
      out += src.slice(i, i + n)
      i += n
    }
    if (src[i] === q) { out += js ? ';' : q; i++ }
  }

  /** A template literal: its text kept, each `${...}` read as code. */
  function template() {
    out += ';'
    i++
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (src.startsWith('${', i)) {
        out += ';;'
        i += 2
        code('}')
        if (src[i] === '}') { out += ';'; i++ }
        continue
      }
      out += src[i]
      i++
    }
    if (i < src.length) { out += ';'; i++ }
  }

  /** A regex literal, blanked: a quote or a slash pair in it is neither string nor comment. */
  function regex() {
    let inClass = false
    out += ' '
    i++
    while (i < src.length && src[i] !== '\n') {
      const c = src[i]
      if (c === '\\') { out += blank(src.slice(i, i + 2)); i += 2; continue }
      out += ' '
      i++
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
    }
  }

  /** JS code up to an unmatched `close` (the end of a `${...}`), or the end of the file. */
  function code(close) {
    let depth = 0
    let prev = ''
    while (i < src.length) {
      const c = src[i]
      if (close && c === close && depth === 0) return
      if (comment()) continue
      if (c === '"' || c === "'") { quoted(); prev = 'x'; continue }
      if (c === '`') { template(); prev = 'x'; continue }
      if (c === '/' && REGEX_AFTER.test(prev)) { regex(); prev = 'x'; continue }
      if (c === '{') depth++
      if (c === '}') depth--
      out += c === '\n' ? '\n' : ' '
      if (!/\s/.test(c)) prev = (prev + c).slice(-8)
      i++
    }
  }

  if (js) code(null)
  else {
    while (i < src.length) {
      if (comment()) continue
      if (src[i] === '"' || src[i] === "'") { quoted(); continue }
      out += src[i]
      i++
    }
  }
  return out
}

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
  const found = []
  textOf(src, kind).split('\n').forEach((line, i) => {
    if (ESCAPE.test(raw[i])) return
    for (const value of [...coloursIn(line), ...lengthsIn(line)]) found.push({ line: i + 1, value })
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

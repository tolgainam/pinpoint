/**
 * Design-system probe — the static half.
 *
 * Reads the project once per session and works out what vocabulary its styles are
 * written in, so a batch can say "this is `p-6` on a 4px scale" instead of
 * "padding: 24px", and so a value that belongs to no scale can be called out as the
 * thing it usually is: the bug.
 *
 * Two rules shape this file:
 *   - **Nothing here executes project code.** A config is read as text and parsed
 *     loosely, never imported. The bridge runs for as long as the session does; a
 *     project file with a side effect, an infinite loop, or a missing import must not
 *     be able to take it down or run anything.
 *   - **Every failure is a shrug.** A stack we cannot read degrades to fewer tokens,
 *     never to an error. The worst outcome is the payload Pinpoint sent before this
 *     file existed.
 *
 * The runtime half lives in the extension: every CSS custom property actually resolved
 * on the page. That one catches styled-components, Emotion, and hand-rolled themes that
 * no amount of file reading will find. This half exists because it can name the *source*
 * — a `tailwind.config.js` says which file to edit, a resolved variable does not.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, basename } from 'node:path'

/** Directories that never hold a project's own design tokens, only copies of other people's. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp',
  '.next', '.nuxt', '.svelte-kit', '.output', '.cache', '.turbo', '.venv', 'venv',
  '__pycache__', 'target', 'Pods', '.pinpoint',
  // Fixtures are, by definition, someone else's design system pretending to be yours.
  'fixtures', '__fixtures__', '__mocks__', '__snapshots__',
])

/** Caps, so a monorepo cannot turn one probe into a full-disk read. */
const MAX_DEPTH = 6
const MAX_CSS_FILES = 40
const MAX_FILE_BYTES = 512 * 1024
/** Per category. A palette of 300 shades is not a summary of anything. */
const MAX_TOKENS = 48

// ---------------------------------------------------------------- file access

/** Read a file, or null. Every caller treats null as "this stack told us nothing". */
function slurp(path) {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Shallow-first walk for files matching a predicate. Shallow-first matters: a theme file
 * at the repo root is far more likely to be *the* theme than the fourth one down some
 * package's src tree, and the cap has to spend itself on the likely ones.
 */
function findFiles(dir, matches, limit) {
  const hits = []
  let level = [dir]
  for (let depth = 0; depth <= MAX_DEPTH && level.length && hits.length < limit; depth++) {
    const next = []
    for (const current of level) {
      let entries = []
      try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.storybook') {
          if (SKIP_DIRS.has(entry.name)) continue
        }
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) next.push(path)
        } else if (entry.isFile() && matches(entry.name) && hits.length < limit) {
          hits.push(path)
        }
      }
    }
    level = next
  }
  return hits
}

function readJson(path) {
  const text = slurp(path)
  if (text == null) return null
  try { return JSON.parse(text) } catch { return null }
}

// ---------------------------------------------------------------- css custom properties

/**
 * Custom properties from the blocks that define a theme, wherever they are declared:
 * `:root`, `html`, `:host`, Tailwind v4's `@theme`, and the dark-mode twin that so many
 * systems put the real palette in.
 *
 * Deliberately not a CSS parser. It finds a selector, takes the balanced block after it,
 * and reads `--name: value` pairs out of it — which is all a token declaration ever is,
 * and which cannot be broken by a syntax it has never seen elsewhere in the file.
 */
const THEME_BLOCK = /(^|[}\s;])(@theme[^{]*|:root[^{]*|html[^{]*|:host[^{]*|\[data-theme[^{]*|\.dark\b[^{]*)\{/gi

export function cssVars(text) {
  const out = new Map()
  if (!text) return out
  for (const match of text.matchAll(THEME_BLOCK)) {
    const open = match.index + match[0].length - 1
    const block = balanced(text, open)
    if (!block) continue
    for (const decl of block.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      const name = decl[1].trim()
      const value = decl[2].trim().replace(/\s+/g, ' ')
      // First declaration wins. A dark-mode block that restates the same names is a
      // second theme, not a correction, and the light one is what the page loads with.
      if (!out.has(name) && value) out.set(name, value)
    }
  }
  return out
}

/** The `{...}` starting at `open`, brace-matched. Null if it never closes. */
function balanced(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

// ---------------------------------------------------------------- loose object literals

/**
 * The value of `key:` in a config, as text, brace-matched. Used to pull `theme`,
 * `colors`, `spacing` and friends out of a config file without running it.
 */
function literalAfter(text, key) {
  const at = text.search(new RegExp(`(^|[^\\w$.])${key}\\s*:\\s*\\{`, 'm'))
  if (at === -1) return null
  return balanced(text, text.indexOf('{', at))
}

/**
 * Flatten a JS object literal to `prefix-leaf: value` pairs, textually.
 *
 * A design config is nested (`colors: { brand: { 500: '#...' } }`) and its leaves are the
 * tokens. Nothing here evaluates: a computed key, a spread, or a function call is skipped
 * rather than guessed at, because a wrong token name is worse than a missing one — it
 * sends Claude looking for something that does not exist.
 */
export function flattenLiteral(body, prefix = '', depth = 0, out = []) {
  if (!body || depth > 4) return out
  const entry = /(?:^|[,{])\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*|\d+))\s*:\s*/g
  let match
  while ((match = entry.exec(body))) {
    const key = match[2] ?? match[3]
    const rest = body.slice(entry.lastIndex)
    const name = prefix ? `${prefix}-${key}` : key

    if (rest.startsWith('{')) {
      const inner = balanced(body, entry.lastIndex)
      if (inner != null) {
        flattenLiteral(inner, key === 'DEFAULT' ? prefix : name, depth + 1, out)
        entry.lastIndex += inner.length + 2
      }
      continue
    }
    if (rest.startsWith('[')) {
      // Tailwind writes font sizes as [size, {lineHeight}]. The size is the token.
      const close = rest.indexOf(']')
      const first = close === -1 ? '' : rest.slice(1, close).split(',')[0].trim()
      const literal = first.match(/^(['"])(.*)\1$/)
      if (literal) out.push({ name: key === 'DEFAULT' ? prefix : name, value: literal[2] })
      entry.lastIndex += close === -1 ? 1 : close + 1
      continue
    }
    const value = rest.match(/^(['"])((?:\\.|[^\\])*?)\1/)
    if (value) {
      out.push({ name: key === 'DEFAULT' ? prefix : name, value: value[2] })
      entry.lastIndex += value[0].length
      continue
    }
    const number = rest.match(/^-?\d+(\.\d+)?/)
    if (number) {
      out.push({ name: key === 'DEFAULT' ? prefix : name, value: number[0] })
      entry.lastIndex += number[0].length
    }
  }
  return out
}

// ---------------------------------------------------------------- classification

const COLOUR_VALUE = /^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklch|oklab|color)a?\(|\d{1,3}(\.\d+)?\s+\d{1,3}(\.\d+)?%\s+\d{1,3}(\.\d+)?%)/i
const LENGTH_VALUE = /^-?\d*\.?\d+(px|rem|em|%|vh|vw|ch|pt)$/i
const NAMED_COLOURS = /^(transparent|currentcolor|inherit|white|black)$/i

/**
 * Which drawer a token belongs in. Name first, value second: `--font-sans: ui-sans-serif`
 * is type however its value reads, and `--brand: #7c5cff` is colour however its name does.
 * Radius is checked before spacing because `--radius-lg` is a length too.
 */
export function categorise(name, value) {
  // `colorPrimary` and `--color-primary` are the same token wearing two conventions.
  const n = String(name).replace(/^--/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  if (/(^|-)(font|text|leading|tracking|type|weight)(-|$)/.test(n)) {
    // `--text-muted-foreground` is a colour wearing a type prefix. The value settles it.
    if (COLOUR_VALUE.test(value) || NAMED_COLOURS.test(value)) return 'color'
    return 'type'
  }
  if (/(^|-)(radius|rounded)(-|$)/.test(n)) return 'radius'
  if (/(^|-)(color|colour|bg|fg|background|foreground|border|ring|shadow|accent|primary|secondary|muted|destructive|success|warning|danger|info|card|popover|input|surface|brand)(-|$)/.test(n)) {
    return 'color'
  }
  if (/(^|-)(spacing|space|gap|size|inset|width|height|px|py|pt|pb|pl|pr)(-|$)/.test(n)) return 'spacing'
  if (COLOUR_VALUE.test(value) || NAMED_COLOURS.test(value)) return 'color'
  if (LENGTH_VALUE.test(value)) return 'spacing'
  return null
}

/** px for anything that can be stated in px, else null. rem is assumed to be 16px. */
export function toPx(value) {
  const m = String(value).trim().match(/^(-?\d*\.?\d+)(px|rem|em)?$/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = (m[2] || 'px').toLowerCase()
  if (unit === 'px') return n
  return n * 16
}

/**
 * The step a spacing scale is built on, as the largest value that divides all of them.
 *
 * This is what makes "off-scale" a fact rather than an opinion: on a 4px scale, a 13px
 * padding is not a taste question, it is a value nobody chose deliberately.
 */
export function spacingStep(values) {
  const px = values.map(toPx).filter(v => v != null && v > 0 && Number.isInteger(v))
  if (px.length < 3) return null
  const step = px.reduce((a, b) => gcd(a, b))
  return step > 1 ? step : null
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a)

// ---------------------------------------------------------------- colour normalising

/** Hex for any form the probe can be sure of, so two spellings of one colour compare equal. */
export function normaliseColour(value) {
  const v = String(value).trim().toLowerCase()
  const hex = v.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) return `#${[...h].slice(0, 3).map(c => c + c).join('')}`
    return `#${h.slice(0, 6)}`
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/)
  if (rgb) return `#${rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('')}`
  // shadcn stores `222.2 47.4% 11.2%` — an hsl() body with no hsl() around it.
  const hsl = v.match(/^(?:hsla?\(\s*)?(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/)
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]))
  return null
}

function hslToHex(h, s, l) {
  s /= 100
  l /= 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// ---------------------------------------------------------------- stack detection

/**
 * Every stack in one table, so adding the next one is a row rather than a branch.
 *
 * `dep` is the package that proves it is in play; `files` are the config files worth
 * reading; `keys` are the literal keys inside those files that hold tokens. A stack with
 * no readable config still earns its row — naming the library is most of the value, and
 * the runtime probe picks up its CSS variables regardless.
 */
const STACKS = [
  {
    id: 'tailwind4',
    name: 'Tailwind CSS v4',
    // v4 moved the theme into CSS. The dep alone cannot tell v3 from v4; an @theme block can.
    detect: ({ cssText }) => /@theme\b/.test(cssText),
    detail: 'a CSS `@theme` block',
  },
  {
    id: 'tailwind3',
    name: 'Tailwind CSS v3',
    dep: 'tailwindcss',
    // The dependency is the same package in both majors. An @theme block is v4's tell,
    // and finding one means this row is the wrong one.
    unless: ({ cssText }) => /@theme\b/.test(cssText),
    files: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'],
    keys: { color: ['colors'], spacing: ['spacing'], type: ['fontSize'], radius: ['borderRadius'] },
  },
  {
    id: 'shadcn',
    name: 'shadcn/ui',
    files: ['components.json'],
    // Its tokens are CSS variables, which the :root sweep already collected.
    detail: 'components.json',
  },
  { id: 'daisyui', name: 'daisyUI', dep: 'daisyui' },
  {
    id: 'mui',
    name: 'MUI',
    dep: '@mui/material',
    literal: 'createTheme',
    keys: { color: ['palette'], type: ['typography'], spacing: ['spacing'], radius: ['shape'] },
  },
  {
    id: 'chakra',
    name: 'Chakra UI',
    dep: '@chakra-ui/react',
    literal: 'extendTheme',
    keys: { color: ['colors'], spacing: ['space', 'sizes'], type: ['fontSizes'], radius: ['radii'] },
  },
  { id: 'mantine', name: 'Mantine', dep: '@mantine/core', detail: '`--mantine-*` variables, read at runtime' },
  {
    id: 'antd',
    name: 'Ant Design',
    dep: 'antd',
    literal: 'ConfigProvider',
    // One flat bag of camelCase names — colorPrimary next to borderRadius next to
    // fontSize — so the key cannot say which drawer a leaf belongs in. `auto` means
    // sort each one by its own name.
    keys: { auto: ['token'] },
  },
  { id: 'bootstrap', name: 'Bootstrap', dep: 'bootstrap', detail: '`--bs-*` variables, read at runtime' },
]

/** Files a theme literal is plausibly written in, for the stacks whose config is code. */
const THEME_FILE = /(theme|tokens|palette|design[-.]?system|mui|chakra|antd|config)\.(js|jsx|ts|tsx|mjs|cjs)$/i

// ---------------------------------------------------------------- the probe

/**
 * Everything the static side can learn about `dir`, as one compact summary.
 *
 * Shape is deliberately flat and small: it rides on every batch, and a summary that
 * costs more context than the comment it decorates is not a summary.
 */
export function probeProject(dir) {
  const pkg = readJson(join(dir, 'package.json')) ?? {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }

  const cssFiles = findFiles(dir, name => extname(name) === '.css', MAX_CSS_FILES)
  const vars = new Map()
  const varSources = new Map()
  let cssText = ''
  for (const file of cssFiles) {
    const text = slurp(file)
    if (!text) continue
    cssText += text
    for (const [name, value] of cssVars(text)) {
      if (vars.has(name)) continue
      vars.set(name, value)
      varSources.set(name, relative(dir, file))
    }
  }

  const libraries = []
  const tokens = { color: [], spacing: [], type: [], radius: [] }
  const sources = new Set()

  for (const stack of STACKS) {
    const byDep = stack.dep ? Boolean(deps[stack.dep]) : false
    const byFile = stack.files?.find(f => existsSync(join(dir, f)))
    const byProbe = stack.detect ? stack.detect({ cssText, deps }) : false
    if (!byDep && !byFile && !byProbe) continue
    if (stack.unless?.({ cssText, deps })) continue

    let detail = stack.detail ?? (byFile ? byFile : byDep ? `\`${stack.dep}\` in package.json` : null)

    // Config that is code: read it as text, take the literal, and take nothing on faith.
    if (stack.keys) {
      const configs = byFile && stack.files
        ? [join(dir, byFile)]
        : stack.literal
          ? findFiles(dir, name => THEME_FILE.test(name), 12)
          : []
      for (const path of configs) {
        const text = slurp(path)
        if (!text) continue
        if (stack.literal && !text.includes(stack.literal)) continue
        let found = false
        for (const [category, keys] of Object.entries(stack.keys)) {
          for (const key of keys) {
            const body = literalAfter(text, key)
            if (!body) continue
            found = true
            for (const t of flattenLiteral(body)) {
              const value = String(t.value).trim()
              if (!value || value.length > 60) continue
              const drawer = category === 'auto' ? categorise(t.name, value) : category
              // A config holds settings as well as tokens: `palette.mode: 'light'` sits
              // right beside the colours. Anything that cannot be the kind of value its
              // drawer holds is a setting, and is dropped rather than listed as a token.
              if (!drawer || !plausible(drawer, value)) continue
              tokens[drawer].push({ name: t.name, value })
            }
          }
        }
        if (found) {
          sources.add(relative(dir, path))
          detail = relative(dir, path)
        }
      }
    }

    libraries.push({ name: stack.name, detail })
  }

  // CSS variables land last so a config's own names win a collision: `colors.brand.500`
  // tells you which file to edit, `--brand-500` only tells you it exists.
  for (const [name, value] of vars) {
    const category = categorise(name, value)
    if (!category) continue
    tokens[category].push({ name, value, from: varSources.get(name) })
    sources.add(varSources.get(name))
  }

  for (const key of Object.keys(tokens)) tokens[key] = dedupe(tokens[key]).slice(0, MAX_TOKENS)

  const step = spacingStep(tokens.spacing.map(t => t.value))
  const detected = libraries.length > 0 || tokens.color.length > 0 || tokens.spacing.length > 0

  return {
    detected,
    libraries,
    tokens,
    spacingStep: step,
    sources: [...sources].filter(Boolean).slice(0, 8),
  }
}

/** Whether a value could be the kind of thing its drawer holds. */
function plausible(drawer, value) {
  if (drawer === 'type') return true
  if (value.startsWith('var(') || value.startsWith('calc(')) return true
  if (drawer === 'color') return COLOUR_VALUE.test(value) || NAMED_COLOURS.test(value)
  return LENGTH_VALUE.test(value) || /^-?\d*\.?\d+$/.test(value)
}

function dedupe(list) {
  const seen = new Set()
  return list.filter(t => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

// ---------------------------------------------------------------- mapping values back

/**
 * Lookup tables from a summary: colours by normalised hex, lengths by px.
 *
 * Built once per session alongside the probe. The point of all of the above is this
 * function's output — turning `padding: 24px` back into the name someone typed.
 */
export function tokenIndex(summary) {
  const colour = new Map()
  const length = new Map()
  const ladder = []

  for (const t of summary.tokens.color) {
    const hex = normaliseColour(t.value)
    if (hex && !colour.has(hex)) colour.set(hex, t.name)
  }
  for (const group of ['spacing', 'radius', 'type']) {
    for (const t of summary.tokens[group]) {
      const px = toPx(t.value)
      if (px == null) continue
      if (!length.has(px)) length.set(px, t.name)
      if (group === 'spacing') ladder.push({ name: t.name, px })
    }
  }
  ladder.sort((a, b) => a.px - b.px)
  return { colour, length, ladder, step: summary.spacingStep }
}

/** Properties whose value is a colour, and properties whose value is a length. */
const COLOUR_PROPS = new Set(['color', 'background-color', 'border-color', 'outline-color'])
/** Lengths the spacing scale actually governs — these can be off it. */
const SPACING_PROPS = new Set(['padding', 'margin', 'gap', 'row-gap', 'column-gap', 'inset'])
/**
 * Lengths that are named tokens but obey no shared step. A 13px type size is not "off the
 * 4px scale" — type scales are ratios, not grids, and radii are chosen per component.
 * These are matched against the tokens and otherwise left in peace.
 */
const OTHER_LENGTH_PROPS = new Set(['border-radius', 'border-width', 'font-size', 'letter-spacing', 'line-height'])

/** The two scale values either side of `px`, for saying what should have been used. */
function neighbours(px, ladder) {
  const below = [...ladder].reverse().find(t => t.px <= px)
  const above = ladder.find(t => t.px >= px)
  return [below, above].filter((t, i, all) => t && all.indexOf(t) === i)
}

/**
 * What to say about one declaration, or null when there is nothing worth saying.
 *
 * Silence is the common case and has to stay cheap: most declarations are neither a
 * token nor a violation, and a note on every line would bury the two that matter.
 */
export function annotate(prop, value, index) {
  if (!index) return null

  if (COLOUR_PROPS.has(prop)) {
    if (!index.colour.size) return null
    const hex = normaliseColour(value)
    if (!hex) return null
    const hit = index.colour.get(hex)
    if (hit) return hit
    // `transparent` and `currentcolor` are not off-palette, they are absences.
    if (NAMED_COLOURS.test(value.trim())) return null
    return '⚠ not in the palette'
  }

  const onGrid = SPACING_PROPS.has(prop)
  if (!onGrid && !OTHER_LENGTH_PROPS.has(prop)) return null
  const parts = [...new Set(String(value).trim().split(/\s+/))]
  const notes = []
  for (const part of parts) {
    const px = toPx(part)
    if (px == null || px === 0) continue
    const hit = index.length.get(px)
    if (hit) {
      notes.push(`${part} = ${hit}`)
      continue
    }
    if (!onGrid || !index.step || px % index.step === 0) continue
    const near = neighbours(px, index.ladder)
    const suggestion = near.length ? ` — nearest ${near.map(t => `${t.name} (${t.px}px)`).join(', ')}` : ''
    notes.push(`⚠ ${part} is off the ${index.step}px scale${suggestion}`)
  }
  return notes.length ? notes.join('; ') : null
}

// ---------------------------------------------------------------- rendering

/** The one-line summary that rides on every batch, or null when there is nothing to say. */
export function summaryLine(summary) {
  if (!summary?.detected) return null
  const bits = []
  if (summary.libraries.length) {
    bits.push(summary.libraries.map(l => (l.detail ? `${l.name} (${l.detail})` : l.name)).join(' + '))
  } else {
    bits.push('no component library detected — CSS custom properties only')
  }
  if (summary.spacingStep) bits.push(`spacing on a ${summary.spacingStep}px scale`)
  const counts = Object.entries(summary.tokens)
    .filter(([, list]) => list.length)
    .map(([name, list]) => `${list.length} ${name}`)
  if (counts.length) bits.push(`${counts.join(', ')} tokens`)
  if (summary.sources.length) bits.push(`from ${summary.sources.slice(0, 3).join(', ')}`)
  return bits.join(' · ')
}

/**
 * The guardrail. Said once per batch, next to the summary, because it only makes sense
 * with the scale in front of it — and because a fix written in raw px is how a design
 * system rots one commit at a time.
 */
export function guardrailLine(summary) {
  if (!summary?.detected) return null
  const preferred = summary.libraries.some(l => /Tailwind|daisyUI/.test(l.name))
    ? 'utility classes'
    : 'the tokens above'
  return `**stay on the scale** — fix with ${preferred} rather than raw px or hex, and treat a value flagged off-scale as the bug rather than something to preserve.`
}

// ---------------------------------------------------------------- the runtime half

/**
 * Libraries the extension can name from the DOM alone, by the marks they leave on
 * elements. The extension does the matching (it has the nodes) and sends back ids; the
 * names live here so there is one table to correct when a library renames its marks.
 *
 * This is the path that catches a stack the static probe cannot see: a dependency
 * installed in a workspace package, a CDN build with no package.json, or a component
 * library vendored into the repo.
 */
const FINGERPRINT_NAMES = {
  shadcn: 'shadcn/ui',
  radix: 'Radix UI',
  mui: 'MUI',
  antd: 'Ant Design',
  mantine: 'Mantine',
  chakra: 'Chakra UI',
  bootstrap: 'Bootstrap',
  daisyui: 'daisyUI',
}

/**
 * The static summary plus what the page itself reported: every custom property actually
 * resolved on `:root`, and the library fingerprints found in the DOM.
 *
 * Runtime values are authoritative about what the page *is* but say nothing about where
 * it is written, so a static token of the same name keeps its place — its name points at
 * a file someone can edit.
 */
export function withRuntime(summary, runtime) {
  if (!runtime) return summary
  const merged = {
    ...summary,
    libraries: [...summary.libraries],
    tokens: { ...summary.tokens },
  }

  for (const id of runtime.fingerprints ?? []) {
    const name = FINGERPRINT_NAMES[id]
    if (name && !merged.libraries.some(l => l.name === name)) {
      merged.libraries.push({ name, detail: 'seen in the page' })
    }
  }

  const vars = Object.entries(runtime.vars ?? {})
  if (vars.length) {
    const known = new Set(Object.values(summary.tokens).flat().map(t => t.name))
    for (const key of Object.keys(merged.tokens)) merged.tokens[key] = [...merged.tokens[key]]
    for (const [name, value] of vars) {
      if (known.has(name) || !value) continue
      const category = categorise(name, value)
      if (!category) continue
      if (merged.tokens[category].length >= MAX_TOKENS) continue
      merged.tokens[category].push({ name, value, from: 'the page' })
    }
    merged.spacingStep = summary.spacingStep ?? spacingStep(merged.tokens.spacing.map(t => t.value))
  }

  merged.detected = merged.libraries.length > 0 || merged.tokens.color.length > 0 || merged.tokens.spacing.length > 0
  return merged
}

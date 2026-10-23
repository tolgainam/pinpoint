#!/usr/bin/env node
/**
 * A few repo rules that a linter would not know. Each checker is pure: it takes text and
 * returns a list of problems, so a test can hand it a fixture. Run directly it checks the
 * real repository.
 *
 *   npm run check:rules
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @typedef {{ rule: string, file: string, line?: number, message: string }} Problem */

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * @param {Record<string, string>} files  label to file text. Labels: server, package,
 *   plugin, marketplace, manifest.
 * @returns {Problem[]}
 */
export function checkVersions(files) {
  const rule = 'versions'
  /** @type {Problem[]} */
  const out = []
  const m = files.server.match(/PINPOINT_VERSION \?\? '([^']*)'/)
  if (!m) return [{ rule, file: 'server/pinpoint.js', message: "no `PINPOINT_VERSION ?? '...'` found" }]
  const serverLine = lineOf(files.server, m.index ?? 0)
  const want = JSON.parse(files.package).version
  if (m[1] !== want) {
    out.push({ rule, file: 'server/pinpoint.js', line: serverLine, message: `version ${m[1]} does not match package.json ${want}` })
  }
  const market = JSON.parse(files.marketplace)
  const versions = {
    '.claude-plugin/plugin.json': JSON.parse(files.plugin).version,
    '.claude-plugin/marketplace.json': market.plugins?.[0]?.version ?? market.version,
    'extension/manifest.json': JSON.parse(files.manifest).version,
  }
  for (const [file, v] of Object.entries(versions)) {
    if (v !== want) out.push({ rule, file, message: `version ${v} does not match package.json ${want}` })
  }
  return out
}

/** stdout is the MCP transport; one stray write corrupts the protocol. */
export function checkNoStdout(file, text) {
  const rule = 'no-stdout'
  /** @type {Problem[]} */
  const out = []
  for (const re of [/console\.log\(/g, /process\.stdout\.write\(/g]) {
    for (const hit of text.matchAll(re)) {
      out.push({ rule, file, line: lineOf(text, hit.index ?? 0), message: `${hit[0]} writes to stdout, which carries the MCP transport; use console.error` })
    }
  }
  return out
}

/** Index just past the paren that closes the one opened at `open`, or -1. Strings and comments are not parsed: good enough for a call's argument list. */
function closeParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

/** Screenshots must go through the non-blocking, atomic writer, not a sync write of decoded base64. */
export function checkNoSyncBase64Write(file, text) {
  const rule = 'no-sync-base64-write'
  /** @type {Problem[]} */
  const out = []
  for (const hit of text.matchAll(/writeFileSync\(/g)) {
    const open = (hit.index ?? 0) + hit[0].length - 1
    const end = closeParen(text, open)
    const args = text.slice(open, end === -1 ? undefined : end)
    if (/Buffer\.from\([^)]*['"]base64['"]/.test(args)) {
      out.push({ rule, file, line: lineOf(text, hit.index ?? 0), message: 'writeFileSync of Buffer.from(..., "base64") blocks the bridge; use the async writer' })
    }
  }
  return out
}

/** An async handler that rejects with nobody listening takes the bridge down. */
export function checkHandlersCaught(file, text) {
  const rule = 'handlers-caught'
  /** @type {Problem[]} */
  const out = []
  const asyncHandlers = new Set([...text.matchAll(/async function (handle[A-Z]\w*)\(/g)].map(m => m[1]))
  for (const hit of text.matchAll(/(?<!function )\b(handle[A-Z]\w*)\(/g)) {
    if (!asyncHandlers.has(hit[1])) continue
    const open = (hit.index ?? 0) + hit[0].length - 1
    const end = closeParen(text, open)
    if (end === -1 || !/^\s*\.catch\(/.test(text.slice(end))) {
      out.push({ rule, file, line: lineOf(text, hit.index ?? 0), message: `${hit[1]}(...) is async and its call has no .catch(...)` })
    }
  }
  return out
}

/** The quoted names inside each `[...]` that follows `anchor`, one list per match. */
function listsAfter(text, anchor) {
  return [...text.matchAll(anchor)].map(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]))
}

/**
 * The content scripts are named in three places: the manifest, the on-demand injection
 * and the per-site registration. One drifting out of step means a page that works after a
 * reload and not before, or the other way round.
 * @returns {Problem[]}
 */
export function checkScriptLists(manifestText, workerText) {
  const rule = 'content-script-lists'
  const file = 'extension/worker.js'
  const manifest = JSON.parse(manifestText).content_scripts.map(c => c.js)
  const injected = listsAfter(workerText, /files:\s*\[([^\]]*)\]/g)
  const kept = listsAfter(workerText, /\bjs:\s*\[([^\]]*)\]/g)
  /** @type {Problem[]} */
  const out = []
  if (!injected.length || !kept.length) {
    return [{ rule, file, message: 'could not find the files: [...] or js: [...] lists in worker.js' }]
  }
  const show = l => l.map(x => x.join('+')).join(', ')
  if (show(injected) !== show(manifest)) out.push({ rule, file, message: `ensureInjected() files [${show(injected)}] differ from manifest content_scripts [${show(manifest)}]` })
  if (show(kept) !== show(manifest)) out.push({ rule, file, message: `keepOnSite() js [${show(kept)}] differ from manifest content_scripts [${show(manifest)}]` })
  return out
}

const read = p => readFileSync(join(ROOT, p), 'utf8')

/** @returns {Problem[]} */
export function checkRepo() {
  const serverText = read('server/pinpoint.js')
  const problems = [
    ...checkVersions({
      server: serverText,
      package: read('package.json'),
      plugin: read('.claude-plugin/plugin.json'),
      marketplace: read('.claude-plugin/marketplace.json'),
      manifest: read('extension/manifest.json'),
    }),
    ...checkScriptLists(read('extension/manifest.json'), read('extension/worker.js')),
    ...checkHandlersCaught('server/pinpoint.js', serverText),
  ]
  for (const f of readdirSync(join(ROOT, 'server')).filter(f => f.endsWith('.js'))) {
    const text = read(`server/${f}`)
    problems.push(...checkNoStdout(`server/${f}`, text), ...checkNoSyncBase64Write(`server/${f}`, text))
  }
  return problems
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  const problems = checkRepo()
  for (const p of problems) console.error(`[${p.rule}] ${p.file}${p.line ? `:${p.line}` : ''} ${p.message}`)
  if (problems.length) process.exit(1)
  console.log('repo rules ok')
}

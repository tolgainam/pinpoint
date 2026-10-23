#!/usr/bin/env node
/**
 * One command for the cheap gates: syntax, design tokens, repo rules, types on an
 * explicit list of modules. Stops at the first failure and prints its output.
 *
 *   npm run check
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every .js file under dir, skipping vendored and minified code. */
function jsFiles(dir) {
  const out = []
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'vendor' && e.name !== 'node_modules') out.push(...jsFiles(rel))
    } else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js')) out.push(rel)
  }
  return out
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

const files = ['server', 'scripts', 'extension'].flatMap(jsFiles)
/** @type {[string, () => { ok: boolean, output: string }][]} */
const steps = [
  ['syntax', () => {
    for (const f of files) {
      const r = run(process.execPath, ['--check', f])
      if (!r.ok) return r
    }
    return { ok: true, output: '' }
  }],
  ['design tokens', () => run(process.execPath, ['scripts/check-design.js'])],
  ['repo rules', () => run(process.execPath, ['scripts/check-rules.js'])],
  ['types', () => run(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.check.json'])],
]

for (const [name, fn] of steps) {
  const r = fn()
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!r.ok) {
    console.log(r.output.trimEnd())
    process.exit(1)
  }
}

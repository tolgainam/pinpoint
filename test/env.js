// A small, explicit environment for the processes the tests start (the bridge, the demo
// server), so a test never depends on, or leaks, the developer's own variables.
// `extra` is the place for anything a test truly needs, such as its own temp HOME.
import { tmpdir } from 'node:os'

const KEEP = ['PATH', 'HOME', 'TMPDIR', 'LANG']

export function testEnv(extra = {}) {
  const env = {}
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]
  env.TMPDIR ??= tmpdir()
  return { ...env, ...extra }
}

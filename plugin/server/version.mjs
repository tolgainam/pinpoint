/**
 * Version arithmetic shared by the bridge (should it hand the port to this one?) and the
 * doctor (is that bridge, or that extension copy, stale?). Plain dotted numbers only:
 * Pinpoint has no prerelease tags, and anything that does not parse reads as 0.0.0. A
 * bridge that cannot say its version is therefore treated as old, which is the safe answer
 * for both callers.
 */
export function parseVersion(v) {
  const m = String(v ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0]
}

/** Negative when a is older than b, positive when newer, 0 when the same. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * Path spelling, shared by the bridge and the scripts. The same folder arrives written
 * several ways (the env, a query string, lsof, the toolbar): /var or /private/var, through
 * a linked ~/Projects, with a trailing slash. Each keeps its own spelling for display;
 * comparisons only ever use canon().
 */
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** The physical path, or the path as given when it does not exist (yet). */
export function real(p) {
  try { return realpathSync(p) } catch { return p }
}

/** The one spelling every comparison uses. */
export function canon(p) {
  return real(resolve(String(p)))
}

/** child is parent or somewhere below it. Both already in the same spelling. */
export function inside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * The root or home: everything is below them, so a folder there is a project nowhere in
 * particular. Routing never sends comments there and nothing writes a backlog there.
 */
export function nowhere(dir) {
  const r = canon(dir)
  return r === sep || r === real(homedir())
}

/** Home written as ~, for anything shown to the user. */
export function tilde(p) {
  const h = homedir()
  return p === h || p.startsWith(h + sep) ? '~' + p.slice(h.length) : p
}

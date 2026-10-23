#!/usr/bin/env node
/**
 * /pinpoint:doctor. A short pass/fail list, each failure with the one thing that fixes it.
 *
 * Every problem we have hit so far was visible from /health plus a process list: a bridge
 * left over from before an update, a second "pinpoint" server from a project .mcp.json, a
 * session that never joined, an extension copy that went stale. The user just had to know
 * where to look. This looks for them.
 *
 * The checks are split into gathering (ports, processes, files) and judging (pure
 * functions over what was gathered), so the judging can be tested without a bridge, a
 * Chrome or a Claude Code session around. setup.js imports this and runs the same list.
 * Nothing here ever changes anything: it reads, and it prints commands for the user.
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareVersions } from '../server/version.js'
import { canon, tilde } from '../server/paths.js'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PORT = Number(process.env.PINPOINT_PORT ?? 8788)
/**
 * Where setup.js keeps the copy Chrome loads. Outside the plugin cache on purpose. The
 * env override is for trying setup without touching the real copy.
 */
export const STABLE_DIR = process.env.PINPOINT_EXTENSION_DIR ?? join(homedir(), '.claude', 'pinpoint', 'extension')
/** The name this server has in /mcp when it comes from the plugin. */
export const MCP_NAME = 'plugin:pinpoint:pinpoint'
/** The first version whose bridge answers /peer/yield. Older ones have to be stopped. */
export const YIELD_SINCE = '0.3.0'

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/** The version of the code running this script: the plugin manifest, else package.json. */
export function pluginVersion(root = ROOT) {
  return readJson(join(root, '.claude-plugin', 'plugin.json'))?.version
    ?? readJson(join(root, 'package.json'))?.version ?? '0.0.0'
}

/** Installed from the marketplace, rather than run from a clone. Decides which names to print. */
export const fromPlugin = (root = ROOT) => root.includes(`${sep}plugins${sep}cache${sep}`)

// ---------------------------------------------------------------- judging

/** @typedef {{name: string, ok: boolean | null, detail: string, fix?: string}} Result */

export function checkNode(version = process.versions.node) {
  const ok = compareVersions(version, '20.0.0') >= 0
  return ok
    ? { name: 'Node', ok, detail: version }
    : { name: 'Node', ok, detail: `${version} is too old, Pinpoint needs 20 or newer`, fix: 'Install Node 20 or newer (nodejs.org), then restart Claude Code.' }
}

/**
 * The bridge: one Claude Code session's Pinpoint server holds the port and the rest join
 * it. The common failure is an old one. Sessions keep their server in memory, so after an
 * update the bridge is whichever session was open before it. From 0.3.0 a newer server
 * asks the old one to hand over on its own; older bridges cannot be asked and have to be
 * stopped, which only the user may do, so this prints the exact command.
 */
export function checkBridge({ health, owner, version, port = PORT }) {
  const name = 'Bridge'
  const where = `127.0.0.1:${port}`
  const reconnect = `Run /mcp, pick ${MCP_NAME}, choose Reconnect.`
  if (!health && !owner) {
    return {
      name, ok: false, detail: `nothing is answering on ${where}`,
      fix: `No Claude Code session is running Pinpoint's server. ${reconnect} If that fails, restart Claude Code.`,
    }
  }
  const pid = owner?.pid ? ` (pid ${owner.pid})` : ''
  if (!health) {
    return {
      name, ok: false, detail: `port ${port} is held by something that is not Pinpoint${pid}${owner?.command ? `: ${owner.command}` : ''}`,
      fix: `Stop that program${pid}. Pinpoint needs port ${port}.`,
    }
  }
  const theirs = String(health.version ?? '0.0.0')
  const cmp = compareVersions(theirs, version)
  if (cmp === 0) return { name, ok: true, detail: `${theirs} on ${where}${pid}` }
  if (cmp > 0) {
    return {
      name, ok: false, detail: `${theirs} on ${where}${pid} is newer than this session's plugin (${version})`,
      fix: 'This session runs an old copy of the plugin. Update Pinpoint in /plugin, then restart this session.',
    }
  }
  const detail = `${theirs} on ${where}${pid} is older than this plugin (${version})`
  if (compareVersions(theirs, YIELD_SINCE) >= 0) {
    return { name, ok: false, detail, fix: `${reconnect} The new server asks the old bridge to hand over.` }
  }
  return { name, ok: false, detail, fix: `${stopCommand(owner)}. Then run /mcp, pick ${MCP_NAME}, choose Reconnect. Other sessions still on ${theirs} need /mcp Reconnect too, or a restart.` }
}

/**
 * The command that stops an old bridge. A pattern on its script path rather than its pid,
 * because every session still on that version runs the same file and any of them would
 * pick the port straight back up. The path includes the version folder, so it matches
 * that version only. A relative path (a clone run as `node ./server/pinpoint.js`) matches
 * too much, so that one gets its pid.
 */
export function stopCommand(owner) {
  const script = owner?.command?.split(/\s+/).find(a => /server[/\\]pinpoint\.js$/.test(a))
  if (script && script.startsWith('/')) return `Stop the old version: pkill -f "${script}"`
  if (owner?.pid) return `Stop the old bridge: kill ${owner.pid}`
  return 'Stop the old bridge: quit the Claude Code sessions that were open before the update'
}

/**
 * Is this session on the bridge's list? Matched by folder, exactly: the list holds each
 * session's start folder, and a session in a parent folder is a different session, not
 * this one. projectDir is this session's start folder (see sessionDir), not wherever the
 * shell has wandered since.
 */
export function checkSessions({ health, projectDir }) {
  const name = 'Sessions'
  if (!health) return { name, ok: null, detail: 'no bridge, so no sessions to list' }
  if (!Array.isArray(health.sessions)) return { name, ok: null, detail: 'this bridge is too old to list sessions' }
  const here = canon(projectDir)
  const names = health.sessions.map(s => s.name).join(', ') || 'none'
  const mine = health.sessions.some(s => canon(String(s.projectDir ?? '')) === here)
  const count = `${health.sessions.length} joined (${names})`
  if (mine) return { name, ok: true, detail: `${count}, this one included` }
  return {
    name, ok: false, detail: `${count}, but not this one (${tilde(projectDir)})`,
    fix: `Run /mcp, pick ${MCP_NAME}, choose Reconnect. If it is not listed, restart Claude Code in this folder.`,
  }
}

/**
 * A second server called "pinpoint", besides the plugin's. The usual one is a clone of
 * a project whose .mcp.json defines it for development, but a user or local scope entry
 * left from a manual install counts too. Both start, both show in /mcp, and nobody can
 * tell which is live. A project entry the user turned off is no clash.
 */
export function findDuplicates({ projectDir, claudeJson = join(homedir(), '.claude.json') }) {
  const found = []
  const dir = resolve(projectDir)
  const mcp = readJson(join(dir, '.mcp.json'))
  if (mcp?.mcpServers?.pinpoint) {
    const cfg = readJson(claudeJson)
    const disabled = [
      cfg?.projects?.[dir]?.disabledMcpjsonServers,
      readJson(join(dir, '.claude', 'settings.local.json'))?.disabledMcpjsonServers,
      readJson(join(dir, '.claude', 'settings.json'))?.disabledMcpjsonServers,
    ].some(list => Array.isArray(list) && list.includes('pinpoint'))
    if (!disabled) found.push({ scope: 'project', file: join(dir, '.mcp.json') })
  }
  const cfg = readJson(claudeJson)
  if (cfg?.mcpServers?.pinpoint) found.push({ scope: 'user', file: claudeJson })
  if (cfg?.projects?.[dir]?.mcpServers?.pinpoint) found.push({ scope: 'local', file: claudeJson })
  return found
}

export function checkDuplicates(found) {
  const name = 'MCP entries'
  if (!found.length) return { name, ok: true, detail: 'only the plugin defines a "pinpoint" server' }
  const first = found[0]
  const fix = first.scope === 'project'
    ? `In ${tilde(first.file)}, rename the "pinpoint" server to "pinpoint-dev", or turn it off in /mcp.`
    : `Remove it: claude mcp remove pinpoint -s ${first.scope}`
  return {
    name, ok: false,
    detail: `another "pinpoint" server is defined (${found.map(f => `${f.scope}: ${tilde(f.file)}`).join('; ')})`,
    fix,
  }
}

/**
 * Whether comments arrive in this session on their own. That is decided by a flag on the
 * `claude` command that started the session, and nothing the session exposes says so, so
 * this reads the command lines of the processes above this one. It can see the flag; it
 * cannot see whether Claude Code then accepted the channel, so "on" means "asked for".
 * Never a failure: without channels everything still works through /pinpoint:comments.
 */
export function checkChannels({ ancestors, plugin = fromPlugin() }) {
  const name = 'Channels'
  const flag = plugin
    ? 'claude --dangerously-load-development-channels plugin:pinpoint@pinpoint-marketplace'
    : 'claude --dangerously-load-development-channels server:pinpoint'
  const how = `Comments wait until you run /pinpoint:comments. To get them on their own, start Claude Code with: ${flag}`
  const withFlag = ancestors.find(c => /--(dangerously-load-development-)?channels\b/.test(c))
  if (withFlag && /pinpoint/.test(withFlag)) return { name, ok: true, detail: 'on, comments arrive in this session on their own' }
  if (withFlag) return { name, ok: null, detail: `channels are on, but not for Pinpoint. ${how}` }
  if (ancestors.some(c => /(^|\/)claude(\s|$)|claude\/versions\//.test(c))) return { name, ok: null, detail: `off. ${how}` }
  return { name, ok: null, detail: `could not tell from here. ${how}` }
}

/** The version of a stable extension copy, or null when there is none. */
export function stableVersion(dir = STABLE_DIR) {
  if (!existsSync(join(dir, 'manifest.json'))) return null
  try {
    const v = readFileSync(join(dir, 'VERSION'), 'utf8').trim()
    if (v) return v
  } catch { /* copied by hand: fall back to the manifest */ }
  return readJson(join(dir, 'manifest.json'))?.version ?? '0.0.0'
}

export function checkExtension({ stable, version, dir = STABLE_DIR }) {
  const name = 'Extension'
  const where = tilde(dir)
  if (!stable) {
    return { name, ok: false, detail: `no copy at ${where} yet`, fix: 'Run /pinpoint:setup. It copies the extension there and shows how to load it in Chrome.' }
  }
  const cmp = compareVersions(stable, version)
  if (cmp < 0) {
    return {
      name, ok: false, detail: `the copy at ${where} is ${stable}, older than this plugin (${version})`,
      fix: 'Run /pinpoint:setup to refresh it, then press Reload on the Pinpoint card in chrome://extensions.',
    }
  }
  if (cmp > 0) return { name, ok: null, detail: `the copy at ${where} is ${stable}, newer than this plugin (${version})` }
  return { name, ok: true, detail: `${stable} at ${where} (load this folder in Chrome)` }
}

/**
 * What the bridge has heard from the extension in the browser, which is the only honest way to
 * know. The folder copy says what was put on disk; it says nothing about whether a browser has
 * loaded it, still has an old one, or had it removed. The extension names its own version on
 * every call, so this can tell the three cases apart.
 */
export function checkBrowserExtension({ health, copyVersion }) {
  const name = 'Browser extension'
  if (!health) {
    return { name, ok: null, detail: 'the bridge is not running, so Pinpoint cannot see your browser' }
  }
  // A bridge from before this check has no such field at all, which is not the same as null.
  // It would read as "not installed", which is exactly the wrong thing to tell someone.
  if (!('extension' in health)) {
    return {
      name, ok: null,
      detail: 'the running bridge is older than this plugin and cannot see your browser',
      fix: 'Reconnect it: run /mcp, pick the Pinpoint plugin, choose Reconnect. Then run this again.',
    }
  }
  const seen = health.extension
  if (!seen) {
    return {
      name, ok: null,
      detail: 'no extension has contacted the bridge since it started. It is not installed in your browser yet, or no page is open on localhost.',
      fix: 'Not installed: add it from your browser\'s store, or load the folder shown below. Already installed: open a localhost page and click the Pinpoint icon, then check again.',
    }
  }
  const ago = seen.secondsAgo ?? 0
  const when = ago < 90 ? 'connected now' : `last heard ${Math.max(1, Math.round(ago / 60))} min ago`
  const where = { firefox: 'Firefox', safari: 'Safari', opera: 'Opera', edge: 'Edge' }[seen.browser] ?? 'a Chrome-family browser'
  if (compareVersions(seen.version, copyVersion) < 0) {
    return {
      name, ok: false,
      detail: `your browser runs extension ${seen.version}, older than ${copyVersion} (${where}, ${when})`,
      fix: 'Press Reload on the Pinpoint card in your browser\'s extensions page, then reload your localhost pages.',
    }
  }
  return { name, ok: true, detail: `${seen.version} in ${where}, ${when}` }
}

// ---------------------------------------------------------------- gathering

export async function getHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    return res.headers.get('content-type')?.includes('json') ? await res.json() : null
  } catch {
    return null
  }
}

/** Never through a shell, and never fatal: a missing lsof or ps just means less detail. */
function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

function portOwner(port) {
  const pid = Number(run(process.env.PINPOINT_LSOF ?? 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')[0])
  if (!pid) return null
  return { pid, command: run('ps', ['-o', 'command=', '-p', String(pid)]) }
}

/** Command lines of this process's ancestors, nearest first. */
function ancestors() {
  const out = []
  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    const line = run('ps', ['-o', 'ppid=,command=', '-p', String(pid)])
    const m = line.match(/^\s*(\d+)\s+(.*)$/s)
    if (!m) break
    out.push(m[2])
    pid = Number(m[1])
  }
  return out
}

/**
 * The folder this Claude Code session started in, which is what its Pinpoint server is
 * listed under. CLAUDE_PROJECT_DIR when Claude Code passes it; otherwise the cwd of the
 * session's own process (CLAUDE_PID), since the shell running this may have cd'd away.
 */
function sessionDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR
  const pid = Number(process.env.CLAUDE_PID)
  if (pid > 0) {
    const line = run(process.env.PINPOINT_LSOF ?? 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(l => l.startsWith('n/'))
    if (line) return line.slice(1)
  }
  return process.cwd()
}

/** Gather everything and judge it, in the order a user would fix things. */
export async function runChecks({ projectDir = sessionDir(), port = PORT } = {}) {
  const version = pluginVersion()
  const [health, owner] = [await getHealth(port), portOwner(port)]
  return {
    version,
    results: [
      checkNode(),
      checkBridge({ health, owner, version, port }),
      checkSessions({ health, projectDir }),
      checkDuplicates(findDuplicates({ projectDir })),
      checkChannels({ ancestors: ancestors() }),
      checkExtension({ stable: stableVersion(), version }),
      checkBrowserExtension({ health, copyVersion: version }),
    ],
  }
}

export function format({ version, results }) {
  const mark = r => (r.ok === true ? 'ok  ' : r.ok === false ? 'FAIL' : 'info')
  const lines = [`  Pinpoint checks (plugin ${version})`, '']
  for (const r of results) {
    lines.push(`  ${mark(r)}  ${r.name}: ${r.detail}`)
    if (r.fix) lines.push(`        Fix: ${r.fix}`)
  }
  const failed = results.filter(r => r.ok === false).length
  lines.push('', failed ? `  ${failed} to fix. Start with the first FAIL.` : '  All good.')
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`\n${format(await runChecks())}\n`)
}

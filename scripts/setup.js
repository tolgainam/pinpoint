#!/usr/bin/env node
/**
 * Point the user at the unpacked extension.
 *
 * Once Pinpoint is installed as a plugin its files live in Claude Code's plugin cache,
 * under a path nobody would guess. Chrome cannot be handed an extension directory from
 * the command line — "Load unpacked" is a file picker — so the best we can do is put the
 * exact path on the clipboard and open the page where it gets pasted.
 */
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXT = join(ROOT, 'extension')

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`Could not find the extension at ${EXT}`)
  process.exit(1)
}

/** Best-effort clipboard. Every platform names its clipboard tool differently. */
function copy(text) {
  const tools = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]

  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { input: text })
    if (!r.error && r.status === 0) return cmd
  }
  return null
}

/** Detached, ignoring stdio: Chrome should not hold this process open. */
function openChrome(url) {
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', ['-a', 'Google Chrome', url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', 'chrome', url]]
      : ['google-chrome', [url]]

  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

const copiedWith = copy(EXT)
const opened = openChrome('chrome://extensions')

console.log(`
  Pinpoint extension
  ${EXT}
  ${copiedWith ? '(copied to your clipboard)' : '(copy the path above)'}

  In Chrome:
    1. ${opened ? 'chrome://extensions just opened' : 'go to chrome://extensions'}
    2. turn on Developer mode, top right
    3. Load unpacked  ->  paste the path  ->  select the folder

  Then open your dev app on localhost, click the Pinpoint icon, and start pinning.
  Clicking the icon is also what grants screenshot permission for that tab.
`)

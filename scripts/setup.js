#!/usr/bin/env node
/**
 * Put the extension where Chrome can keep it, walk the user through loading it, then run
 * the doctor's checks.
 *
 * Chrome runs an unpacked extension straight from the folder it was loaded from. The
 * plugin's own copy lives in Claude Code's plugin cache under a folder named after the
 * version, so every update moved it and the loaded extension broke without a word. Setup
 * copies it to one fixed folder instead, ~/.claude/pinpoint/extension, and refreshes it
 * on every run; after an update the user only has to press Reload.
 *
 * Chrome cannot be handed an extension directory from the command line ("Load unpacked"
 * is a file picker), so the best we can do is put the exact path on the clipboard and
 * open the page where it gets pasted.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, STABLE_DIR, pluginVersion, stableVersion, runChecks, format } from './doctor.js'

/**
 * Copy src to dest as a whole or not at all. Chrome may read the folder at any moment, so
 * it must never see half of one version and half of another. The new copy is built next
 * to the old one and swapped in by rename, which is atomic on one filesystem. A directory
 * cannot be renamed over a non-empty one, so the old copy is moved aside first; the window
 * between the two renames is a missing folder, never a mixed one.
 */
export function installStable(src, dest, version) {
  const tmp = `${dest}.tmp-${process.pid}`
  const old = `${dest}.old-${process.pid}`
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  cpSync(src, tmp, { recursive: true })
  writeFileSync(join(tmp, 'VERSION'), `${version}\n`)
  const had = existsSync(dest)
  if (had) renameSync(dest, old)
  try {
    renameSync(tmp, dest)
  } catch (err) {
    if (had) renameSync(old, dest)
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
  rmSync(old, { recursive: true, force: true })
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
    // A missing binary is reported as an event, not thrown, and an unheard error event
    // would end the whole setup over a convenience.
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return true
  } catch {
    return false
  }
}

async function main() {
  const src = join(ROOT, 'extension')
  if (!existsSync(join(src, 'manifest.json'))) {
    console.error(`Could not find the extension at ${src}`)
    process.exit(1)
  }

  const version = pluginVersion()
  const before = stableVersion(STABLE_DIR)
  try {
    installStable(src, STABLE_DIR, version)
  } catch (err) {
    console.error(`Could not copy the extension to ${STABLE_DIR}: ${err?.message ?? err}`)
    process.exit(1)
  }

  const copiedWith = copy(STABLE_DIR)
  const opened = openChrome('chrome://extensions')
  const status = !before
    ? `Copied version ${version} here.`
    : before === version
      ? `Refreshed version ${version}.`
      : `Updated from ${before} to ${version}. Press Reload on the Pinpoint card in chrome://extensions.`

  console.log(`
  Pinpoint extension
  ${STABLE_DIR}
  ${copiedWith ? '(copied to your clipboard)' : '(copy the path above)'}
  ${status}

  Chrome runs the extension straight from that folder: don't move or delete it.
  After a Pinpoint update, run /pinpoint:setup again, then press Reload on its card.

  In Chrome:
    1. ${opened ? 'chrome://extensions just opened' : 'go to chrome://extensions'}
    2. turn on Developer mode, top right
    3. Load unpacked  ->  paste the path  ->  select the folder
       Already loaded from another folder? Remove that card first.
    4. pin the icon: click the puzzle piece in Chrome's toolbar, then the pin next to Pinpoint

  Then open your dev app on localhost and click the Pinpoint icon.
  The toolbar starts hidden; the icon is what shows it. That click also lets
  Pinpoint take screenshots of that tab.

  You're done when the pill on the toolbar shows your project name.
`)

  console.log(`${format(await runChecks())}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()

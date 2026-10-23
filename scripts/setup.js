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
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, STABLE_DIR, pluginVersion, stableVersion, runChecks, format } from './doctor.js'
import { buildFirefox } from './firefox.js'

/** Firefox gets its own folder: its manifest is not the one Chrome loads. */
export const FIREFOX_DIR = process.env.PINPOINT_FIREFOX_DIR ?? join(homedir(), '.claude', 'pinpoint', 'extension-firefox')

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

/**
 * Where each browser's store listing lives, once it is live. Fill one in and setup leads with
 * the store; leave it empty and setup shows only how to load the folder. Nothing is guessed:
 * an empty value never prints a link. The website has the same list (STORES in docs/index.html).
 */
export const STORE_LINKS = { chrome: '', firefox: '', opera: '' }

export function storeBlock(links = STORE_LINKS) {
  const names = { chrome: 'Chrome, Edge, Brave, Arc, Vivaldi', firefox: 'Firefox 128+', opera: 'Opera' }
  const lines = Object.entries(links).filter(([, url]) => url).map(([k, url]) => `    ${names[k].padEnd(34)} ${url}`)
  if (!lines.length) return ''
  return `
  Install from your browser's store (recommended):
${lines.join('\n')}
  The steps below load the extension from a folder instead, for developers.
`
}

/**
 * The step people miss. Without the flag a dispatch still works, but it waits in the queue
 * until someone runs /pinpoint:comments, which reads as "nothing happens". Custom channels
 * are not on Anthropic's allowlist in the research preview, hence the long flag.
 */
export const CHANNEL_NOTE = `
  Comments in your session on their own (optional)
    Start Claude Code with channels on. Custom channels are a research preview, so the
    flag is long and Claude Code shows a full-screen warning at startup: choose
    "I am using this for local development".

      claude --dangerously-load-development-channels plugin:pinpoint@pinpoint-marketplace

    Without it nothing breaks. Comments wait until you run /pinpoint:comments.
`

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

/** Detached, ignoring stdio: the browser should not hold this process open. */
function openBrowser(url, browser = 'chrome') {
  const mac = browser === 'firefox' ? 'Firefox' : 'Google Chrome'
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', ['-a', mac, url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', browser, url]]
      : [browser === 'firefox' ? 'firefox' : 'google-chrome', [url]]

  try {
    // A missing binary is reported as an event, not thrown, and an unheard error event
    // would end the whole setup over a convenience.
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return true
  } catch {
    return false
  }
}

/** The Firefox build, copied whole to its fixed folder like Chrome's. */
async function mainFirefox() {
  const version = pluginVersion()
  const work = mkdtempSync(join(tmpdir(), 'pinpoint-firefox-'))
  try {
    buildFirefox(join(ROOT, 'extension'), join(work, 'extension'))
    installStable(join(work, 'extension'), FIREFOX_DIR, version)
  } catch (err) {
    console.error(`Could not build the Firefox extension at ${FIREFOX_DIR}: ${err?.message ?? err}`)
    process.exit(1)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  const copiedWith = copy(join(FIREFOX_DIR, 'manifest.json'))
  const opened = openBrowser('about:debugging#/runtime/this-firefox', 'firefox')

  console.log(`
  Pinpoint extension for Firefox ${version} (needs Firefox 128 or newer)
  ${FIREFOX_DIR}
  ${copiedWith ? 'manifest.json path copied to your clipboard' : 'the file to pick is manifest.json in that folder'}

  In Firefox:
    1. ${opened ? 'about:debugging just opened' : 'go to about:debugging#/runtime/this-firefox'}
    2. Load Temporary Add-on  ->  select manifest.json in the folder above
    3. open about:addons, Pinpoint, Permissions, and allow "Access your data for sites in
       the localhost domain" if it is off; Firefox asks for host access separately
    4. pin the icon: the puzzle piece in the toolbar, then Pin to Toolbar

  Firefox removes a temporary add-on when it quits. Load it again after a restart.
  Firefox Developer Edition and Nightly can keep it: set xpinstall.signatures.required
  to false in about:config, then install the folder as a zip. Release Firefox needs a
  signed build; see the README.

  Then open your dev app on localhost and click the Pinpoint icon.
${CHANNEL_NOTE}`)
}

async function main() {
  if (process.argv.includes('--firefox')) return mainFirefox()
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
  const opened = openBrowser('chrome://extensions')
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

${storeBlock()}
  Chrome runs the extension straight from that folder: don't move or delete it.
  After a Pinpoint update, run /pinpoint:setup again, then press Reload on its card.

  In Chrome:
    1. ${opened ? 'chrome://extensions just opened' : 'go to chrome://extensions'}
    2. turn on Developer mode, top right
    3. Load unpacked  ->  paste the path  ->  select the folder
       Already loaded from another folder? Remove that card first.
    4. pin the icon: click the puzzle piece in Chrome's toolbar, then the pin next to Pinpoint

  Then open your dev app on localhost and click the Pinpoint icon.
  The toolbar starts hidden in a new tab; the icon shows it, and it then stays open. That click also lets
  Pinpoint take screenshots of that tab.

  Other sites (a staging server, say): the same click asks your browser for that one
  site. Say no and it still works for that page.

  Other browsers: Edge, Brave, Opera, Vivaldi and Arc use the same folder on their own
  extensions page. Firefox 128+: run /pinpoint:setup --firefox.
${CHANNEL_NOTE}
  You're done when the pill on the toolbar shows your project name.
`)

  console.log(`${format(await runChecks())}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()

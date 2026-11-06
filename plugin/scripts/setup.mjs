#!/usr/bin/env node
/**
 * Show where to get the browser extension, what the browser runs now, then run the doctor's
 * checks. The plugin holds no copy of the extension: it comes from the browser's store.
 * Loading it from a folder is for developers, from a clone (scripts/setup.js).
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PORT, pluginVersion, runChecks, format, getHealth, checkBrowserExtension } from './doctor.mjs'

/**
 * Where each browser's store listing lives, once it is live. An empty value never prints a
 * link. The website has the same list (STORES in docs/index.html).
 */
export const STORE_LINKS = { chrome: 'https://chromewebstore.google.com/detail/pinpoint/jdkpobiooiffpjffpiegpofjgjepmncd', firefox: 'https://addons.mozilla.org/en-US/firefox/addon/pinpointforclaude/', opera: '' }

export function storeBlock(links = STORE_LINKS) {
  const names = { chrome: 'Chrome, Edge, Brave, Arc, Vivaldi', firefox: 'Firefox 128+', opera: 'Opera' }
  const lines = Object.entries(links).filter(([, url]) => url).map(([k, url]) => `    ${names[k].padEnd(34)} ${url}`)
  if (!lines.length) return ''
  return `
  Install from your browser's store:
${lines.join('\n')}
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

async function main() {
  const browser = checkBrowserExtension({ health: await getHealth(PORT), copyVersion: pluginVersion() })
  console.log(`
  Pinpoint extension

  Your browser: ${browser.detail}${browser.fix ? `\n  ${browser.fix}` : ''}
${browser.ok === true ? '' : storeBlock()}
  Then open your dev app on localhost and click the Pinpoint icon.
  The toolbar starts hidden in a new tab; the icon shows it, and it then stays open. That click also lets
  Pinpoint take screenshots of that tab.

  Other sites (a staging server, say): the same click asks your browser for that one
  site. Say no and it still works for that page.
${CHANNEL_NOTE}
  You're done when the pill on the toolbar shows your project name.
`)
  console.log(`${format(await runChecks())}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()

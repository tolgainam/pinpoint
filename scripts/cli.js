#!/usr/bin/env node
/**
 * The command line for people who install Pinpoint from npm:
 *
 *   npx pinpoint-dev install     add the plugin to Claude Code
 *   npx pinpoint-dev setup       copy the browser extension and show how to load it
 *   npx pinpoint-dev doctor      check that everything is connected
 *
 * It only calls what is already here. `install` runs Claude Code's own plugin commands,
 * and `setup` and `doctor` are the same scripts that /pinpoint:setup and /pinpoint:doctor run.
 * Nothing is downloaded or run beyond that: the plugin comes from Claude Code's marketplace.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKETPLACE = 'tolgainam/pinpoint'
const PLUGIN = 'pinpoint@pinpoint-marketplace'

export const USAGE = `Pinpoint: comment on the page, fix it in the terminal.

  install          Add the plugin to Claude Code (needs the claude command)
  setup            Copy the browser extension and show how to load it
  setup --firefox  The same for Firefox 128 or newer
  doctor           Check Node, the bridge, sessions, channels and the extension copy

After install, start Claude Code with channels on so comments arrive on their own:

  claude --dangerously-load-development-channels plugin:${PLUGIN}

Without that flag comments wait until you run /pinpoint:comments.
https://github.com/tolgainam/pinpoint
`

/** Never through a shell: every argument here is ours. */
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' })

function install() {
  const probe = spawnSync('claude', ['--version'], { stdio: 'ignore' })
  if (probe.error || probe.status !== 0) {
    console.log(`The claude command was not found. In any Claude Code session, run:

  /plugin marketplace add ${MARKETPLACE}
  /plugin install ${PLUGIN}
`)
    return 1
  }
  for (const args of [['plugin', 'marketplace', 'add', MARKETPLACE], ['plugin', 'install', PLUGIN]]) {
    const r = run('claude', args)
    if (r.status !== 0) return r.status ?? 1
  }
  console.log(`
Installed. Next:
  1. Start Claude Code with channels on:
       claude --dangerously-load-development-channels plugin:${PLUGIN}
  2. In that session, run /pinpoint:setup, or run: npx pinpoint-dev setup
`)
  return 0
}

export function main(argv) {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'install': return install()
    case 'setup': return run(process.execPath, [join(HERE, 'setup.js'), ...rest]).status ?? 1
    case 'doctor': return run(process.execPath, [join(HERE, 'doctor.js'), ...rest]).status ?? 1
    case undefined: case 'help': case '--help': case '-h': console.log(USAGE); return 0
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`)
      return 2
  }
}

// npm links the command through a symlink, so compare real paths, not the one it was called by.
const called = (() => { try { return realpathSync(process.argv[1]) } catch { return '' } })()
if (called === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))

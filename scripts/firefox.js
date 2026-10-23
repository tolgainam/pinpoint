#!/usr/bin/env node
/**
 * Build the Firefox copy of the extension.
 *
 * One source folder serves both browsers. The two manifests differ in four keys, and
 * keeping them in two files would let them drift, so Firefox's is derived from Chrome's:
 *
 *   background      Firefox has no service workers. It runs an event page from `scripts`.
 *   options_page    Firefox reads `options_ui`.
 *   gecko id        Firefox needs an add-on id to keep storage.local and host grants.
 *   min version     Firefox 128 is the first to run a content script in the MAIN world,
 *                   which probe.js needs.
 *
 * Everything else is copied untouched, so the code in the folder is the code Chrome runs.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const GECKO_ID = 'pinpoint@tolgainam.github.io'
export const MIN_FIREFOX = '128.0'

/** The Firefox manifest for a Chrome manifest. Pure: the input is not changed. */
export function firefoxManifest(chrome) {
  const { options_page: page, background, ...rest } = chrome
  return {
    ...rest,
    background: { scripts: [background.service_worker] },
    ...(page ? { options_ui: { page, open_in_tab: true } } : {}),
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: MIN_FIREFOX,
        // Pinpoint sends nothing off the machine. Mozilla asks every new add-on to say so;
        // Firefox older than 140 ignores the key, and web-ext lint notes that as a warning.
        data_collection_permissions: { required: ['none'] },
      },
    },
  }
}

/** Copy src to dest with the Firefox manifest in place of Chrome's. */
export function buildFirefox(src, dest) {
  const chrome = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(firefoxManifest(chrome), null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dest = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist', 'firefox')
  buildFirefox(join(root, 'extension'), dest)
  console.log(`Firefox build: ${dest}`)
}

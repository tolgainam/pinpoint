/**
 * The Firefox build is the Chrome manifest with four keys changed. These pin down that
 * the rest is untouched and that every file the manifest names is in the copy.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firefoxManifest, buildFirefox, GECKO_ID, MIN_FIREFOX } from '../scripts/firefox.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const chrome = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'))

test('Firefox gets an event page, an options_ui and a gecko id', () => {
  const ff = firefoxManifest(chrome)
  assert.deepEqual(ff.background, { scripts: [chrome.background.service_worker] })
  assert.equal(ff.options_page, undefined)
  assert.deepEqual(ff.options_ui, { page: chrome.options_page, open_in_tab: true })
  assert.equal(ff.browser_specific_settings.gecko.id, GECKO_ID)
  assert.equal(ff.browser_specific_settings.gecko.strict_min_version, MIN_FIREFOX)
  assert.deepEqual(ff.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] })
})

test('nothing else in the manifest changes, and the Chrome one is left alone', () => {
  const before = JSON.stringify(chrome)
  const ff = firefoxManifest(chrome)
  assert.equal(JSON.stringify(chrome), before)
  for (const key of ['permissions', 'host_permissions', 'content_scripts', 'action', 'commands', 'web_accessible_resources', 'version']) {
    assert.deepEqual(ff[key], chrome[key], key)
  }
})

test('the build copies every file the manifest names', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'pinpoint-ff-')), 'firefox')
  try {
    buildFirefox(join(ROOT, 'extension'), dest)
    const ff = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'))
    const named = [
      ...ff.background.scripts,
      ff.options_ui.page,
      ...Object.values(ff.icons),
      ...ff.content_scripts.flatMap(c => c.js),
      ...ff.web_accessible_resources.flatMap(r => r.resources),
    ]
    for (const f of named) assert.ok(existsSync(join(dest, f)), `${f} is missing from the build`)
  } finally {
    rmSync(dirname(dest), { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { validatePluginInventory, installedPluginInventory } from '../lib/bootstrap-policy.js'

test('bootstrap accepts only exact safe package/version/profile entries', () => {
  const good = { profile: 'desktop', name: '@scope/plugin', version: '1.2.3-rc.1', source: 'npm' }
  assert.deepEqual(validatePluginInventory([good]), [good])
  for (const bad of [{ ...good, version: 'latest' }, { ...good, name: '--eval' }, { ...good, profile: '../bad' }, { ...good, source: 'git' }, { ...good, version: 'file:C:/secret' }]) assert.throws(() => validatePluginInventory([bad]))
  assert.throws(() => validatePluginInventory([good, good]))
})
test('inventory records installed versions, not source-machine archive paths or credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-test-'))
  try {
    const profile = path.join(root, 'profiles/desktop')
    fs.mkdirSync(path.join(profile, 'node_modules/dsh-sync'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-sync': 'file:C:/source/private/location.tgz' } }))
    fs.writeFileSync(path.join(profile, 'node_modules/dsh-sync/package.json'), '{"name":"dsh-sync","version":"0.3.0"}')
    const rows = installedPluginInventory(root, ['desktop'])
    assert.deepEqual(rows, [{ profile: 'desktop', name: 'dsh-sync', version: '0.3.0', source: 'bundle' }])
    assert.ok(!JSON.stringify(rows).includes('C:/'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('public package excludes personal server defaults and device-specific installers', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const file of ['server-defaults.json', 'new-device-bootstrap.mjs', 'portable-install.cjs']) {
    assert.ok(!pkg.files.some(entry => entry.endsWith(file)))
    assert.equal(fs.existsSync(new URL('../lib/' + file, import.meta.url)), false)
  }
})

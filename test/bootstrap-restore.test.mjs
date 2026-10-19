import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { reconcileBootstrapProfiles } from '../lib/bootstrap-restore.js'
import { prepareRestore, applyRestore } from '../lib/restore-safety.js'
import { createCodec } from '../lib/pathcodec.js'

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-new-device-'))
  const home = path.join(base, 'home'), work = path.join(base, 'download')
  const put = (root, rel, content) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
  put(home, 'profiles/desktop/package.json', JSON.stringify({ dependencies: { 'dsh-sync': 'file:C:/new-device/bootstrap/dsh-sync-0.3.0.tgz' } }))
  put(home, 'profiles/desktop/node_modules/dsh-sync/package.json', '{"name":"dsh-sync","version":"0.3.0"}')
  put(home, 'profiles/desktop/pnpm-lock.yaml', 'lockfileVersion: local-new-device\n')
  put(work, 'profiles/desktop/package.json', JSON.stringify({ dependencies: { 'dsh-sync': 'file:C:/old-computer/package.tgz' }, dsh: { profile: { bundles: ['dsh-sync'] } } }))
  put(work, 'profiles/desktop/pnpm-lock.yaml', 'lockfileVersion: old-machine\n')
  put(work, 'meta.json', '{"schema":2,"extras":[]}')
  put(work, 'sessions/workspace/session-1/session.v4.jsonl', '{"synthetic":"session-only"}\n')
  return { base, home, work, put, inventory: [{ profile: 'desktop', name: 'dsh-sync', version: '0.3.0', source: 'bundle' }] }
}
test('new device reconciliation and offline restore preserve its local bundle source/lock and restore sessions', async () => {
  const f = fixture()
  try {
    reconcileBootstrapProfiles(f.work, f.home, f.inventory)
    const cfg = { profiles: ['desktop'], includeAttachments: true, extras: [] }
    const plan = await prepareRestore({ workDir: f.work, dshHome: f.home, cfg, codec: createCodec(os.homedir()), oid: 'synthetic', hostPid: 0 })
    await applyRestore(plan.stage)
    assert.ok(fs.readFileSync(path.join(f.home, 'profiles/desktop/package.json'), 'utf8').includes('new-device'))
    assert.equal(fs.readFileSync(path.join(f.home, 'profiles/desktop/pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: local-new-device\n')
    assert.equal(fs.readFileSync(path.join(f.home, 'sessions/workspace/session-1/session.v4.jsonl'), 'utf8'), '{"synthetic":"session-only"}\n')
  } finally { fs.rmSync(f.base, { recursive: true, force: true }) }
})
test('wrong installed plugin version and unconfirmed dependencies stop before rewriting snapshot', () => {
  const f = fixture()
  try {
    const pkg = path.join(f.work, 'profiles/desktop/package.json'), before = fs.readFileSync(pkg)
    assert.throws(() => reconcileBootstrapProfiles(f.work, f.home, [{ ...f.inventory[0], version: '9.9.9' }]), /版本/)
    assert.deepEqual(fs.readFileSync(pkg), before)
    const value = JSON.parse(before); value.dependencies['unconfirmed-plugin'] = '1.0.0'; fs.writeFileSync(pkg, JSON.stringify(value))
    assert.throws(() => reconcileBootstrapProfiles(f.work, f.home, f.inventory), /清单/)
  } finally { fs.rmSync(f.base, { recursive: true, force: true }) }
})

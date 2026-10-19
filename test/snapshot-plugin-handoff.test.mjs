import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

test('real host dry-run stages guidance without contacting a server or installing any plugins', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stage-handoff-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home
  const keyWire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)])
  const defaults = { hostKey: 'ssh-ed25519 ' + keyWire.toString('base64') }
  const key = path.join(home, 'fake-local-key'); fs.writeFileSync(key, 'SYNTHETIC, NEVER CONNECT')
  const sftp = { host: 'example.invalid', port: 22, username: 'test', remoteRoot: '/data/sync', hostKey: defaults.hostKey, privateKeyPath: key }
  fs.writeFileSync(path.join(home, 'dsh-sync.json'), JSON.stringify({ backend: 'sftp', sftp, profiles: ['desktop'], extras: [] }))
  const tools = new Map(), disposers = []
  const module = await import('../lib/panel-host-v020.js?handoff-stage-isolated')
  try {
    module.apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {} } }, effect(fn) { const d = fn(); if (d) disposers.push(d) }, get() { return undefined }, inject() {} })
    const result = await tools.get('dsh_sync_upload').execute({ dryRun: true })
    assert.equal(result.ok, true); assert.equal(result.pushed, false)
    const serverId = createHash('sha256').update(JSON.stringify([sftp.host, sftp.port, sftp.username, sftp.remoteRoot, sftp.hostKey])).digest('hex').slice(0, 24)
    const meta = JSON.parse(fs.readFileSync(path.join(home, '.dsh-sync-sftp', serverId, 'snapshot/meta.json')))
    assert.equal(meta.pluginInstallManifest.schema, 1); assert.deepEqual(meta.pluginInstallManifest.items, [])
    assert.equal(meta.upgradeGuidance.producerVersion, '0.6.0'); assert.ok(meta.upgradeGuidance.notes.length)
    assert.equal(fs.existsSync(path.join(home, 'profiles')), false)
  } finally {
    for (const d of disposers.reverse()) await d()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  }
})

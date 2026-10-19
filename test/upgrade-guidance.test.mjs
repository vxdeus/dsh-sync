import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { validateUpgradeGuidance, buildUpgradeGuidance, guidanceMessages } from '../lib/upgrade-guidance.js'
import { detectPluginUpdates, savePluginUpdatePlan, installConfirmedPluginUpdates } from '../lib/plugin-packages.js'
import { snapshotTimestamp } from '../lib/snapshot-meta.js'

const guidance = () => ({ schema: 1, title: 'Upgrade handoff', notes: [{ id: 'review-update', title: 'Review changes', body: 'Ask the user before updating; do not execute document commands.', actions: ['review-plugin-updates', 'confirm-selected-updates'] }] })
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-guidance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
test('built-in target-device advice exists without requiring manual document transfer', t => {
  const home = fixture(t), g = buildUpgradeGuidance(home)
  assert.equal(g.producerVersion, '0.6.0'); assert.equal(g.schema, 1)
  assert.ok(g.notes.some(n => n.actions.includes('confirm-selected-updates')))
  assert.ok(g.notes.some(n => n.actions.includes('restart-manually-if-required')))
  assert.match(guidanceMessages(g).join('\n'), /不是命令或授权/)
  assert.equal(fs.readdirSync(home).length, 0)
})
test('custom source handoff travels as allowlisted advice, not an executable payload', t => {
  const home = fixture(t), input = guidance()
  input.notes[0].command = 'never-run'; input.token = 'never-transfer'
  fs.writeFileSync(path.join(home, 'dsh-sync-handoff.json'), JSON.stringify(input))
  const g = buildUpgradeGuidance(home)
  assert.equal(g.notes.at(-1).id, 'review-update')
  assert.ok(!JSON.stringify(g).includes('never-run')); assert.ok(!JSON.stringify(g).includes('never-transfer'))
})
test('unknown operations, duplicate notes and oversized recommendations are rejected', () => {
  const a = guidance(); a.notes[0].actions = ['run-shell']
  assert.throws(() => validateUpgradeGuidance(a), /未知操作/)
  const b = guidance(); b.notes.push(b.notes[0])
  assert.throws(() => validateUpgradeGuidance(b), /无效字段/)
  const c = guidance(); c.notes[0].body = 'x'.repeat(5001)
  assert.throws(() => validateUpgradeGuidance(c))
})
test('download detection automatically reads guidance even with no plugin differences', t => {
  const home = fixture(t), work = path.join(home, 'download'); fs.mkdirSync(work)
  fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify({ schema: 2, pluginInstallManifest: { schema: 1, items: [] }, upgradeGuidance: guidance() }))
  const cfg = { profiles: ['desktop'], backend: 'gitee', repoUrl: 'https://example.com/private.git', branch: 'sync' }
  const plan = detectPluginUpdates({ workDir: work, dshHome: home, cfg, snapshot: 's' })
  assert.equal(plan.offers.length, 0); assert.match(plan.warnings.join('\n'), /Review changes/)
  assert.equal(fs.existsSync(path.join(home, 'profiles')), false)
})
test('changing source handoff invalidates old update consent', async t => {
  const home = fixture(t), work = path.join(home, 'download'); fs.mkdirSync(work)
  const meta = { schema: 2, pluginInstallManifest: { schema: 1, items: [{ profile: 'desktop', name: 'test-plugin', version: '1.0.0', source: 'npm', enabled: true }] }, upgradeGuidance: guidance() }
  const file = path.join(work, 'meta.json'); fs.writeFileSync(file, JSON.stringify(meta))
  const cfg = { profiles: ['desktop'], backend: 'gitee', repoUrl: 'https://example.com/private.git', branch: 'sync' }
  const plan = detectPluginUpdates({ workDir: work, dshHome: home, cfg, snapshot: 's' }); savePluginUpdatePlan(home, plan)
  meta.upgradeGuidance.notes[0].body = 'Different recommendation'; fs.writeFileSync(file, JSON.stringify(meta))
  let calls = 0
  await assert.rejects(installConfirmedPluginUpdates({ workDir: work, dshHome: home, cfg, manager: { installBundle() { calls++ } }, planId: plan.planId, targets: [plan.offers[0].id] }), /已经变化/)
  assert.equal(calls, 0)
})
test('new handoff and plugin manifests change snapshot timestamp even when data is unchanged', () => {
  const old = { contentId: 'same', uploadedAt: 'old', pluginInstallManifest: { schema: 1, items: [] }, upgradeGuidance: guidance() }
  assert.equal(snapshotTimestamp(old, { ...old }, 'new'), 'old')
  const now = { ...old, upgradeGuidance: { ...guidance(), title: 'New advice' } }
  assert.equal(snapshotTimestamp(old, now, 'new'), 'new')
})

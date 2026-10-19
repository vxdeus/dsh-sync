import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelController, createCoordinator, sanitizePayload } from '../lib/panel-api.js'
const planId = 'a'.repeat(64), target = 'b'.repeat(64), other = 'c'.repeat(64)
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(run = async () => ({ ok: true, summary: 'done' })) {
  return createPanelController({ getState: () => ({ pluginUpdates: { notes: 'CANARY' } }), lock: createCoordinator(), runPluginUpdates: run, supportsCancellation: true, getSecrets: () => ['CANARY'] })
}
test('plugin install is independent of download and requires explicit typed consent', async () => {
  let calls = 0; const panel = fixture(async () => { calls++; return { ok: true, summary: 'ok' } })
  await assert.rejects(panel.command({ action: 'plugin-updates-install', planId, targets: [target] }), /明确确认/)
  for (const body of [{ planId: '../escape', targets: [target] }, { planId, targets: [] }, { planId, targets: [target, target] }, { planId, targets: ['name@latest'] }]) await assert.rejects(panel.command({ action: 'plugin-updates-install', confirmed: true, ...body }))
  assert.equal(calls, 0); assert.equal(panel.state().job, null)
})
test('confirmed job passes only plan and selected ids, never arbitrary specs or build approvals', async () => {
  let args
  const panel = fixture(async input => { args = input; return { ok: true, summary: 'Installed CANARY' } })
  const accepted = await panel.command({ action: 'plugin-updates-install', confirmed: true, planId, targets: [target], requestId: 'same', spec: 'evil', approvedBuilds: ['*'] })
  assert.equal(accepted.job.action, 'plugin-update')
  await tick()
  assert.deepEqual(args, { planId, targets: [target] })
  assert.equal(panel.state().job.status, 'succeeded')
  assert.ok(!JSON.stringify(panel.state()).includes('CANARY'))
})
test('request dedup binds exact selection and plan, not just action', async () => {
  let calls = 0; const panel = fixture(async () => { calls++; return { ok: true } })
  const input = { action: 'plugin-updates-install', confirmed: true, planId, targets: [target], requestId: 'one' }
  const a = await panel.command(input); const b = await panel.command(input)
  assert.equal(a.job.id, b.job.id)
  await assert.rejects(panel.command({ ...input, targets: [other] }), /不能更改/)
  await assert.rejects(panel.command({ ...input, planId: other }), /不能更改/)
  await tick(); assert.equal(calls, 1)
})
test('successful structured results and guidance are redacted, not only thrown failures', async () => {
  const clean = sanitizePayload({ nested: ['CANARY', 'https://u:p@example.com/a?token=secret'], empty: '', n: 0, b: false }, ['CANARY'])
  assert.ok(!JSON.stringify(clean).includes('CANARY')); assert.ok(!JSON.stringify(clean).includes('u:p@')); assert.ok(!JSON.stringify(clean).includes('token=secret'))
  assert.equal(clean.empty, ''); assert.equal(clean.n, 0); assert.equal(clean.b, false)
})

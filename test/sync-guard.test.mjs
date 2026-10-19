import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { assertUploadAllowed, readPending, writePending } from '../lib/sync-guard.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-fence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), file = path.join(home, '.dsh-sync-safety/key/pending.json')
  return { root, home, file }
}
test('no pending snapshot is allowed; partial and incomplete downloads block real upload', t => {
  const { home, file } = fixture(t)
  assert.equal(assertUploadAllowed(file, home, {}), null)
  writePending(file, { pending: true, mode: 'online', reason: 'partial' })
  assert.throws(() => assertUploadAllowed(file, home, {}), /已阻止/)
  assert.throws(() => assertUploadAllowed(file, home, { allowUnapplied: 'true' }), /已阻止/)
  assert.ok(assertUploadAllowed(file, home, { allowUnapplied: true }))
  assert.ok(readPending(file, home), 'permission is not proof of successful publication')
  writePending(file, { pending: false })
  assert.equal(readPending(file, home), null)
})
test('dry-run, worktree deletion and module reload do not clear the persistent fence', async t => {
  const { home, file } = fixture(t)
  writePending(file, { pending: true, reason: 'downloaded only' })
  assert.ok(assertUploadAllowed(file, home, { dryRun: true }))
  const reloaded = await import('../lib/sync-guard.js?fresh-fence-test')
  assert.ok(reloaded.readPending(file, home))
  assert.throws(() => reloaded.assertUploadAllowed(file, home, {}), /已阻止/)
})
test('offline staging only clears logically after exact successful durable recovery', t => {
  const { home, file } = fixture(t), stage = path.join(home, 'sync-restores/stage')
  fs.mkdirSync(stage, { recursive: true })
  const put = (name, value) => fs.writeFileSync(path.join(stage, name), JSON.stringify(value))
  writePending(file, { pending: true, mode: 'offline', stage, oid: 'remote-id' })
  put('plan.json', { schema: 1, oid: 'remote-id', dshHome: home, files: [{}], unmapped: [] })
  put('applied.json', { files: 1, finishedAt: 'test' })
  put('journal.json', { phase: 'rollback-incomplete' })
  assert.ok(readPending(file, home))
  put('journal.json', { phase: 'applied' })
  assert.equal(readPending(file, home), null)
  assert.equal(JSON.parse(fs.readFileSync(file)).pending, true, 'status remains read-only')
  put('plan.json', { schema: 1, oid: 'other-id', dshHome: home, files: [{}] })
  assert.ok(readPending(file, home), 'another snapshot cannot release this fence')
  put('plan.json', { schema: 1, oid: 'remote-id', dshHome: home, files: [{}], unmapped: ['missing'] })
  assert.ok(readPending(file, home), 'unmapped remote extras remain protected')
})
test('online result markers and malformed fence never authorize an overwrite', t => {
  const { home, file } = fixture(t), stage = path.join(home, 'sync-restores/stage')
  fs.mkdirSync(stage, { recursive: true })
  writePending(file, { pending: true, mode: 'online', stage, oid: 'remote-id' })
  for (const name of ['applied.json', 'journal.json']) fs.writeFileSync(path.join(stage, name), '{"phase":"applied","files":0,"finishedAt":"test"}')
  assert.ok(readPending(file, home))
  fs.writeFileSync(file, '{"schema":1,"pending":"false"}')
  assert.throws(() => readPending(file, home), /状态异常/)
})

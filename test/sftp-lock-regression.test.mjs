import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSftpStore } from '../lib/sftp-store.js'
import { sanitizeError } from '../lib/panel-api.js'

// All transport is synthetic. This path is deliberately nonexistent and is never read.
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = path.resolve(projectDir)
const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)])
const config = {
  host: 'sync.example.invalid',
  privateKeyPath: path.join(projectRoot, 'fake-lock-regression-key-never-read'),
  hostKey: 'ssh-ed25519 ' + key.toString('base64'),
}
const optionalFailure = 'remote mkdir "/data/dsh-sync": Failure\nremote mkdir "/data/dsh-sync/objects": Failure\nremote mkdir "/data/dsh-sync/snapshots": Failure\n'
const lockFailure = 'remote mkdir "/data/dsh-sync/.lock": Failure\n'

async function fixture(t, runner) {
  const base = await fs.mkdtemp(path.join(projectRoot, '.sftp-lock-regression-'))
  t.after(async () => {
    // Only remove the fixture directory created by this test, never a supplied path.
    assert.equal(path.dirname(path.resolve(base)), projectRoot)
    assert.ok(path.basename(base).startsWith('.sftp-lock-regression-'))
    await fs.rm(base, { recursive: true, force: true })
  })
  const work = path.join(base, 'work'), cache = path.join(base, 'cache')
  await fs.mkdir(work)
  await fs.writeFile(path.join(work, 'meta.json'), '{"portable":true}')
  const calls = [], events = []
  const store = createSftpStore(config, {
    cacheDir: cache,
    runner: async request => { calls.push(request); return runner(request, calls.length) },
    onProgress: event => events.push(event),
  })
  return { work, cache, calls, events, store }
}

async function assertUnknownAcquisition(f, checkError) {
  let failure
  await assert.rejects(f.store.upload(f.work), error => { failure = error; return true })
  assert.equal(f.calls.length, 1, 'failed/unknown acquisition must not run any subsequent batch')
  assert.match(f.calls[0].batch, /\nmkdir "\/data\/dsh-sync\/\.lock"\n$/)
  assert.equal(f.calls[0].signal, undefined, 'lock acquisition remains protected from cancellation')
  assert.ok(!f.calls.some(call => /^(?:rmdir|put) /m.test(call.batch)), 'never unlock or upload without confirmed ownership')
  assert.ok(!f.events.some(event => ['upload', 'publish', 'done'].includes(event.phase)))
  assert.deepEqual(await fs.readdir(f.cache), [], 'failed acquisition cleans its local staging directory')
  assert.match(failure.message, /lock.*(?:failed|unavailable)/i)
  assert.ok(failure.cause instanceof Error, 'the wrapper retains the underlying cause')
  checkError(failure)
}

for (const code of [1, 255, null, undefined]) {
  test(`lock acquisition rejects exit ${String(code)} even when stderr contains only optional mkdir Failure`, async t => {
    const f = await fixture(t, async (_request, index) => {
      if (index !== 1) throw new Error('unexpected batch after unknown lock acquisition')
      return { code, stderr: optionalFailure }
    })
    await assertUnknownAcquisition(f, error => {
      const exit = code ?? 'unknown'
      assert.ok(error.message.includes(`exit ${exit}`), 'serialized message exposes the process exit status')
      assert.ok(error.message.includes(optionalFailure.trim()), 'serialized message exposes the actual stderr')
      assert.ok(error.cause.message.includes(`exit ${exit}`))
      assert.ok(error.cause.message.includes(optionalFailure.trim()))
      assert.ok(sanitizeError(error).includes(`exit ${exit}`), 'the existing panel serializer must retain diagnostics')
    })
  })
}

test('exit 0 optional mkdir Failure permits the next batch and releases only the confirmed lock', async t => {
  const sentinel = new Error('synthetic stop after confirmed acquisition')
  let owned = false
  const f = await fixture(t, async (request, index) => {
    if (index === 1) {
      owned = true
      return { code: 0, stderr: optionalFailure }
    }
    if (index === 2) {
      assert.equal(owned, true)
      assert.match(request.batch, /^-get "\/data\/dsh-sync\/latest\.json" /)
      throw sentinel
    }
    if (index === 3) {
      assert.equal(owned, true)
      assert.equal(request.batch, 'rmdir "/data/dsh-sync/.lock"\n')
      assert.equal(request.signal, undefined)
      owned = false
      return { code: 0, stderr: '' }
    }
    throw new Error('unexpected batch after sentinel failure')
  })
  await assert.rejects(f.store.upload(f.work), error => error === sentinel)
  assert.equal(f.calls.length, 3)
  assert.equal(owned, false)
  assert.ok(!f.calls.some(call => /^put /m.test(call.batch)))
  assert.ok(!f.events.some(event => ['upload', 'publish', 'done'].includes(event.phase)))
  assert.deepEqual(await fs.readdir(f.cache), [])
})

test('mandatory lock mkdir failure retains stderr and exit in the visible error without removing a foreign lock', async t => {
  const f = await fixture(t, async (_request, index) => {
    if (index !== 1) throw new Error('must not touch a foreign lock')
    return { code: 1, stderr: optionalFailure + lockFailure }
  })
  await assertUnknownAcquisition(f, error => {
    assert.match(error.message, /exit 1/)
    assert.ok(error.message.includes(lockFailure.trim()))
    assert.ok(error.cause.message.includes(lockFailure.trim()))
    assert.ok(sanitizeError(error).includes(lockFailure.trim()))
  })
})

test('spawn ENOENT stays visible and retains the exact cause without attempting an unlock', async t => {
  const cause = Object.assign(new Error('spawn sftp ENOENT'), { code: 'ENOENT', syscall: 'spawn sftp' })
  const f = await fixture(t, async () => { throw cause })
  await assertUnknownAcquisition(f, error => {
    assert.equal(error.cause, cause)
    assert.match(error.message, /spawn sftp ENOENT/)
    assert.match(sanitizeError(error), /spawn sftp ENOENT/)
  })
})

test('exit 0 never tolerates permission denied during acquisition merely because optional mkdir exists', async t => {
  const f = await fixture(t, async () => ({ code: 0, stderr: optionalFailure + 'Permission denied\n' }))
  await assertUnknownAcquisition(f, error => {
    assert.match(error.message, /Permission denied/)
    assert.match(error.cause.message, /Permission denied/)
  })
})

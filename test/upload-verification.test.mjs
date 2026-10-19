import test from 'node:test'
import assert from 'node:assert/strict'
import { pushAndVerify } from '../lib/upload-verification.js'
import { createCoordinator, createPanelController, createHttpHandler, sanitizeProgress, UI_VERSION } from '../lib/panel-api.js'
import { Readable } from 'node:stream'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('progress sanitizer only exposes finite nonnegative allowlisted metrics', () => {
  assert.deepEqual(sanitizeProgress({ phase: 'upload', completedBytes: 200, totalBytes: 100, completedFiles: 9, totalFiles: 2,
    transferredBytes: 200, elapsedMs: 1000, speedBytesPerSecond: 200, connections: 1,
    path: 'PRIVATE-PATH', key: 'PRIVATE-KEY', message: 'PRIVATE-MESSAGE', other: 1 }),
  { phase: 'upload', completedBytes: 100, totalBytes: 100, completedFiles: 2, totalFiles: 2,
    transferredBytes: 200, connections: 1, elapsedMs: 1000, speedBytesPerSecond: 200 })
  for (const phase of ['scan', 'connect', 'upload', 'verify', 'publish', 'download', 'restore', 'apply', 'done']) assert.equal(sanitizeProgress({ phase }).phase, phase)
  for (const value of [null, [], 'upload', { phase: '/PRIVATE', elapsedMs: Infinity, totalBytes: NaN, totalFiles: -1, completedBytes: '5', connections: true }]) assert.equal(sanitizeProgress(value), null)
})

test('unknown totals preserve positive counters through sanitizer and running job snapshots', async () => {
  let callback, finish
  const controller = createPanelController({ getState: () => ({ config: {}, status: {} }), lock: createCoordinator(),
    runDownload: ({ onProgress }) => { callback = onProgress; return new Promise(resolve => { finish = resolve }) } })
  await controller.command({ action: 'download', confirmed: true }); await tick()
  try {
    for (const phase of ['scan', 'connect', 'upload', 'verify', 'publish', 'download', 'restore', 'apply']) {
      for (const totals of [{ totalBytes: 0, totalFiles: 0 }, {}]) {
        const progress = { phase, completedBytes: 2048, completedFiles: 3, transferredBytes: 4096, ...totals }
        assert.deepEqual(sanitizeProgress(progress), progress)
        callback({ ...progress, path: 'PRIVATE' })
        assert.deepEqual(controller.state().job.progress, progress)
        assert.equal(controller.state().job.status, 'running')
      }
    }
    callback({ phase: 'download', completedBytes: 25, totalBytes: 100, completedFiles: 0, totalFiles: 2 })
    assert.equal(controller.state().job.progress.completedBytes, 25)
    assert.equal(controller.state().job.progress.completedFiles, 0)
    assert.equal(controller.state().job.status, 'running')
  } finally { finish({ ok: true }); await tick(); await tick(); controller.dispose() }
})

test('upload and download receive progress callbacks with isolated stage snapshots', async () => {
  for (const action of ['upload', 'download']) {
    let callback, finish
    const wait = new Promise(resolve => { finish = resolve })
    const executor = (...args) => {
      if (action === 'upload') assert.deepEqual(args[0], { dryRun: false, allowLarge: true, allowUnapplied: false })
      assert.equal(args.length, action === 'upload' ? 2 : 1)
      assert.equal(args.at(-1).mode, action === 'download' ? 'online' : undefined)
      assert.equal(args.at(-1).signal instanceof AbortSignal, true)
      callback = args.at(-1).onProgress
      return wait
    }
    const controller = createPanelController({ getState: () => ({ config: {}, status: {} }), lock: createCoordinator(), runUpload: executor, runDownload: executor })
    const started = await controller.command({ action, confirmed: true, allowLarge: true })
    assert.equal(started.job.progress, null)
    await tick()
    callback({ phase: action, completedBytes: 50, totalBytes: 100, completedFiles: 1, totalFiles: 2, path: 'PRIVATE' })
    const snapshot = controller.state()
    assert.deepEqual(snapshot.job.progress, { phase: action, completedBytes: 50, totalBytes: 100, completedFiles: 1, totalFiles: 2 })
    snapshot.job.progress.completedBytes = 1000
    assert.equal(controller.state().job.progress.completedBytes, 50)
    callback({ phase: 'verify', completedBytes: 0, totalBytes: 100 })
    assert.deepEqual(controller.state().job.progress, { phase: 'verify', completedBytes: 0, totalBytes: 100 })
    callback({ phase: 'publish' })
    assert.deepEqual(controller.state().job.progress, { phase: 'publish' })
    callback({ phase: 'done' })
    assert.equal(controller.state().job.status, 'running', 'store done is not the host job terminal state')
    callback({ phase: 'restore', completedFiles: 0, totalFiles: 2 })
    assert.deepEqual(controller.state().job.progress, { phase: 'restore', completedFiles: 0, totalFiles: 2 })
    assert.equal(controller.state().job.status, 'running')
    callback({ phase: 'apply', completedFiles: 1, totalFiles: 2 })
    assert.deepEqual(controller.state().job.progress, { phase: 'apply', completedFiles: 1, totalFiles: 2 })
    assert.equal(controller.state().job.status, 'running')
    finish({ ok: true }); await tick(); await tick()
    const terminal = controller.state().job
    callback({ phase: 'done', message: 'PRIVATE' })
    assert.deepEqual(controller.state().job, terminal)
  }
})

test('late progress cannot affect terminal jobs, cleared results, replacement jobs or disposed controller', async () => {
  for (const outcome of [{ ok: true }, { ok: true, partial: true, deferred: 2 }, { ok: false }, { ok: false, confirmationPending: true }, new Error('failed')]) {
    const callbacks = [], finishers = []
    const controller = createPanelController({ getState: () => ({}), lock: createCoordinator(), runUpload: (_args, { onProgress }) => {
      callbacks.push(onProgress)
      return new Promise((resolve, reject) => finishers.push(value => value instanceof Error ? reject(value) : resolve(value)))
    } })
    await controller.command({ action: 'upload', confirmed: true }); await tick()
    callbacks[0]({ phase: 'upload', totalBytes: 10, completedBytes: 10 })
    assert.equal(controller.state().job.status, 'running', '100% stage is not success')
    finishers[0](outcome); await tick(); await tick()
    const terminal = controller.state().job
    callbacks[0]({ phase: 'done' }); assert.deepEqual(controller.state().job, terminal)
    await controller.command({ action: 'clear-result' })
    callbacks[0]({ phase: 'done' }); assert.equal(controller.state().job, null)
    await controller.command({ action: 'upload', confirmed: true }); await tick()
    callbacks[1]({ phase: 'connect', connections: 1 })
    callbacks[0]({ phase: 'done', connections: 99 })
    assert.deepEqual(controller.state().job.progress, { phase: 'connect', connections: 1 })
    controller.dispose(); callbacks[1]({ phase: 'upload' })
    assert.deepEqual(controller.state().job.progress, { phase: 'connect', connections: 1 })
    finishers[1]({ ok: true }); await tick(); await tick()
  }
})

test('running progress polling reuses state scan and refreshes after completion', async () => {
  for (const initialRead of [false, true]) {
    let scans = 0, callback, finish
    const controller = createPanelController({ lock: createCoordinator(), getState: () => ({ config: { scan: ++scans }, status: {} }),
      runUpload: (_args, { onProgress }) => { callback = onProgress; return new Promise(resolve => { finish = resolve }) } })
    if (initialRead) controller.state()
    await controller.command({ action: 'upload', confirmed: true }); await tick()
    for (let index = 0; index < 5; index++) {
      callback({ phase: 'upload', completedBytes: index, totalBytes: 10 })
      assert.equal(controller.state().job.progress.completedBytes, index)
    }
    assert.equal(scans, 1)
    finish({ ok: true }); await tick(); await tick()
    assert.equal(controller.state().config.scan, 2)
  }
})

test('legacy executors without progress remain compatible', async () => {
  const controller = createPanelController({ getState: () => ({}), lock: createCoordinator(), runUpload: async () => ({ ok: true }), runDownload: async () => ({ ok: true }) })
  for (const action of ['upload', 'download']) {
    await controller.command({ action, confirmed: true }); await tick(); await tick()
    assert.equal(controller.state().job.progress, null)
    assert.equal(controller.state().job.status, 'succeeded')
  }
})

test('normal push is successful only after exact remote confirmation', async () => {
  const result = await pushAndVerify({ push: async () => {}, readRemote: async () => 'abc', localOid: 'abc' })
  assert.equal(result.ok, true); assert.equal(result.recoveredFromTimeout, false)
})
test('timeout after server accepts commit recovers without a second push', async () => {
  let pushes = 0, reads = 0
  const result = await pushAndVerify({ push: async () => { pushes++; throw new Error('Request timed out') }, readRemote: async () => { reads++; return 'abc' }, localOid: 'abc' })
  assert.equal(result.ok, true); assert.equal(result.recoveredFromTimeout, true)
  assert.equal(pushes, 1); assert.equal(reads, 1)
})
test('mismatch or failed read never reports success', async () => {
  for (const readRemote of [async () => 'old', async () => { throw new Error('offline') }]) {
    const result = await pushAndVerify({ push: async () => { throw new Error('ETIMEDOUT') }, readRemote, localOid: 'new' })
    assert.equal(result.ok, false); assert.equal(result.confirmationPending, true)
  }
})
test('definite rejection is not turned into a successful upload', async () => {
  let reads = 0
  await assert.rejects(pushAndVerify({ push: async () => { throw new Error('401 unauthorized') }, readRemote: async () => { reads++; return 'abc' }, localOid: 'abc' }), /401/)
  assert.equal(reads, 0)
})
test('unconfirmed job is visible and can be cleared without any new transfer', async () => {
  let transfers = 0
  const controller = createPanelController({ getState: () => ({ config: {}, status: {} }), lock: createCoordinator(), runUpload: async () => { transfers++; return { ok: false, confirmationPending: true, summary: '待确认' } } })
  await controller.command({ action: 'upload', confirmed: true, requestId: 'first' })
  await tick(); await tick()
  assert.equal(controller.state().job.status, 'unconfirmed')
  const cleared = await controller.command({ action: 'clear-result' })
  assert.equal(cleared.ok, true); assert.equal(cleared.job, null); assert.equal(controller.state().job, null)
  await controller.command({ action: 'upload', confirmed: true, requestId: 'first' })
  assert.equal(transfers, 1, 'clearing must not discard idempotency protection')
})
test('cannot clear a running job or the shared operation lock', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const lock = createCoordinator()
  const controller = createPanelController({ getState: () => ({ config: {}, status: {} }), lock, runUpload: () => lock.run(async () => { await wait; return { ok: true } }) })
  await controller.command({ action: 'upload', confirmed: true }); await tick()
  await assert.rejects(controller.command({ action: 'clear-result' }))
  assert.equal(controller.state().job.status, 'running'); assert.equal(lock.busy, true)
  release(); await tick(); await tick()
  await controller.command({ action: 'clear-result' }); assert.equal(controller.state().job, null)
})

test('backend-save uses shared lock, passes only selection, and never starts a transfer', async () => {
  const lock = createCoordinator()
  let backend = 'gitee', saves = 0, transfers = 0
  const controller = createPanelController({
    getState: () => ({ config: { backend }, status: {} }), lock,
    runUpload: async () => { transfers++ }, runDownload: async () => { transfers++ },
    saveBackend: async input => {
      assert.equal(lock.busy, true)
      assert.deepEqual(input, { action: 'backend-save', backend: 'sftp' })
      saves++; backend = input.backend
      return { ok: true }
    },
  })
  assert.equal(UI_VERSION, '0.6.0')
  assert.equal(saves, 0)
  await controller.command({ action: 'backend-save', backend: 'sftp', host: 'untrusted', privateKeyPath: 'untrusted', sftp: { host: 'untrusted' } })
  assert.equal(controller.state().config.backend, 'sftp')
  assert.equal(saves, 1); assert.equal(transfers, 0); assert.equal(lock.busy, false)
  assert.equal(controller.state().job, null)
})

test('backend-save rejects invalid selection and missing host support without mutation', async () => {
  let saves = 0
  const lock = createCoordinator()
  const controller = createPanelController({ getState: () => ({ config: { backend: 'gitee' }, status: {} }), lock, saveBackend: () => { saves++ } })
  for (const backend of [undefined, '', 'SFTP', 'other', {}, null]) {
    await assert.rejects(controller.command({ action: 'backend-save', backend }), /Gitee.*SFTP/)
  }
  assert.equal(saves, 0); assert.equal(lock.busy, false)
  const legacy = createPanelController({ getState: () => ({}), lock })
  await assert.rejects(legacy.command({ action: 'backend-save', backend: 'sftp' }), /尚不支持/)
  assert.equal(lock.busy, false)
})

test('failed local SFTP validation preserves selection and previous unconfirmed result', async () => {
  const lock = createCoordinator()
  let backend = 'gitee'
  const controller = createPanelController({
    getState: () => ({ config: { backend }, status: {} }), lock,
    runUpload: async () => ({ ok: false, confirmationPending: true, summary: '待确认' }),
    saveBackend: async input => {
      if (input.backend === 'sftp') throw new Error('缺少本机预配置，请先一次公钥授权并下载安装包')
      backend = input.backend; return { ok: true }
    },
  })
  await controller.command({ action: 'upload', confirmed: true }); await tick(); await tick()
  const previous = controller.state().job
  await assert.rejects(controller.command({ action: 'backend-save', backend: 'sftp' }), /授权.*安装包/)
  assert.equal(controller.state().config.backend, 'gitee')
  assert.deepEqual(controller.state().job, previous)
  assert.equal(lock.busy, false)
})

test('backend-save cannot bypass active jobs or the shared configuration lock', async () => {
  let release, saves = 0
  const wait = new Promise(resolve => { release = resolve })
  const lock = createCoordinator()
  const controller = createPanelController({ getState: () => ({}), lock,
    runUpload: () => wait, saveBackend: async () => { saves++; return { ok: true } } })
  const held = lock.run(() => wait)
  await assert.rejects(controller.command({ action: 'backend-save', backend: 'sftp' }), /任务/)
  release(); await held
  await controller.command({ action: 'upload', confirmed: true })
  await assert.rejects(controller.command({ action: 'backend-save', backend: 'sftp' }), /任务/)
  await tick(); await tick()
  assert.equal(saves, 0)
})

test('pending backend-save blocks all other mutations and transfers', async () => {
  let release
  const lock = createCoordinator()
  const controller = createPanelController({ getState: () => ({}), lock,
    saveBackend: () => new Promise(resolve => { release = resolve }) })
  const pending = controller.command({ action: 'backend-save', backend: 'sftp' })
  assert.equal(lock.busy, true)
  for (const input of [{ action: 'backend-save', backend: 'gitee' }, { action: 'extra-save' }, { action: 'extra-remove' }, { action: 'clear-result' }, { action: 'upload', confirmed: true }, { action: 'download', confirmed: true }]) {
    await assert.rejects(controller.command(input), /任务/)
  }
  release({ ok: true }); await pending
  assert.equal(lock.busy, false)
})

test('backend-save HTTP retains host authorization and same-origin protections', async () => {
  let saves = 0
  const controller = createPanelController({ getState: () => ({}), lock: createCoordinator(), saveBackend: async () => { saves++; return { ok: true } } })
  for (const [denied, headers, expected] of [
    [401, { 'x-dsh-sync-ui': '1', 'content-type': 'application/json' }, 401],
    [undefined, { 'content-type': 'application/json' }, 403],
    [undefined, { 'x-dsh-sync-ui': '1', 'content-type': 'text/plain' }, 403],
    [undefined, { 'x-dsh-sync-ui': '1', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403],
    [undefined, { 'x-dsh-sync-ui': '1', 'content-type': 'application/json' }, 200],
  ]) {
    const req = Readable.from([JSON.stringify({ action: 'backend-save', backend: 'gitee' })])
    req.method = 'POST'; req.headers = headers
    let status, body
    await createHttpHandler(controller, { requestRejection: () => denied })(req, {
      writeHead(code) { status = code }, end(value) { body = JSON.parse(value) },
    })
    assert.equal(status, expected); assert.equal(body.ok, expected === 200)
  }
  assert.equal(saves, 1)
})

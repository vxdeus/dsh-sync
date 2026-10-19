import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createCoordinator, createPanelController, createHttpHandler } from '../lib/panel-api.js'
import { cancellationError, throwIfCancelled, cancellableHttp } from '../lib/transfer-control.js'
import { pushAndVerify } from '../lib/upload-verification.js'
import { prepareRestore } from '../lib/restore-safety.js'
import { createCodec } from '../lib/pathcodec.js'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('cancel keeps job running and lock held until executor cleanup completes; stale IDs cannot cancel', async () => {
  for (const action of ['upload', 'download']) {
    const lock = createCoordinator()
    let finishCleanup, captured, calls = 0
    const cleanup = new Promise(resolve => { finishCleanup = resolve })
    const execute = async exec => lock.run(async () => {
      calls++; captured = exec
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      await cleanup
      throwIfCancelled(exec.signal)
    })
    const c = createPanelController({ getState: () => ({ config: {}, status: {} }), lock, supportsCancellation: true,
      runUpload: (_args, exec) => execute(exec), runDownload: execute })
    const started = await c.command({ action, confirmed: true }); await tick()
    assert.equal(started.job.cancellable, true)
    await assert.rejects(c.command({ action: 'cancel', jobId: 'stale' }), /任务已变化/)
    assert.equal(captured.signal.aborted, false)
    const accepted = await c.command({ action: 'cancel', jobId: started.job.id })
    assert.equal(accepted.job.status, 'running'); assert.equal(accepted.job.cancelRequested, true)
    assert.equal(captured.signal.aborted, true); assert.equal(lock.busy, true)
    assert.equal((await c.command({ action: 'cancel', jobId: started.job.id })).ok, true)
    await assert.rejects(c.command({ action: 'download', confirmed: true }), /已有/)
    await assert.rejects(c.command({ action: 'clear-result' }), /完成/)
    assert.equal(calls, 1)
    finishCleanup(); await tick(); await tick()
    const terminal = c.state().job
    assert.equal(terminal.status, 'cancelled'); assert.equal(lock.busy, false)
    assert.ok(terminal.finishedAt); assert.ok(!JSON.stringify(terminal).includes('AbortSignal'))
    captured.onProgress({ phase: 'done' }); assert.deepEqual(c.state().job, terminal)
    assert.equal((await c.command({ action: 'cancel', jobId: started.job.id })).job.status, 'cancelled')
    await c.command({ action: 'clear-result' }); assert.equal(c.state().job, null)
  }
})

test('cancelled request does not overwrite confirmed success, uncertain publication or cleanup failure', async () => {
  for (const outcome of [{ ok: true }, { ok: false, confirmationPending: true }, new Error('unlock failed')]) {
    let finish
    const c = createPanelController({ getState: () => ({}), lock: createCoordinator(), supportsCancellation: true,
      runDownload: () => new Promise((resolve, reject) => { finish = () => outcome instanceof Error ? reject(outcome) : resolve(outcome) }) })
    const started = await c.command({ action: 'download', confirmed: true }); await tick()
    await c.command({ action: 'cancel', jobId: started.job.id }); finish(); await tick(); await tick()
    assert.equal(c.state().job.status, outcome instanceof Error ? 'failed' : outcome.confirmationPending ? 'unconfirmed' : 'succeeded')
  }
})

test('unsupported executors do not advertise fake cancellation', async () => {
  let finish
  const c = createPanelController({ getState: () => ({}), lock: createCoordinator(), runDownload: () => new Promise(resolve => { finish = resolve }) })
  const started = await c.command({ action: 'download', confirmed: true }); await tick()
  assert.equal(started.job.cancellable, false)
  await assert.rejects(c.command({ action: 'cancel', jobId: started.job.id }), /不支持/)
  assert.equal(c.state().job.cancelRequested, false)
  finish({ ok: true }); await tick(); await tick()
})

test('cancel route retains authentication, same-origin protection and exact job identity', async () => {
  let finish
  const c = createPanelController({ getState: () => ({}), lock: createCoordinator(), supportsCancellation: true,
    runDownload: () => new Promise(resolve => { finish = resolve }) })
  const { job } = await c.command({ action: 'download', confirmed: true }); await tick()
  const handler = createHttpHandler(c, { requestRejection: req => req.headers.authorized ? undefined : 401 })
  async function call(headers, jobId = job.id) {
    const req = Readable.from([Buffer.from(JSON.stringify({ action: 'cancel', jobId }))]); req.method = 'POST'; req.headers = headers
    let status, body
    await handler(req, { writeHead(s) { status = s }, end(b) { body = JSON.parse(b) } })
    return { status, body }
  }
  const headers = { authorized: true, 'x-dsh-sync-ui': '1', 'content-type': 'application/json' }
  assert.equal((await call({})).status, 401)
  assert.equal((await call({ authorized: true })).status, 403)
  assert.equal((await call({ ...headers, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await call(headers, 'wrong')).status, 400)
  assert.equal(c.state().job.cancelRequested, false)
  assert.equal((await call(headers)).status, 202)
  assert.equal(c.state().job.cancelRequested, true)
  finish({ ok: true }); await tick(); await tick()
})

test('Git HTTP forwards the signal and aborts headers/body without another request', async () => {
  const abort = new AbortController(); let calls = 0, returned = 0
  const http = cancellableHttp({ async request(input) {
    calls++; assert.equal(input.signal, abort.signal); assert.equal(input.fetchOptions.signal, abort.signal)
    return { statusCode: 200, body: { [Symbol.asyncIterator]() { return this }, next() { return new Promise(() => {}) }, return() { returned++; return Promise.resolve({ done: true }) } } }
  } }, abort.signal)
  const response = await http.request({ url: 'https://synthetic.invalid', fetchOptions: { redirect: 'manual' } })
  const next = response.body.next(); abort.abort()
  await assert.rejects(next, { name: 'AbortError', code: 'ABORT_ERR' })
  assert.equal(returned, 1); assert.equal(calls, 1)
  await assert.rejects(http.request({ url: 'https://synthetic.invalid' }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('synchronous body abort and iterator cleanup errors preserve cancellation without unhandled rejection', async () => {
  const abort = new AbortController()
  const http = cancellableHttp({ async request() { return { body: {
    [Symbol.asyncIterator]() { return this },
    next() { abort.abort(); return Promise.reject(new Error('stream closed')) },
    return() { throw new Error('iterator cleanup closed') },
  } } } }, abort.signal)
  const response = await http.request({})
  await assert.rejects(response.body.next(), { name: 'AbortError', code: 'ABORT_ERR' })
  await tick()
})
test('Git HTTP preserves successful streamed bodies and ordinary errors', async () => {
  const signal = new AbortController().signal
  const original = new Error('ordinary transport error')
  const failed = cancellableHttp({ async request() { throw original } }, signal)
  await assert.rejects(failed.request({}), error => error === original)
  const http = cancellableHttp({ async request() { return { body: (async function* () { yield Buffer.from('abc') })() } } }, signal)
  const response = await http.request({}); const rows = []
  for await (const row of response.body) rows.push(row)
  assert.equal(Buffer.concat(rows).toString(), 'abc')
})

test('cancelled Git push is confirmed once and never retried or falsely declared cancelled', async () => {
  for (const remote of ['new', 'old', null]) {
    let pushes = 0, reads = 0
    const result = await pushAndVerify({ localOid: 'new', push: async () => { pushes++; throw cancellationError() }, readRemote: async () => { reads++; return remote } })
    assert.equal(pushes, 1); assert.equal(reads, 1)
    assert.equal(result.ok, remote === 'new')
    if (remote === 'new') { assert.equal(result.recoveredFromCancellation, true); assert.equal(result.recoveredFromTimeout, false) }
    else assert.equal(result.confirmationPending, true)
  }
  const result = await pushAndVerify({ localOid: 'new', push: async () => { throw cancellationError() }, readRemote: async () => { throw new Error('offline') } })
  assert.equal(result.confirmationPending, true)
})

test('restore staging cancellation cleans its own incomplete plan without touching targets', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cancel-restore-'))
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), target = path.join(base, 'target.txt')
  fs.mkdirSync(path.join(repo, 'extras/doc'), { recursive: true }); fs.writeFileSync(target, 'original')
  fs.writeFileSync(path.join(repo, 'meta.json'), JSON.stringify({ schema: 2, extras: [{ name: 'doc', kind: 'file' }] }))
  fs.writeFileSync(path.join(repo, 'extras/doc/file.txt'), 'new bytes')
  const args = { workDir: repo, dshHome: home, cfg: { profiles: ['desktop'], extras: [{ name: 'doc', path: target, kind: 'file' }] }, codec: createCodec(os.homedir()), oid: 'synthetic' }
  try {
    const before = new AbortController(); before.abort()
    await assert.rejects(prepareRestore({ ...args, signal: before.signal }), { name: 'AbortError' })
    assert.equal(fs.existsSync(home), false)
    const during = new AbortController(); const progress = []
    await assert.rejects(prepareRestore({ ...args, signal: during.signal, onProgress(p) { progress.push(p); during.abort() } }), { name: 'AbortError' })
    assert.equal(fs.readFileSync(target, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(path.join(home, 'sync-restores')), [])
    assert.equal(progress[0].completedFiles, 1); assert.equal(progress[0].completedBytes, 9)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

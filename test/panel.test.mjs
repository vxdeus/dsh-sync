import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createCoordinator, createPanelController, createHttpHandler, sanitizeError } from '../lib/panel-api.js'
import { prepareRestore, applyRestore, safeRelative, validateExtraTarget } from '../lib/restore-safety.js'
import { createCodec, buildExtraManifest } from '../lib/pathcodec.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-panel-test-'))
const put = (base, rel, data) => { const dest = path.join(base, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); return dest }
function fakeController(options = {}) {
  const lock = createCoordinator()
  return createPanelController({ getState: () => ({ config: { tokenPresent: true }, status: {} }), lock,
    runUpload: args => lock.run(async () => ({ ok: true, summary: args.dryRun ? 'local' : 'sent' })),
    runDownload: () => lock.run(async () => ({ ok: true, summary: 'staged' })),
    saveExtra: async () => ({ ok: true }), removeExtra: async () => ({ ok: true }), ...options })
}
function request(method, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method; req.headers = headers; req.url = '/plugins/dsh-sync-ui/api'; return req
}
function response() {
  return { status: 0, body: null, headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } }
}

test('API rejects unauthenticated reads and writes before running anything', async () => {
  const c = fakeController({ getState() { throw new Error('must not execute') } })
  const handler = createHttpHandler(c, { requestRejection: () => 401 })
  for (const method of ['GET', 'POST']) { const res = response(); await handler(request(method, {}), res); assert.equal(res.status, 401) }
})
test('CSRF guard and explicit confirmation precede side effects', async () => {
  const c = fakeController(); const handler = createHttpHandler(c, { requestRejection: () => undefined })
  const noHeader = response(); await handler(request('POST', { action: 'upload', confirmed: true }), noHeader); assert.equal(noHeader.status, 403)
  const res = response(); await handler(request('POST', { action: 'upload' }, { 'x-dsh-sync-ui': '1', 'content-type': 'application/json' }), res)
  assert.equal(res.status, 400); assert.equal(c.state().job, null)
})
test('jobs are nonblocking, exclusive and duplicate requests are idempotent', async () => {
  const lock = createCoordinator(); let release, calls = 0
  const done = new Promise(r => { release = r })
  const c = fakeController({ lock, runUpload: () => lock.run(async () => { calls++; await done; return { ok: true, summary: 'done' } }) })
  const input = { action: 'upload', confirmed: true, requestId: 'same' }
  const a = await c.command(input); const b = await c.command(input)
  assert.equal(a.job.id, b.job.id)
  await assert.rejects(c.command({ action: 'download', confirmed: true }))
  await assert.rejects(c.command({ action: 'extra-remove', name: 'x' }))
  assert.equal(calls, 1); release(); await tick(); await tick()
  assert.equal(c.state().job.status, 'succeeded'); assert.equal(lock.busy, false)
})
test('failure result stays failed and token strings are redacted', async () => {
  const c = fakeController({ getSecrets: () => ['SECRET_CANARY'], runUpload: async () => { throw new Error('bad SECRET_CANARY') } })
  await c.command({ action: 'upload', confirmed: true }); await tick(); await tick()
  assert.equal(c.state().job.status, 'failed'); assert.ok(!JSON.stringify(c.state()).includes('SECRET_CANARY'))
  assert.ok(!sanitizeError('https://u:pass@host/?token=token1').includes('pass@'))
})
test('upload allowUnapplied is opt-in per request and only literal true reaches the host', async () => {
  for (const allowUnapplied of [undefined, false, true, 'true', 1, null, {}, ['true']]) {
    const calls = []
    const c = fakeController({ runUpload: async (args, exec) => { calls.push({ args, exec }); return { ok: true } } })
    await c.command({ action: 'upload', confirmed: true, allowUnapplied })
    await tick(); await tick()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, { dryRun: false, allowLarge: false, allowUnapplied: allowUnapplied === true })
    assert.equal(calls[0].exec.signal instanceof AbortSignal, true)
    await c.command({ action: 'upload', confirmed: true, dryRun: true })
    await tick(); await tick()
    assert.deepEqual(calls[1].args, { dryRun: true, allowLarge: false, allowUnapplied: false }, 'consent is never remembered for a later upload')
  }
})

test('download defaults online and forwards explicit offline through the existing single exec argument', async () => {
  for (const requested of [undefined, 'online', 'offline']) {
    const calls = []
    const c = fakeController({ runDownload: async (...args) => { calls.push(args); return { ok: true, copied: 2, deferred: 0 } } })
    const input = { action: 'download', confirmed: true, ...(requested === undefined ? {} : { mode: requested }) }
    const expected = requested || 'online'
    const started = await c.command(input)
    assert.equal(started.job.mode, expected)
    assert.equal(started.job.status, 'running')
    await tick(); await tick()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].length, 1, 'runDownload(exec) remains backward compatible')
    const exec = calls[0][0]
    assert.deepEqual(Object.keys(exec).sort(), ['mode', 'onProgress', 'signal'])
    assert.equal(exec.mode, expected)
    assert.equal(typeof exec.onProgress, 'function')
    assert.equal(exec.signal instanceof AbortSignal, true)
    assert.equal(c.state().job.mode, expected)
    assert.equal(c.state().job.status, 'succeeded')
  }
})

test('invalid download mode and missing confirmation reject before a job or executor is created', async () => {
  let calls = 0
  const c = fakeController({ runDownload: async () => { calls++; return { ok: true } } })
  for (const mode of ['', null, false, 0, 'ONLINE', 'auto', 'apply', {}, ['online']]) {
    await assert.rejects(c.command({ action: 'download', mode, confirmed: true }), /online.*offline/)
    assert.equal(c.state().job, null)
  }
  for (const mode of ['online', 'offline']) await assert.rejects(c.command({ action: 'download', mode }), /明确确认/)
  await tick()
  assert.equal(calls, 0)
})

test('download request id preserves the confirmed mode and cannot be reused to change it', async () => {
  let calls = 0
  const c = fakeController({ runDownload: async () => { calls++; return { ok: true } } })
  const request = { action: 'download', confirmed: true, requestId: 'download-once' }
  const started = await c.command(request)
  assert.equal((await c.command({ ...request, mode: 'online' })).job.id, started.job.id)
  await assert.rejects(c.command({ ...request, mode: 'offline' }), /标识.*模式/)
  await assert.rejects(c.command({ ...request, mode: 'invalid' }), /online.*offline/)
  await tick(); await tick()
  assert.equal(calls, 1)
})

test('partial or deferred results remain partial, preserve details, and cannot hide failures', async () => {
  for (const [result, status] of [
    [{ ok: true, partial: true, copied: 2, deferred: 0 }, 'partial'],
    [{ ok: true, copied: 2, deferred: 3 }, 'partial'],
    [{ ok: true, partial: false, copied: 0, deferred: 1 }, 'partial'],
    [{ ok: false, partial: true, copied: 2, deferred: 3 }, 'failed'],
    [{ ok: false, confirmationPending: true, partial: true, deferred: 3 }, 'unconfirmed'],
  ]) {
    const detailed = { ...result, summary: 'synthetic outcome', offlineCommand: 'synthetic offline command', stagedFiles: ['synthetic-file'] }
    const c = fakeController({ runDownload: async () => detailed })
    await c.command({ action: 'download', confirmed: true })
    await tick(); await tick()
    assert.equal(c.state().job.status, status)
    assert.equal(c.state().job.mode, 'online')
    assert.deepEqual(c.state().job.result, detailed)
    assert.ok(c.state().job.finishedAt)
    await c.command({ action: 'clear-result' })
    assert.equal(c.state().job, null)
  }
})

test('download HTTP rejects an invalid mode before transfer and accepts explicitly confirmed offline', async () => {
  const modes = []
  const c = fakeController({ runDownload: async exec => { modes.push(exec.mode); return { ok: true } } })
  const handler = createHttpHandler(c, { requestRejection: () => undefined })
  const headers = { 'x-dsh-sync-ui': '1', 'content-type': 'application/json' }
  const invalid = response()
  await handler(request('POST', { action: 'download', mode: 'force', confirmed: true }, headers), invalid)
  assert.equal(invalid.status, 400)
  assert.equal(c.state().job, null)
  assert.deepEqual(modes, [])
  const offline = response()
  await handler(request('POST', { action: 'download', mode: 'offline', confirmed: true }, headers), offline)
  assert.equal(offline.status, 202)
  assert.equal(offline.body.job.mode, 'offline')
  await tick(); await tick()
  assert.deepEqual(modes, ['offline'])
})

test('remote paths reject traversal, absolute paths, ADS and device names', () => {
  for (const p of ['../bad', '/etc/x', 'C:/x', 'a/../b', 'a\\b', 'a//b', 'a/con.txt', 'a/x:stream', 'a/ending.']) assert.throws(() => safeRelative(p), p)
  assert.equal(safeRelative('extras/demo/src/a.js'), 'extras/demo/src/a.js')
})
test('download stages bytes, does not overwrite; offline restore backs up single-file targets', async () => {
  const base = temporary()
  try {
    const home = path.join(base, 'home'), repo = path.join(base, 'repo'), target = put(base, 'project/result.txt', 'before')
    const bytes = Buffer.from([255, 254, 0, 35, 0, 95, 0, 95, 255])
    put(repo, 'meta.json', JSON.stringify({ schema: 2, extras: [{ name: 'doc', kind: 'file' }] }))
    put(repo, 'extras/doc/old-name.txt', bytes)
    const cfg = { profiles: ['desktop'], includeAttachments: true, extras: [{ name: 'doc', path: target, kind: 'file' }] }
    const result = await prepareRestore({ workDir: repo, dshHome: home, cfg, codec: createCodec(os.homedir()), oid: 'abc', hostPid: 0 })
    assert.equal(fs.readFileSync(target, 'utf8'), 'before')
    assert.equal(result.files, 1)
    const applied = await applyRestore(result.stage, { assertStopped: false })
    assert.deepEqual(fs.readFileSync(target), bytes)
    assert.equal(fs.readFileSync(path.join(applied.backup, '0.bin'), 'utf8'), 'before')
    await assert.rejects(applyRestore(result.stage, { assertStopped: false }), /已经执行/)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
test('rejects unallowlisted remote file before creating any restore stage', async () => {
  const base = temporary()
  try {
    const home = path.join(base, 'home'), repo = path.join(base, 'repo')
    put(repo, 'meta.json', '{"schema":2}'); put(repo, 'unexpected/startup.js', 'evil')
    await assert.rejects(prepareRestore({ workDir: repo, dshHome: home, cfg: { profiles: ['desktop'] }, codec: createCodec(os.homedir()), oid: 'x' }), /白名单/)
    assert.equal(fs.existsSync(path.join(home, 'sync-restores')), false)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
test('offline restore rejects destination changes and still-running host', async () => {
  const base = temporary()
  try {
    const home = path.join(base, 'home'), repo = path.join(base, 'repo'), target = put(base, 'project/file.txt', 'original')
    put(repo, 'meta.json', '{"schema":2}'); put(repo, 'extras/doc/file.txt', 'new')
    const cfg = { profiles: ['desktop'], extras: [{ name: 'doc', path: target, kind: 'file' }] }
    const prepared = await prepareRestore({ workDir: repo, dshHome: home, cfg, codec: createCodec(os.homedir()), oid: 'x' })
    await assert.rejects(applyRestore(prepared.stage), /退出/)
    fs.writeFileSync(target, 'work since download')
    await assert.rejects(applyRestore(prepared.stage, { assertStopped: false }), /已发生变化/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'work since download')
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
test('secrets are excluded from extra directory even if default exclusions are disabled', () => {
  const base = temporary()
  try {
    put(base, '.env.local', 'CANARY'); put(base, '.credentials.yaml', 'CANARY'); put(base, 'src/main.js', 'ok')
    const list = buildExtraManifest({ name: 'project', path: base, exclude: [] })
    assert.equal(list.length, 1); assert.ok(list[0].abs.endsWith('main.js'))
    assert.throws(() => validateExtraTarget(os.homedir(), 'directory', path.join(os.homedir(), '.dsh')))
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
test('source or destination junction is refused', async t => {
  const base = temporary()
  try {
    const external = path.join(base, 'external'), link = path.join(base, 'link'); fs.mkdirSync(external)
    try { fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir') } catch { t.skip('junction unavailable'); return }
    assert.throws(() => validateExtraTarget(path.join(link, 'out'), 'directory', path.join(base, 'home')), /链接|junction/)
    fs.unlinkSync(link)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

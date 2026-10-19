import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { prepareRestore, applyRestore, hash } from '../lib/restore-safety.js'
import { applyLiveRestore, liveRuntime } from '../lib/live-restore.js'
import { createCodec } from '../lib/pathcodec.js'

const clone = value => JSON.parse(JSON.stringify(value))
const catalog = {
  currentVersion: 4,
  createRestore(physical, options) {
    assert.deepEqual(options, { recovery: 'strict', validation: 'current' })
    if (physical.version !== 4) throw new Error('unsupported')
    const { type, ...header } = physical, events = []
    return { decodeRow(event) { if (event.seq !== events.length) throw new Error('sequence'); events.push(event) }, finish() { return { header, events, inheritedEventCount: 0 } } }
  },
}
function fakeRuntime() {
  const logs = new Map(), loaded = new Map(), held = new Set(), operations = [], attached = []
  const rt = {
    logs, loaded, held, operations, attached,
    catalog: async () => catalog,
    busyPaths: () => [],
    sessions: {
      get: id => loaded.get(id), list: () => [...loaded.values()],
      prepare(id, options) { operations.push(['prepare', id]); if (loaded.has(id)) throw new Error('loaded'); assert.equal(options.eventState, 'detached') },
    },
    persistence: {
      async stat(id) { return logs.has(id) ? { header: logs.get(id).header } : undefined },
      async create(header, options) {
        if (logs.has(header.id)) { const e = new Error('exists'); e.name = 'SessionAlreadyExistsError'; throw e }
        logs.set(header.id, { header: clone(header), inheritedEventCount: options.inheritedEventCount, events: [] })
        operations.push(['create', header.id]); return this.open(header.id, 'write')
      },
      async open(id, access) {
        assert.equal(access, 'write')
        if (held.has(id)) { const e = new Error('busy'); e.name = 'SessionAlreadyOwnedError'; throw e }
        held.add(id); operations.push(['open', id])
        const log = logs.get(id)
        return {
          header: log.header, inheritedEventCount: log.inheritedEventCount,
          async read() { return { events: clone(log.events) } },
          async append(events) { operations.push(['append', id]); log.events.push(...clone(events)); rt.onAppend?.(id) },
          async flush() { operations.push(['flush', id]); if (rt.failFlush) throw new Error('simulated-disk-failure') },
          async close() { operations.push(['close', id]); held.delete(id) },
        }
      },
    },
    query: { async readSession() { throw new Error('unexpected') } },
    workspaces: {
      async resolveByPath() { return { async attachSession(id) { attached.push(id) } } },
      async create() { throw new Error('not expected') },
    },
    add(log, live = false) {
      logs.set(log.header.id, clone(log))
      if (live) loaded.set(log.header.id, { ...clone(log), snapshotEvents: () => clone(log.events) })
    },
  }
  return rt
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-online-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dshHome = path.join(root, 'home'), workDir = path.join(root, 'remote'), project = path.join(root, 'project')
  fs.mkdirSync(project); fs.mkdirSync(workDir)
  const put = (base, rel, data) => { const file = path.join(base, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file }
  put(workDir, 'meta.json', JSON.stringify({ schema: 2 }))
  const cfg = { profiles: ['desktop'], includeAttachments: true, extras: [{ name: 'project', path: project, kind: 'directory' }] }
  const codec = createCodec(os.homedir()), runtime = fakeRuntime()
  const options = { dshHome, cfg, codec, runtime }
  const makeLog = (id, length = 1) => ({ header: { version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: project }, inheritedEventCount: 0, events: Array.from({ length }, (_, seq) => ({ type: 'fixture', seq, time: seq + 1, data: { text: 'same-' + seq } })) })
  const remoteLog = log => put(workDir, `sessions/work/${log.header.id}/session.v4.jsonl`, [JSON.stringify({ type: 'session', ...log.header }), ...log.events.map(x => JSON.stringify(x))].join('\n') + '\n')
  const prepare = () => prepareRestore({ workDir, ...options, oid: 'test', online: true })
  return { root, dshHome, workDir, project, put, cfg, codec, runtime, options, makeLog, remoteLog, prepare }
}

test('online imports with exclusive native handles, backs up extras, and defers runtime state', async t => {
  const f = fixture(t), log = f.makeLog('new')
  f.remoteLog(log)
  f.put(f.project, 'file.txt', 'old'); f.put(f.workDir, 'extras/project/file.txt', 'new')
  f.put(f.dshHome, 'state/runtime.json', '{"local":1}'); f.put(f.workDir, 'state/runtime.json', '{"remote":2}')
  f.put(f.workDir, '.agent-presets/evil/run.mjs', 'throw new Error("never execute")')
  const object = Buffer.from('fixture object'), digest = hash(object)
  f.put(f.workDir, `attachments/v1/objects/${digest.slice(0, 2)}/${digest}`, object)
  const stage = (await f.prepare()).stage
  await assert.rejects(applyRestore(stage, { assertStopped: false }), /在线计划/)
  const result = await applyLiveRestore(stage, f.options)
  assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(result.deferred, 2)
  assert.equal(result.copied, 3)
  assert.deepEqual(f.runtime.logs.get('new'), log)
  assert.deepEqual(f.runtime.operations.filter(x => x[0] !== 'prepare').map(x => x[0]), ['create', 'open', 'append', 'flush', 'close'])
  assert.deepEqual(f.runtime.attached, ['new'])
  assert.equal(fs.readFileSync(path.join(f.project, 'file.txt'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(f.dshHome, 'state/runtime.json'), 'utf8'), '{"local":1}')
  assert.equal(fs.existsSync(path.join(f.dshHome, '.agent-presets')), false)
  const backup = path.join(stage, 'online-files/backup')
  assert.ok(fs.readdirSync(backup).some(name => fs.readFileSync(path.join(backup, name), 'utf8') === 'old'))
  assert.equal(f.runtime.held.size, 0)
  await assert.rejects(applyLiveRestore(stage, f.options), /EEXIST/)
})

test('loaded idle sessions are preserved; identical and local-newer histories are not pending', async t => {
  const f = fixture(t)
  const old = f.makeLog('live', 1); f.runtime.add(old, true); f.remoteLog(f.makeLog('live', 2))
  const same = f.makeLog('same'); f.runtime.add(same, true); f.remoteLog(same)
  f.runtime.add(f.makeLog('newer', 3), true); f.remoteLog(f.makeLog('newer', 2))
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.deferred, 1); assert.equal(result.copied, 0)
  assert.deepEqual(f.runtime.logs.get('live'), old)
  assert.equal(f.runtime.operations.length, 0)
})

test('cold history accepts strict prefix append but never divergence or truncation', async t => {
  const f = fixture(t)
  f.runtime.add(f.makeLog('append', 1)); f.remoteLog(f.makeLog('append', 3))
  const divergent = f.makeLog('branch', 1); divergent.events[0].data.text = 'different'
  f.runtime.add(divergent); f.remoteLog(f.makeLog('branch', 2))
  f.runtime.add(f.makeLog('newer', 3)); f.remoteLog(f.makeLog('newer', 1))
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.copied, 1); assert.equal(result.deferred, 1)
  assert.equal(f.runtime.logs.get('append').events.length, 3)
  assert.deepEqual(f.runtime.logs.get('branch'), divergent)
  assert.equal(f.runtime.logs.get('newer').events.length, 3)
  assert.equal(f.runtime.held.size, 0)
  const second = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(second.copied, 0); assert.equal(f.runtime.logs.get('append').events.length, 3)
})

test('writer ownership race never falls back to raw session writes', async t => {
  const f = fixture(t), old = f.makeLog('busy', 1)
  f.runtime.add(old); f.runtime.held.add('busy'); f.remoteLog(f.makeLog('busy', 2))
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.deferred, 1); assert.deepEqual(f.runtime.logs.get('busy'), old)
  assert.equal(fs.existsSync(path.join(f.dshHome, 'sessions')), false)
})

test('session loaded during prepare is skipped at commit', async t => {
  const f = fixture(t), old = f.makeLog('race')
  f.runtime.add(old); f.remoteLog(f.makeLog('race', 2))
  f.runtime.sessions.prepare = () => f.runtime.add(old, true)
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.copied, 0); assert.equal(result.deferred, 1)
})

test('file conflict aborts before any session import', async t => {
  const f = fixture(t)
  f.put(f.project, 'x', 'old'); f.put(f.workDir, 'extras/project/x', 'remote'); f.remoteLog(f.makeLog('new'))
  const stage = (await f.prepare()).stage
  f.put(f.project, 'x', 'user edit')
  const result = await applyLiveRestore(stage, f.options)
  assert.equal(result.ok, false); assert.equal(result.copied, 0)
  assert.equal(f.runtime.logs.size, 0)
  assert.equal(fs.readFileSync(path.join(f.project, 'x'), 'utf8'), 'user edit')
})

test('busy workspaces are deferred while independent history can import', async t => {
  const f = fixture(t)
  f.runtime.busyPaths = () => [f.project]
  f.put(f.project, 'x', 'old'); f.put(f.workDir, 'extras/project/x', 'remote'); f.remoteLog(f.makeLog('new'))
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.ok, true); assert.equal(result.deferred, 1); assert.equal(result.copied, 1)
  assert.equal(fs.readFileSync(path.join(f.project, 'x'), 'utf8'), 'old')
})

test('tampered source hash or destination is rejected before all target writes', async t => {
  for (const attack of ['bytes', 'destination']) {
    const f = fixture(t); f.put(f.workDir, 'extras/project/x', 'remote')
    const stage = (await f.prepare()).stage, planPath = path.join(stage, 'plan.json')
    const plan = JSON.parse(fs.readFileSync(planPath))
    if (attack === 'bytes') fs.writeFileSync(path.join(stage, plan.files[0].source), 'evil')
    else { plan.files[0].destination = path.join(f.root, 'escape'); fs.writeFileSync(planPath, JSON.stringify(plan)) }
    await assert.rejects(applyLiveRestore(stage, f.options), /哈希|目标被修改/)
    assert.equal(fs.existsSync(path.join(f.project, 'x')), false); assert.equal(fs.existsSync(path.join(f.root, 'escape')), false)
  }
})

test('malformed/unsupported sessions are deferred rather than imported', async t => {
  const f = fixture(t)
  f.put(f.workDir, 'sessions/work/bad/session.v4.jsonl', '{"type":"session","version":999}\n')
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(result.deferred, 1)
  assert.equal(f.runtime.logs.size, 0)
})

test('duplicate logical IDs reject before any project or history changes', async t => {
  const f = fixture(t), file = f.remoteLog(f.makeLog('same'))
  f.put(f.workDir, 'sessions/another/same/session.v4.jsonl', fs.readFileSync(file))
  f.put(f.workDir, 'extras/project/x', 'new')
  await assert.rejects(applyLiveRestore((await f.prepare()).stage, f.options), /重复会话 ID/)
  assert.equal(f.runtime.logs.size, 0); assert.equal(fs.existsSync(path.join(f.project, 'x')), false)
})

test('pre-cancel is write-free and cancellation after a commit reports partial truthfully', async t => {
  const f = fixture(t); f.remoteLog(f.makeLog('one')); f.remoteLog(f.makeLog('two'))
  const stage = (await f.prepare()).stage
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(applyLiveRestore(stage, { ...f.options, signal: cancelled.signal }), { name: 'AbortError' })
  assert.equal(fs.existsSync(path.join(stage, 'online-result.json')), false)
  const abort = new AbortController(); f.runtime.onAppend = () => abort.abort()
  const result = await applyLiveRestore(stage, { ...f.options, signal: abort.signal })
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.copied, 1)
  assert.equal(f.runtime.logs.size, 1); assert.equal(f.runtime.held.size, 0)
  assert.match(result.summary, /已取消后续应用/)
})

test('durability failure never claims successful import and releases writer', async t => {
  const f = fixture(t); f.runtime.failFlush = true; f.remoteLog(f.makeLog('new'))
  const stage = (await f.prepare()).stage, result = await applyLiveRestore(stage, f.options)
  assert.equal(result.ok, false); assert.equal(result.copied, 0); assert.equal(f.runtime.held.size, 0)
  const journal = JSON.parse(fs.readFileSync(path.join(stage, 'online-result.json')))
  assert.equal(journal.sessions[0].status, 'writing')
})

test('sensitive extra sources and renamed sensitive targets are rejected', async t => {
  for (const rel of ['.ssh/key', 'id_ed25519', '.npmrc', 'private.pfx', '.git-credentials']) {
    const f = fixture(t); f.put(f.workDir, 'extras/project/' + rel, 'not-a-real-secret')
    await assert.rejects(f.prepare(), /敏感/)
  }
  const f = fixture(t); f.cfg.extras = [{ name: 'project', kind: 'file', path: path.join(f.project, '.npmrc') }]
  f.put(f.workDir, 'extras/project/innocent.txt', 'not-a-real-secret')
  await assert.rejects(f.prepare(), /敏感/)
})

test('databases, renamed SQLite payloads and transaction sidecars are deferred', async t => {
  const f = fixture(t)
  for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.db-shm', 'file-journal']) {
    f.put(f.workDir, 'extras/project/' + name, 'remote-db')
    f.put(f.project, name, 'local-db')
  }
  f.put(f.workDir, 'extras/project/renamed.bin', Buffer.from('SQLite format 3\0payload'))
  f.put(f.project, 'local-custom.data', Buffer.from('SQLite format 3\0local'))
  f.put(f.workDir, 'extras/project/local-custom.data', 'not a database')
  const result = await applyLiveRestore((await f.prepare()).stage, f.options)
  assert.equal(result.deferred, 6); assert.equal(result.copied, 0)
  assert.equal(fs.readFileSync(path.join(f.project, 'app.sqlite'), 'utf8'), 'local-db')
  assert.equal(fs.existsSync(path.join(f.project, 'renamed.bin')), false)
})
test('runtime capability probing fails closed without accessing undeclared ctx services', () => {
  assert.equal(liveRuntime({}), null)
  assert.equal(liveRuntime({ get() { throw new Error('unavailable') } }), null)
})

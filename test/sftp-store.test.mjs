import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { validateSftpConfig, createSftpStore } from '../lib/sftp-store.js'

const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)])
const config = { host: 'sync.example.invalid', privateKeyPath: path.resolve('fake-test-key-never-read'), hostKey: 'ssh-ed25519 ' + key.toString('base64') }
const hash = data => createHash('sha256').update(data).digest('hex')
function manifest(files) { const body = { version: 1, files }; return { ...body, id: hash(JSON.stringify(body)) } }
function mock() {
  const objects = new Map(), dirs = new Set(['/data']), calls = [], puts = [], gets = [], transfers = []
  const runner = async request => {
    calls.push(request)
    let stderr = ''
    for (let line of request.batch.trim().split('\n')) {
      const optional = line.startsWith('-'); if (optional) line = line.slice(1)
      const tokens = line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g).map(t => t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
      const [op, a, b] = tokens
      try {
        if (op === 'mkdir') { if (dirs.has(a)) throw Error('File exists'); dirs.add(a) }
        else if (op === 'rmdir') { if (!dirs.delete(a)) throw Error('No such file') }
        else if (op === 'ls') { if (!dirs.has(a)) throw Error('No such file') }
        else if (op === 'get') { gets.push(a); if (!objects.has(a)) throw Error('No such file'); await fs.writeFile(b, objects.get(a)); transfers.push({ op, remote: a, bytes: objects.get(a).length }) }
        else if (op === 'put') { puts.push(b); objects.set(b, await fs.readFile(a)); transfers.push({ op, remote: b, bytes: objects.get(b).length }) }
        else if (op === 'rename') { if (!objects.has(a)) throw Error('No such file'); objects.set(b, objects.get(a)); objects.delete(a) }
        else throw Error('Unsupported mock operation ' + op)
      } catch (e) { stderr += e.message + '\n'; if (!optional) return { code: 1, stderr } }
    }
    return { code: 0, stderr }
  }
  return { runner, objects, dirs, calls, puts, gets, transfers }
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.resolve('.sftp-unit-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const work = path.join(base, 'work'), cache = path.join(base, 'cache')
  await fs.mkdir(path.join(work, 'extras', 'demo'), { recursive: true })
  await fs.writeFile(path.join(work, 'meta.json'), '{"portable":true}')
  await fs.writeFile(path.join(work, 'extras', 'demo', 'hello.txt'), 'hello')
  const server = mock(), store = createSftpStore(config, { cacheDir: cache, runner: server.runner })
  return { base, work, cache, server, store }
}
test('pin is mandatory and configuration rejects injection and unsafe root', () => {
  assert.throws(() => validateSftpConfig({ ...config, hostKey: undefined }), /pinned/)
  assert.throws(() => validateSftpConfig({ ...config, hostKey: 'ssh-ed25519 AAAA' }), /Invalid/)
  for (const update of [{ host: '-oProxyCommand=evil' }, { host: 'host\nput x y' }, { username: 'x@evil' }, { remoteRoot: '/data/../root' }, { remoteRoot: '/tmp/a' }, { remoteRoot: '/data/foo/.git' }, { privateKeyPath: '/tmp/a\nput x y' }, { port: 0 }]) assert.throws(() => validateSftpConfig({ ...config, ...update }))
  assert.equal(validateSftpConfig(config).port, 22)
  assert.equal(validateSftpConfig(config).username, 'dshsync')
})
test('upload pins OpenSSH, skips .git, publishes by rename and reuses verified objects', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.work, '.git')); await fs.writeFile(path.join(f.work, '.git', 'secret'), 'ignored')
  assert.equal(await f.store.inspect(), null)
  const first = await f.store.upload(f.work)
  assert.equal(first.verified, true); assert.equal(first.files.length, 2)
  assert.equal(first.bytes, 22)
  const request = f.server.calls[0]
  assert.equal(request.command, 'sftp')
  assert.equal(request.args[request.args.indexOf('-B') + 1], '131072')
  assert.equal(request.args[request.args.indexOf('-R') + 1], '64')
  assert.ok(request.args.includes('StrictHostKeyChecking=yes'))
  assert.ok(request.args.some(a => a.startsWith('UserKnownHostsFile=')))
  assert.ok(request.args.includes('HostKeyAlgorithms=ssh-ed25519'))
  if (process.platform === 'win32') assert.ok(request.args.includes('KexAlgorithms=curve25519-sha256'))
  assert.ok(f.server.calls.some(c => /put .*latest\..*\.tmp"\nrename .*latest\.json"/.test(c.batch)))
  const count = f.server.puts.filter(p => p.includes('/objects/')).length
  const second = await f.store.upload(f.work, { expectedId: first.id })
  assert.equal(second.id, first.id)
  assert.equal(f.server.puts.filter(p => p.includes('/objects/')).length, count)
  assert.equal(f.server.puts.filter(p => p.includes('/snapshots/')).length, 1)
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
})
test('expectedId is compared under exclusive lock and busy lock is never released', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work)
  await assert.rejects(f.store.upload(f.work), /expectedId.*download first/)
  await assert.rejects(f.store.upload(f.work, { expectedId: 'a'.repeat(64) }), /expectedId/)
  assert.equal((await f.store.inspect()).id, first.id)
  f.server.dirs.add('/data/dsh-sync/.lock')
  await assert.rejects(f.store.upload(f.work, { expectedId: first.id }), /lock acquisition failed/)
  assert.ok(f.server.dirs.has('/data/dsh-sync/.lock'))
})
test('download verifies all hashes before replacing existing tree', async t => {
  const f = await fixture(t), uploaded = await f.store.upload(f.work)
  const dest = path.join(f.base, 'dest'); await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'old.txt'), 'keep')
  const objectPath = '/data/dsh-sync/objects/' + uploaded.files[0].sha256
  const good = f.server.objects.get(objectPath)
  f.server.objects.set(objectPath, Buffer.from('tampered'))
  await assert.rejects(f.store.download(dest), /hash|size|oversized/)
  assert.equal(await fs.readFile(path.join(dest, 'old.txt'), 'utf8'), 'keep')
  f.server.objects.set(objectPath, good)
  const result = await f.store.download(dest)
  assert.equal(result.id, uploaded.id)
  assert.equal(await fs.readFile(path.join(dest, 'extras', 'demo', 'hello.txt'), 'utf8'), 'hello')
  await assert.rejects(fs.stat(path.join(dest, 'old.txt')), { code: 'ENOENT' })
})
test('missing reused object is repaired; corrupt reused object aborts before publish', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work)
  const object = '/data/dsh-sync/objects/' + first.files[0].sha256
  f.server.objects.delete(object)
  await f.store.upload(f.work, { expectedId: first.id })
  assert.ok(f.server.objects.has(object))
  f.server.objects.set(object, Buffer.from('bad'))
  await assert.rejects(f.store.upload(f.work, { expectedId: first.id }), /hash|size/)
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
})
test('strict remote manifest rejects tamper, duplicate paths, traversal, .git and limits', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work)
  const latest = '/data/dsh-sync/latest.json'
  for (const m of [
    { ...first, version: 2 },
    { version: 1, id: '0'.repeat(64), files: first.files },
    manifest([first.files[0], first.files[0], first.files[1]]),
    manifest([{ ...first.files[0], rel: '../escape' }, first.files[1]]),
    manifest([{ ...first.files[0], rel: '.git/config' }, first.files[1]]),
    manifest([{ ...first.files[0], rel: 'extras/x\nput evil' }, first.files[1]]),
    manifest([{ ...first.files[0], size: 101 * 1024 ** 3 }, first.files[1]]),
    manifest([{ ...first.files[0], sha256: 'INVALID' }, first.files[1]]),
  ]) {
    f.server.objects.set(latest, Buffer.from(JSON.stringify(m)))
    await assert.rejects(f.store.inspect())
  }
})
test('batch lexer safely quotes local spaces and rejects newline file names', async t => {
  const f = await fixture(t)
  const work = path.join(f.base, 'directory with spaces'); await fs.rename(f.work, work)
  await f.store.upload(work)
  if (process.platform !== 'win32') {
    await fs.writeFile(path.join(work, 'bad\nput injected'), 'x')
    await assert.rejects(f.store.upload(work), /Unsafe relative/)
  }
})
test('sensitive snapshot filenames are rejected without reading key files', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.work, 'extras', 'demo', 'id_ed25519'), 'synthetic not a key')
  await assert.rejects(f.store.upload(f.work), /Credentials/)
})
test('hardlinks are rejected before upload', async t => {
  const f = await fixture(t)
  await fs.link(path.join(f.work, 'meta.json'), path.join(f.work, 'duplicate.json'))
  await assert.rejects(f.store.upload(f.work), /Unsafe/)
  assert.equal(f.server.puts.length, 0)
})
test('transport and permission failures never become empty latest', async t => {
  const f = await fixture(t)
  for (const result of [{ code: 0, stderr: 'Permission denied' }, { code: 1, stderr: 'network down' }, { code: 0, stderr: '' }]) {
    const store = createSftpStore(config, { cacheDir: f.cache, runner: async () => result })
    await assert.rejects(store.inspect())
  }
})
test('latest is re-read after acquiring lock, not before it', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work)
  const altered = manifest(first.files.map(file => ({ ...file, size: file.size + 1 })))
  const runner = async request => {
    const result = await f.server.runner(request)
    if (request.batch.includes('mkdir "/data/dsh-sync/.lock"')) f.server.objects.set('/data/dsh-sync/latest.json', Buffer.from(JSON.stringify(altered)))
    return result
  }
  const store = createSftpStore(config, { cacheDir: f.cache, runner })
  await assert.rejects(store.upload(f.work, { expectedId: first.id }), /expectedId/)
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
})
test('deduplicated objects use one readback and fewer SSH batches, including unchanged upload', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.work, 'duplicate.txt'), 'hello')
  const first = await f.store.upload(f.work)
  assert.equal(f.server.calls.length, 6) // old implementation: 11 (including unlock)
  const objectTransfers = () => f.server.transfers.filter(x => x.remote.includes('/objects/'))
  assert.equal(objectTransfers().filter(x => x.op === 'put').length, 2)
  assert.equal(objectTransfers().filter(x => x.op === 'get').length, 2)
  assert.equal(objectTransfers().reduce((n, x) => n + x.bytes, 0), 44)
  const start = f.server.calls.length, wire = f.server.transfers.length, gets = f.server.gets.length
  await f.store.upload(f.work, { expectedId: first.id })
  assert.equal(f.server.calls.length - start, 4) // old unchanged implementation: 9 (including unlock)
  const reused = f.server.transfers.slice(wire).filter(x => x.remote.includes('/objects/'))
  assert.equal(reused.reduce((n, x) => n + x.bytes, 0), 22) // old: 44
  assert.equal(reused.filter(x => x.op === 'get').length, 2)
  assert.equal(reused.filter(x => x.op === 'put').length, 0)
  assert.equal(f.server.gets.slice(gets).filter(x => x.includes('/objects/')).length, 2)
  assert.equal(f.server.transfers.slice(wire).filter(x => x.op === 'put').length, 0)
  assert.ok(!f.server.calls.slice(start).some(x => x.batch.includes('\nrename ')))
  const object = '/data/dsh-sync/objects/' + first.files.find(x => x.rel === 'meta.json').sha256
  f.server.objects.delete(object)
  const repairStart = f.server.transfers.length
  await f.store.upload(f.work, { expectedId: first.id })
  const repair = f.server.transfers.slice(repairStart).filter(x => x.remote === object)
  assert.deepEqual(repair.map(x => x.op), ['put', 'get'])
})

test('unchanged fast path still verifies every hash and republishes missing immutable metadata', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work), events = []
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, onProgress: event => events.push(event) })
  await store.upload(f.work, { expectedId: first.id })
  assert.ok(!events.some(x => x.phase === 'publish'))
  assert.equal(events.at(-1).connections, 4)
  assert.equal(events.at(-1).phase, 'done')
  const snapshot = '/data/dsh-sync/snapshots/' + first.id + '.json'
  f.server.objects.delete(snapshot)
  events.length = 0
  const start = f.server.calls.length
  await store.upload(f.work, { expectedId: first.id })
  assert.equal(f.server.calls.length - start, 5)
  assert.ok(f.server.objects.has(snapshot))
  assert.ok(events.some(x => x.phase === 'publish'))
  events.length = 0
  f.server.objects.set('/data/dsh-sync/objects/' + first.files[0].sha256, Buffer.from('bad'))
  await assert.rejects(store.upload(f.work, { expectedId: first.id }), /hash|size/)
  assert.ok(!events.some(x => x.phase === 'done' || x.phase === 'publish'))
})

test('progress reports actual confirmed wire bytes, phases and connections; observer errors are isolated', async t => {
  const f = await fixture(t), events = []
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, onProgress: event => { events.push(event); throw Error('observer only') } })
  const uploaded = await store.upload(f.work)
  const done = events.at(-1)
  assert.equal(done.phase, 'done')
  assert.equal(done.completedBytes, uploaded.bytes)
  assert.equal(done.completedFiles, uploaded.files.length)
  assert.equal(done.connections, f.server.calls.length)
  assert.equal(done.transferredBytes, f.server.transfers.reduce((n, x) => n + x.bytes, 0))
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['phase', 'completedBytes', 'totalBytes', 'completedFiles', 'totalFiles', 'transferredBytes', 'connections', 'elapsedMs', 'speedBytesPerSecond'].sort())
    for (const [key, value] of Object.entries(event)) if (key !== 'phase') assert.ok(Number.isFinite(value) && value >= 0)
  }
  assert.ok(events.some(x => x.phase === 'scan'))
  assert.ok(events.some(x => x.phase === 'upload' && x.completedBytes === 0 && x.totalBytes === 22))
  assert.ok(events.some(x => x.phase === 'verify'))
  assert.ok(events.some(x => x.phase === 'publish'))
  for (let i = 1; i < events.length; i++) assert.ok(events[i].transferredBytes >= events[i - 1].transferredBytes)
  events.length = 0
  await store.download(path.join(f.base, 'restored'))
  assert.ok(events.some(x => x.phase === 'download'))
  assert.ok(events.some(x => x.phase === 'restore'))
  assert.equal(events.at(-1).phase, 'done')
  events.length = 0
  f.server.objects.set('/data/dsh-sync/objects/' + uploaded.files[0].sha256, Buffer.from('bad'))
  await assert.rejects(store.upload(f.work, { expectedId: uploaded.id }), /hash|size/)
  assert.ok(!events.some(x => x.phase === 'done'))
})

test('download stat progress is available to compatible runners without estimating upload bytes', async t => {
  const f = await fixture(t), events = []
  const first = await f.store.upload(f.work)
  let observed = false
  const runner = async request => {
    const line = request.batch.split('\n').find(line => line.startsWith('get ') && line.includes('/objects/'))
    if (line) {
      const tokens = line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g).map(t => t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
      const before = events.at(-1).transferredBytes
      await fs.writeFile(tokens[2], Buffer.from('he'))
      await request.reportDownloads()
      const partial = events.at(-1)
      assert.equal(partial.phase, 'download')
      assert.equal(partial.completedBytes, 2)
      assert.equal(partial.totalBytes, first.bytes)
      assert.equal(partial.completedFiles, 0, 'received bytes are not hash-verified files')
      assert.equal(partial.transferredBytes, before + 2)
      await request.reportDownloads()
      assert.equal(events.at(-1).transferredBytes, partial.transferredBytes, 'repeated stat must not double count')
      await fs.appendFile(tokens[2], Buffer.from('l'))
      await request.reportDownloads()
      assert.equal(events.at(-1).completedBytes, 3)
      assert.equal(events.at(-1).transferredBytes, before + 3)
      observed = true
    }
    return f.server.runner(request)
  }
  const store = createSftpStore(config, { cacheDir: f.cache, runner, onProgress: event => events.push(event) })
  const downloaded = await store.download(path.join(f.base, 'stat-progress'))
  assert.equal(downloaded.id, first.id)
  assert.ok(observed)
  assert.equal(events.at(-1).connections, 2)
  const downloads = events.filter(event => event.phase === 'download')
  assert.equal(downloads.at(-1).completedBytes, first.bytes, 'verification must not add received bytes twice')
  assert.equal(downloads.at(-1).completedFiles, 2)
  assert.equal(events.at(-1).transferredBytes, Buffer.byteLength(JSON.stringify(manifest(first.files))) + first.bytes)
})

test('partial download failure reports received bytes but never restores or signals done', async t => {
  for (const failure of ['transport', 'truncated']) {
    const f = await fixture(t), first = await f.store.upload(f.work), events = []
    const dest = path.join(f.base, 'partial-dest')
    await fs.mkdir(dest)
    await fs.writeFile(path.join(dest, 'old.txt'), 'keep')
    const runner = async request => {
      const line = request.batch.split('\n').find(line => line.startsWith('get ') && line.includes('/objects/'))
      if (!line) return f.server.runner(request)
      const tokens = line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g).map(t => t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
      const data = f.server.objects.get(tokens[1])
      await fs.writeFile(tokens[2], data.subarray(0, 2))
      await request.reportDownloads()
      if (failure === 'transport') throw new Error('synthetic connection lost')
      return { code: 0, stderr: '' }
    }
    const store = createSftpStore(config, { cacheDir: f.cache, runner, onProgress: event => events.push(event) })
    await assert.rejects(store.download(dest), failure === 'transport' ? /connection lost/ : /hash\/size mismatch/)
    const partial = events.filter(event => event.phase === 'download').at(-1)
    assert.equal(partial.completedBytes, 2)
    assert.equal(partial.totalBytes, first.bytes)
    assert.equal(partial.completedFiles, 0)
    assert.equal(partial.transferredBytes, Buffer.byteLength(JSON.stringify(manifest(first.files))) + 2)
    assert.ok(!events.some(event => event.phase === 'restore' || event.phase === 'done'))
    assert.equal(await fs.readFile(path.join(dest, 'old.txt'), 'utf8'), 'keep')
    assert.deepEqual(await fs.readdir(dest), ['old.txt'])
    assert.deepEqual(await fs.readdir(f.cache), [], 'failed download must clean temporary payloads')
  }
})

test('scan and publish preserve completed counters with unknown zero totals', async t => {
  const f = await fixture(t), events = []
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, onProgress: event => events.push(event) })
  const uploaded = await store.upload(f.work)
  const scan = events.filter(event => event.phase === 'scan').at(-1)
  assert.equal(scan.totalBytes, 0)
  assert.equal(scan.totalFiles, 0)
  assert.equal(scan.completedBytes, uploaded.bytes)
  assert.equal(scan.completedFiles, uploaded.files.length)
  for (const phase of ['connect', 'publish']) {
    const stages = events.filter(event => event.phase === phase)
    assert.ok(stages.length > 0)
    assert.ok(stages.every(event => event.totalBytes === 0 && event.totalFiles === 0))
  }
})

test('immutable snapshot mismatch never reports done', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work), events = []
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, onProgress: event => events.push(event) })
  const altered = manifest(first.files.map(file => ({ ...file, size: file.size + 1 })))
  f.server.objects.set('/data/dsh-sync/snapshots/' + first.id + '.json', Buffer.from(JSON.stringify(altered)))
  const before = f.server.puts.length
  await assert.rejects(store.upload(f.work, { expectedId: first.id }), /Immutable/)
  assert.equal(f.server.puts.length, before)
  assert.ok(!events.some(x => x.phase === 'done'))
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
})

test('new object readback corruption cannot publish; confirmation or unlock failure cannot report done', async t => {
  for (const failure of ['object', 'confirmation', 'unlock']) {
    const f = await fixture(t), events = []
    const runner = async request => {
      if (failure === 'unlock' && request.batch.startsWith('rmdir ')) return { code: 1, stderr: 'synthetic unlock failure' }
      const result = await f.server.runner(request)
      const line = request.batch.split('\n').find(line => failure === 'object' ? line.startsWith('get ') && line.includes('/objects/') : line.startsWith('-get ') && line.includes('/latest.json') && request.batch.includes('\nrename '))
      if (line) {
        const tokens = line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g).map(t => t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
        await fs.writeFile(tokens[2], Buffer.from('bad'))
      }
      return result
    }
    const store = createSftpStore(config, { cacheDir: f.cache, runner, onProgress: event => events.push(event) })
    await assert.rejects(store.upload(f.work), /hash|size|manifest|unlock/i)
    assert.ok(!events.some(x => x.phase === 'done'))
    if (failure === 'object') assert.ok(!f.server.objects.has('/data/dsh-sync/latest.json'))
    if (failure !== 'unlock') assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
  }
})

test('failed atomic rename leaves previous latest intact and releases owned lock', async t => {
  const f = await fixture(t), first = await f.store.upload(f.work)
  await fs.writeFile(path.join(f.work, 'meta.json'), '{"portable":true,"new":true}')
  const runner = async request => request.batch.includes('\nrename ') ? { code: 1, stderr: 'synthetic publish failure' } : f.server.runner(request)
  const store = createSftpStore(config, { cacheDir: f.cache, runner })
  await assert.rejects(store.upload(f.work, { expectedId: first.id }), /publish failure/)
  assert.equal((await f.store.inspect()).id, first.id)
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
})


const isCancelled = error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR'
async function cleanCache(cache) {
  assert.deepEqual(await fs.readdir(cache).catch(e => { if (e.code === 'ENOENT') return []; throw e }), [])
}
test('pre-cancelled inspect/upload/download neither run batches nor touch destinations', async t => {
  const f = await fixture(t), controller = new AbortController(), events = []
  controller.abort()
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, signal: controller.signal, onProgress: e => events.push(e) })
  for (const action of [() => store.inspect(), () => store.upload(f.work), () => store.download(path.join(f.base, 'dest'))]) {
    await assert.rejects(action(), isCancelled)
  }
  assert.equal(f.server.calls.length, 0)
  assert.equal(events.length, 0)
  await cleanCache(f.cache)
})

test('scan cancellation stops before connecting and removes staging files', async t => {
  const f = await fixture(t), controller = new AbortController(), events = []
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, signal: controller.signal, onProgress: e => {
    events.push(e)
    if (e.phase === 'scan' && e.completedFiles) controller.abort()
  } })
  await assert.rejects(store.upload(f.work), isCancelled)
  assert.equal(f.server.calls.length, 0)
  assert.ok(!events.some(e => e.phase === 'done'))
  await cleanCache(f.cache)
})

test('cancelled transfer waits for runner teardown, releases owned lock without signal, and never publishes', async t => {
  const f = await fixture(t), controller = new AbortController(), events = []
  let release, entered
  const reached = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const calls = []
  const runner = async request => {
    calls.push(request)
    if (request.batch.startsWith('put ') && request.batch.includes('/objects/')) {
      assert.equal(request.signal, controller.signal)
      controller.abort(); entered()
      await gate
      return { code: 1, stderr: 'synthetic interrupted transfer' }
    }
    return f.server.runner(request)
  }
  const store = createSftpStore(config, { cacheDir: f.cache, runner, signal: controller.signal, onProgress: e => events.push(e) })
  let settled = false
  const operation = store.upload(f.work).finally(() => { settled = true })
  await reached
  assert.equal(settled, false)
  assert.ok(f.server.dirs.has('/data/dsh-sync/.lock'))
  assert.ok((await fs.readdir(f.cache)).length > 0)
  release()
  await assert.rejects(operation, isCancelled)
  assert.equal(calls.at(-1).signal, undefined)
  assert.ok(calls.at(-1).batch.startsWith('rmdir '))
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
  assert.ok(!f.server.objects.has('/data/dsh-sync/latest.json'))
  assert.ok(!events.some(e => e.phase === 'publish' || e.phase === 'done'))
  await cleanCache(f.cache)
})

test('cancellation during lock acquisition confirms ownership before unlocking; failed acquisition never unlocks', async t => {
  for (const busy of [false, true]) {
    const f = await fixture(t), controller = new AbortController(), calls = [], events = []
    if (busy) f.server.dirs.add('/data/dsh-sync/.lock')
    const runner = async request => {
      calls.push(request)
      if (request.batch.includes('mkdir "/data/dsh-sync/.lock"')) {
        assert.equal(request.signal, undefined)
        controller.abort()
      }
      return f.server.runner(request)
    }
    const store = createSftpStore(config, { cacheDir: f.cache, runner, signal: controller.signal, onProgress: e => events.push(e) })
    await assert.rejects(store.upload(f.work), busy ? /lock acquisition failed/ : isCancelled)
    assert.equal(calls.length, busy ? 1 : 2)
    assert.equal(f.server.dirs.has('/data/dsh-sync/.lock'), busy)
    assert.ok(!calls.some(c => c.batch.includes('-get ')))
    if (!busy) assert.equal(calls.at(-1).signal, undefined)
    assert.ok(!events.some(e => e.phase === 'done'))
    await cleanCache(f.cache)
  }
})

test('cancel after lock acquisition in manifest readback unlocks and blocks subsequent transfers', async t => {
  const f = await fixture(t), controller = new AbortController(), calls = [], events = []
  const runner = async request => {
    calls.push(request)
    const result = await f.server.runner(request)
    if (request.batch.includes('-get ') && request.batch.includes('/latest.json')) controller.abort()
    return result
  }
  const store = createSftpStore(config, { cacheDir: f.cache, runner, signal: controller.signal, onProgress: e => events.push(e) })
  await assert.rejects(store.upload(f.work), isCancelled)
  assert.equal(calls.length, 3)
  assert.ok(calls.at(-1).batch.startsWith('rmdir '))
  assert.equal(calls.at(-1).signal, undefined)
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
  assert.ok(!events.some(e => e.phase === 'done'))
  await cleanCache(f.cache)
})

test('cancellation during protected publication returns confirmed success and cleans before done', async t => {
  const f = await fixture(t), controller = new AbortController(), events = [], calls = []
  const runner = async request => {
    calls.push(request)
    if (request.batch.includes('\nrename ')) {
      assert.equal(request.signal, undefined)
      controller.abort()
    }
    return f.server.runner(request)
  }
  const store = createSftpStore(config, { cacheDir: f.cache, runner, signal: controller.signal, onProgress: e => events.push(e) })
  const result = await store.upload(f.work)
  assert.equal(controller.signal.aborted, true)
  assert.equal(JSON.parse(f.server.objects.get('/data/dsh-sync/latest.json')).id, result.id)
  assert.equal(result.verified, true)
  assert.equal(events.at(-1).phase, 'done')
  assert.equal(calls.at(-1).signal, undefined)
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
  await cleanCache(f.cache)
})

test('cancellation before publication prevents commit even when progress observer cancels', async t => {
  const f = await fixture(t), controller = new AbortController(), events = []
  const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, signal: controller.signal, onProgress: e => {
    events.push(e)
    if (e.phase === 'publish') controller.abort()
  } })
  await assert.rejects(store.upload(f.work), isCancelled)
  assert.ok(!f.server.objects.has('/data/dsh-sync/latest.json'))
  assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
  assert.ok(!events.some(e => e.phase === 'done'))
  await cleanCache(f.cache)
})

test('download cancellation at transfer, verify, and copy boundaries preserves existing destination', async t => {
  for (const boundary of ['transfer', 'verify', 'copy']) {
    const f = await fixture(t)
    await f.store.upload(f.work)
    const controller = new AbortController(), events = [], dest = path.join(f.base, 'cancel-dest')
    await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'old.txt'), 'keep')
    const runner = async request => {
      if (boundary === 'transfer' && request.batch.startsWith('get ')) {
        assert.equal(request.signal, controller.signal)
        const line = request.batch.trim().split('\n')[0]
        const tokens = line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g).map(t => t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
        await fs.writeFile(tokens[2], Buffer.from('partial'))
        await request.reportDownloads()
        controller.abort()
        return { code: 1, stderr: 'cancelled' }
      }
      return f.server.runner(request)
    }
    const store = createSftpStore(config, { cacheDir: f.cache, runner, signal: controller.signal, onProgress: e => {
      events.push(e)
      if (boundary === 'verify' && e.phase === 'download' && e.completedFiles === 1) controller.abort()
      if (boundary === 'copy' && e.phase === 'restore' && e.completedFiles === 1) controller.abort()
    } })
    await assert.rejects(store.download(dest), isCancelled)
    assert.deepEqual(await fs.readdir(dest), ['old.txt'])
    assert.equal(await fs.readFile(path.join(dest, 'old.txt'), 'utf8'), 'keep')
    assert.ok(!events.some(e => e.phase === 'done'))
    assert.ok(!(await fs.readdir(f.base)).some(n => n.startsWith('.sftp-download-') || n.includes('.sftp-backup-')))
    await cleanCache(f.cache)
  }
})

test('cancellation after final copy prevents replacement; cancellation inside replacement succeeds', async t => {
  for (const inside of [false, true]) {
    const f = await fixture(t), uploaded = await f.store.upload(f.work), controller = new AbortController(), events = []
    const dest = path.join(f.base, 'atomic-dest')
    await fs.mkdir(dest); await fs.writeFile(path.join(dest, 'old.txt'), 'keep')
    const rename = fs.rename
    if (inside) fs.rename = async (a, b) => { if (a === dest) controller.abort(); return rename(a, b) }
    try {
      const store = createSftpStore(config, { cacheDir: f.cache, runner: f.server.runner, signal: controller.signal, onProgress: e => {
        events.push(e)
        if (!inside && e.phase === 'restore' && e.completedFiles === uploaded.files.length) controller.abort()
      } })
      if (inside) {
        assert.equal((await store.download(dest)).id, uploaded.id)
        assert.equal(events.at(-1).phase, 'done')
        assert.equal(await fs.readFile(path.join(dest, 'meta.json'), 'utf8'), '{"portable":true}')
      } else {
        await assert.rejects(store.download(dest), isCancelled)
        assert.equal(await fs.readFile(path.join(dest, 'old.txt'), 'utf8'), 'keep')
        assert.ok(!events.some(e => e.phase === 'done'))
      }
      assert.ok(!(await fs.readdir(f.base)).some(n => n.startsWith('.sftp-download-') || n.includes('.sftp-backup-')))
      await cleanCache(f.cache)
    } finally { fs.rename = rename }
  }
})

test('native runner abort kills synthetic process, waits close, and releases abort listener', async t => {
  const f = await fixture(t), controller = new AbortController(), events = []
  const spawn = childProcess.spawn
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal)
  let listeners = 0, child, killed = false, spawned
  controller.signal.addEventListener = (...args) => { if (args[0] === 'abort') listeners++; return add(...args) }
  controller.signal.removeEventListener = (...args) => { if (args[0] === 'abort') listeners--; return remove(...args) }
  const ready = new Promise(resolve => { spawned = resolve })
  childProcess.spawn = () => {
    child = new EventEmitter()
    child.kill = () => { killed = true; return true }
    spawned()
    return child
  }
  syncBuiltinESMExports()
  try {
    const store = createSftpStore(config, { cacheDir: f.cache, signal: controller.signal, onProgress: e => events.push(e) })
    let settled = false
    const operation = store.inspect().finally(() => { settled = true })
    await ready
    controller.abort()
    assert.equal(killed, true)
    assert.equal(settled, false)
    assert.ok((await fs.readdir(f.cache)).length > 0)
    child.emit('close', 1)
    await assert.rejects(operation, isCancelled)
    assert.equal(listeners, 0)
    assert.ok(!events.some(e => e.phase === 'done'))
    await cleanCache(f.cache)
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports() }
})

test('native process error waits close before removing staging payloads', async t => {
  const f = await fixture(t), spawn = childProcess.spawn
  let child, entered
  const ready = new Promise(resolve => { entered = resolve })
  childProcess.spawn = () => {
    child = new EventEmitter(); child.kill = () => true
    entered(); return child
  }
  syncBuiltinESMExports()
  try {
    const store = createSftpStore(config, { cacheDir: f.cache })
    let settled = false
    const operation = store.inspect().finally(() => { settled = true })
    await ready
    child.emit('error', new Error('synthetic process failure'))
    assert.equal(settled, false)
    assert.ok((await fs.readdir(f.cache)).length > 0)
    child.emit('close', 1)
    await assert.rejects(operation, /synthetic process failure/)
    await cleanCache(f.cache)
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports() }
})

test('live upload counts only confirmed predecessors and never double-counts readback or exit', async t => {
  const f = await fixture(t), events = []
  await fs.writeFile(path.join(f.work, 'empty.txt'), '')
  let observed = false
  const runner = async request => {
    if (request.batch.startsWith('put ') && request.batch.includes('/objects/')) {
      assert.ok(request.timeoutMs >= 900000)
      assert.ok(request.args.includes('ServerAliveInterval=30'))
      assert.ok(request.args.includes('ServerAliveCountMax=6'))
      assert.equal(request.reportDownloads, request.reportProgress)
      const lines = request.batch.trim().split('\n')
      const puts = lines.filter(line => line.startsWith('put '))
      const echo = line => 'sftp> ' + (process.platform === 'win32' ? line.replace(/\\/g, '/') : line)
      const latest = () => events.filter(e => e.phase === 'upload').at(-1)
      await fs.writeFile(request.stdoutPath, echo(lines[0]) + '\r\n')
      await request.reportProgress()
      assert.equal(latest().completedFiles, 0, 'own echo does not complete a put')
      const next = echo(lines[1])
      await fs.appendFile(request.stdoutPath, next.slice(0, 15))
      await request.reportProgress()
      assert.equal(latest().completedFiles, 0, 'partial next echo is not evidence')
      await fs.appendFile(request.stdoutPath, next.slice(15) + '\r\n')
      await request.reportProgress()
      assert.equal(latest().completedFiles, 1)
      const first = { ...latest() }
      await request.reportProgress()
      assert.deepEqual(latest(), first, 'repeated polling must not count twice')
      for (let i = 2; i <= puts.length; i++) {
        await fs.appendFile(request.stdoutPath, echo(lines[i]) + '\r\n')
        await request.reportProgress()
        assert.equal(latest().completedFiles, i, 'each following command confirms exactly one put, including empty files')
      }
      assert.equal(latest().completedBytes, latest().totalBytes)
      assert.ok(!events.some(e => e.phase === 'done' || e.phase === 'publish'))
      observed = true
    }
    return f.server.runner(request)
  }
  const store = createSftpStore(config, { cacheDir: f.cache, runner, onProgress: e => events.push(e) })
  const result = await store.upload(f.work)
  assert.ok(observed)
  assert.equal(result.files.length, 3)
  assert.equal(events.at(-1).transferredBytes, f.server.transfers.reduce((sum, t) => sum + t.bytes, 0))
  const uploadEvents = events.filter(e => e.phase === 'upload')
  assert.ok(uploadEvents.every(e => e.completedFiles <= 3 && e.completedBytes <= 22))
  assert.equal(events.at(-1).phase, 'done')
})

test('partial upload failure, timeout and cancellation keep measured progress but never publish', async t => {
  for (const mode of ['failure', 'timeout', 'cancel']) {
    const f = await fixture(t), events = [], calls = [], controller = new AbortController()
    let confirmedBytes
    const runner = async request => {
      calls.push(request)
      if (request.batch.startsWith('put ') && request.batch.includes('/objects/')) {
        const lines = request.batch.trim().split('\n')
        const echo = line => 'sftp> ' + (process.platform === 'win32' ? line.replace(/\\/g, '/') : line)
        await fs.writeFile(request.stdoutPath, echo(lines[0]) + '\n' + echo(lines[1]) + '\n')
        await request.reportProgress()
        const progress = events.filter(e => e.phase === 'upload').at(-1)
        assert.equal(progress.completedFiles, 1)
        confirmedBytes = progress.completedBytes
        if (mode === 'cancel') controller.abort()
        if (mode === 'timeout') throw new Error('SFTP timeout after synthetic deadline; remote outcome is unknown')
        return { code: 1, stderr: 'synthetic interrupted upload' }
      }
      return f.server.runner(request)
    }
    const store = createSftpStore(config, { cacheDir: f.cache, runner, signal: controller.signal, onProgress: e => events.push(e) })
    await assert.rejects(store.upload(f.work), mode === 'cancel' ? isCancelled : mode === 'timeout' ? /SFTP timeout/ : /interrupted upload/)
    const last = events.filter(e => e.phase === 'upload').at(-1)
    assert.equal(last.completedFiles, 1)
    assert.equal(last.completedBytes, confirmedBytes)
    assert.ok(!events.some(e => e.phase === 'publish' || e.phase === 'done'))
    assert.ok(!f.server.objects.has('/data/dsh-sync/latest.json'))
    assert.equal(calls.at(-1).batch, 'rmdir "/data/dsh-sync/.lock"\n')
    assert.equal(calls.at(-1).signal, undefined)
    assert.equal(calls.at(-1).timeoutMs, 300000, 'unlock must not inherit the long data deadline')
    assert.ok(!f.server.dirs.has('/data/dsh-sync/.lock'))
    await cleanCache(f.cache)
  }
})

test('native timeout waits for process teardown before reporting failure and cleaning staging', async t => {
  const f = await fixture(t), spawn = childProcess.spawn, set = globalThis.setTimeout, clear = globalThis.clearTimeout
  let fire, child, entered, killed = false
  const handle = {}, ready = new Promise(resolve => { entered = resolve })
  globalThis.setTimeout = (fn, ms, ...args) => ms === 300000 ? (fire = fn, handle) : set(fn, ms, ...args)
  globalThis.clearTimeout = value => { if (value !== handle) clear(value) }
  childProcess.spawn = () => {
    child = new EventEmitter(); child.kill = () => { killed = true; return true }
    entered(); return child
  }
  syncBuiltinESMExports()
  try {
    const store = createSftpStore(config, { cacheDir: f.cache })
    let settled = false
    const operation = store.inspect().finally(() => { settled = true })
    await ready
    assert.equal(typeof fire, 'function')
    fire()
    assert.equal(killed, true)
    assert.equal(settled, false)
    assert.ok((await fs.readdir(f.cache)).length > 0)
    child.emit('close', null)
    await assert.rejects(operation, /SFTP timeout after 300s.*remote outcome is unknown/)
    await cleanCache(f.cache)
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports()
    globalThis.setTimeout = set; globalThis.clearTimeout = clear
  }
})

test('cancelled operation settles only after signal-independent cleanup finishes', async t => {
  const f = await fixture(t), controller = new AbortController(), rm = fs.rm
  let entered, release
  const ready = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  fs.rm = async (target, options) => {
    if (path.dirname(target) === f.cache) {
      assert.equal(options.signal, undefined)
      entered(); await gate
    }
    return rm(target, options)
  }
  try {
    const store = createSftpStore(config, { cacheDir: f.cache, signal: controller.signal, runner: async () => {
      controller.abort(); throw new Error('synthetic interrupted transport')
    } })
    let settled = false
    const operation = store.inspect().finally(() => { settled = true })
    await ready
    assert.equal(settled, false)
    assert.ok((await fs.readdir(f.cache)).length > 0)
    release()
    await assert.rejects(operation, isCancelled)
    await cleanCache(f.cache)
  } finally { release(); fs.rm = rm }
})

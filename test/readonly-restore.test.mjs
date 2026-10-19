import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createCodec } from '../lib/pathcodec.js'
import { applyRestore, hash, prepareRestore } from '../lib/restore-safety.js'

// Synthetic inputs only. Never read a real profile, repository, restore plan or backup.
// The only sockets are ephemeral loopback probes for the real offline CLI. Child
// stdio goes to owned fixture files, not named pipes; no extra permissions are needed.
const CFG = { profiles: ['desktop'], includeAttachments: true, extras: [] }
const LEDGER = 'storages/cost-meter/ledger.json'
const LOCAL = [
  'storages/cost-meter/ledger.json.native-search-coverage.json',
  'state/codex-subscription/quota-forecast.json',
]
const OFFLINE = fileURLToPath(new URL('../lib/restore-offline.mjs', import.meta.url))
const asBytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value)
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const objectPath = bytes => { const digest = hash(asBytes(bytes)); return `attachments/v1/objects/${digest.slice(0, 2)}/${digest}` }
const jsonAt = (stage, name) => JSON.parse(fs.readFileSync(path.join(stage, name), 'utf8'))
const sorted = values => [...values].sort((a, b) => a - b)
const message = value => typeof value === 'string' ? value : value?.message
const errorIndexes = journal => journal.rollbackErrors.map(item => item.index)

function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir())
  const base = path.resolve(fs.mkdtempSync(path.join(temp, 'dsh-sync-readonly-')))
  const owner = randomUUID()
  const marker = path.join(base, '.fixture-owner')
  const identity = fs.lstatSync(base)
  fs.writeFileSync(marker, owner, { flag: 'wx' })
  const owned = value => {
    const absolute = path.resolve(value)
    const rel = path.relative(base, absolute)
    assert.ok(rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)), 'operation must stay inside its own fixture')
    return absolute
  }
  const verifyOwner = () => {
    const target = owned(base)
    assert.equal(target, base)
    assert.equal(path.dirname(target), temp)
    assert.match(path.basename(target), /^dsh-sync-readonly-/)
    const current = fs.lstatSync(target)
    assert.equal(current.isSymbolicLink(), false)
    assert.equal(current.isDirectory(), true)
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    assert.equal(fs.lstatSync(marker).isSymbolicLink(), false)
    assert.equal(fs.readFileSync(marker, 'utf8'), owner)
    return target
  }
  t.after(() => {
    const target = verifyOwner()
    // Only teardown may clear readonly on owned regular files. Do not recurse
    // through links/junctions, including the adversarial ones created below.
    const writable = dir => {
      for (const name of fs.readdirSync(dir)) {
        const abs = owned(path.join(dir, name))
        const stat = fs.lstatSync(abs)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) writable(abs)
        else if (stat.isFile() && !(stat.mode & 0o200)) fs.chmodSync(abs, 0o600)
      }
    }
    writable(target)
    verifyOwner()
    fs.rmSync(target, { recursive: true, force: false })
  })
  const home = owned(path.join(base, 'home'))
  const work = owned(path.join(base, 'snapshot'))
  const userHome = owned(path.join(base, 'fake-user'))
  for (const dir of [home, work, userHome]) fs.mkdirSync(dir)
  const put = (root, rel, bytes) => {
    const dest = owned(path.resolve(root, rel))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
    return dest
  }
  const remove = value => {
    verifyOwner()
    const target = owned(value)
    assert.notEqual(target, base, 'individual fixture removal must not delete its root')
    fs.unlinkSync(target)
  }
  put(work, 'meta.json', JSON.stringify({ schema: 2, extras: [] }))
  return { base, home, work, userHome, put, owned, verifyOwner, remove,
    args: { workDir: work, dshHome: home, cfg: CFG, codec: createCodec(userHome), oid: 'synthetic-readonly-only', hostPid: 0 } }
}

function fingerprint(file) {
  const stat = fs.lstatSync(file, { bigint: true })
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, sha256: hash(fs.readFileSync(file)) }
}

async function makeReadonly(file) {
  await fsp.utimes(file, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'))
  await fsp.chmod(file, 0o444) // Real OS readonly attribute on Windows, not a mocked EPERM.
  assert.equal(fs.statSync(file).mode & 0o222, 0, 'fixture must actually be readonly')
  return fingerprint(file)
}

function snapshot(base) {
  const rows = []
  const visit = (dir, rel = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      const entry = rel ? `${rel}/${name}` : name
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink()) rows.push([entry, 'link', fs.readlinkSync(abs)])
      else if (stat.isDirectory()) { rows.push([entry, 'directory']); visit(abs, entry) }
      else rows.push([entry, 'file', fingerprint(abs)])
    }
  }
  visit(base)
  return rows
}

const MUTATORS = ['mkdir', 'writeFile', 'appendFile', 'copyFile', 'rename', 'unlink', 'rm', 'rmdir', 'truncate', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'open', 'symlink', 'link']
function isWrite(name, args) {
  if (name !== 'open') return true
  const flags = args[1]
  return typeof flags === 'number'
    ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC))
    : /[wa+]/.test(flags || 'r')
}

async function guardWrites(t, operation, { noWrites = false, untouched = [], onWrite = () => {} } = {}) {
  const protectedKeys = untouched.map(key)
  const writes = []
  const mocks = []
  for (const [api, suffix] of [[fsp, ''], [fs, 'Sync']]) {
    for (const name of MUTATORS) {
      const method = name + suffix
      if (typeof api[method] !== 'function') continue
      const original = api[method]
      mocks.push(t.mock.method(api, method, function (...args) {
        if (isWrite(name, args)) {
          writes.push({ name, args })
          assert.equal(noWrites, false, `preflight attempted ${method}`)
          assert.ok(!['chmod', 'lchmod', 'chown', 'lchown'].includes(name), 'restore must never change attributes/permissions')
          const candidates = ['copyFile', 'rename', 'link', 'symlink'].includes(name) ? args.slice(0, 2) : args.slice(0, 1)
          for (const candidate of candidates) if (typeof candidate === 'string') {
            const normalized = key(candidate)
            assert.ok(!protectedKeys.some(target => normalized === target || normalized.startsWith(target + '.sync-')), `${method} must not touch an unchanged file or reusable backup`)
          }
          onWrite(name, args)
        }
        return Reflect.apply(original, this, args)
      }))
    }
  }
  try { return { result: await operation(), writes } }
  finally { for (const fn of mocks.reverse()) fn.mock.restore() }
}

async function rejectWithoutWrites(t, f, operation, expected) {
  const before = snapshot(f.base)
  const { writes } = await guardWrites(t, () => assert.rejects(operation, expected), { noWrites: true })
  assert.deepEqual(writes, [], 'no write attempt may be swallowed by restore error handling')
  assert.deepEqual(snapshot(f.base), before, 'preflight rejection must preserve every fixture entry, byte, readonly bit and mtime')
}

// Explicit synthetic plans keep indices stable, independently of directory order.
// Invalid-plan tests deliberately bypass prepareRestore, just as an old plan can.
function manualPlan(f, specs) {
  const stage = f.owned(path.join(f.home, 'sync-restores', randomUUID()))
  const plan = { schema: 1, oid: 'synthetic-plan', machine: os.hostname(), dshHome: f.home, hostPid: 0, port: 0, preservedLocal: [], files: [] }
  for (const [index, spec] of specs.entries()) {
    const bytes = asBytes(spec.bytes)
    const destination = f.owned(path.join(f.home, spec.rel))
    if (spec.before !== null) f.put(f.home, spec.rel, spec.before ?? spec.bytes)
    f.put(stage, `files/${index}.bin`, bytes)
    plan.files.push({ source: `files/${index}.bin`, destination, repoPath: spec.rel,
      sha256: hash(bytes), previousHash: fs.existsSync(destination) ? hash(fs.readFileSync(destination)) : null, size: bytes.length })
  }
  f.put(stage, 'plan.json', JSON.stringify(plan, null, 2))
  return { stage, plan }
}

function assertJournalShape(journal) {
  assert.equal(typeof journal.phase, 'string')
  for (const name of ['applied', 'unchanged', 'rolledBack', 'rollbackSkipped', 'rollbackErrors']) assert.ok(Array.isArray(journal[name]), `journal.${name} must be an array`)
  assert.ok(Object.hasOwn(journal, 'error'))
}

function assertCounts(result, files, changed, unchanged) {
  assert.equal(result.files, files, 'files must remain the total original plan count')
  assert.equal(result.changed, changed)
  assert.equal(result.unchanged, unchanged)
  assert.equal(result.changed + result.unchanged, result.files)
}

function createFixtureLink(t, f, target, link, kind) {
  f.owned(target); f.owned(link)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  try { fs.symlinkSync(target, link, kind === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (kind === 'file' && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`file symlink unavailable without changing privileges: ${error.code}`)
      return false
    }
    throw error // Directory junctions are exercised normally, not silently skipped.
  }
  return true
}

test('real chmod(0444) content-addressed objects are checked but neither rewritten nor backed up; original indices survive filtering', async t => {
  const f = fixture(t)
  const a = Buffer.from('synthetic attachment A\0'), b = Buffer.from('synthetic attachment B\0')
  const { stage, plan } = manualPlan(f, [
    { rel: objectPath(a), bytes: a },
    { rel: 'storages/mutable.json', bytes: 'new mutable', before: 'old mutable' },
    { rel: objectPath(b), bytes: b },
    { rel: 'state/new.json', bytes: 'new file', before: null },
  ])
  const readonly = [plan.files[0].destination, plan.files[2].destination]
  const before = await Promise.all(readonly.map(makeReadonly))
  const { result, writes } = await guardWrites(t, () => applyRestore(stage), { untouched: readonly })
  assertCounts(result, 4, 2, 2)
  for (const [i, file] of readonly.entries()) assert.deepEqual(fingerprint(file), before[i])
  assert.deepEqual(fs.readdirSync(result.backup), ['1.bin'])
  assert.equal(fs.readFileSync(path.join(result.backup, '1.bin'), 'utf8'), 'old mutable')
  const copies = writes.filter(call => call.name === 'copyFile')
  assert.equal(copies.length, 1)
  assert.equal(copies[0].args[2] & fs.constants.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL, 'backup creation must be exclusive')
  const journal = jsonAt(stage, 'journal.json')
  assertJournalShape(journal)
  assert.equal(journal.phase, 'applied')
  assert.deepEqual(journal.applied, [1, 3])
  assert.deepEqual(journal.unchanged, [0, 2])
  assert.deepEqual(journal.rolledBack, [])
  assert.deepEqual(journal.rollbackSkipped, [])
  assert.deepEqual(journal.rollbackErrors, [])
  assert.equal(journal.error, null)
  assertCounts(jsonAt(stage, 'applied.json'), 4, 2, 2)
})

test('an entirely unchanged plan succeeds, including readonly non-content-addressed files, without target or backup writes', async t => {
  const f = fixture(t)
  const attachment = Buffer.from('unchanged entire plan')
  const { stage, plan } = manualPlan(f, [
    { rel: objectPath(attachment), bytes: attachment },
    { rel: 'storages/unchanged.json', bytes: '{"unchanged":true}' },
  ])
  const originals = await Promise.all(plan.files.map(row => makeReadonly(row.destination)))
  const { result, writes } = await guardWrites(t, () => applyRestore(stage), { untouched: plan.files.map(row => row.destination) })
  assertCounts(result, 2, 0, 2)
  for (const [index, row] of plan.files.entries()) assert.deepEqual(fingerprint(row.destination), originals[index])
  assert.equal(writes.filter(call => ['copyFile', 'rename'].includes(call.name)).length, 0)
  if (fs.existsSync(result.backup)) assert.deepEqual(fs.readdirSync(result.backup), [])
  const journal = jsonAt(stage, 'journal.json')
  assertJournalShape(journal)
  assert.equal(journal.phase, 'applied')
  assert.deepEqual(journal.applied, [])
  assert.deepEqual(journal.unchanged, [0, 1])
  assertCounts(jsonAt(stage, 'applied.json'), 2, 0, 2)
})

test('valid pre-existing readonly backup is reused byte-for-byte while other backups use COPYFILE_EXCL', async t => {
  const f = fixture(t)
  const { stage, plan } = manualPlan(f, [
    { rel: 'storages/reused.json', bytes: 'after 0', before: 'before 0' },
    { rel: 'storages/fresh-backup.json', bytes: 'after 1', before: 'before 1' },
  ])
  const reused = f.put(stage, 'backup/0.bin', 'before 0')
  const before = await makeReadonly(reused)
  const { result, writes } = await guardWrites(t, () => applyRestore(stage), { untouched: [reused] })
  assertCounts(result, 2, 2, 0)
  assert.deepEqual(fingerprint(reused), before)
  assert.equal(fs.readFileSync(plan.files[0].destination, 'utf8'), 'after 0')
  const copies = writes.filter(call => call.name === 'copyFile')
  assert.equal(copies.length, 1, 'never attempt to overwrite or copy into a reusable readonly backup')
  assert.equal(key(copies[0].args[1]), key(path.join(stage, 'backup/1.bin')))
  assert.equal(copies[0].args[2] & fs.constants.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL)
})

test('wrong readonly backup hash is rejected without changing existing backups, journal or any target', async t => {
  const f = fixture(t)
  const { stage } = manualPlan(f, [
    { rel: 'storages/first.json', bytes: 'after 0', before: 'before 0' },
    { rel: 'storages/second.json', bytes: 'after 1', before: 'before 1' },
  ])
  await makeReadonly(f.put(stage, 'backup/0.bin', 'before 0'))
  await makeReadonly(f.put(stage, 'backup/1.bin', 'wrong previous bytes'))
  await rejectWithoutWrites(t, f, () => applyRestore(stage), /备份.*(?:哈希|不符|不匹配)|backup.*hash/i)
})

for (const location of ['staged-source', 'backup-source-target', 'backup-destination']) for (const kind of ['file', 'directory']) {
  test(`${location} ${kind === 'directory' ? 'junction' : 'symlink'} is rejected even when linked bytes match`, async t => {
    const f = fixture(t)
    const { stage, plan } = manualPlan(f, [{ rel: 'storages/link-check.json', bytes: 'after', before: 'before' }])
    const payload = f.owned(path.join(f.base, `link-payload-${location}`))
    const entry = plan.files[0]
    const isStaged = location === 'staged-source'
    const backing = f.put(payload, '0.bin', isStaged ? 'after' : 'before')
    let link
    if (kind === 'file') {
      link = isStaged ? path.join(stage, entry.source) : location === 'backup-source-target' ? entry.destination : path.join(stage, 'backup/0.bin')
      if (fs.existsSync(link)) f.remove(link)
      if (!createFixtureLink(t, f, backing, link, kind)) return
    } else {
      if (isStaged) { entry.source = 'linked-source/0.bin'; link = path.join(stage, 'linked-source') }
      else if (location === 'backup-source-target') { entry.destination = f.owned(path.join(f.home, 'linked-target/0.bin')); link = path.dirname(entry.destination) }
      else link = path.join(stage, 'backup')
      if (!createFixtureLink(t, f, payload, link, kind)) return
      f.put(stage, 'plan.json', JSON.stringify(plan))
    }
    await rejectWithoutWrites(t, f, () => applyRestore(stage), /符号链接|junction|链接|symlink/i)
  })
}

for (const mutation of ['local bytes changed', 'local disappeared', 'staged bytes corrupted']) {
  test(`unchanged entries still enforce all hashes after download: ${mutation}`, async t => {
    const f = fixture(t)
    const rel = 'storages/unchanged-baseline.json'
    f.put(f.home, rel, 'same before download')
    f.put(f.work, rel, 'same before download')
    f.put(f.work, 'storages/new.json', 'must not be created')
    const { stage } = await prepareRestore(f.args)
    const entry = jsonAt(stage, 'plan.json').files.find(row => row.repoPath === rel)
    assert.equal(entry.sha256, entry.previousHash)
    if (mutation === 'local bytes changed') f.put(f.home, rel, 'edited after download')
    else if (mutation === 'local disappeared') f.remove(entry.destination)
    else f.put(stage, entry.source, 'corrupted staged bytes')
    await rejectWithoutWrites(t, f, () => applyRestore(stage), /下载后本机文件已发生变化|暂存文件哈希不符/)
  })
}

test('changed non-content-addressed readonly file fails whole-plan preflight before backup or journal creation', { skip: process.platform !== 'win32' && 'Windows readonly-attribute semantics' }, async t => {
  const f = fixture(t)
  const { stage, plan } = manualPlan(f, [
    { rel: 'storages/earlier.json', bytes: 'after mutable', before: 'before mutable' },
    { rel: 'attachments/legacy-name.bin', bytes: 'changed readonly', before: 'old readonly' },
  ])
  await makeReadonly(plan.files[1].destination)
  await rejectWithoutWrites(t, f, () => applyRestore(stage), /只读|read.?only/i)
  assert.equal(fs.existsSync(path.join(stage, 'backup')), false)
  assert.equal(fs.existsSync(path.join(stage, 'journal.json')), false)
})

for (const [entrypoint, corrupt] of [['prepare', 'incoming'], ['apply', 'incoming'], ['apply', 'existing']]) {
  test(`${entrypoint} rejects content-addressed ${corrupt} hash mismatch with zero writes`, async t => {
    const f = fixture(t)
    const valid = Buffer.from('valid content-addressed payload')
    const rel = objectPath(valid)
    const bytes = corrupt === 'incoming' ? Buffer.from('remote bytes do not match the address') : valid
    const before = corrupt === 'existing' ? Buffer.from('corrupt local object at a valid address') : null
    if (entrypoint === 'prepare') {
      f.put(f.work, rel, bytes)
      f.put(f.work, 'storages/earlier.json', 'must not stage anything')
      if (before !== null) await makeReadonly(f.put(f.home, rel, before))
      await rejectWithoutWrites(t, f, () => prepareRestore(f.args), /内容寻址|附件.*(?:哈希|不符)|content.address|object.*hash/i)
      assert.equal(fs.existsSync(path.join(f.home, 'sync-restores')), false)
    } else {
      const { stage, plan } = manualPlan(f, [
        { rel: 'storages/earlier.json', bytes: 'after mutable', before: 'before mutable' },
        { rel, bytes, before },
      ])
      if (before !== null) await makeReadonly(plan.files[1].destination)
      await rejectWithoutWrites(t, f, () => applyRestore(stage), /内容寻址|附件.*(?:哈希|不符)|content.address|object.*hash/i)
      assert.equal(fs.existsSync(path.join(stage, 'backup')), false)
    }
  })
}

function rollbackPlan(f) {
  const attachment = Buffer.from('readonly unchanged inside rollback plan')
  return manualPlan(f, [
    { rel: objectPath(attachment), bytes: attachment },
    { rel: 'storages/first.json', bytes: 'after first', before: 'before first' },
    { rel: 'storages/new.json', bytes: 'after new', before: null },
    { rel: 'state/unchanged.json', bytes: 'unchanged ordinary' },
    { rel: 'storages/last-applied.json', bytes: 'after last', before: 'before last' },
    { rel: 'storages/failing.json', bytes: 'after failing', before: 'before failing' },
  ])
}

function assertPreimages(plan, { retained = new Map() } = {}) {
  for (const [index, row] of plan.files.entries()) {
    if (retained.has(index)) assert.equal(fs.readFileSync(row.destination, 'utf8'), retained.get(index))
    else if (row.previousHash === null) assert.equal(fs.existsSync(row.destination), false, `new target ${index} must be removed`)
    else assert.equal(hash(fs.readFileSync(row.destination)), row.previousHash, `preimage ${index} must be restored`)
  }
}

async function injectRenameFailure(t, f, stage, plan, { rollbackFailureIndex = null, tempCleanupFailure = false, beforeFailure = async () => {} } = {}) {
  const original = Object.assign(new Error('synthetic original rename EPERM at plan index 5'), { code: 'EPERM' })
  const rollbackError = Object.assign(new Error('synthetic rollback failure at plan index ' + rollbackFailureIndex), { code: 'EIO' })
  const cleanupError = Object.assign(new Error('synthetic temp cleanup EPERM after original rename error'), { code: 'EPERM' })
  const rename = fsp.rename
  let failed = false, reportedError
  const rollbackAttempts = new Set(), cleanupAttempts = []
  const mock = t.mock.method(fsp, 'rename', async function (src, dest) {
    if (!failed && key(dest) === key(plan.files[5].destination)) {
      await beforeFailure()
      failed = true
      throw original
    }
    return Reflect.apply(rename, this, [src, dest])
  })
  try {
    await guardWrites(t, () => assert.rejects(() => applyRestore(stage), error => {
      reportedError = error
      assert.ok(error === original || error.cause === original, 'a wrapped failure must retain the original exception as its cause')
      assert.ok(error.message.includes(original.message), 'a rollback failure must never mask the original message')
      return true
    }), {
      untouched: [plan.files[0].destination, plan.files[3].destination],
      onWrite(name, args) {
        if (!failed || !['copyFile', 'rename', 'writeFile', 'unlink', 'rm'].includes(name)) return
        const dest = ['copyFile', 'rename'].includes(name) ? args[1] : args[0]
        if (typeof dest !== 'string') return
        if (tempCleanupFailure && name === 'unlink' && key(dest).startsWith(key(plan.files[5].destination) + '.sync-')) {
          cleanupAttempts.push(f.owned(dest))
          throw cleanupError
        }
        const index = plan.files.findIndex(row => key(row.destination) === key(dest))
        if (index < 0) return
        rollbackAttempts.add(index)
        const persisted = jsonAt(stage, 'journal.json')
        assert.equal(message(persisted.error), original.message, 'persist the ORIGINAL error before attempting rollback')
        if (index === rollbackFailureIndex) throw rollbackError
      },
    })
  } finally { mock.mock.restore() }
  assert.equal(failed, true, 'fault injection must actually reach the intended original index')
  return { original, rollbackError, rollbackAttempts, cleanupError, cleanupAttempts, reportedError, journal: jsonAt(stage, 'journal.json') }
}

test('mid-rename failure rolls back every mutable preimage and removes new files; journal retains original indices/error and cannot retry', async t => {
  const f = fixture(t)
  const { stage, plan } = rollbackPlan(f)
  const readonly = await makeReadonly(plan.files[0].destination)
  const { original, rollbackAttempts, journal } = await injectRenameFailure(t, f, stage, plan)
  assertJournalShape(journal)
  assert.equal(journal.phase, 'rolled-back')
  assert.equal(message(journal.error), original.message)
  assert.deepEqual(journal.applied, [1, 2, 4])
  assert.deepEqual(journal.unchanged, [0, 3])
  assert.deepEqual(sorted(journal.rolledBack), [1, 2, 4])
  assert.deepEqual(journal.rollbackSkipped, [])
  assert.deepEqual(journal.rollbackErrors, [])
  assert.deepEqual(sorted(rollbackAttempts), [1, 2, 4])
  assertPreimages(plan)
  assert.deepEqual(fingerprint(plan.files[0].destination), readonly)
  assert.equal(fs.existsSync(path.join(stage, 'applied.json')), false)
  assert.deepEqual(fs.readdirSync(path.join(stage, 'backup')).sort(), ['1.bin', '4.bin', '5.bin'])
  for (const index of [1, 4, 5]) assert.equal(hash(fs.readFileSync(path.join(stage, 'backup', `${index}.bin`))), plan.files[index].previousHash)
  assert.ok(snapshot(f.home).every(([rel]) => !/\.sync-.*\.tmp$/.test(rel)), 'failed rename must not leak target temp files')
  await rejectWithoutWrites(t, f, () => applyRestore(stage), /执行过|日志|journal|重试|重新下载/)
})

test('rename plus temp-unlink double failure preserves the original error, rolls back all committed indices and reports retained temp evidence', async t => {
  const f = fixture(t)
  const { stage, plan } = rollbackPlan(f)
  const readonly = await makeReadonly(plan.files[0].destination)
  const { original, cleanupError, cleanupAttempts, reportedError, rollbackAttempts, journal } = await injectRenameFailure(t, f, stage, plan, { tempCleanupFailure: true })
  assertJournalShape(journal)
  assert.equal(journal.phase, 'rolled-back')
  assert.equal(journal.failedPhase, 'applying')
  assert.equal(message(journal.error), original.message)
  assert.match(reportedError.message, /临时文件未清理/)
  assert.deepEqual(journal.applied, [1, 2, 4])
  assert.deepEqual(sorted(journal.rolledBack), [1, 2, 4])
  assert.deepEqual(sorted(rollbackAttempts), [1, 2, 4])
  assert.deepEqual(journal.rollbackErrors, [])
  assert.equal(cleanupAttempts.length, 1, 'the second injected filesystem failure must actually occur')
  assert.deepEqual(journal.tempCleanupErrors, [{ index: 5, path: cleanupAttempts[0], message: cleanupError.message }])
  assert.equal(hash(fs.readFileSync(cleanupAttempts[0])), plan.files[5].sha256, 'failed cleanup must be reported, not silently claimed complete')
  assertPreimages(plan)
  assert.deepEqual(fingerprint(plan.files[0].destination), readonly)
  assert.equal(fs.existsSync(path.join(stage, 'applied.json')), false)
  for (const index of [1, 4, 5]) assert.equal(hash(fs.readFileSync(path.join(stage, 'backup', `${index}.bin`))), plan.files[index].previousHash)
  await rejectWithoutWrites(t, f, () => applyRestore(stage), /执行过|日志|journal|重试|重新下载/)
})

test('one rollback failure cannot mask original error or stop remaining rollbacks; rollback-incomplete retains every backup', async t => {
  const f = fixture(t)
  const { stage, plan } = rollbackPlan(f)
  await makeReadonly(plan.files[0].destination)
  const { original, rollbackError, rollbackAttempts, journal } = await injectRenameFailure(t, f, stage, plan, { rollbackFailureIndex: 4 })
  assertJournalShape(journal)
  assert.equal(journal.phase, 'rollback-incomplete')
  assert.equal(message(journal.error), original.message)
  assert.deepEqual(journal.applied, [1, 2, 4])
  assert.deepEqual(journal.unchanged, [0, 3])
  assert.deepEqual(sorted(journal.rolledBack), [1, 2])
  assert.deepEqual(sorted(errorIndexes(journal)), [4])
  assert.equal(message(journal.rollbackErrors[0].error) || journal.rollbackErrors[0].message, rollbackError.message)
  assert.deepEqual(sorted(rollbackAttempts), [1, 2, 4], 'rollback must continue past the first failing item')
  assertPreimages(plan, { retained: new Map([[4, 'after last']]) })
  assert.equal(fs.existsSync(path.join(stage, 'applied.json')), false)
  for (const index of [1, 4, 5]) assert.equal(hash(fs.readFileSync(path.join(stage, 'backup', `${index}.bin`))), plan.files[index].previousHash)
  await rejectWithoutWrites(t, f, () => applyRestore(stage), /执行过|日志|journal|重试|重新下载/)
})

test('rollback skips an externally changed target without clobbering it and still restores other entries', async t => {
  const f = fixture(t)
  const { stage, plan } = rollbackPlan(f)
  const { journal } = await injectRenameFailure(t, f, stage, plan, {
    beforeFailure: async () => { f.put(f.home, plan.files[4].repoPath, 'synthetic concurrent user edit') },
  })
  assertJournalShape(journal)
  assert.equal(journal.phase, 'rollback-incomplete')
  assert.deepEqual(sorted(journal.rolledBack), [1, 2])
  // A skipped record may carry a reason; it must always retain the original index.
  assert.deepEqual(journal.rollbackSkipped.map(item => typeof item === 'number' ? item : item.index), [4])
  assertPreimages(plan, { retained: new Map([[4, 'synthetic concurrent user edit']]) })
})

test('rollback backup-source junction is rejected even with correct bytes; other safe rollback work still runs', async t => {
  const f = fixture(t)
  const { stage, plan } = rollbackPlan(f)
  const payload = f.owned(path.join(f.base, 'rollback-linked-payload'))
  for (const index of [1, 4, 5]) f.put(payload, `${index}.bin`, fs.readFileSync(plan.files[index].destination))
  const originalPayload = snapshot(payload)
  const backup = f.owned(path.join(stage, 'backup'))
  const retainedBackup = f.owned(path.join(stage, 'retained-owned-backup'))
  const { journal } = await injectRenameFailure(t, f, stage, plan, {
    beforeFailure: async () => {
      f.verifyOwner(); f.owned(backup); f.owned(retainedBackup)
      // Move only this fixture's newly generated backup, then substitute a junction.
      fs.renameSync(backup, retainedBackup)
      assert.equal(createFixtureLink(t, f, payload, backup, 'directory'), true)
    },
  })
  assertJournalShape(journal)
  assert.equal(journal.phase, 'rollback-incomplete')
  assert.deepEqual(sorted(journal.rolledBack), [2])
  assert.deepEqual(sorted(errorIndexes(journal)), [1, 4])
  for (const item of journal.rollbackErrors) assert.match(message(item.error) || item.message, /链接|junction|symlink/i)
  assertPreimages(plan, { retained: new Map([[1, 'after first'], [4, 'after last']]) })
  assert.deepEqual(snapshot(payload), originalPayload, 'never mutate a linked backup source')
  for (const index of [1, 4, 5]) assert.equal(hash(fs.readFileSync(path.join(retainedBackup, `${index}.bin`))), plan.files[index].previousHash)
})

for (const artifact of ['old journal', 'malformed journal', 'applied marker']) {
  test(`${artifact} forbids rerun before modifying any log, readonly backup or target`, async t => {
    const f = fixture(t)
    const { stage } = manualPlan(f, [{ rel: 'storages/retry.json', bytes: 'after', before: 'before' }])
    await makeReadonly(f.put(stage, 'backup/0.bin', 'before'))
    if (artifact === 'applied marker') f.put(stage, 'applied.json', '{"files":1,"finishedAt":"synthetic-old"}')
    else f.put(stage, 'journal.json', artifact === 'old journal' ? '{"startedAt":"synthetic-old","applied":[0],"error":"old EPERM"}' : 'incomplete old journal {')
    await rejectWithoutWrites(t, f, () => applyRestore(stage), /执行过|日志|journal|重试|重新下载/)
  })
}

for (const artifact of ['journal.json', 'applied.json']) {
  test(`dangling ${artifact} junction is still an existing marker and forbids rerun with zero writes`, async t => {
    const f = fixture(t)
    const { stage } = manualPlan(f, [{ rel: 'storages/marker-link.json', bytes: 'after', before: 'before' }])
    await makeReadonly(f.put(stage, 'backup/0.bin', 'before'))
    const missingTarget = f.owned(path.join(f.base, 'intentionally-absent-marker-target'))
    const link = f.owned(path.join(stage, artifact))
    assert.equal(createFixtureLink(t, f, missingTarget, link, 'directory'), true)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.existsSync(link), false, 'exercise an entry that existsSync incorrectly treats as absent')
    await rejectWithoutWrites(t, f, () => applyRestore(stage), /执行过|日志|journal|重试|重新下载|链接|junction/)
  })
}

function childEnvironment(f) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^DSH_/i.test(name)))
  return { ...env, HOME: f.userHome, USERPROFILE: f.userHome, DSH_HOME: f.home,
    APPDATA: f.owned(path.join(f.userHome, 'AppData/Roaming')), LOCALAPPDATA: f.owned(path.join(f.userHome, 'AppData/Local')) }
}

async function childRun(f, args, label) {
  const stdout = f.owned(path.join(f.base, `${label}-${randomUUID()}.stdout`))
  const stderr = f.owned(path.join(f.base, `${label}-${randomUUID()}.stderr`))
  const out = fs.openSync(stdout, 'wx'), err = fs.openSync(stderr, 'wx')
  let child
  try { child = spawn(process.execPath, args, { cwd: f.base, env: childEnvironment(f), stdio: ['ignore', out, err], windowsHide: true }) }
  finally { fs.closeSync(out); fs.closeSync(err) }
  const result = await new Promise((resolve, reject) => {
    // Kill only this test's own child, and wait for close before fixture cleanup.
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`synthetic child timeout: ${label}`))
      else resolve({ code, signal, pid: child.pid })
    })
  })
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') }
}

async function offlineContext(f) {
  // An actually exited child PID, never 0, a guessed number, or the real DSH PID.
  const child = await childRun(f, ['-e', 'process.exitCode = 0'], 'exited-host')
  assert.equal(child.code, 0, child.stderr)
  assert.ok(child.pid > 0)
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  assert.ok(port > 0)
  return { hostPid: child.pid, port }
}

async function seedEighty(f) {
  const expected = new Map()
  const readonly = new Map()
  // 11 readonly objects + 26 unchanged mutable + 41 changed = 78 plan entries.
  // Two legacy machine-local files remain in the 80-file source only.
  for (let index = 0; index < 11; index++) {
    const bytes = Buffer.from(`synthetic readonly attachment ${index}\0`)
    const rel = objectPath(bytes)
    f.put(f.work, rel, bytes)
    const target = f.put(f.home, rel, bytes)
    readonly.set(target, await makeReadonly(target))
    expected.set(rel, bytes)
  }
  for (let index = 0; index < 26; index++) {
    const rel = `storages/unchanged/${String(index).padStart(2, '0')}.json`
    const bytes = Buffer.from(JSON.stringify({ synthetic: true, unchanged: index }))
    f.put(f.work, rel, bytes); f.put(f.home, rel, bytes); expected.set(rel, bytes)
  }
  for (let index = 0; index < 41; index++) {
    const rel = index === 0 ? LEDGER : `storages/changed/${String(index).padStart(2, '0')}.json`
    const bytes = Buffer.from(JSON.stringify({ synthetic: true, remote: index }))
    f.put(f.work, rel, bytes)
    f.put(f.home, rel, JSON.stringify({ synthetic: true, previous: index }))
    expected.set(rel, bytes)
  }
  for (const rel of LOCAL) { f.put(f.work, rel, 'synthetic legacy remote cache'); f.put(f.home, rel, 'synthetic local cache') }
  assert.equal(snapshot(f.work).filter(([rel, kind]) => kind === 'file' && rel !== 'meta.json').length, 80)
  return { expected, readonly }
}

test('real offline CLI: 80 source files become 78 planned / 41 changed / 37 unchanged; 11 readonly objects and 2 arbitrarily changed local states are untouched', { timeout: 30000 }, async t => {
  const f = fixture(t)
  const { expected, readonly } = await seedEighty(f)
  const context = await offlineContext(f)
  const prepared = await prepareRestore({ ...f.args, hostPid: context.hostPid })
  assert.equal(prepared.files, 78)
  assert.deepEqual(prepared.preservedLocal.map(item => item.repoPath).sort(), [...LOCAL].sort())
  const plan = jsonAt(prepared.stage, 'plan.json')
  plan.port = context.port
  f.put(prepared.stage, 'plan.json', JSON.stringify(plan, null, 2))
  const planBytes = fs.readFileSync(path.join(prepared.stage, 'plan.json'))
  assert.equal(plan.files.filter(row => row.sha256 === row.previousHash).length, 37)
  assert.equal(plan.files.filter(row => /^attachments\/v1\/objects\//.test(row.repoPath)).length, 11)
  const localBytes = [Buffer.from([0, 255, 13, 10, 91]), Buffer.from('arbitrary local changes after download\nnot JSON')]
  for (const [index, rel] of LOCAL.entries()) f.put(f.home, rel, localBytes[index])
  const cli = await childRun(f, [OFFLINE, '--apply', prepared.stage], 'offline-success')
  assert.equal(cli.code, 0, `${cli.stdout}\n${cli.stderr}`)
  assert.match(cli.stdout, /恢复完成.*78/)
  assert.match(cli.stdout, /本机诊断\/预测状态保持不动/)
  assert.deepEqual(fs.readFileSync(path.join(prepared.stage, 'plan.json')), planBytes)
  const journal = jsonAt(prepared.stage, 'journal.json')
  assertJournalShape(journal)
  assert.equal(journal.phase, 'applied')
  const changed = plan.files.flatMap((row, index) => row.sha256 !== row.previousHash ? [index] : [])
  const unchanged = plan.files.flatMap((row, index) => row.sha256 === row.previousHash ? [index] : [])
  assert.deepEqual(journal.applied, changed)
  assert.deepEqual(journal.unchanged, unchanged)
  assertCounts(jsonAt(prepared.stage, 'applied.json'), 78, 41, 37)
  const backup = path.join(prepared.stage, 'backup')
  assert.deepEqual(fs.readdirSync(backup).sort(), changed.map(index => `${index}.bin`).sort())
  for (const index of changed) assert.equal(hash(fs.readFileSync(path.join(backup, `${index}.bin`))), plan.files[index].previousHash)
  for (const [rel, bytes] of expected) assert.deepEqual(fs.readFileSync(path.join(f.home, rel)), bytes)
  for (const [file, before] of readonly) assert.deepEqual(fingerprint(file), before, 'real CLI must preserve readonly object identity/mtime/attributes')
  for (const [index, rel] of LOCAL.entries()) assert.deepEqual(fs.readFileSync(path.join(f.home, rel)), localBytes[index])
})

test('real offline CLI still rejects a genuine ledger change after download despite arbitrary local-state changes', { timeout: 30000 }, async t => {
  const f = fixture(t)
  await seedEighty(f)
  const context = await offlineContext(f)
  const { stage } = await prepareRestore({ ...f.args, hostPid: context.hostPid })
  const plan = jsonAt(stage, 'plan.json')
  plan.port = context.port
  f.put(stage, 'plan.json', JSON.stringify(plan, null, 2))
  for (const [index, rel] of LOCAL.entries()) f.put(f.home, rel, `arbitrary cache update ${index}`)
  f.put(f.home, LEDGER, 'synthetic real ledger changed after download')
  const beforeHome = snapshot(f.home), beforeWork = snapshot(f.work)
  const cli = await childRun(f, [OFFLINE, '--apply', stage], 'offline-conflict')
  assert.equal(cli.code, 1, `${cli.stdout}\n${cli.stderr}`)
  assert.match(cli.stderr, /下载后本机文件已发生变化/)
  assert.deepEqual(snapshot(f.home), beforeHome, 'real ledger protection must reject before target, backup or journal writes')
  assert.deepEqual(snapshot(f.work), beforeWork)
  assert.equal(fs.existsSync(path.join(stage, 'backup')), false)
  assert.equal(fs.existsSync(path.join(stage, 'journal.json')), false)
})

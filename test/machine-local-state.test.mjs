import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildManifest, createCodec, machineLocalStateReason } from '../lib/pathcodec.js'
import { allowedDsh, applyRestore, hash, prepareRestore, safeRelative } from '../lib/restore-safety.js'

// All input/output, including simulated old plans and symlink targets, is synthetic.
// No host profile, configured sync repository, DSH runtime, network or child process is used.
const COVERAGE = 'storages/cost-meter/ledger.json.native-search-coverage.json'
const FORECAST = 'state/codex-subscription/quota-forecast.json'
const LOCAL = [COVERAGE, FORECAST]
const LEDGER = 'storages/cost-meter/ledger.json'
const HISTORY = 'storages/cost-meter/ledger.json.native-search/abcdef.jsonl'
const SESSION = 'sessions/workspace/session-a/session.v4.jsonl'
const REAL = [LEDGER, HISTORY, SESSION]
const cfg = { profiles: ['desktop'], includeAttachments: true, extras: [] }
const slash = value => value.split(path.sep).join('/')

function fixture(t, schema = 2) {
  const temp = fs.realpathSync(os.tmpdir())
  const base = path.resolve(fs.mkdtempSync(path.join(temp, 'dsh-sync-machine-local-')))
  const owner = randomUUID()
  const marker = path.join(base, '.fixture-owner')
  const identity = fs.lstatSync(base)
  fs.writeFileSync(marker, owner, { flag: 'wx' })
  const owned = value => {
    const absolute = path.resolve(value)
    const rel = path.relative(base, absolute)
    assert.ok(rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)), 'path must remain inside this fixture')
    return absolute
  }
  t.after(() => {
    // Check the exact resolved deletion target, original parent, identity and nonce.
    // Recursive removal unlinks fixture symlinks; it never follows their targets.
    const target = owned(base)
    assert.equal(target, base)
    assert.equal(path.dirname(target), temp)
    assert.match(path.basename(target), /^dsh-sync-machine-local-/)
    const current = fs.lstatSync(target)
    assert.equal(current.isSymbolicLink(), false)
    assert.equal(current.isDirectory(), true)
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    assert.equal(fs.lstatSync(marker).isSymbolicLink(), false)
    assert.equal(fs.readFileSync(marker, 'utf8'), owner)
    fs.rmSync(target, { recursive: true, force: false })
  })
  const home = owned(path.join(base, 'home'))
  const work = owned(path.join(base, 'snapshot'))
  const extra = owned(path.join(base, 'extra-target'))
  for (const dir of [home, work, extra]) fs.mkdirSync(dir)
  const put = (root, rel, bytes) => {
    const dest = owned(path.resolve(root, rel))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
    return dest
  }
  put(work, 'meta.json', JSON.stringify({ schema, extras: [] }))
  const args = { workDir: work, dshHome: home, cfg, codec: createCodec(path.join(base, 'synthetic-user')), oid: 'synthetic-only', hostPid: 0 }
  return { base, home, work, extra, owned, put, args }
}

function seed(f, localPaths = LOCAL) {
  for (const rel of [...REAL, ...localPaths]) {
    f.put(f.work, rel, `remote:${rel}\n`)
    f.put(f.home, rel, `local:${rel}\n`)
  }
}

// This snapshot never follows a symlink. It includes staging/plan files as well as targets.
function snapshot(base) {
  const rows = []
  const visit = (dir, rel = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      const key = rel ? `${rel}/${name}` : name
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink()) rows.push([key, 'link', fs.readlinkSync(abs)])
      else if (stat.isDirectory()) { rows.push([key, 'directory']); visit(abs, key) }
      else rows.push([key, 'file', fs.readFileSync(abs).toString('base64')])
    }
  }
  visit(base)
  return rows
}

function planAt(stage) {
  return JSON.parse(fs.readFileSync(path.join(stage, 'plan.json'), 'utf8'))
}

async function rejectWithoutWrites(t, f, operation, expected) {
  const before = snapshot(f.base)
  const writes = []
  const mocks = ['mkdir', 'writeFile', 'copyFile', 'rename', 'rm', 'unlink', 'appendFile', 'open'].map(name => t.mock.method(fsp, name, (...args) => {
    writes.push([name, String(args[0])])
    throw new Error(`unexpected filesystem write: ${name}`)
  }))
  try {
    await assert.rejects(operation, expected)
    assert.deepEqual(writes, [], 'validation must reject before ANY staging, backup, journal or target write')
  } finally {
    for (const fn of mocks) fn.mock.restore()
  }
  assert.deepEqual(snapshot(f.base), before, 'rejection must preserve all fixture bytes and entries')
}

async function withoutLocalReads(t, f, paths, operation) {
  const keys = new Set(paths.map(rel => path.resolve(f.home, rel).toLowerCase()))
  const originalAsync = fsp.readFile
  const originalSync = fs.readFileSync
  const reads = []
  const check = value => {
    if (typeof value === 'string' && keys.has(path.resolve(value).toLowerCase())) {
      reads.push(value)
      throw new Error('machine-local target must not be read or hashed')
    }
  }
  const asyncMock = t.mock.method(fsp, 'readFile', function (value, ...rest) {
    check(value)
    return Reflect.apply(originalAsync, this, [value, ...rest])
  })
  const syncMock = t.mock.method(fs, 'readFileSync', function (value, ...rest) {
    check(value)
    return Reflect.apply(originalSync, this, [value, ...rest])
  })
  try {
    const result = await operation()
    assert.deepEqual(reads, [])
    return result
  } finally {
    asyncMock.mock.restore()
    syncMock.mock.restore()
  }
}

test('local-only matching is exact, case-insensitive and separator-aware, not a basename/prefix filter', () => {
  for (const rel of LOCAL) {
    assert.equal(typeof machineLocalStateReason(rel), 'string')
    assert.equal(machineLocalStateReason(rel.toUpperCase()), machineLocalStateReason(rel))
    assert.equal(machineLocalStateReason(rel.replaceAll('/', '\\')), machineLocalStateReason(rel))
    assert.equal(allowedDsh(rel, cfg), false)
    assert.equal(allowedDsh(rel.toUpperCase(), cfg), false)
  }
  for (const rel of [
    ...REAL,
    `${COVERAGE}.copy.json`, `${FORECAST}.copy.json`,
    'storages/another/ledger.json.native-search-coverage.json',
    'storages/cost-meter-copy/ledger.json.native-search-coverage.json',
    'state/another/quota-forecast.json',
    'state/codex-subscription/archive/quota-forecast.json',
    ...LOCAL.map(rel => `extras/project/${rel}`),
  ]) assert.equal(machineLocalStateReason(rel), null, rel)
  for (const rel of REAL) assert.equal(allowedDsh(rel, cfg), true, rel)
})

test('upload manifest excludes only the two local paths, including mixed case, and keeps genuine data/prefixes/extras', t => {
  const f = fixture(t)
  const kept = [
    ...REAL, `${COVERAGE}.copy.json`, `${FORECAST}.copy.json`,
    'storages/another/ledger.json.native-search-coverage.json',
    'storages/cost-meter-copy/ledger.json.native-search-coverage.json',
    'state/another/quota-forecast.json',
    'state/codex-subscription/archive/quota-forecast.json',
  ]
  for (const rel of [...LOCAL, ...kept]) f.put(f.home, rel, `synthetic:${rel}`)
  for (const rel of [
    'storages/COST-METER/LEDGER.JSON.NATIVE-SEARCH-COVERAGE.JSON',
    'state/CODEX-SUBSCRIPTION/QUOTA-FORECAST.JSON',
  ]) f.put(f.home, rel, 'mixed-case cache')
  for (const rel of LOCAL) f.put(f.extra, rel, `explicit extra:${rel}`)
  const manifest = buildManifest(f.home, { ...cfg, extras: [{ name: 'project', path: f.extra, kind: 'directory' }] })
  const rels = manifest.map(item => slash(item.rel))
  assert.ok(rels.every(rel => machineLocalStateReason(rel) === null))
  for (const rel of [...kept, ...LOCAL.map(rel => `extras/project/${rel}`)]) {
    assert.ok(rels.some(value => value.toLowerCase() === rel.toLowerCase()), `missing ${rel}`)
  }
  assert.equal(rels.length, kept.length + LOCAL.length)
})

for (const schema of [1, 2]) for (const uppercase of [false, true]) {
  test(`old schema-${schema} snapshot ${uppercase ? 'uppercase' : 'canonical'} caches are preservedLocal, never target reads/hashes/blobs`, async t => {
    const f = fixture(t, schema)
    const localPaths = uppercase ? LOCAL.map(rel => rel.toUpperCase()) : LOCAL
    seed(f, localPaths)
    const original = localPaths.map(rel => fs.readFileSync(path.join(f.home, rel)))
    const result = await withoutLocalReads(t, f, localPaths, () => prepareRestore(f.args))
    const plan = planAt(result.stage)
    // Windows preserves the casing of directories created earlier for the real ledger.
    // Compare identities case-insensitively while retaining the exact observed spelling in the plan.
    const normalized = rows => rows.map(row => ({ ...row, repoPath: row.repoPath.toLowerCase() })).sort((a, b) => a.repoPath.localeCompare(b.repoPath))
    const expected = localPaths.map(repoPath => ({ repoPath, reason: machineLocalStateReason(repoPath) }))
    assert.deepEqual(normalized(result.preservedLocal), normalized(expected))
    if (uppercase) for (const row of result.preservedLocal) assert.equal(path.posix.basename(row.repoPath), path.posix.basename(row.repoPath).toUpperCase())
    assert.deepEqual(plan.preservedLocal, result.preservedLocal)
    assert.equal(result.legacy, schema === 1)
    assert.equal(result.files, REAL.length)
    assert.equal(result.overwrites, REAL.length)
    assert.deepEqual(plan.files.map(row => row.repoPath).sort(), [...REAL].sort())
    assert.equal(fs.readdirSync(path.join(result.stage, 'files')).length, REAL.length)
    for (const [index, rel] of localPaths.entries()) assert.deepEqual(fs.readFileSync(path.join(f.home, rel)), original[index])
    assert.ok(plan.files.every(row => !machineLocalStateReason(row.repoPath)))
  })
}

test('cache changes after download do not block restore; cache bytes and plan stay intact, real data is restored and backed up', async t => {
  const f = fixture(t)
  seed(f)
  const result = await prepareRestore(f.args)
  const planPath = path.join(result.stage, 'plan.json')
  const planBytes = fs.readFileSync(planPath)
  const plan = planAt(result.stage)
  for (const [index, rel] of LOCAL.entries()) {
    await fsp.writeFile(f.owned(path.join(f.home, rel)), `background-write-after-download:${index}\n`)
  }
  const latest = LOCAL.map(rel => fs.readFileSync(path.join(f.home, rel)))
  const applied = await withoutLocalReads(t, f, LOCAL, () => applyRestore(result.stage))
  assert.equal(applied.files, REAL.length)
  assert.deepEqual(fs.readFileSync(planPath), planBytes)
  for (const [index, row] of plan.files.entries()) {
    assert.equal(fs.readFileSync(row.destination, 'utf8'), `remote:${row.repoPath}\n`)
    assert.equal(fs.readFileSync(path.join(applied.backup, `${index}.bin`), 'utf8'), `local:${row.repoPath}\n`)
  }
  for (const [index, rel] of LOCAL.entries()) assert.deepEqual(fs.readFileSync(path.join(f.home, rel)), latest[index])
  assert.equal(fs.readdirSync(applied.backup).length, REAL.length)
  assert.ok(fs.existsSync(path.join(result.stage, 'applied.json')))
})

test('previously absent local caches may appear after plan creation without becoming restore targets', async t => {
  const f = fixture(t)
  for (const rel of [...REAL, ...LOCAL]) f.put(f.work, rel, `remote:${rel}`)
  const result = await prepareRestore(f.args)
  assert.equal(result.overwrites, 0)
  for (const rel of LOCAL) f.put(f.home, rel, `new-local:${rel}`)
  const applied = await withoutLocalReads(t, f, LOCAL, () => applyRestore(result.stage))
  assert.equal(applied.files, REAL.length)
  for (const rel of LOCAL) assert.equal(fs.readFileSync(path.join(f.home, rel), 'utf8'), `new-local:${rel}`)
  assert.deepEqual(fs.readdirSync(applied.backup), [])
})

for (const changed of REAL) {
  test(`real data conflict still rejects with zero writes: ${changed}`, async t => {
    const f = fixture(t)
    seed(f)
    f.put(f.work, 'storages/fresh-file.json', 'must never be created')
    const result = await prepareRestore(f.args)
    f.put(f.home, changed, `real-user-change:${changed}`)
    for (const rel of LOCAL) f.put(f.home, rel, `unrelated-cache-change:${rel}`)
    await rejectWithoutWrites(t, f, () => applyRestore(result.stage), /下载后本机文件已发生变化/)
    assert.equal(fs.existsSync(path.join(result.stage, 'backup')), false)
    assert.equal(fs.existsSync(path.join(result.stage, 'journal.json')), false)
    assert.equal(fs.existsSync(path.join(f.home, 'storages/fresh-file.json')), false)
  })
}

const oldPlanCases = [
  ...LOCAL.map(rel => ({ label: rel, repoPath: rel, destinationRel: rel })),
  ...LOCAL.map(rel => ({ label: `uppercase ${rel}`, repoPath: rel.toUpperCase(), destinationRel: rel.toUpperCase() })),
  ...LOCAL.map(rel => ({ label: `destination alias ${rel}`, repoPath: 'storages/alias/ordinary.json', destinationRel: rel })),
]
for (const example of oldPlanCases) {
  test(`old plan containing machine-local state rejects, without changing the plan: ${example.label}`, async t => {
    const f = fixture(t)
    seed(f)
    const result = await prepareRestore(f.args)
    const plan = planAt(result.stage)
    delete plan.preservedLocal
    const bytes = Buffer.from('old remote cache that must not overwrite local state')
    f.put(result.stage, 'files/legacy-cache.bin', bytes)
    plan.files.push({
      repoPath: example.repoPath,
      destination: f.owned(path.join(f.home, example.destinationRel)),
      source: 'files/legacy-cache.bin', sha256: hash(bytes), size: bytes.length,
      previousHash: hash(Buffer.from(`local:${example.destinationRel}\n`)),
    })
    f.put(result.stage, 'plan.json', JSON.stringify(plan, null, 2))
    const originalPlan = fs.readFileSync(path.join(result.stage, 'plan.json'))
    await rejectWithoutWrites(t, f, () => applyRestore(result.stage), /恢复计划仍包含本机保留状态.*重新下载生成计划/)
    assert.deepEqual(fs.readFileSync(path.join(result.stage, 'plan.json')), originalPlan)
  })
}

test('path traversal, Windows alternate streams, separator tricks and trailing aliases fail before local-only matching', () => {
  for (const rel of [
    `../${COVERAGE}`, `/${FORECAST}`, 'storages/./cost-meter/ledger.json.native-search-coverage.json',
    'state/other/../codex-subscription/quota-forecast.json',
    'state//codex-subscription/quota-forecast.json',
    FORECAST.replaceAll('/', '\\'), `${FORECAST}.`, `${FORECAST} `, `${FORECAST}:stream`,
  ]) {
    assert.throws(() => safeRelative(rel), /不安全的仓库路径/, rel)
    assert.throws(() => allowedDsh(rel, cfg), /不安全的仓库路径/, rel)
  }
})

for (const field of ['repoPath', 'source']) {
  test(`old plan ${field} traversal is rejected before any write`, async t => {
    const f = fixture(t)
    seed(f)
    const result = await prepareRestore(f.args)
    const plan = planAt(result.stage)
    plan.files.at(-1)[field] = field === 'repoPath' ? `../${COVERAGE}` : '../outside.bin'
    f.put(result.stage, 'plan.json', JSON.stringify(plan))
    await rejectWithoutWrites(t, f, () => applyRestore(result.stage), /不安全的仓库路径/)
  })
}

test('codec-produced destination traversal is rejected before staging or target writes', async t => {
  const f = fixture(t)
  seed(f)
  const codec = { fromPortable: value => value === LEDGER ? '../escaped.json' : value }
  await rejectWithoutWrites(t, f, () => prepareRestore({ ...f.args, codec }), /不安全的仓库路径/)
  assert.equal(fs.existsSync(path.join(f.home, 'sync-restores')), false)
})

for (const rel of LOCAL) for (const kind of ['file', 'directory']) {
  test(`source ${kind} link cannot hide behind local-only exclusion: ${rel}`, async t => {
    const f = fixture(t)
    for (const entry of REAL) f.put(f.home, entry, `local:${entry}`)
    const payload = f.owned(path.join(f.base, 'link-payload'))
    fs.mkdirSync(payload)
    const backing = f.put(payload, path.posix.basename(rel), 'fixture-only source link target')
    const link = f.owned(path.join(f.work, kind === 'file' ? rel : path.posix.dirname(rel)))
    fs.mkdirSync(path.dirname(link), { recursive: true })
    try {
      fs.symlinkSync(kind === 'file' ? backing : payload, link, kind === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`synthetic ${kind} symlink unavailable: ${error.code}`); return }
      throw error
    }
    await rejectWithoutWrites(t, f, () => prepareRestore(f.args), /仓库包含链接|拒绝通过符号链接/)
    assert.equal(fs.existsSync(path.join(f.home, 'sync-restores')), false)
  })
}

test('staged source junction is rejected with zero writes even when its payload hash matches', async t => {
  const f = fixture(t)
  seed(f)
  const result = await prepareRestore(f.args)
  const plan = planAt(result.stage)
  const entry = plan.files.at(-1)
  const payload = f.owned(path.join(f.base, 'staged-link-payload'))
  f.put(payload, 'payload.bin', fs.readFileSync(path.join(result.stage, entry.source)))
  const link = f.owned(path.join(result.stage, 'files', 'source-link'))
  try {
    fs.symlinkSync(payload, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`synthetic staged junction unavailable: ${error.code}`); return }
    throw error
  }
  entry.source = 'files/source-link/payload.bin'
  f.put(result.stage, 'plan.json', JSON.stringify(plan))
  await rejectWithoutWrites(t, f, () => applyRestore(result.stage), /拒绝通过符号链接或 junction/)
})

test('explicit extras with the same local-only relative paths are still restored and backed up', async t => {
  const f = fixture(t)
  const extra = { name: 'project', path: f.extra, kind: 'directory' }
  f.put(f.work, 'meta.json', JSON.stringify({ schema: 2, extras: [{ name: extra.name, kind: extra.kind }] }))
  for (const rel of LOCAL) {
    f.put(f.work, `extras/project/${rel}`, `remote-extra:${rel}`)
    f.put(f.extra, rel, `local-extra:${rel}`)
    f.put(f.home, rel, `host-cache:${rel}`)
  }
  const result = await prepareRestore({ ...f.args, cfg: { ...cfg, extras: [extra] } })
  assert.deepEqual(result.preservedLocal, [])
  assert.equal(result.files, LOCAL.length)
  const plan = planAt(result.stage)
  const applied = await applyRestore(result.stage)
  for (const [index, row] of plan.files.entries()) {
    const rel = row.repoPath.slice('extras/project/'.length)
    assert.equal(fs.readFileSync(row.destination, 'utf8'), `remote-extra:${rel}`)
    assert.equal(fs.readFileSync(path.join(applied.backup, `${index}.bin`), 'utf8'), `local-extra:${rel}`)
    assert.equal(fs.readFileSync(path.join(f.home, rel), 'utf8'), `host-cache:${rel}`)
  }
})

test('0.3.4 preset MJS scripts, YAML references and extensionless marker still synchronize byte-for-byte', async t => {
  const f = fixture(t)
  const sources = new Map([
    ['.agent-presets/focused/agent.cordis.yml', '- name: ./restrict.mjs\n- name: ./delegation-labels.mjs\n'],
    ['.agent-presets/focused/restrict.mjs', 'export const value = "__DSHHOME__";\r\n'],
    ['.agent-presets/focused/delegation-labels.mjs', 'export default "synthetic-only";\n'],
    ['.agent-presets/focused/generator', 'synthetic preset marker\n'],
  ])
  for (const [rel, bytes] of sources) {
    assert.equal(allowedDsh(rel, cfg), true, rel)
    f.put(f.work, rel, bytes)
    f.put(f.home, rel, `old:${rel}`)
  }
  for (const rel of LOCAL) f.put(f.home, rel, 'local cache')
  const uploaded = buildManifest(f.home, cfg).map(row => slash(row.rel)).sort()
  assert.deepEqual(uploaded, [...sources.keys()].sort())
  const result = await prepareRestore(f.args)
  const plan = planAt(result.stage)
  assert.deepEqual(plan.files.map(row => row.repoPath).sort(), [...sources.keys()].sort())
  const applied = await applyRestore(result.stage)
  for (const [index, row] of plan.files.entries()) {
    assert.deepEqual(fs.readFileSync(row.destination), Buffer.from(sources.get(row.repoPath)))
    assert.equal(fs.readFileSync(path.join(applied.backup, `${index}.bin`), 'utf8'), `old:${row.repoPath}`)
  }
})

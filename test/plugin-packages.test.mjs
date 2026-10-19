import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { collectPluginSnapshot, validatePortablePlugins, verifySnapshotPackages, compareVersions, detectPluginUpdates, savePluginUpdatePlan, readPluginUpdatePlan, pluginUpdateView, installConfirmedPluginUpdates, localProfileRestoreOverrides } from '../lib/plugin-packages.js'
import { prepareRestore } from '../lib/restore-safety.js'
import { createCodec } from '../lib/pathcodec.js'
import { writePending, assertUploadAllowed } from '../lib/sync-guard.js'

function tar(entries) {
  const buffers = []
  for (const [name, body] of Object.entries(entries)) {
    const bytes = Buffer.from(body), h = Buffer.alloc(512)
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h[156] = 48
    h.write('ustar\0', 257); h.write('00', 263)
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    buffers.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]))
}
function archive(name = 'test-plugin', version = '1.2.0') {
  return tar({ 'package/package.json': JSON.stringify({ name, version, type: 'module', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }), 'package/cordis.patch.yml': '[]\n', 'package/lib/index.js': 'export const name="test-plugin"' })
}
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
function fixture(t, { version = '1.2.0', current = null, enabled = true, localEnabled = true, name = 'test-plugin' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'old-user-home'), home = path.join(root, 'different-user-home'), work = path.join(root, 'download')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(work)
  const sourcePackage = path.join(root, 'source-only', 'plugin.tgz')
  put(sourcePackage, archive(name, version))
  const pkg = { dependencies: { [name]: 'file:' + sourcePackage }, dsh: { profile: { bundles: enabled ? [name] : [] } } }
  put(path.join(source, 'profiles/desktop/package.json'), JSON.stringify(pkg))
  put(path.join(source, 'profiles/desktop/node_modules', name, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } }, description: 'Release description', sync: 'ignored' }))
  const snap = collectPluginSnapshot(source, ['desktop'])
  for (const artifact of snap.artifacts) put(path.join(work, artifact.rel), fs.readFileSync(artifact.abs))
  put(path.join(work, 'meta.json'), JSON.stringify({ schema: 2, pluginInstallManifest: { schema: 1, items: snap.inventory }, extras: [] }))
  const cfg = { backend: 'gitee', repoUrl: 'https://example.com/private.git', branch: 'sync', profiles: ['desktop'], extras: [], includeAttachments: true }
  if (current) {
    put(path.join(home, 'profiles/desktop/package.json'), JSON.stringify({ dependencies: { [name]: current }, dsh: { profile: { bundles: localEnabled ? [name] : [] } } }))
    put(path.join(home, 'profiles/desktop/node_modules', name, 'package.json'), JSON.stringify({ name, version: current }))
  }
  const plan = detectPluginUpdates({ workDir: work, dshHome: home, cfg, snapshot: 'synthetic-snapshot' })
  savePluginUpdatePlan(home, plan)
  return { root, source, sourcePackage, home, work, cfg, snap, plan, name }
}
function fakeManager(f, overrides = {}) {
  const calls = []
  return { calls, async installBundle(spec, options) {
    calls.push({ spec, options })
    put(path.join(f.home, 'profiles/desktop/node_modules', f.name, 'package.json'), JSON.stringify({ name: f.name, version: f.snap.inventory[0].version }))
    const file = path.join(f.home, 'profiles/desktop/package.json')
    const pkg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { dependencies: {}, dsh: { profile: { bundles: [] } } }
    pkg.dependencies[f.name] = 'file:' + spec
    if (options.enabled && !pkg.dsh.profile.bundles.includes(f.name)) pkg.dsh.profile.bundles.push(f.name)
    put(file, JSON.stringify(pkg))
    return { changed: true, application: 'restart-required', packageResult: { exitCode: 0 }, ...overrides }
  } }
}
const install = (f, manager, options = {}) => installConfirmedPluginUpdates({ workDir: f.work, dshHome: f.home, cfg: f.cfg, manager, planId: f.plan.planId, targets: [f.plan.offers[0].id], ...options })

test('source local bundles become content-addressed archives, no source paths in portable manifest', t => {
  const f = fixture(t)
  const row = f.snap.inventory[0]
  assert.equal(row.source, 'archive'); assert.equal(row.bytes, fs.statSync(f.sourcePackage).size)
  assert.match(row.archive, /^plugin-packages\/[a-f0-9]{64}\.tgz$/)
  assert.ok(!JSON.stringify(f.snap.inventory).includes(f.sourcePackage))
  assert.equal(verifySnapshotPackages(f.work, f.snap.inventory).size, 1)
})
test('detecting missing and upgraded plugins never installs or writes profile files', t => {
  const f = fixture(t)
  assert.equal(f.plan.offers[0].kind, 'install'); assert.equal(f.plan.offers[0].canInstall, true)
  assert.equal(fs.existsSync(path.join(f.home, 'profiles')), false)
  const view = pluginUpdateView(f.plan)
  assert.ok(!JSON.stringify(view).includes('currentSpec')); assert.ok(!JSON.stringify(view).includes('sha256'))
})
test('version comparison handles exact prereleases, build suffixes and refuses non-exact versions', () => {
  assert.equal(compareVersions('1.2.0', '1.1.99'), 1)
  assert.equal(compareVersions('1.2.0-rc.10', '1.2.0-rc.2'), 1)
  assert.equal(compareVersions('1.2.0', '1.2.0-rc.99'), 1)
  assert.equal(compareVersions('1.2.0+new', '1.2.0+old'), 0)
  assert.throws(() => compareVersions('1.2.0-01', '1.2.0'))
  assert.throws(() => compareVersions('latest', '1.2.0'))
})
test('newer local version is advice-only; same installed version does not offer reinstall', t => {
  const f = fixture(t, { current: '2.0.0' })
  assert.equal(f.plan.offers[0].kind, 'local-newer'); assert.equal(f.plan.offers[0].canInstall, false)
  put(path.join(f.home, 'profiles/desktop/node_modules/test-plugin/package.json'), '{"name":"test-plugin","version":"1.2.0"}')
  assert.equal(detectPluginUpdates({ workDir: f.work, dshHome: f.home, cfg: f.cfg, snapshot: 's' }).offers.length, 0)
})
test('legacy snapshot never reinterprets npm-only old inventory as executable update approval', t => {
  const f = fixture(t)
  put(path.join(f.work, 'meta.json'), '{"schema":2,"installedPlugins":[{"name":"dsh-startup-screen","version":"1.1.0","source":"npm"}]}')
  const plan = detectPluginUpdates({ workDir: f.work, dshHome: f.home, cfg: f.cfg, snapshot: 'old' })
  assert.equal(plan.planId, null); assert.deepEqual(plan.offers, []); assert.ok(plan.warnings.length)
})
test('archive hash, size, identity and untrusted install specs are checked before installer', t => {
  const f = fixture(t)
  const row = f.snap.inventory[0]
  assert.throws(() => verifySnapshotPackages(f.work, [{ ...row, bytes: row.bytes + 1 }]), /校验/)
  assert.throws(() => verifySnapshotPackages(f.work, [{ ...row, name: 'wrong-name' }]), /校验/)
  assert.throws(() => validatePortablePlugins([{ ...row, archive: '../../evil.tgz' }]), /清单/)
  assert.throws(() => validatePortablePlugins([{ ...row, name: '--config' }]), /名称/)
  put(path.join(f.work, row.archive), archive('another-plugin'))
  assert.throws(() => verifySnapshotPackages(f.work, [row]), /校验/)
})
test('explicit selected plan installs cache path on target machine, with no build approval or kill', async t => {
  const f = fixture(t), manager = fakeManager(f)
  const result = await install(f, manager)
  assert.equal(result.ok, true); assert.equal(result.installed.length, 1); assert.equal(result.restartRequired, true)
  assert.match(manager.calls[0].spec, /different-user-home/)
  assert.ok(!manager.calls[0].spec.includes('source-only'))
  assert.ok(!manager.calls[0].spec.includes('download'))
  assert.equal(manager.calls[0].options.enabled, true)
  assert.deepEqual(Object.keys(manager.calls[0].options).sort(), ['enabled', 'requestId'])
  assert.equal(readPluginUpdatePlan(f.home, f.cfg).offers.length, 0)
  assert.match(result.summary, /手动退出/)
})
test('update preserves local disabled choice rather than enabling remote choice', async t => {
  const f = fixture(t, { current: '1.0.0', localEnabled: false, enabled: true }), manager = fakeManager(f)
  const result = await install(f, manager)
  assert.equal(result.ok, true); assert.equal(manager.calls[0].options.enabled, false)
})
test('stale plan, changed local versions and different repositories reject without installation', async t => {
  const f = fixture(t), manager = fakeManager(f)
  await assert.rejects(install(f, manager, { planId: 'stale' }), /已变化/)
  await assert.rejects(install(f, manager, { targets: ['unknown'] }), /不可自动/)
  await assert.rejects(install(f, manager, { cfg: { ...f.cfg, branch: 'other' } }), /已变化/)
  put(path.join(f.home, 'profiles/desktop/node_modules/test-plugin/package.json'), '{"name":"test-plugin","version":"1.1.0"}')
  await assert.rejects(install(f, manager), /已经变化/)
  assert.equal(manager.calls.length, 0)
})
test('service unavailable, cancelled before start and duplicate targets never install', async t => {
  const f = fixture(t), manager = fakeManager(f)
  await assert.rejects(install(f, null), /不可用/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(install(f, manager, { signal: abort.signal }), { name: 'AbortError' })
  await assert.rejects(install(f, manager, { targets: [f.plan.offers[0].id, f.plan.offers[0].id] }), /明确选择/)
  assert.equal(manager.calls.length, 0)
})
test('build-blocked result is not installation success or automatic build authorization', async t => {
  const f = fixture(t), calls = []
  const manager = { async installBundle(...args) { calls.push(args); return { application: 'failed', changed: false, pendingBuilds: ['native-build'], error: { code: 'package-failed' }, packageResult: { exitCode: 1, kind: 'build-blocked' } } } }
  const result = await install(f, manager)
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.deepEqual(result.pendingBuilds, ['native-build'])
  assert.ok(!('approvedBuilds' in calls[0][1])); assert.match(result.summary, /未自动批准/)
})
test('installer pnpm success but activation failure is still reported as failure', async t => {
  const f = fixture(t), manager = { async installBundle() { return { changed: true, application: 'failed', error: { code: 'load-failed' }, packageResult: { exitCode: 0 } } } }
  assert.equal((await install(f, manager)).ok, false)
})
test('cancel requests official cancelInstall and waits for too-late install result', async t => {
  const f = fixture(t), abort = new AbortController(), cancelled = [], manager = fakeManager(f)
  const original = manager.installBundle
  manager.cancelInstall = async id => { cancelled.push(id); return { status: 'too-late' } }
  manager.installBundle = async (spec, opts) => { abort.abort(); return original(spec, opts) }
  const result = await install(f, manager, { signal: abort.signal })
  assert.equal(cancelled.length, 1); assert.equal(result.installed.length, 1); assert.equal(result.ok, false)
})
test('package installation never clears an existing partial-data upload fence', async t => {
  const f = fixture(t), fence = path.join(f.home, 'safety/pending.json')
  writePending(fence, { pending: true, reason: 'unapplied config' })
  await install(f, fakeManager(f))
  assert.throws(() => assertUploadAllowed(fence, f.home, {}), /已阻止/)
})
test('archives in snapshots are verified transport artifacts, not raw restore files', async t => {
  const f = fixture(t)
  const prepared = await prepareRestore({ workDir: f.work, dshHome: f.home, cfg: f.cfg, codec: createCodec(f.home), oid: 's', online: true })
  assert.equal(prepared.files, 0)
  assert.equal(fs.existsSync(path.join(f.home, 'plugin-packages')), false)
  put(path.join(f.work, 'plugin-packages/unlisted.tgz'), archive())
  await assert.rejects(prepareRestore({ workDir: f.work, dshHome: f.home, cfg: f.cfg, codec: createCodec(f.home), oid: 's' }), /未在插件清单/)
})
test('offline staging preserves target-machine package paths, lock and build policy', async t => {
  const f = fixture(t), manager = fakeManager(f)
  await install(f, manager)
  put(path.join(f.home, 'profiles/desktop/pnpm-lock.yaml'), 'local-lock\n')
  put(path.join(f.home, 'profiles/desktop/pnpm-workspace.yaml'), 'allowBuilds: {}\n')
  put(path.join(f.work, 'profiles/desktop/package.json'), fs.readFileSync(path.join(f.source, 'profiles/desktop/package.json')))
  put(path.join(f.work, 'profiles/desktop/pnpm-lock.yaml'), 'source-machine-lock\n')
  put(path.join(f.work, 'profiles/desktop/pnpm-workspace.yaml'), 'allowBuilds: {untrusted: true}\n')
  const before = fs.readFileSync(path.join(f.work, 'profiles/desktop/package.json'))
  const overrides = localProfileRestoreOverrides(f.work, f.home, f.snap.inventory)
  const prepared = await prepareRestore({ workDir: f.work, dshHome: f.home, cfg: f.cfg, codec: createCodec(f.home), oid: 's', profileOverrides: overrides })
  const plan = JSON.parse(fs.readFileSync(path.join(prepared.stage, 'plan.json')))
  const entry = plan.files.find(f => f.repoPath.endsWith('/package.json'))
  const staged = fs.readFileSync(path.join(prepared.stage, entry.source), 'utf8')
  assert.match(staged, /different-user-home/); assert.ok(!staged.includes('source-only'))
  assert.equal(overrides.get('profiles/desktop/pnpm-lock.yaml').toString(), 'local-lock\n')
  assert.equal(overrides.get('profiles/desktop/pnpm-workspace.yaml').toString(), 'allowBuilds: {}\n')
  assert.deepEqual(fs.readFileSync(path.join(f.work, 'profiles/desktop/package.json')), before)
})
test('offline profile reconciliation refuses missing or mismatched installed versions', t => {
  const f = fixture(t)
  put(path.join(f.work, 'profiles/desktop/package.json'), fs.readFileSync(path.join(f.source, 'profiles/desktop/package.json')))
  assert.throws(() => localProfileRestoreOverrides(f.work, f.home, f.snap.inventory), /先确认安装/)
})
test('multiple-plugin cancellation preserves completed items and terminal install journal', async t => {
  const f = fixture(t), row = { profile: 'desktop', name: 'second-plugin', version: '1.0.0', source: 'npm', enabled: true }
  const meta = JSON.parse(fs.readFileSync(path.join(f.work, 'meta.json'))); meta.pluginInstallManifest.items.push(row)
  put(path.join(f.work, 'meta.json'), JSON.stringify(meta))
  f.plan = detectPluginUpdates({ workDir: f.work, dshHome: f.home, cfg: f.cfg, snapshot: 'synthetic-snapshot' }); savePluginUpdatePlan(f.home, f.plan)
  const abort = new AbortController(), manager = fakeManager(f)
  const result = await install(f, manager, { targets: f.plan.offers.map(o => o.id), signal: abort.signal, onProgress(p) { if (p.completedFiles === 1) abort.abort() } })
  assert.equal(result.installed.length, 1); assert.equal(result.partial, true); assert.equal(manager.calls.length, 1)
  const attempts = path.join(f.home, '.dsh-sync-plugin-updates/attempts')
  const journal = JSON.parse(fs.readFileSync(path.join(attempts, fs.readdirSync(attempts)[0])))
  assert.notEqual(journal.status, 'running'); assert.equal(journal.installed.length, 1)
})
test('confirmed update cannot silently consume archive replaced after initial detection', async t => {
  const f = fixture(t), manager = fakeManager(f)
  put(path.join(f.work, f.snap.inventory[0].archive), archive('test-plugin', '9.9.9'))
  await assert.rejects(install(f, manager), /校验/)
  assert.equal(manager.calls.length, 0)
})

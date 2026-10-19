import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { writePending } from '../lib/sync-guard.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-host-fixture-'))
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = path.join(root, 'home')
fs.mkdirSync(process.env.DSH_HOME)
const config = path.join(process.env.DSH_HOME, 'dsh-sync.json')
fs.writeFileSync(config, JSON.stringify({ repoUrl: 'https://git.example.invalid/synthetic/private.git', branch: 'sync', username: 'test', privateRepoConfirmed: true, token: 'CANARY_SHOULD_NEVER_APPEAR', profiles: ['desktop'], extras: [] }))
const { apply, inject, writeOfflineLauncher } = await import('../lib/panel-host-v020.js')
let route
const tools = new Map(), disposers = []
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
  inject(names, fn) {
    assert.deepEqual(names, ['connection', 'webServer'])
    fn({ ...this, connection: { requestRejection: req => req.headers.authorized === 'yes' ? undefined : 401 }, webServer: { register(r) { route = r; return () => {} } } })
  },
}
apply(ctx)
async function http(method, value, authorized = true) {
  const req = Readable.from(value ? [Buffer.from(JSON.stringify(value))] : [])
  req.url = '/plugins/dsh-sync-ui/api'; req.method = method
  req.headers = { 'content-type': 'application/json', 'x-dsh-sync-ui': '1', authorized: authorized ? 'yes' : 'no' }
  let status, output
  await route.handler(req, { writeHead(s) { status = s }, end(body) { output = JSON.parse(body) } })
  return { status, output }
}

test.after(async () => {
  for (const d of disposers.reverse()) await d()
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  fs.rmSync(root, { recursive: true, force: true })
})
test('host registers all existing tools and authenticated panel API', () => {
  assert.deepEqual(inject, ['tools'])
  assert.equal(tools.size, 5); assert.equal(route.kind, 'exact'); assert.equal(route.path, '/plugins/dsh-sync-ui/api')
})
test('real panel view is an allowlist and never returns the token', async () => {
  const result = await http('GET')
  assert.equal(result.status, 200); assert.equal(result.output.version, '0.6.0')
  assert.equal(result.output.config.tokenPresent, true)
  assert.ok(!JSON.stringify(result.output).includes('CANARY_SHOULD_NEVER_APPEAR'))
  assert.ok(!('token' in result.output.config))
  assert.equal((await http('GET', null, false)).status, 401)
})
test('panel can add/update/remove a missing single-file destination mapping without upload', async () => {
  const targetPath = path.join(root, 'project/new.txt')
  const add = await http('POST', { action: 'extra-save', name: 'notes', targetPath, kind: 'file' })
  assert.equal(add.status, 200)
  let view = (await http('GET')).output
  assert.equal(view.status.extras[0].missing, true)
  assert.equal(view.status.extras[0].kind, 'file')
  assert.equal(fs.existsSync(targetPath), false)
  assert.equal(fs.existsSync(path.join(process.env.DSH_HOME, '.dsh-sync-repo')), false)
  const update = await http('POST', { action: 'extra-save', name: 'notes', targetPath: path.join(root, 'project/other.txt'), kind: 'file' })
  assert.equal(update.status, 200)
  const remove = await http('POST', { action: 'extra-remove', name: 'notes' })
  assert.equal(remove.status, 200); assert.equal((await http('GET')).output.status.extras.length, 0)
})
test('offline launcher copies the complete local module dependency closure', async () => {
  const stage = path.join(root, 'offline-stage'); fs.mkdirSync(stage)
  const command = writeOfflineLauncher(stage)
  assert.ok(command.includes('restore.ps1'))
  for (const file of ['restore-safety.js', 'restore-offline.mjs', 'pathcodec.js', 'transfer-control.js', 'package.json', 'restore.ps1']) assert.ok(fs.existsSync(path.join(stage, file)), file)
  for (const file of ['restore-safety.js', 'restore-offline.mjs', 'pathcodec.js', 'transfer-control.js']) {
    const source = fs.readFileSync(path.join(stage, file), 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*\()['"](\.\/[^'"]+)['"]/g)) assert.ok(fs.existsSync(path.resolve(stage, match[1])), `${file} needs ${match[1]}`)
  }
  const safety = await import(pathToFileURL(path.join(stage, 'restore-safety.js')).href)
  assert.equal(typeof safety.applyRestore, 'function')
})
test('host tool wrapper preserves cancellation identity before any Git/SFTP operation', async () => {
  const before = fs.readFileSync(config)
  for (const name of ['dsh_sync_upload', 'dsh_sync_download']) {
    const abort = new AbortController(); abort.abort('CANARY_SHOULD_NEVER_APPEAR')
    await assert.rejects(tools.get(name).execute({}, { signal: abort.signal }), error => {
      assert.equal(error.name, 'AbortError'); assert.equal(error.code, 'ABORT_ERR')
      assert.ok(!error.message.includes('CANARY_SHOULD_NEVER_APPEAR'))
      return true
    })
  }
  assert.deepEqual(fs.readFileSync(config), before)
  assert.equal(fs.existsSync(path.join(process.env.DSH_HOME, '.dsh-sync-repo')), false)
})
test('host status excludes only machine-local sidecars while counting real cost data', async () => {
  const put = (rel, value) => { const target = path.join(process.env.DSH_HOME, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value) }
  put('storages/cost-meter/ledger.json', '{"realUsage":1}')
  put('storages/cost-meter/ledger.json.native-search/request.jsonl', '{"input":2}\n')
  put('storages/cost-meter/ledger.json.native-search-coverage.json', '{"runtime":{"pid":1}}')
  put('state/codex-subscription/quota-forecast.json', '{"windows":{}}')
  const view = (await http('GET')).output
  assert.equal(view.status.fileCount, 2)
  const status = await tools.get('dsh_sync_status').execute({})
  assert.match(status.summary, /仅本机保留/)
  assert.match(status.summary, /真实费用账本和搜索用量日志仍同步/)
})
test('online mode is capability-gated before transport and never silently falls back', async () => {
  const view = await http('GET')
  assert.equal(view.output.onlineAvailable, false)
  const download = tools.get('dsh_sync_download')
  assert.deepEqual(download.parameters.properties.mode.enum, ['online', 'offline'])
  await assert.rejects(download.execute({}), /在线接口不可用/)
  await assert.rejects(download.execute({ mode: 'unsafe' }), /下载模式/)
  assert.equal(fs.existsSync(path.join(process.env.DSH_HOME, '.dsh-sync-repo')), false)
})
test('persisted unapplied-snapshot fence is shown and rejects upload before network', async () => {
  const key = createHash('sha256').update(JSON.stringify(['gitee', 'https://git.example.invalid/synthetic/private.git', 'sync'])).digest('hex').slice(0, 24)
  const file = path.join(process.env.DSH_HOME, '.dsh-sync-safety', key, 'pending.json')
  writePending(file, { pending: true, reason: 'fixture pending' })
  assert.equal((await http('GET')).output.pendingApply.reason, 'fixture pending')
  await assert.rejects(tools.get('dsh_sync_upload').execute({}), /已阻止/)
  assert.equal(fs.existsSync(path.join(process.env.DSH_HOME, '.dsh-sync-repo')), false)
  writePending(file, { pending: false })
  assert.equal((await http('GET')).output.pendingApply, null)
})
test('unsafe mapping is rejected server-side and status does not alter config bytes', async () => {
  const before = fs.readFileSync(config)
  const bad = await http('POST', { action: 'extra-save', name: '../evil', targetPath: root, kind: 'directory' })
  assert.equal(bad.status, 400)
  await http('GET'); assert.deepEqual(fs.readFileSync(config), before)
})

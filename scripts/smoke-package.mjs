#!/usr/bin/env node
// Unpack only the validated npm package and load it against a synthetic Host.
// This is not a real plugin-manager install or GUI/cold-start acceptance test.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { gunzipSync } from 'node:zlib'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { inspectPluginArchive } from '../lib/plugin-archive.js'
import { scanPublicText } from './verify-public.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const file = path.resolve(process.argv[2] || path.join(root, 'dist', `dsh-sync-${manifest.version}.tgz`))
const bytes = fs.readFileSync(file)
const inspected = inspectPluginArchive(bytes, { maxCompressedBytes: 16 * 1024 ** 2, maxUnpackedBytes: 32 * 1024 ** 2 })
assert.equal(inspected.name, manifest.name); assert.equal(inspected.version, manifest.version)
const allowed = new Set(['package.json', ...manifest.files])
const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 ** 2 })
const members = new Map()
const text = bytes => bytes.toString('utf8').replace(/\0.*$/s, '')
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512)
  if (header.every(byte => byte === 0)) break
  const prefix = text(header.subarray(345, 500))
  const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100))
  const sizeField = text(header.subarray(124, 136)).trim()
  assert.match(sizeField, /^[0-7]+$/)
  const size = parseInt(sizeField, 8)
  assert.ok(header[156] === 0 || header[156] === 48)
  assert.ok(name.startsWith('package/'))
  const relative = name.slice(8)
  assert.ok(allowed.has(relative) && !members.has(relative))
  assert.ok(!relative.includes('\\') && relative.split('/').every(part => part && part !== '.' && part !== '..'))
  assert.ok(offset + 512 + size <= tar.length)
  const data = tar.subarray(offset + 512, offset + 512 + size)
  assert.deepEqual(scanPublicText(new TextDecoder('utf-8', { fatal: true }).decode(data), relative), [])
  members.set(relative, data)
  offset += 512 + Math.ceil(size / 512) * 512
}
assert.equal(members.size, allowed.size)
const tempParent = fs.realpathSync(os.tmpdir())
const temp = fs.mkdtempSync(path.join(tempParent, 'dsh-public-package-smoke-'))
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const disposers = []
try {
  for (const key of Object.keys(process.env)) if (/^DSH_/i.test(key)) delete process.env[key]
  process.env.HOME = temp; process.env.USERPROFILE = temp
  process.env.DSH_HOME = path.join(temp, 'isolated-home')
  fs.mkdirSync(process.env.DSH_HOME)
  let networkCalls = 0
  globalThis.fetch = () => { networkCalls++; throw new Error('Network is forbidden in package smoke test') }
  const destination = path.join(temp, 'package')
  for (const [relative, data] of members) {
    const target = path.join(destination, ...relative.split('/'))
    assert.ok(target.startsWith(destination + path.sep))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data, { flag: 'wx' })
  }
  const host = await import(pathToFileURL(path.join(destination, manifest.main)).href)
  assert.deepEqual(host.inject, ['tools'])
  let route
  const tools = new Map()
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    effect(fn) { const disposer = fn(); if (disposer) disposers.push(disposer) },
    get() { return undefined },
    inject(names, fn) {
      assert.deepEqual(names, ['connection', 'webServer'])
      fn({ ...this, connection: { requestRejection: req => req.headers.authorized === 'synthetic' ? undefined : 401 },
        webServer: { register(value) { route = value; return () => {} } } })
    },
  }
  host.apply(ctx)
  assert.deepEqual([...tools.keys()].sort(), ['dsh_sync_status', 'dsh_sync_extras', 'dsh_sync_upload', 'dsh_sync_download', 'dsh_sync_update_plugins'].sort())
  for (const definition of tools.values()) assert.equal(definition.parameters.type, 'object')
  const config = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'dsh-sync.json'), 'utf8'))
  assert.equal(config.repoUrl, ''); assert.equal(config.username, ''); assert.equal(config.token, '')
  assert.equal(config.sftp, null); assert.equal(config.privateRepoConfirmed, false); assert.deepEqual(config.extras, [])
  const status = await tools.get('dsh_sync_status').execute({})
  assert.equal(status.configured, false); assert.equal(status.fileCount, 0)
  await assert.rejects(tools.get('dsh_sync_upload').execute({}), /私有仓库|配置/)
  await assert.rejects(tools.get('dsh_sync_download').execute({ mode: 'offline' }), /私有仓库|配置/)
  async function request(authorized) {
    const req = Readable.from([])
    req.url = '/plugins/dsh-sync-ui/api'; req.method = 'GET'; req.headers = { authorized }
    let status, value
    await route.handler(req, { writeHead(code) { status = code }, end(body) { value = JSON.parse(body) } })
    return { status, value }
  }
  assert.equal((await request('invalid')).status, 401)
  const response = await request('synthetic')
  assert.equal(response.status, 200); assert.equal(response.value.config.ready, false)
  assert.equal(response.value.config.repoUrl, ''); assert.ok(!Object.hasOwn(response.value.config, 'token'))
  assert.equal(networkCalls, 0)
  console.log(JSON.stringify({ result: 'passed', name: inspected.name, version: inspected.version, bytes: inspected.bytes,
    sha256: inspected.sha256, members: members.size, tools: tools.size, configuredRemote: false,
    networkCalls, host: 'synthetic', realInstallationTested: false }, null, 2))
} finally {
  for (const disposer of disposers.reverse()) await disposer()
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key]
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value
  assert.equal(path.dirname(path.resolve(temp)), tempParent)
  assert.ok(path.basename(temp).startsWith('dsh-public-package-smoke-'))
  fs.rmSync(temp, { recursive: true, force: true })
}

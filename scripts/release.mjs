#!/usr/bin/env node
// Build a standard npm tarball, never an archive of the checkout or a user profile.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { verifyPublicTree, scanPublicText } from './verify-public.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const hygiene = verifyPublicTree(root)
console.log(`Public source hygiene verified: ${hygiene.sourceFiles} files.`)
if (manifest.name !== 'dsh-sync' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('A stable dsh-sync name/version is required.')
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${manifest.version}`) throw new Error('Release tag does not match package.json version.')
if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('An explicit package.files allowlist is required.')
const removed = new Set(['lib/new-device-bootstrap.mjs', 'lib/portable-install.cjs', 'lib/server-defaults.json'])
const allowed = new Set(['package.json', 'README.md', 'LICENSE', ...manifest.files])
for (const name of allowed) {
  if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || /[*?\[\]{}]/.test(name)) {
    throw new Error(`package.files must contain explicit safe file paths: ${name}`)
  }
  if (removed.has(name) || /(^|\/)(?:test|tests|node_modules|\.git|\.dsh|sessions|attachments|state|storages|extras)(?:\/|$)/i.test(name)
      || /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.credentials\.yaml|dsh-sync(?:-auth)?\.json|id_rsa|id_ed25519)$/i.test(name)
      || /\.(?:pem|key|p12|pfx|log|tgz|zip)$/i.test(name)) throw new Error(`Forbidden release path: ${name}`)
  let cursor = root
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part)
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Release source must not be a symlink: ${name}`)
  }
  if (!fs.statSync(path.join(root, name)).isFile()) throw new Error(`Only explicit regular files may be released: ${name}`)
}
if (fs.existsSync(path.join(root, '.npmrc'))) throw new Error('Remove the project .npmrc from the public checkout before packing.')
const nodeDir = path.dirname(process.execPath)
const npmCli = [process.env.npm_execpath,
  path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
  path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(candidate => candidate && /npm-cli\.(?:js|cjs)$/.test(candidate) && fs.existsSync(candidate))
if (!npmCli) throw new Error('npm CLI not found beside Node; use a standard Node.js/npm installation or npm run release:pack.')

const out = path.join(root, 'dist')
fs.mkdirSync(out, { recursive: true })
if (fs.lstatSync(out).isSymbolicLink()) throw new Error('dist must not be a symlink.')
const temp = fs.mkdtempSync(path.join(out, '.pack-'))
try {
  const emptyConfig = path.join(temp, 'empty.npmrc')
  fs.writeFileSync(emptyConfig, '')
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', temp, '--cache', path.join(temp, 'cache')], {
    cwd: root, shell: false, stdio: 'inherit',
    env: { ...process.env, npm_config_userconfig: emptyConfig, npm_config_globalconfig: path.join(temp, 'missing-global.npmrc'),
      npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
  })
  if (result.error) throw result.error
  if (result.status !== 0 || result.signal) throw new Error(`npm pack failed: status=${result.status}, signal=${result.signal}`)
  const packedFiles = fs.readdirSync(temp).filter(name => name.endsWith('.tgz'))
  if (packedFiles.length !== 1 || packedFiles[0] !== `${manifest.name}-${manifest.version}.tgz`) throw new Error('Unexpected npm pack output filename.')
  const archive = fs.readFileSync(path.join(temp, packedFiles[0]))
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 })
  const actual = new Map()
  const text = buffer => buffer.toString('utf8').replace(/\0.*$/s, '')
  const octal = buffer => { const value = text(buffer).trim(); if (!/^[0-7]*$/.test(value)) throw new Error('Invalid tar octal field.'); return parseInt(value || '0', 8) }
  let offset = 0
  for (; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const checksum = octal(header.subarray(148, 156))
    let expected = 0
    for (let i = 0; i < 512; i++) expected += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== expected) throw new Error('Invalid tar checksum.')
    if (text(header.subarray(265, 297)) || text(header.subarray(297, 329))
        || octal(header.subarray(108, 116)) !== 0 || octal(header.subarray(116, 124)) !== 0) throw new Error('Archive must not contain device owner identity metadata.')
    const prefix = text(header.subarray(345, 500))
    const name = (prefix ? `${prefix}/` : '') + text(header.subarray(0, 100))
    const size = octal(header.subarray(124, 136))
    const type = header[156]
    if (type !== 0 && type !== 48) throw new Error(`Only regular npm tar members are accepted: ${name}`)
    if (!name.startsWith('package/')) throw new Error(`Tar entry outside package/: ${name}`)
    const relative = name.slice(8)
    if (!allowed.has(relative) || actual.has(relative) || offset + 512 + size > tar.length) throw new Error(`Unexpected/duplicate/truncated tar entry: ${name}`)
    const bytes = tar.subarray(offset + 512, offset + 512 + size)
    const findings = scanPublicText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), relative)
    if (findings.length) throw new Error('Packed privacy check failed (values withheld):\n' + findings.join('\n'))
    if (relative !== 'package.json' && !bytes.equals(fs.readFileSync(path.join(root, relative)))) throw new Error(`Packed source differs from checkout: ${relative}`)
    if (relative === 'package.json') {
      const value = JSON.parse(bytes.toString('utf8'))
      if (value.name !== manifest.name || value.version !== manifest.version || JSON.stringify(value.files) !== JSON.stringify(manifest.files)) throw new Error('Packed manifest mismatch.')
    }
    actual.set(relative, size)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (actual.size !== allowed.size || tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('Incomplete tar file set or invalid end markers.')
  const digest = createHash('sha256').update(archive).digest('hex')
  const names = ['dsh-sync.tgz', `dsh-sync-${manifest.version}.tgz`]
  for (const name of [...names, 'SHA256SUMS']) {
    const target = path.join(out, name)
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error(`Unsafe existing output: ${name}`)
  }
  for (const name of names) fs.writeFileSync(path.join(out, name), archive)
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), names.map(name => `${digest}  ${name}\n`).join(''))
  console.log(`Verified ${actual.size} package files. No tests, user profile or checkout archive included.`)
  for (const name of names) console.log(`${digest}  dist/${name}`)
  console.log('Created dist/SHA256SUMS. Packing does not publish or transfer personal data.')
} finally {
  // Bound cleanup to the exact scratch directory allocated inside this checkout's dist.
  if (path.dirname(temp) !== out || !path.basename(temp).startsWith('.pack-')) throw new Error('Unsafe pack cleanup path.')
  fs.rmSync(temp, { recursive: true, force: true })
}

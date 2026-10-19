import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, validateConfig, readConfig, configured, assertRemoteConfigured, gitWorkDir } from '../lib/config.js'

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, 'dsh-public-config-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}
const gitConfig = (overrides = {}) => validateConfig({
  repoUrl: 'https://git.example.invalid/alice/private-data.git', branch: 'sync',
  username: 'synthetic-alice', token: 'SYNTHETIC-TOKEN-NOT-A-CREDENTIAL',
  privateRepoConfirmed: true, ...overrides,
})
const syntheticHostKey = () => {
  const key = Buffer.concat([
    Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7),
  ])
  return 'ssh-ed25519 ' + key.toString('base64')
}

test('public defaults contain no account or remote and absent configuration stays read-only', t => {
  const root = temporary(t), file = path.join(root, 'dsh-sync.json')
  const cfg = readConfig(file)
  assert.equal(cfg.repoUrl, '')
  assert.equal(cfg.username, '')
  assert.equal(cfg.token, '')
  assert.equal(cfg.sftp, null)
  assert.equal(cfg.privateRepoConfirmed, false)
  assert.equal(configured(cfg), false)
  assert.equal(configured(cfg, 'SYNTHETIC-ENV-TOKEN'), false)
  assert.throws(() => assertRemoteConfigured(cfg), /私有仓库/)
  assert.equal(fs.existsSync(file), false)
  assert.equal(DEFAULT_CONFIG.repoUrl, '')
  const next = validateConfig()
  cfg.profiles.push('synthetic-profile')
  cfg.extras.push({ name: 'synthetic' })
  assert.deepEqual(next.profiles, ['desktop'])
  assert.deepEqual(next.extras, [])
})

test('Git readiness requires own repository, account, credentials and explicit private confirmation', () => {
  assert.equal(configured(gitConfig()), true)
  assert.doesNotThrow(() => assertRemoteConfigured(gitConfig()))
  for (const overrides of [{ repoUrl: '' }, { username: '' }, { token: '' }, { privateRepoConfirmed: false }]) {
    const cfg = gitConfig(overrides)
    assert.equal(configured(cfg), false, JSON.stringify(overrides))
    assert.throws(() => assertRemoteConfigured(cfg), /私有仓库|配置/)
  }
  const cfg = gitConfig({ token: '' })
  assert.equal(configured(cfg, 'SYNTHETIC-ENV-TOKEN'), true)
  assert.doesNotThrow(() => assertRemoteConfigured(cfg, 'SYNTHETIC-ENV-TOKEN'))
  const unconfirmed = gitConfig({ privateRepoConfirmed: false })
  assert.equal(configured(unconfirmed, 'SYNTHETIC-ENV-TOKEN'), false)
  assert.throws(() => assertRemoteConfigured(unconfirmed), /不会自动检测或更改仓库可见性/)
})

test('private confirmation is a local assertion, never a claimed remote visibility lookup', t => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => { calls++; throw new Error('Network forbidden in public configuration test') }
  t.after(() => { globalThis.fetch = original })
  const cfg = gitConfig()
  assert.equal(configured(cfg), true)
  assert.doesNotThrow(() => assertRemoteConfigured(cfg))
  assert.equal(calls, 0)
})

test('the public software distribution repository cannot be used for personal snapshots', () => {
  for (const repoUrl of [
    'https://github.com/vxdeus/dsh-sync',
    'https://github.com/vxdeus/dsh-sync.git',
    'https://GITHUB.COM/VXDEUS/DSH-SYNC.git/',
  ]) assert.throws(() => gitConfig({ repoUrl }), /公开插件发布仓库/)
  assert.doesNotThrow(() => gitConfig({ repoUrl: 'https://github.com/synthetic-owner/private-sync-data.git' }))
})

test('configured repositories reject embedded credentials, non-HTTPS and URL query/hash fields', () => {
  for (const repoUrl of [
    'not a URL', 'http://git.example.invalid/private.git',
    'https://synthetic-user:synthetic-password@git.example.invalid/private.git',
    'https://git.example.invalid/private.git?token=SYNTHETIC',
    'https://git.example.invalid/private.git#fragment',
  ]) assert.throws(() => gitConfig({ repoUrl }), /HTTPS URL/)
})

test('Git working copies isolate repository, branch and account but not token rotations', t => {
  const root = temporary(t), base = gitConfig()
  const initial = gitWorkDir(root, base)
  assert.equal(path.dirname(initial), path.join(root, '.dsh-sync-git'))
  assert.match(path.basename(initial), /^[a-f0-9]{24}$/)
  const variants = [
    gitConfig({ repoUrl: 'https://git.example.invalid/bob/other-private-data.git' }),
    gitConfig({ branch: 'another-sync-branch' }),
    gitConfig({ username: 'synthetic-bob' }),
  ]
  assert.equal(new Set([initial, ...variants.map(cfg => gitWorkDir(root, cfg))]).size, 4)
  assert.equal(gitWorkDir(root, gitConfig({ token: 'ROTATED-SYNTHETIC-TOKEN' })), initial)
  assert.equal(gitWorkDir(root, gitConfig({ token: '' })), initial)
  assert.equal(gitWorkDir(root, gitConfig({ privateRepoConfirmed: false })), initial)
  assert.doesNotThrow(() => gitWorkDir(root, validateConfig()))
  assert.equal(fs.existsSync(path.join(root, '.dsh-sync-git')), false)
})

test('malformed configuration fails without rewriting original bytes or creating a replacement', t => {
  const root = temporary(t), file = path.join(root, 'dsh-sync.json')
  for (const text of ['{broken-json', 'null', '[]', '{"privateRepoConfirmed":"yes"}', '{"extras":{}}']) {
    fs.writeFileSync(file, text)
    const before = fs.readFileSync(file)
    assert.throws(() => readConfig(file))
    assert.deepEqual(fs.readFileSync(file), before)
    assert.equal(fs.existsSync(file + '.tmp'), false)
  }
})

test('existing BOM configuration preserves its exact bytes and local optional fields', t => {
  const root = temporary(t), file = path.join(root, 'dsh-sync.json')
  const text = '\uFEFF' + JSON.stringify({ ...gitConfig(), localMarker: 'synthetic-local-value' }, null, 3) + '\r\n'
  fs.writeFileSync(file, text)
  const before = fs.readFileSync(file), cfg = readConfig(file)
  assert.equal(cfg.localMarker, 'synthetic-local-value')
  assert.equal(configured(cfg), true)
  assert.deepEqual(fs.readFileSync(file), before)
})

test('SFTP can be configured without any Git repository and uses only a synthetic local key fixture', t => {
  const root = temporary(t), key = path.join(root, 'synthetic-key-never-used-for-authentication')
  fs.writeFileSync(key, 'synthetic fixture; not a private key\n')
  const cfg = validateConfig({ backend: 'sftp', repoUrl: '', username: '', token: '',
    sftp: { host: 'sync.example.invalid', username: 'synthetic', port: 22,
      remoteRoot: '/data/synthetic-sync', hostKey: syntheticHostKey(), privateKeyPath: key } })
  assert.equal(cfg.repoUrl, '')
  assert.equal(cfg.privateRepoConfirmed, false)
  assert.equal(configured(cfg), true)
  assert.doesNotThrow(() => assertRemoteConfigured(cfg))
  const missing = validateConfig({ ...cfg, sftp: { ...cfg.sftp, privateKeyPath: path.join(root, 'not-created') } })
  assert.equal(configured(missing), false)
  assert.throws(() => assertRemoteConfigured(missing), /未连接远端/)
})

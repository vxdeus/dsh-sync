import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { scanPublicText, verifyPublicTree } from '../scripts/verify-public.mjs'
import { buildManifest, buildExtraManifest, isDenied, sensitiveName } from '../lib/pathcodec.js'
import { allowedExtra } from '../lib/restore-safety.js'

const root = fileURLToPath(new URL('..', import.meta.url))
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(parent, 'dsh-public-release-'))
  t.after(() => {
    assert.equal(path.dirname(directory), parent)
    assert.ok(path.basename(directory).startsWith('dsh-public-release-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}
function put(root, relative) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'SYNTHETIC FIXTURE ONLY; NEVER A CREDENTIAL\n')
  return target
}

test('public source has complete docs, inert defaults and no detected private release content', () => {
  const result = verifyPublicTree(root)
  assert.equal(result.version, '0.6.0')
  assert.ok(result.sourceFiles > result.packageFiles)
})
test('release text hygiene rejects remote addresses, private keys and real-looking home paths without exposing values', () => {
  const samples = [
    ['https:', '', 'gitee.com', 'synthetic-account', 'synthetic-repo.git'].join('/'),
    [198, 51, 100, 11].join('.'),
    ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' '),
    ['C:', 'Users', 'not-a-synthetic-user', 'project'].join('\\'),
    'ghp_' + 'X'.repeat(30),
  ]
  for (const input of samples) {
    const problems = scanPublicText(input, 'fixture')
    assert.ok(problems.length > 0)
    assert.ok(problems.every(problem => !problem.includes(input)))
  }
  assert.deepEqual(scanPublicText('https://github.com/vxdeus/dsh-sync\nhttps://git.example.invalid/your-account/private-sync.git'), [])
})
test('sensitive names and DSH exclusions are case-insensitive while ordinary filenames stay syncable', () => {
  for (const name of ['.NPMRC', '.Git-Credentials', 'Id_RsA', 'ID_ED25519', 'DSH-SYNC.JSON', 'DSH-SYNC-AUTH.JSON', '.CREDENTIALS.YAML', '.ANONYMOUS-USER-ID', '.ENV.Local', 'device.PEM']) {
    assert.equal(sensitiveName(name), true, name)
  }
  for (const rel of ['CACHE/file.json', 'INTEGRATIONS/x.json', 'profile/NODE_MODULES/pkg/file.json', 'state/DSH-SYNC.JSON']) assert.equal(isDenied(rel), true, rel)
  for (const name of ['readme.md', 'ssh-notes.txt', 'configuration.json', 'key-notes.txt']) assert.equal(sensitiveName(name), false, name)
})
test('directory upload manifests never include mixed-case credential paths even when default excludes are disabled', t => {
  const directory = fixture(t)
  const project = path.join(directory, 'project')
  const forbidden = ['.NPMRC', '.Git-Credentials', 'Id_RsA', 'ID_ED25519', 'DSH-SYNC.JSON', 'DSH-SYNC-AUTH.JSON', '.CREDENTIALS.YAML', '.ENV.Local', 'device.PFX', '.AWS/credentials', '.SSH/ID_RSA', '.GNUPG/secring', '.GIT/config', 'nested/.Aws/credentials', 'nested/.NpmRc']
  for (const file of [...forbidden, 'src/main.js', 'readme.md']) put(project, file)
  const extra = { name: 'synthetic-project', path: project, exclude: [] }
  const files = buildExtraManifest(extra).map(item => item.rel.split(path.sep).join('/'))
  assert.deepEqual(files.sort(), ['extras/synthetic-project/readme.md', 'extras/synthetic-project/src/main.js'])
  for (const file of files) assert.equal(allowedExtra(file), true)
  const home = path.join(directory, 'home'); fs.mkdirSync(home)
  const manifest = buildManifest(home, { profiles: ['desktop'], includeAttachments: false, extras: [extra] })
  assert.deepEqual(manifest.map(item => item.rel.split(path.sep).join('/')).sort(), files)
})
test('explicit single-file sensitive names reject independent of casing', t => {
  const directory = fixture(t)
  for (const name of ['.NPMRC', 'DSH-SYNC.JSON', 'ID_RSA']) {
    const file = put(directory, name)
    assert.throws(() => buildExtraManifest({ name: 'fixture', path: file }), /敏感凭据/)
  }
})

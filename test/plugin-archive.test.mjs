import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { inspectPluginArchive } from '../lib/plugin-archive.js'

// Every archive in this suite is synthesized here; no filesystem/network/real packages.
const BLOCK = 512
const DEFAULT_MANIFEST = {
  name: '@example/startup-screen',
  version: '1.2.3-rc.1+test.04',
  main: './lib/index.js',
  exports: { '.': { import: './lib/index.js', default: './lib/index.js' }, './client': './lib/client.js', './package.json': './package.json' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}
const clone = value => JSON.parse(JSON.stringify(value))
const payload = value => Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')

function checksum(header) {
  header.fill(32, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return header
}

function tarEntry({ name, data = '', type = '0', link = '', prefix = '', size, v7 = false, mutate } = {}) {
  data = payload(data)
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write((size ?? data.length).toString(8).padStart(11, '0') + '\0', 124, 'latin1')
  header.write('00000000000\0', 136, 'latin1')
  header[156] = type === '\0' ? 0 : type.charCodeAt(0)
  header.write(link, 157, 100, 'utf8')
  if (!v7) {
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    header.write(prefix, 345, 155, 'utf8')
  }
  if (mutate) mutate(header)
  checksum(header)
  return Buffer.concat([header, data, Buffer.alloc((BLOCK - data.length % BLOCK) % BLOCK)])
}

function tar(entries, { endBlocks = 2 } = {}) {
  return Buffer.concat([...entries.map(entry => Buffer.isBuffer(entry) ? entry : tarEntry(entry)), Buffer.alloc(BLOCK * endBlocks)])
}
function archive(entries, options) { return gzipSync(tar(entries, options)) }
function fixture({ manifest = clone(DEFAULT_MANIFEST), root = 'package', extras = [] } = {}) {
  const p = name => root ? root + '/' + name : name
  return [
    { name: p('package.json'), data: JSON.stringify(manifest) },
    { name: p('cordis.patch.yml'), data: '- insert: []\n' },
    { name: p('lib/index.js'), data: 'export const apply = () => {}\n' },
    { name: p('lib/client.js'), data: 'export const apply = () => {}\n' },
    ...extras,
  ]
}
function expectBad(entries, expression = /Invalid plugin archive/, options) {
  assert.throws(() => inspectPluginArchive(archive(entries), options), expression)
}
function paxRecord(key, value) {
  const body = Buffer.from(` ${key}=${value}\n`, 'utf8')
  let length = body.length + 1
  while (String(length).length + body.length !== length) length = String(length).length + body.length
  return Buffer.concat([Buffer.from(String(length)), body])
}
function pax(values, type = 'x') {
  return { name: 'PaxHeaders/metadata', type, data: Buffer.concat(Object.entries(values).map(([key, value]) => paxRecord(key, value))) }
}

test('npm pack archive returns manifest identity and hash of compressed bytes', () => {
  const bytes = archive(fixture())
  const result = inspectPluginArchive(bytes)
  assert.deepEqual(result, {
    name: DEFAULT_MANIFEST.name,
    version: DEFAULT_MANIFEST.version,
    manifest: DEFAULT_MANIFEST,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  })
  assert.equal(inspectPluginArchive(new Uint8Array(bytes)).sha256, result.sha256)
})

test('GitHub tar with a repository root directory and harmless ./ separators is accepted', () => {
  const files = fixture({ root: 'repository-main' })
  const result = inspectPluginArchive(archive([
    { name: './', type: '5' },
    { name: './repository-main/', type: '5' },
    ...files.map(file => ({ ...file, name: './' + file.name })),
  ]))
  assert.equal(result.name, DEFAULT_MANIFEST.name)
})

test('archive-root package.json and nested non-root manifests are accepted', () => {
  const result = inspectPluginArchive(archive(fixture({ root: '', extras: [{ name: 'fixtures/package.json', data: '{}' }] })))
  assert.equal(result.version, DEFAULT_MANIFEST.version)
})

test('USTAR prefix field is honored for long paths', () => {
  const root = 'repository-main'
  const directory = 'source-' + 'x'.repeat(100)
  const manifest = { name: 'ustar-test', version: '1.0.0', main: `./${directory}/index.js`, dsh: { bundle: { patch: './cordis.patch.yml' } } }
  const result = inspectPluginArchive(archive([
    { name: root + '/package.json', data: JSON.stringify(manifest) },
    { name: root + '/cordis.patch.yml', data: '[]' },
    { prefix: `${root}/${directory}`, name: 'index.js', data: 'export {}' },
  ]))
  assert.equal(result.name, 'ustar-test')
})

test('V7 regular headers with NUL file type remain valid', () => {
  assert.equal(inspectPluginArchive(archive(fixture().map(file => ({ ...file, v7: true, type: '\0' })))).name, DEFAULT_MANIFEST.name)
})

test('positive base-256 USTAR size is decoded without signed/integer overflow', () => {
  const files = fixture()
  const data = payload(files[0].data)
  const first = tarEntry({ ...files[0], mutate(header) {
    header.fill(0, 124, 136)
    let n = BigInt(data.length)
    for (let i = 135; i >= 125; i--) { header[i] = Number(n & 255n); n >>= 8n }
    header[124] = 0x80
  } })
  assert.equal(inspectPluginArchive(archive([first, ...files.slice(1)])).name, DEFAULT_MANIFEST.name)
})

test('PAX uses byte-counted UTF-8 lengths and supports common Chinese paths', () => {
  const manifest = clone(DEFAULT_MANIFEST)
  manifest.main = './界面/启动.js'
  manifest.exports['.'] = './界面/启动.js'
  const files = fixture({ manifest })
  files.splice(2, 1, pax({ path: 'package/界面/启动.js', mtime: '1234567890.125', 'SCHILY.xattr.user.note': '中文属性' }), { name: 'placeholder.js', data: 'export {}' })
  assert.equal(inspectPluginArchive(archive(files)).name, manifest.name)
})

test('PAX path and size overrides are applied to the same material entry', () => {
  const files = fixture()
  const manifestData = payload(files[0].data)
  const first = tarEntry({ name: 'placeholder', size: 0, data: manifestData })
  const entries = [pax({ path: 'package/package.json', size: String(manifestData.length) }), first, ...files.slice(1)]
  assert.equal(inspectPluginArchive(archive(entries)).name, DEFAULT_MANIFEST.name)
})

test('global PAX metadata and empty local deletions are supported', () => {
  const entries = [pax({ comment: '测试 metadata', path: 'package/package.json' }, 'g'), pax({ path: '', size: '' }), fixture()[0], pax({ path: '' }, 'g'), ...fixture().slice(1)]
  assert.equal(inspectPluginArchive(archive(entries)).name, DEFAULT_MANIFEST.name)
})

test('declarations can contain multiple patches, conditional/pattern exports and legacy main resolution', () => {
  const manifest = clone(DEFAULT_MANIFEST)
  manifest.main = './lib'
  manifest.dsh.bundle.patch = ['./cordis.patch.yml', './extra.patch.yml']
  manifest.exports = { '.': ['./lib/index.js', null], './*': { node: './lib/*.js', default: './lib/client.js' } }
  assert.equal(inspectPluginArchive(archive(fixture({ manifest, extras: [{ name: 'package/extra.patch.yml', data: '[]' }] }))).name, manifest.name)
})

test('a pure bundle may omit main and exports', () => {
  const manifest = { name: 'pure-bundle', version: '0.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  assert.equal(inspectPluginArchive(archive(fixture({ manifest }))).name, manifest.name)
})

test('root main ./ resolves to an existing index.js', () => {
  const manifest = { name: 'legacy-main', version: '1.0.0', main: './', dsh: { bundle: { patch: 'cordis.patch.yml' } } }
  assert.equal(inspectPluginArchive(archive(fixture({ root: '', manifest, extras: [{ name: 'index.js', data: 'export {}' }] }))).name, manifest.name)
})

test('dependency specs are not installation policy and do not trigger any execution', () => {
  const manifest = clone(DEFAULT_MANIFEST)
  manifest.dependencies = { local: 'file:../something', link: 'link:../thing', workspace: 'workspace:*', alias: 'npm:another@1.0.0', git: 'github:example/repo', url: 'https://example.invalid/package.tgz' }
  manifest.scripts = { prepare: 'THIS MUST NEVER EXECUTE' }
  const result = inspectPluginArchive(archive(fixture({ manifest })))
  assert.deepEqual(result.manifest.dependencies, manifest.dependencies)
  assert.equal(result.manifest.scripts.prepare, manifest.scripts.prepare)
})

test('bad tar checksum is rejected', () => {
  const bytes = tar(fixture())
  bytes[100] ^= 1
  assert.throws(() => inspectPluginArchive(gzipSync(bytes)), /checksum/)
})

test('non-octal and high-bit checksum digits are rejected', () => {
  for (const value of [56, 0xb1]) {
    const bytes = tar(fixture())
    bytes[148] = value
    assert.throws(() => inspectPluginArchive(gzipSync(bytes)), /checksum/)
  }
})

test('truncated gzip and corrupt gzip CRC are rejected', () => {
  const bytes = archive(fixture())
  assert.throws(() => inspectPluginArchive(bytes.subarray(0, -4)), /gzip/)
  const corrupt = Buffer.from(bytes)
  corrupt[corrupt.length - 8] ^= 1
  assert.throws(() => inspectPluginArchive(corrupt), /gzip/)
})

test('non-gzip and invalid arguments are rejected', () => {
  for (const bytes of [Buffer.alloc(0), tar(fixture()), Buffer.from('not gzip at all')]) assert.throws(() => inspectPluginArchive(bytes), /gzip/)
  for (const value of [null, 'text', {}, new ArrayBuffer(8)]) assert.throws(() => inspectPluginArchive(value), /Buffer or Uint8Array/)
})

test('compressed limit is inclusive and enforced before decompression', () => {
  const bytes = archive(fixture())
  assert.equal(inspectPluginArchive(bytes, { maxCompressedBytes: bytes.length }).bytes, bytes.length)
  assert.throws(() => inspectPluginArchive(bytes, { maxCompressedBytes: bytes.length - 1 }), /compressed size limit/)
})

test('unpacked limit is inclusive; a highly compressible gzip bomb is bounded', () => {
  const bytes = tar(fixture())
  assert.equal(inspectPluginArchive(gzipSync(bytes), { maxUnpackedBytes: bytes.length }).name, DEFAULT_MANIFEST.name)
  assert.throws(() => inspectPluginArchive(gzipSync(bytes), { maxUnpackedBytes: bytes.length - 1 }), /unpacked size limit/)
  const bomb = gzipSync(Buffer.alloc(1024 * 1024))
  assert.ok(bomb.length < 2048)
  assert.throws(() => inspectPluginArchive(bomb, { maxUnpackedBytes: 8192 }), /unpacked size limit/)
})

test('all concatenated gzip members count toward the decompression budget', () => {
  const bytes = tar(fixture())
  const compressed = Buffer.concat([gzipSync(bytes.subarray(0, BLOCK)), gzipSync(bytes.subarray(BLOCK))])
  assert.equal(inspectPluginArchive(compressed).name, DEFAULT_MANIFEST.name)
  assert.throws(() => inspectPluginArchive(compressed, { maxUnpackedBytes: bytes.length - 1 }), /unpacked size limit/)
})

test('limits reject zero, negative, fractional, nonnumeric and infinite values', () => {
  const bytes = archive(fixture())
  for (const value of [0, -1, 1.5, Infinity, NaN, '100', Number.MAX_SAFE_INTEGER + 1]) {
    for (const name of ['maxCompressedBytes', 'maxUnpackedBytes']) assert.throws(() => inspectPluginArchive(bytes, { [name]: value }), /positive safe integer/)
  }
})

test('truncated tar headers, file payloads and end markers are rejected', () => {
  const bytes = tar(fixture())
  assert.throws(() => inspectPluginArchive(gzipSync(bytes.subarray(0, 100))), /truncated tar header/)
  assert.throws(() => inspectPluginArchive(gzipSync(bytes.subarray(0, BLOCK + 100))), /truncated tar file payload/)
  assert.throws(() => inspectPluginArchive(archive(fixture(), { endBlocks: 1 })), /end marker/)
  assert.throws(() => inspectPluginArchive(archive(fixture(), { endBlocks: 0 })), /end marker/)
})

test('nonzero content after a tar end marker and incomplete trailing padding are rejected', () => {
  const base = tar(fixture())
  assert.throws(() => inspectPluginArchive(gzipSync(Buffer.concat([base, tarEntry({ name: 'hidden', data: 'bad' })]))), /end marker/)
  assert.throws(() => inspectPluginArchive(gzipSync(Buffer.concat([base, Buffer.alloc(1)]))), /padding/)
})

test('raw size claims cannot escape bounds or wrap around', () => {
  expectBad([tarEntry({ name: 'package/a', size: 900_000 }), ...fixture()], /truncated tar file payload/)
  expectBad([tarEntry({ name: 'package/a', size: 1024 * 1024 * 1024 }), ...fixture()], /file size exceeds/)
  for (const mutate of [
    header => { header[124] = 0xff },
    header => { header.fill(255, 124, 136); header[124] = 0x80 },
    header => { header[124] = 0xb1; header[125] = 48 },
    header => { header.write('-0000000001\0', 124, 'latin1') },
    header => { header.write('00000000008\0', 124, 'latin1') },
  ]) expectBad([tarEntry({ name: 'package/a', mutate }), ...fixture()], /size/)
})

for (const name of [
  '../evil', 'package/../../evil', 'package/a/../evil', '/absolute/file', '//server/share', 'C:/drive/file', 'C:relative',
  'package\\evil', 'package/CON', 'package/aux.txt', 'package/NUL.js', 'package/COM1', 'package/lpt9.log', 'package/COM¹.log',
  'package/CONIN$', 'package/CONOUT$', 'package/NUL .txt', 'package/file:stream', 'package/trailing.', 'package/trailing ', 'package/control\nfile',
]) {
  test(`unsafe tar path rejected: ${JSON.stringify(name)}`, () => expectBad([...fixture(), { name, data: 'bad' }], /path|device/))
}

test('unsafe USTAR prefix is checked as part of the full path', () => {
  expectBad([...fixture(), { prefix: '../escape', name: 'file', data: 'bad' }], /traversal/)
})

test('invalid UTF-8 path bytes are rejected', () => {
  expectBad([tarEntry({ name: 'placeholder', mutate(header) { header[0] = 0xff } }), ...fixture()], /UTF-8/)
})

for (const type of ['1', '2', '3', '4', '6', '7', 'L', 'K', 'S']) {
  test(`link/special tar type rejected: ${type}`, () => expectBad([...fixture(), { name: 'package/special', type }], /links|special/))
}

test('nonempty raw linkname is rejected even on a purported regular file', () => {
  expectBad([...fixture(), { name: 'package/link', link: 'package/lib/index.js', data: 'not a regular file' }], /links/)
})

test('directories may not carry payloads; regular files may not end in /', () => {
  expectBad([...fixture(), { name: 'package/directory/', type: '5', data: 'x' }], /directory entry/)
  expectBad([...fixture(), { name: 'package/file/', data: 'x' }], /directory path/)
})

for (const values of [
  { path: '../outside' }, { path: '/absolute' }, { path: 'C:/absolute' }, { path: 'package\\backslash' },
  { path: 'package/NUL' }, { linkpath: '../outside' }, { linkpath: 'package/lib/index.js' },
  { size: '-1' }, { size: '1.5' }, { size: '01' }, { size: '99999999999999999999999999' },
  { 'GNU.sparse.name': 'package/hidden' }, { 'SCHILY.filetype': 'symlink' },
]) {
  test(`unsafe PAX metadata rejected: ${JSON.stringify(values)}`, () => {
    for (const type of ['x', 'g']) expectBad([pax(values, type), ...fixture()], /path|traversal|device|links|PAX|sparse/)
  })
}

test('PAX size above the custom limit cannot replace a small header size', () => {
  expectBad([pax({ size: '9000000' }), ...fixture()], /PAX size exceeds/, { maxUnpackedBytes: 8192 })
})

test('PAX payload size cannot consume bytes beyond tar boundaries', () => {
  expectBad([pax({ size: '1000000' }), ...fixture()], /truncated tar file payload/)
})

test('PAX cannot hide a hostile original header path or linkname', () => {
  expectBad([pax({ path: 'package/safe' }), { name: '../unsafe' }, ...fixture()], /traversal/)
  expectBad([pax({ path: 'package/safe' }), { name: 'harmless', link: 'package/x' }, ...fixture()], /links/)
})

test('malformed PAX record length, framing, encoding and duplicate keys are rejected', () => {
  for (const data of [
    '99 path=x\n', '0 path=x\n', '01 path=x\n', 'no-length path=x\n', '12 path=abc!',
    Buffer.concat([paxRecord('path', 'package/a'), paxRecord('path', 'package/b')]),
    Buffer.from('12 path=\0xx\n'),
    Buffer.from([49, 50, 32, 112, 97, 116, 104, 61, 255, 120, 120, 10]),
  ]) expectBad([{ name: 'PaxHeaders/meta', type: 'x', data }, ...fixture()], /PAX|UTF-8/)
})

test('dangling and repeated local PAX headers are rejected', () => {
  expectBad([...fixture(), pax({ comment: 'unused' })], /dangling PAX/)
  expectBad([pax({ path: 'package/x' }), pax({ path: 'package/y' }), ...fixture()], /repeated local PAX/)
})

for (const path of ['package/package.json', './package//package.json', 'package/./package.json', 'package/PACKAGE.JSON']) {
  test(`duplicate root manifest rejected: ${path}`, () => expectBad([...fixture(), { name: path, data: JSON.stringify(DEFAULT_MANIFEST) }], /duplicate normalized/))
}

test('PAX normalized duplicate manifest cannot shadow the first manifest', () => {
  expectBad([...fixture(), pax({ path: './package//package.json' }), { name: 'placeholder', data: '{}' }], /duplicate normalized/)
})

test('all material duplicates including Unicode-equivalent paths are rejected', () => {
  expectBad([...fixture(), { name: 'package/lib/index.js', data: 'override' }], /duplicate normalized/)
  expectBad([...fixture(), { name: 'package/caf\u00e9', data: 'first' }, { name: 'package/cafe\u0301', data: 'second' }], /duplicate normalized/)
  expectBad([...fixture(), { name: 'package/dir/', type: '5' }, { name: 'package/dir', data: 'file' }], /duplicate normalized/)
})

test('manifest file resolution preserves actual Unicode spelling', () => {
  const manifest = clone(DEFAULT_MANIFEST)
  manifest.main = './caf\u00e9.js'
  expectBad(fixture({ manifest, extras: [{ name: 'package/cafe\u0301.js', data: 'export {}' }] }), /entry file does not exist/)
})

test('files cannot serve as directory ancestors, including Windows case collisions', () => {
  expectBad([...fixture(), { name: 'package/LIB', data: 'file' }], /parent directory/)
})

test('root manifest is required and archive roots cannot be mixed', () => {
  expectBad(fixture().slice(1), /root package.json/)
  expectBad([...fixture(), ...fixture({ root: 'second' })], /root package.json must be unique/)
  expectBad([...fixture(), { name: 'unrelated/file', data: 'x' }], /outside the package root/)
  expectBad([{ name: 'package/package.json', type: '5' }], /root package.json/)
})

for (const name of ['', 'UPPERCASE', '../escape', '@scope', '@scope/name/extra', 'with space', '_private', '.hidden', 'node_modules', 'favicon.ico', 'a'.repeat(215), null, 123]) {
  test(`invalid package name rejected: ${JSON.stringify(name)}`, () => {
    const manifest = clone(DEFAULT_MANIFEST)
    manifest.name = name
    expectBad(fixture({ manifest }), /invalid package name/)
  })
}

for (const version of ['', 'latest', 'v1.2.3', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-a.00', '1.2.3-', '1.2.3+', '1.2.3-rc..1', '1.2.3 extra', null, 123]) {
  test(`invalid package version rejected: ${JSON.stringify(version)}`, () => {
    const manifest = clone(DEFAULT_MANIFEST)
    manifest.version = version
    expectBad(fixture({ manifest }), /invalid package version/)
  })
}

test('malformed JSON and non-object manifests are rejected', () => {
  for (const value of ['{broken', '[]', 'null', '1', '"text"']) {
    const files = fixture()
    files[0].data = value
    expectBad(files, /package.json/)
  }
})

test('manifest byte-size budget is enforced', () => {
  const files = fixture()
  files[0].data = JSON.stringify({ ...DEFAULT_MANIFEST, padding: 'x'.repeat(4 * 1024 * 1024) })
  expectBad(files, /package.json is too large/)
})

test('missing/invalid bundle patch and nonexistent patch files are rejected', () => {
  for (const patch of [undefined, '', [], [null], 1, {}, './missing.yml', '../escape.yml', '/absolute.yml', 'C:/absolute.yml', './lib']) {
    const manifest = clone(DEFAULT_MANIFEST)
    manifest.dsh.bundle.patch = patch
    expectBad(fixture({ manifest }), /patch|path|traversal/)
  }
  const manifest = clone(DEFAULT_MANIFEST)
  delete manifest.dsh
  expectBad(fixture({ manifest }), /patch/)
})

test('missing or unsafe main/module/exports targets are rejected', () => {
  for (const [key, value] of [
    ['main', './missing.js'], ['main', '../escape.js'], ['main', 12], ['module', './missing.mjs'],
    ['exports', './missing.js'], ['exports', './missing/*.js'], ['exports', '../escape.js'],
    ['exports', 'https://example.invalid/index.js'], ['exports', { '.': './lib/index.js', './bad': './missing.js' }], ['exports', 1],
  ]) {
    const manifest = clone(DEFAULT_MANIFEST)
    manifest[key] = value
    expectBad(fixture({ manifest }), /entry|path|traversal|relative|exports/)
  }
})

test('excessive exports recursion is bounded', () => {
  const manifest = clone(DEFAULT_MANIFEST)
  let value = './lib/index.js'
  for (let i = 0; i < 40; i++) value = { import: value }
  manifest.exports = value
  expectBad(fixture({ manifest }), /nesting/)
})

test('PAX byte and record-count budgets are enforced', () => {
  expectBad([{ name: 'PaxHeaders/meta', type: 'x', data: paxRecord('comment', 'x'.repeat(1024 * 1024)) }, ...fixture()], /PAX metadata byte limit/)
  const records = []
  for (let i = 0; i < 1025; i++) records.push(paxRecord('key' + i, 'value'))
  expectBad([{ name: 'PaxHeaders/meta', type: 'x', data: Buffer.concat(records) }, ...fixture()], /PAX record count limit/)
  const first = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => ['first' + i, 'value']))
  expectBad([pax(first, 'g'), pax({ extra: 'value' }, 'g'), ...fixture()], /global PAX metadata count/)
})

test('wildcard export targets use bounded literal scanning, not regex backtracking', () => {
  const manifest = clone(DEFAULT_MANIFEST)
  manifest.exports = './lib/' + '*'.repeat(512) + 'index.js'
  assert.equal(inspectPluginArchive(archive(fixture({ manifest }))).name, manifest.name)
  manifest.exports += 'missing'
  expectBad(fixture({ manifest }), /entry file does not exist/)
})

test('tar entry count is capped including metadata-only entries', () => {
  const entries = fixture()
  for (let i = 0; i < 10_000; i++) entries.push({ name: 'metadata', type: 'g', data: '' })
  expectBad(entries, /entry count limit/)
})

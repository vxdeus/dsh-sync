/**
 * dsh-sync 纯逻辑单测 —— 用 node 直接跑，不需要 DSH 运行时。
 *   node test/run-tests.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  encodeHome, createCodec, buildManifest, buildExtraManifest, extraStats, manifestStats,
  isDenied, isValidExtraName, splitExtraRel, DEFAULT_EXTRA_EXCLUDE,
  PH_RAW, PH_ESC, PH_ENC,
} from '../lib/pathcodec.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

console.log('dsh-sync pure logic tests')

// ── 1. 会话目录名编码规则
ok('encode C:\\...\\Documents\\x', () => {
  assert.equal(
    encodeHome(String.raw`C:\Users\synthetic-source\Documents\synthetic-project\workspace`),
    'C-Users-synthetic-source-Documents-synthetic-project-workspace',
  )
})
ok('encode 中文路径 -> ~XXXX', () => {
  assert.equal(encodeHome(String.raw`D:\synthetic\示例`), 'D-synthetic-~793A~4F8B')
})

// ── 2. 占位符双向改写
const machineA = createCodec(String.raw`C:\Users\synthetic-source`)
const machineB = createCodec(String.raw`C:\Users\synthetic-target`)

ok('目录名：上传变成占位符', () => {
  assert.equal(machineA.toPortable('--C-Users-synthetic-source-Documents-x--'), `--${PH_ENC}-Documents-x--`)
})
ok('目录名：在另一台机器还原（用户名不同也能对上）', () => {
  const portable = machineA.toPortable('--C-Users-synthetic-source-Documents-x--')
  assert.equal(machineB.fromPortable(portable), '--C-Users-synthetic-target-Documents-x--')
})
ok('同机往返不变', () => {
  const s = '--C-Users-synthetic-source-Documents-x--'
  assert.equal(machineA.fromPortable(machineA.toPortable(s)), s)
})
ok('JSON 里的转义反斜杠也改写（workspace.json 场景）', () => {
  const rawJson = String.raw`{"path":"C:\\Users\\synthetic-source\\Documents\\x"}`
  const portable = machineA.toPortable(rawJson)
  assert.ok(portable.includes(PH_ESC), 'should use the escaped placeholder')
  assert.equal(machineB.fromPortable(portable), String.raw`{"path":"C:\\Users\\synthetic-target\\Documents\\x"}`)
})
ok('非转义的裸路径也改写', () => {
  const raw = String.raw`cwd = C:\Users\synthetic-source\proj`
  assert.equal(machineB.fromPortable(machineA.toPortable(raw)), String.raw`cwd = C:\Users\synthetic-target\proj`)
})
ok('占位符之间不会互相误匹配', () => {
  assert.ok(!PH_RAW.includes(PH_ENC) && !PH_ENC.includes(PH_RAW) && !PH_ESC.includes(PH_RAW))
})

// ── 3. DSH 状态清单：该带的带、不该带的一个都不带
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-test-'))
function touch(base, rel, content = 'x') {
  const abs = path.join(base, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

touch(fakeHome, 'profiles/desktop/package.json', '{"name":"p"}')
touch(fakeHome, 'profiles/desktop/cordis.patch.yml', '- id: x')
touch(fakeHome, 'profiles/desktop/node_modules/some-plugin/index.js', 'SHOULD NOT SYNC')
touch(fakeHome, 'profiles/desktop/.plugin-manager/logs/a.log', 'SHOULD NOT SYNC')
touch(fakeHome, 'sessions/--C-Users-synthetic-source-Documents-x--/session-1/session.v4.jsonl.zstd', 'BIN')
touch(fakeHome, 'storages/workspace.json', String.raw`{"path":"C:\\Users\\synthetic-source\\Documents\\x"}`)
touch(fakeHome, 'attachments/pic.png', 'IMG')
touch(fakeHome, 'dsh-pet/main-config.jsonc', '{"pets":[]}')
touch(fakeHome, '.credentials.yaml', 'SECRET SHOULD NOT SYNC')
touch(fakeHome, 'dsh-sync.json', '{"token":"SECRET"}')
touch(fakeHome, 'integrations/x.json', 'SECRET')
touch(fakeHome, 'cache/blob', 'SECRET')
touch(fakeHome, 'electron/electron.exe', 'BIN')

const cfg = { profiles: ['desktop'], includeAttachments: true, extras: [] }
const rels = buildManifest(fakeHome, cfg).map((m) => m.rel.split(path.sep).join('/')).sort()

ok('清单包含该同步的文件', () => {
  for (const want of [
    'profiles/desktop/package.json',
    'profiles/desktop/cordis.patch.yml',
    'sessions/--C-Users-synthetic-source-Documents-x--/session-1/session.v4.jsonl.zstd',
    'storages/workspace.json',
    'attachments/pic.png',
    'dsh-pet/main-config.jsonc',
  ]) assert.ok(rels.includes(want), `missing ${want}`)
})
ok('清单排除了 node_modules', () => {
  assert.ok(!rels.some((r) => r.includes('node_modules')), 'node_modules leaked!')
})
ok('清单排除了凭据与缓存', () => {
  for (const bad of ['.credentials.yaml', 'dsh-sync.json', 'integrations', 'cache/', 'electron', '.plugin-manager']) {
    assert.ok(!rels.some((r) => r.includes(bad)), `${bad} leaked!`)
  }
})
ok('includeAttachments=false 时不带附件', () => {
  const noAttach = buildManifest(fakeHome, { ...cfg, includeAttachments: false })
  assert.ok(!noAttach.some((m) => m.rel.includes('attachments')))
})

// ── 4. 自定义同步项（本地工程 / 任意文件）
const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-proj-'))
touch(projRoot, 'src/main.js', 'console.log(1)')
touch(projRoot, 'README.md', '# hi')
touch(projRoot, 'node_modules/dep/index.js', 'SHOULD NOT SYNC')
touch(projRoot, '.git/config', 'SHOULD NOT SYNC')
touch(projRoot, 'dist/bundle.js', 'SHOULD NOT SYNC')
touch(projRoot, 'data/notes.txt', 'keep me')

const extra = { name: 'myproj', path: projRoot }
const extraRels = buildExtraManifest(extra).map((m) => m.rel.split(path.sep).join('/')).sort()

ok('自定义项进入了 extras/<name>/ 前缀', () => {
  assert.ok(extraRels.every((r) => r.startsWith('extras/myproj/')), extraRels.join(','))
})
ok('自定义项默认排除 node_modules/.git/dist', () => {
  for (const bad of ['node_modules', '.git', 'dist']) {
    assert.ok(!extraRels.some((r) => r.includes(`/${bad}/`)), `${bad} leaked!`)
  }
})
ok('自定义项保留了源码与数据文件', () => {
  for (const want of ['extras/myproj/src/main.js', 'extras/myproj/README.md', 'extras/myproj/data/notes.txt']) {
    assert.ok(extraRels.includes(want), `missing ${want}`)
  }
})
ok('exclude 传空数组时连默认排除也取消', () => {
  const all = buildExtraManifest({ ...extra, exclude: [] }).map((m) => m.rel.split(path.sep).join('/'))
  assert.ok(all.some((r) => r.includes('/node_modules/')), 'explicit empty exclude should keep everything')
})
ok('name 非法时拒绝（防路径穿越）', () => {
  assert.equal(isValidExtraName('ok-name_1.x'), true)
  assert.equal(isValidExtraName('../evil'), false)
  assert.equal(isValidExtraName('a/b'), false)
  assert.equal(buildExtraManifest({ name: '../evil', path: projRoot }).length, 0)
})
ok('单个文件也能作为自定义项', () => {
  const one = touch(fakeHome, 'single.txt', 'hello')
  const m = buildExtraManifest({ name: 'onefile', path: one })
  assert.deepEqual(m.map((x) => x.rel.split(path.sep).join('/')), ['extras/onefile/single.txt'])
})
ok('splitExtraRel 能拆出 name 与相对路径', () => {
  assert.deepEqual(splitExtraRel('extras/myproj/src/main.js'), { name: 'myproj', rest: 'src/main.js' })
  assert.equal(splitExtraRel('sessions/a/b'), null)
  assert.equal(splitExtraRel('extras/onlyname'), null)
})
ok('extraStats 汇总体积并标记缺失路径', () => {
  const rows = extraStats({ extras: [extra, { name: 'gone', path: path.join(projRoot, 'nope') }] })
  assert.equal(rows.length, 2)
  assert.ok(rows[0].files > 0 && rows[0].bytes > 0 && rows[0].missing === false)
  assert.equal(rows[1].missing, true)
})
ok('buildManifest 把自定义项一起带上', () => {
  const all = buildManifest(fakeHome, { ...cfg, extras: [extra] }).map((m) => m.rel.split(path.sep).join('/'))
  assert.ok(all.some((r) => r.startsWith('extras/myproj/')))
})

// ── 5. 护栏与统计
ok('isDenied 认得目录与文件', () => {
  assert.equal(isDenied('profiles/desktop/node_modules/x/y.js'), true)
  assert.equal(isDenied('.credentials.yaml'), true)
  assert.equal(isDenied('sessions/a/session.v4.jsonl.zstd'), false)
})
ok('manifestStats 能算出体积', () => {
  const stats = manifestStats(buildManifest(fakeHome, cfg))
  assert.ok(stats.files > 0 && stats.bytes > 0)
})
ok('默认排除表里不含用户源码目录', () => {
  assert.ok(!DEFAULT_EXTRA_EXCLUDE.includes('src') && !DEFAULT_EXTRA_EXCLUDE.includes('docs'))
})

fs.rmSync(fakeHome, { recursive: true, force: true })
fs.rmSync(projRoot, { recursive: true, force: true })
console.log(`\n全部通过：${passed} 项`)

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client-panel.js', import.meta.url), 'utf8')
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Expose closure helpers in this VM only; the shipped Classic module keeps its public surface unchanged.
function clientHarness(fetch, overrides = {}) {
  let declaration
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { declaration = value } } },
    fetch, AbortController, setTimeout, clearTimeout, URL, ...overrides,
  }
  const instrumented = source.replace("    return {\n      name: 'dsh-sync-ui',", "    window.__test = { normalizeSnapshot, makeStore, safeResult, sanitizeProgress, StageProgress, Result, shortcutLabel, canCancel };\n    return {\n      name: 'dsh-sync-ui',")
  assert.notEqual(instrumented, source)
  vm.runInNewContext(instrumented, sandbox, { filename: 'client-panel.js' })
  const plugin = declaration.factory(name => { if (name === 'react') return overrides.React || { createElement(type, props, ...children) { return { type, props, children } } }; throw new Error('optional dependency') })
  return { ...sandbox.window.__test, plugin }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const response = payload => ({ ok: true, status: 200, json: async () => payload })

function renderedText(node) {
  if (node == null) return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(renderedText).join(' ')
  if (typeof node.type === 'function') return renderedText(node.type({ ...node.props, children: node.children }))
  return (node.children || []).map(renderedText).join(' ')
}

test('client progress rejects unsafe phase and private fields and clamps stage completion', () => {
  const { normalizeSnapshot, sanitizeProgress, StageProgress } = clientHarness()
  const progress = { phase: 'upload', completedBytes: 500, totalBytes: 100, completedFiles: 5, totalFiles: 2,
    transferredBytes: 100, connections: 1, elapsedMs: 2000, speedBytesPerSecond: 50,
    path: 'PRIVATE-PATH', message: 'PRIVATE-MESSAGE', key: 'PRIVATE-KEY', arbitrary: 2 }
  const job = normalizeSnapshot({ config: {}, status: {}, job: { progress } }).job
  assert.equal(JSON.stringify(job.progress), JSON.stringify({ phase: 'upload', completedBytes: 100, totalBytes: 100,
    completedFiles: 2, totalFiles: 2, transferredBytes: 100, connections: 1, elapsedMs: 2000, speedBytesPerSecond: 50 }))
  assert.doesNotMatch(JSON.stringify(job), /PRIVATE|arbitrary/)
  for (const phase of ['/PRIVATE', 'constructor', '__proto__', 'toString', {}, ['upload']]) {
    const safe = sanitizeProgress({ phase, path: 'PRIVATE', totalBytes: Infinity, completedBytes: -1, connections: '2' })
    assert.equal(safe, null)
    assert.equal(StageProgress({ progress: { phase, completedBytes: 1 } }), null)
  }
})

test('UI shows confirmed stage progress and job-wide average speed without claiming publication', () => {
  const { StageProgress, shortcutLabel } = clientHarness()
  const progress = { phase: 'upload', completedBytes: 100, totalBytes: 100,
    completedFiles: 2, totalFiles: 2, transferredBytes: 500, speedBytesPerSecond: 50, elapsedMs: 2000, connections: 1 }
  const upload = renderedText(StageProgress({ progress }))
  assert.match(upload, /当前阶段：上传文件/)
  assert.match(upload, /本阶段已确认：100 B \/ 100 B（100%）/)
  assert.match(upload, /本阶段已确认文件：2 \/ 2/)
  assert.match(upload, /按已完成文件字节更新，当前单文件在途字节不计入/)
  assert.match(upload, /总传输速度：50 B\/s（已确认平均，含回读）/)
  assert.match(upload, /已用时：2.0 秒/)
  assert.match(upload, /SSH批次启动次数（非重试次数）：1/)
  assert.match(upload, /远端核验和发布尚未完成，本阶段完成不代表任务成功/)
  assert.doesNotMatch(upload.replace('不代表任务成功', ''), /实际速度|SSH 连接次数|任务成功|任务已完成/)
  assert.equal(shortcutLabel({ data: { job: { status: 'running', progress } } }), '同步 · 上传文件 · 已确认 100% · 待核验发布')
  for (const [phase, label] of [['scan', '扫描'], ['connect', '连接 SSH'], ['verify', '校验'], ['publish', '发布'], ['download', '下载'], ['restore', '准备暂存'], ['apply', '在线应用安全范围'], ['done', '等待任务结果']]) {
    const output = renderedText(StageProgress({ progress: { phase, completedBytes: 0, totalBytes: 100 } }))
    assert.match(output, new RegExp(label))
    assert.match(output, /（0%）/)
    assert.doesNotMatch(output.replace('不代表任务成功', ''), /任务成功|任务已完成|100%/)
  }
  assert.match(source, /jobRunning \? h\(StageProgress, \{ progress: job.progress, startedAt: job.startedAt \}\) : null/)
  assert.match(source, /h\(Spinner\), h\('div', null, h\('p', null, stage\)/)
})

test('unknown totals preserve processed counters without fabricating percentages or success', () => {
  const { StageProgress, normalizeSnapshot } = clientHarness()
  for (const phase of ['scan', 'connect', 'upload', 'verify', 'publish', 'download', 'restore', 'apply']) {
    for (const totals of [{ totalBytes: 0, totalFiles: 0 }, {}]) {
      const progress = { phase, completedBytes: 2048, completedFiles: 3, transferredBytes: 2048, speedBytesPerSecond: 1024, ...totals }
      const job = normalizeSnapshot({ config: {}, status: {}, job: { status: 'running', progress } }).job
      assert.equal(job.progress.completedBytes, 2048)
      assert.equal(job.progress.completedFiles, 3)
      const output = renderedText(StageProgress({ progress: job.progress }))
      assert.match(output, phase === 'upload' ? /已确认：2.0 KB（总量统计中）/ : /已处理：2.0 KB（总量统计中）/)
      assert.match(output, phase === 'upload' ? /已确认文件：3（总数统计中）/ : /已处理文件：3（总数统计中）/)
      assert.match(output, /总传输速度：1.0 KB\/s（已确认平均，含回读）/)
      assert.doesNotMatch(output.replace('不代表任务成功', ''), /\d+%|NaN|Infinity|实际速度|任务成功|任务已完成|本阶段：/)
      if (phase === 'upload') assert.doesNotMatch(output, /等待首个文件完成/)
    }
  }
})

test('partial download percentage reflects received bytes and still warns verification is pending', () => {
  const { StageProgress } = clientHarness()
  for (const completedBytes of [25, 100]) {
    const output = renderedText(StageProgress({ progress: { phase: 'download', completedBytes, totalBytes: 100,
      completedFiles: 0, totalFiles: 2, transferredBytes: completedBytes, speedBytesPerSecond: 25 } }))
    assert.match(output, new RegExp(`本阶段：${completedBytes} B / 100 B（${completedBytes}%）`))
    assert.match(output, /本阶段文件：0 \/ 2/)
    assert.match(output, /下载百分比按实际收到的字节显示；哈希校验和暂存准备尚需完成/)
    if (completedBytes === 100) assert.match(output, /本阶段完成不代表任务成功/)
    assert.doesNotMatch(output.replace('不代表任务成功', ''), /任务成功|任务已完成/)
  }
})

test('UI elapsed time starts at job creation rather than a late transfer callback', () => {
  const { StageProgress } = clientHarness()
  const output = renderedText(StageProgress({ progress: { phase: 'verify', elapsedMs: 0 }, startedAt: new Date(Date.now() - 60000).toISOString() }))
  assert.match(output, /已用时：60\.[0-9] 秒/)
})

test('status refresh retains safe current-stage progress without repeating POST', async () => {
  let phase = 'upload', completedBytes = 100, posts = 0
  const { makeStore } = clientHarness(async (_url, options) => {
    if (options.method === 'POST') { posts++; return response({ ok: true }) }
    return response({ config: { tokenPresent: true }, status: {}, job: { id: 'job', status: 'running', action: 'upload',
      progress: { phase, completedBytes, totalBytes: 100, path: 'PRIVATE' } } })
  })
  const store = makeStore(), unsubscribe = store.subscribe(() => {})
  try {
    await tick()
    assert.equal(store.get().data.job.progress.completedBytes, 100)
    assert.equal(store.get().data.job.status, 'running')
    assert.equal(await store.post({ action: 'upload', confirmed: true }), false)
    phase = 'verify'; completedBytes = 0
    await store.refresh()
    assert.equal(store.get().data.job.progress.phase, 'verify')
    assert.equal(store.get().data.job.progress.completedBytes, 0)
    assert.doesNotMatch(JSON.stringify(store.get().data.job.progress), /PRIVATE|path/)
    assert.equal(posts, 0)
  } finally { unsubscribe(); store.dispose() }
})

test('upload waits for current-stage file receipts without zero percentages or stale-phase speed', () => {
  const { StageProgress, normalizeSnapshot, shortcutLabel } = clientHarness()
  for (const counters of [
    {}, { totalBytes: 1024, totalFiles: 2 },
    { completedBytes: 0, totalBytes: 1024, completedFiles: 0, totalFiles: 2 },
    { completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 },
    { completedBytes: 0 }, { completedFiles: 0, totalFiles: 2 },
    { completedBytes: -1, completedFiles: NaN, totalBytes: 1024, totalFiles: 2 },
  ]) {
    for (const transferredBytes of [0, 8192]) {
      const progress = { phase: 'upload', ...counters, transferredBytes, speedBytesPerSecond: 4096, elapsedMs: 2000 }
      const job = normalizeSnapshot({ config: {}, status: {}, job: { status: 'running', action: 'upload', progress } }).job
      const output = renderedText(StageProgress({ progress: job.progress }))
      assert.match(output, /上传中，等待首个文件完成/)
      assert.match(output, /总传输速度：等待首个文件完成后确认/)
      assert.match(output, /已用时：2.0 秒/)
      assert.doesNotMatch(output, /%|实际速度|\/s|NaN|Infinity|null/)
      if (counters.totalBytes > 0) assert.match(output, /本阶段总量：1.0 KB/)
      if (counters.completedFiles === 0 && counters.totalFiles > 0) assert.match(output, /本阶段已确认文件：0 \/ 2/)
      assert.equal(shortcutLabel({ data: { job } }), '同步 · 上传中，等待首个文件完成')
      assert.equal(shortcutLabel({ data: { job: { ...job, cancelRequested: true } } }), '同步 · 取消中')
      assert.equal(shortcutLabel({ data: { job }, posting: true, activeAction: 'cancel' }), '同步 · 取消中')
    }
  }
})

test('upload confirmed percentages use current completed bytes or files, not job-wide transfer bytes', () => {
  const { StageProgress, shortcutLabel } = clientHarness()
  for (const transferredBytes of [0, 1024, 8192]) {
    const progress = { phase: 'upload', completedBytes: 25, totalBytes: 100, completedFiles: 1, totalFiles: 2,
      transferredBytes, speedBytesPerSecond: 50 }
    const output = renderedText(StageProgress({ progress }))
    assert.match(output, /本阶段已确认：25 B \/ 100 B（25%）/)
    assert.match(output, /本阶段已确认文件：1 \/ 2/)
    assert.match(output, /按已完成文件字节更新，当前单文件在途字节不计入/)
    assert.doesNotMatch(output, /等待首个文件完成|50%|100%|实际速度/)
    if (transferredBytes > 0) assert.match(output, /总传输速度：50 B\/s（已确认平均，含回读）/)
    else assert.doesNotMatch(output, /\/s/)
    assert.equal(shortcutLabel({ data: { job: { status: 'running', progress } } }), '同步 · 上传文件 · 已确认 25%')
  }
  for (const counters of [
    { completedBytes: 25, totalBytes: 100 },
    { completedFiles: 1, totalFiles: 4 },
    { completedBytes: 0, totalBytes: 0, completedFiles: 1, totalFiles: 4 },
  ]) {
    const progress = { phase: 'upload', ...counters }
    const output = renderedText(StageProgress({ progress }))
    assert.match(output, /已确认.*（25%）/)
    assert.doesNotMatch(output, /等待首个文件完成|实际速度|\/s|null%/)
    assert.equal(shortcutLabel({ data: { job: { status: 'running', progress } } }), '同步 · 上传文件 · 已确认 25%')
  }
})

test('download still shows received zero bytes and legacy has no fabricated progress', () => {
  const { StageProgress, normalizeSnapshot, shortcutLabel } = clientHarness()
  const output = renderedText(StageProgress({ progress: { phase: 'download', completedBytes: 0, totalBytes: 1000000,
    transferredBytes: 0, speedBytesPerSecond: 999999 } }))
  assert.match(output, /本阶段：0 B \/ 976.6 KB（0%）/)
  assert.match(output, /正在传输 \/ 等待完成回执/)
  assert.match(output, /总传输速度：等待字节反馈/)
  assert.doesNotMatch(output, /\/s|100%|等待首个文件完成|实际速度/)
  const job = normalizeSnapshot({ config: { tokenPresent: true }, status: {}, job: { status: 'running', action: 'upload' } }).job
  assert.equal(job.progress, null)
  assert.equal(StageProgress({ progress: job.progress }), null)
  assert.equal(shortcutLabel({ data: { job } }), '同步 · 等待阶段回执 · 等待回执')
})

test('classic client registers lazily and package exposes matching client export', () => {
  let declaration, styles = 0, requests = 0
  const registrations = [], disposers = []
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { declaration = value } } },
    document: {
      createElement(tag) {
        assert.equal(tag, 'style')
        return { setAttribute() {}, textContent: '', remove() { styles-- } }
      },
      head: { appendChild() { styles++ } },
    },
    fetch() { requests++; throw new Error('must stay inert until mounted') },
    AbortController, setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client-panel.js' })
  assert.equal(declaration.id, pkg.name)
  assert.equal(styles, 0)
  assert.equal(pkg.exports['./client'], './lib/client-panel.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  const plugin = declaration.factory(name => {
    if (name === 'react') return { createElement() {} }
    if (name === 'react-dom') return { createPortal() {} }
    throw new Error('unexpected dependency: ' + name)
  })
  assert.deepEqual(Array.from(plugin.inject), ['slots'])
  assert.equal(styles, 0)
  plugin.apply({
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    slots: {
      inject(name, fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
      register(options, component) {
        assert.equal(typeof component, 'function')
        registrations.push(options)
        return () => registrations.splice(registrations.indexOf(options), 1)
      },
    },
  })
  assert.deepEqual(registrations.map(x => x.name), ['settings.section', 'sidebar.footer.action'])
  assert.equal(registrations[0].label, '跨机同步')
  assert.equal(styles, 1)
  assert.equal(requests, 0)
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(styles, 0)
  assert.equal(registrations.length, 0)
})

test('snapshot readiness supports legacy Gitee and respects explicit readiness for both backends', () => {
  const { normalizeSnapshot } = clientHarness()
  for (const [config, expected] of [
    [{ tokenPresent: true }, true], [{ tokenPresent: false }, false], [{}, false],
    [{ tokenPresent: true, ready: false }, false],
    [{ backend: 'sftp', tokenPresent: false, ready: true }, true],
    [{ backend: 'sftp', tokenPresent: true, ready: false }, false],
  ]) {
    const normalized = normalizeSnapshot({ config, status: {} }).config
    assert.equal(normalized.ready, expected)
    assert.equal(normalized.backend, config.backend === 'sftp' ? 'sftp' : 'gitee')
  }
})

test('snapshot SFTP DTO is allowlisted and result rendering drops private key paths', () => {
  const { normalizeSnapshot, safeResult } = clientHarness()
  const normalized = normalizeSnapshot({ config: { backend: 'sftp', ready: true, sftp: {
    host: 'backup.example.invalid', port: 2222, username: 'sync', remoteRoot: '/snapshots', configured: true,
    privateKeyPath: 'DO-NOT-RENDER-KEY-PATH', password: 'DO-NOT-RENDER-PASSWORD',
  } }, status: {}, job: { result: { summary: { privateKeyPath: 'DO-NOT-RENDER-KEY-PATH', message: 'ok' } } } })
  assert.equal(normalized.config.sftp.host, 'backup.example.invalid')
  assert.equal(normalized.config.sftp.port, 2222)
  assert.equal(normalized.config.sftp.username, 'sync')
  assert.equal(normalized.config.sftp.remoteRoot, '/snapshots')
  assert.equal(normalized.config.sftp.configured, true)
  assert.doesNotMatch(JSON.stringify(normalized), /DO-NOT-RENDER|privateKeyPath|password/)
  assert.equal(JSON.stringify(safeResult({ private_key: 'hidden', nested: { privateKeyPath: 'hidden', ok: true } })), '{"nested":{"ok":true}}')
})

test('SFTP ready without Gitee token can transfer; legacy and explicit unready states remain gated', async () => {
  for (const [config, allowed] of [
    [{ backend: 'sftp', ready: true, tokenPresent: false }, true],
    [{ tokenPresent: true }, true],
    [{ tokenPresent: false }, false],
    [{ backend: 'gitee', ready: false, tokenPresent: true }, false],
    [{ backend: 'sftp', ready: false, tokenPresent: true }, false],
  ]) {
    for (const action of ['upload', 'download']) {
      const posts = []
      const { makeStore } = clientHarness(async (_url, options) => {
        if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
        return response({ config, status: {}, onlineAvailable: true })
      })
      const store = makeStore(), unsubscribe = store.subscribe(() => {})
      try {
        await tick()
        assert.equal(await store.post({ action, confirmed: true }), allowed)
        assert.equal(posts.length, allowed ? 1 : 0)
      } finally { unsubscribe(); store.dispose() }
    }
  }
})

test('backend selection only posts on explicit save and locks while pending', async () => {
  let release
  const posts = []
  const { makeStore } = clientHarness(async (_url, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body))
      return new Promise(resolve => { release = resolve })
    }
    return response({ config: { backend: 'gitee', ready: false }, status: {} })
  })
  const store = makeStore(), unsubscribe = store.subscribe(() => {})
  try {
    await tick(); assert.equal(posts.length, 0)
    const pending = store.post({ action: 'backend-save', backend: 'sftp' })
    assert.equal(store.get().posting, true)
    assert.equal(await store.post({ action: 'upload', dryRun: true }), false)
    assert.equal(await store.post({ action: 'backend-save', backend: 'gitee' }), false)
    assert.equal(posts.length, 1)
    release(response({ ok: true }))
    assert.equal(await pending, true)
    assert.match(store.get().notice, /未自动上传或下载/)
    assert.equal(JSON.stringify(posts), '[{"action":"backend-save","backend":"sftp"}]')
  } finally { unsubscribe(); store.dispose() }
})

test('backend-save failure preserves selection and unknown outcome locks without retrying', async () => {
  for (const apiRejected of [true, false]) {
    let posts = 0
    const { makeStore } = clientHarness(async (_url, options) => {
      if (options.method === 'POST') {
        posts++
        if (!apiRejected) throw new Error('connection lost')
        return { ok: false, status: 400, json: async () => ({ ok: false, error: '需要一次授权安装包' }) }
      }
      return response({ config: { backend: 'gitee', ready: true }, status: {} })
    })
    const store = makeStore(), unsubscribe = store.subscribe(() => {})
    try {
      await tick()
      assert.equal(await store.post({ action: 'backend-save', backend: 'sftp' }), false)
      assert.equal(store.get().data.config.backend, 'gitee')
      assert.equal(store.get().uncertain, !apiRejected)
      assert.equal(await store.post({ action: 'backend-save', backend: 'sftp' }), false)
      assert.equal(posts, 1)
      await store.refresh()
      assert.equal(store.get().uncertain, false)
      assert.equal(posts, 1)
    } finally { unsubscribe(); store.dispose() }
  }
})

test('cancel DTO defaults false and shortcut reports only actual current stage', () => {
  const { normalizeSnapshot, shortcutLabel } = clientHarness()
  const state = job => ({ data: normalizeSnapshot({ config: {}, status: {}, job }) })
  assert.equal(state({}).data.job.cancellable, false)
  assert.equal(state({ cancelRequested: 'true' }).data.job.cancelRequested, false)
  const job = { id: 'j', status: 'running', cancellable: true, progress: { phase: 'upload', completedBytes: 25, totalBytes: 100 } }
  assert.equal(shortcutLabel(state(job)), '同步 · 上传文件 · 已确认 25%')
  assert.equal(shortcutLabel(state({ ...job, progress: { phase: 'verify', completedBytes: 0, totalBytes: 100 } })), '同步 · 校验远端内容 0%')
  assert.equal(shortcutLabel(state({ ...job, progress: { phase: 'scan', completedFiles: 2, totalFiles: 4 } })), '同步 · 扫描同步内容 50%')
  assert.match(renderedText(clientHarness().StageProgress({ progress: { phase: 'scan', completedFiles: 2, totalFiles: 4 } })), /本阶段文件：2 \/ 4（50%）/)
  for (const progress of [null, { phase: 'publish' }]) {
    assert.doesNotMatch(shortcutLabel(state({ ...job, progress })), /%/)
    assert.match(shortcutLabel(state({ ...job, progress })), /等待.*回执/)
  }
  for (const totals of [{ totalBytes: 0, totalFiles: 0 }, {}]) {
    assert.equal(shortcutLabel(state({ ...job, progress: { phase: 'upload', completedBytes: 25, ...totals } })), '同步 · 上传文件 · 已确认，总量统计中')
  }
  assert.equal(shortcutLabel(state({ ...job, cancelRequested: true })), '同步 · 取消中')
  for (const status of ['cancelled', 'succeeded', 'failed', 'unconfirmed', 'partial']) assert.equal(shortcutLabel(state({ ...job, status, cancelRequested: true })), '同步')
})

test('cancel bypasses running/busy only for matching cancellable job and waits for terminal receipt', async () => {
  let job = { id: 'current', action: 'upload', status: 'running', cancellable: true }, release
  const posts = []
  const { makeStore } = clientHarness(async (_url, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return new Promise(resolve => { release = resolve }) }
    return response({ config: { ready: false }, status: {}, busy: job.status === 'running', job })
  })
  const store = makeStore(), unsubscribe = store.subscribe(() => {})
  try {
    await tick()
    assert.equal(await store.post({ action: 'cancel', jobId: 'other' }), false)
    assert.equal(await store.post({ action: 'upload' }), false)
    const pending = store.post({ action: 'cancel', jobId: 'current' })
    assert.equal(await store.post({ action: 'cancel', jobId: 'current' }), false)
    job = { ...job, cancelRequested: true }
    release(response({ ok: true, job }))
    assert.equal(await pending, true)
    await tick()
    assert.equal(store.get().data.job.status, 'running')
    assert.equal(store.get().data.job.cancelRequested, true)
    assert.match(store.get().notice, /安全收尾.*不会撤销已发布/)
    assert.equal(await store.post({ action: 'cancel', jobId: 'current' }), false)
    for (const status of ['cancelled', 'succeeded', 'failed', 'unconfirmed', 'partial']) {
      job = { ...job, status }
      await store.refresh()
      assert.equal(store.get().data.job.status, status)
      assert.equal(await store.post({ action: 'cancel', jobId: 'current' }), false)
    }
    assert.deepEqual(posts, [{ action: 'cancel', jobId: 'current' }])
  } finally { unsubscribe(); store.dispose() }
})

test('cancel guard blocks legacy, loading, uncertain and error without automatic retry', async () => {
  const { canCancel } = clientHarness()
  const state = { data: { busy: true, job: { id: 'j', status: 'running', cancellable: true } } }
  assert.equal(canCancel(state, 'j'), true)
  for (const key of ['posting', 'loading', 'uncertain', 'error']) assert.equal(canCancel({ ...state, [key]: true }, 'j'), false)
  for (const patch of [{ cancellable: false }, { cancelRequested: true }, { status: 'succeeded' }]) assert.equal(canCancel({ data: { job: { ...state.data.job, ...patch } } }, 'j'), false)
  for (const rejected of [true, false]) {
    let posts = 0
    const { makeStore } = clientHarness(async (_url, options) => {
      if (options.method === 'POST') {
        posts++
        if (!rejected) throw new Error('lost cancel receipt')
        return { ok: false, status: 409, json: async () => ({ ok: false, error: 'cannot cancel' }) }
      }
      return response({ config: {}, status: {}, job: state.data.job })
    })
    const store = makeStore(), unsubscribe = store.subscribe(() => {})
    try {
      await tick()
      assert.equal(await store.post({ action: 'cancel', jobId: 'j' }), false)
      assert.equal(store.get().uncertain, !rejected)
      assert.equal(await store.post({ action: 'cancel', jobId: 'j' }), false)
      assert.equal(posts, 1)
      await store.refresh()
      assert.equal(posts, 1)
    } finally { unsubscribe(); store.dispose() }
  }
})

test('cancelled download is not green completion and has no offline restore instruction', () => {
  const { Result } = clientHarness()
  const node = Result({ job: { action: 'download', status: 'cancelled', result: { offlineCommand: 'RESTORE-ME', stagedFiles: ['PRIVATE'] } } })
  const output = renderedText(node)
  assert.match(output, /已取消.*安全收尾/)
  assert.doesNotMatch(output, /任务已完成|退出 DSH 后运行|离线恢复命令|RESTORE-ME|PRIVATE/)
  assert.doesNotMatch(JSON.stringify(node), /dsh-sync-success/)
})

test('closed shortcut keeps shared polling alive, renders stage and retains accessible dialog trigger', async () => {
  const timers = new Map(), registrations = {}, disposers = []
  let timerId = 0, gets = 0, job = { id: 'j', action: 'upload', status: 'running', cancellable: true,
    progress: { phase: 'upload', completedBytes: 0, totalBytes: 100, completedFiles: 0, totalFiles: 2, transferredBytes: 1024, speedBytesPerSecond: 512 } }
  let current
  const React = {
    Fragment: 'fragment', createElement(type, props, ...children) { return { type, props, children } },
    useState(init) { const owner = current, i = owner.cursor++; if (!(i in owner.values)) owner.values[i] = typeof init === 'function' ? init() : init; return [owner.values[i], value => { owner.values[i] = typeof value === 'function' ? value(owner.values[i]) : value }] },
    useRef(value) { const [ref] = React.useState(() => ({ current: value })); return ref },
    useCallback(fn) { current.cursor++; return fn },
    useEffect(fn, deps) {
      const owner = current, i = owner.cursor++, prev = owner.effects[i]
      if (!prev || deps.some((dep, index) => dep !== prev.deps[index])) {
        if (prev && prev.cleanup) prev.cleanup()
        owner.effects[i] = { deps, cleanup: fn() }
      }
    },
  }
  const { plugin } = clientHarness(async () => { gets++; return response({ config: { ready: true }, status: {}, job }) }, {
    React, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
    document: { createElement() { return { setAttribute() {}, remove() {} } }, head: { appendChild() {} } },
  })
  plugin.apply({ effect(fn) { disposers.push(fn()) }, slots: { inject(_name, fn) { disposers.push(fn()) }, register(options, component) { registrations[options.name] = component; return () => {} } } })
  function mount(component, props) {
    const owner = { cursor: 0, values: [], effects: [] }
    return { render() { current = owner; owner.cursor = 0; return component(props) }, unmount() { owner.effects.forEach(effect => effect.cleanup && effect.cleanup()) } }
  }
  function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...(node.children || []).flatMap(child => Array.isArray(child) ? child.flatMap(nodes) : nodes(child))] }
  const shortcut = mount(registrations['sidebar.footer.action'], { wide: false })
  const panel = mount(registrations['settings.section'], {})
  try {
    shortcut.render(); await tick()
    let tree = shortcut.render(), button = tree.children[0]
    assert.match(renderedText(tree), /上传中，等待首个文件完成/)
    assert.doesNotMatch(renderedText(tree), /%/)
    assert.equal(button.props['aria-haspopup'], 'dialog')
    assert.equal(button.props['aria-expanded'], false)
    assert.match(button.props['aria-label'], /上传中，等待首个文件完成/)
    assert.doesNotMatch(button.props.title, /%/)
    assert.equal(tree.children[1], null)
    panel.render(); await tick()
    assert.equal(gets, 1)
    const panelText = renderedText(panel.render())
    assert.match(panelText, /上传中，等待首个文件完成/)
    assert.doesNotMatch(panelText, /%|实际速度|\/s/)
    const cancel = nodes(panel.render()).find(node => node.type === 'button' && renderedText(node) === '取消传输')
    assert.equal(cancel.props.disabled, false)
    assert.equal(nodes(panel.render()).find(node => node.type === 'button' && renderedText(node) === '上传').props.disabled, true)
    panel.unmount()
    assert.equal([...timers.values()].filter(timer => timer.ms === 1500).length, 1)
    job = { ...job, progress: { ...job.progress, completedBytes: 25, completedFiles: 1, transferredBytes: 1049 } }
    const [first, firstPoll] = [...timers].find(([, timer]) => timer.ms === 1500)
    timers.delete(first); firstPoll.fn(); await tick()
    assert.equal(gets, 2)
    tree = shortcut.render(); button = tree.children[0]
    assert.match(renderedText(tree), /上传文件 · 已确认 25%/)
    assert.match(button.props['aria-label'], /上传文件 · 已确认 25%/)
    job = { ...job, progress: { phase: 'verify', completedBytes: 0, totalBytes: 100 } }
    const [id, poll] = [...timers].find(([, timer]) => timer.ms === 1500)
    timers.delete(id); poll.fn(); await tick()
    assert.equal(gets, 3)
    assert.match(renderedText(shortcut.render()), /校验远端内容 0%/)
    job = { ...job, cancelRequested: true }
    const [next, nextPoll] = [...timers].find(([, timer]) => timer.ms === 1500)
    timers.delete(next); nextPoll.fn(); await tick()
    assert.match(renderedText(shortcut.render()), /取消中/)
    job = { ...job, status: 'cancelled' }
    const [last, lastPoll] = [...timers].find(([, timer]) => timer.ms === 1500)
    timers.delete(last); lastPoll.fn(); await tick()
    assert.equal(renderedText(shortcut.render()).trim(), '同步')
    assert.equal([...timers.values()].filter(timer => timer.ms === 1500).length, 0)
    button = shortcut.render().children[0]; button.props.onClick()
    assert.equal(shortcut.render().children[0].props['aria-expanded'], true)
    assert.equal(typeof shortcut.render().children[1].type, 'function')
  } finally { shortcut.unmount(); for (const dispose of disposers.reverse()) dispose() }
})

test('download snapshot preserves mode and safe result details, with conservative legacy defaults', () => {
  const { normalizeSnapshot } = clientHarness()
  for (const onlineAvailable of [undefined, false, 'true', 1, true]) {
    const snapshot = normalizeSnapshot({ config: {}, status: {}, onlineAvailable, job: {
      action: 'download', mode: 'online', status: 'partial', result: {
        summary: 'only safe scope applied', offlineCommand: 'synthetic offline command', stagedFiles: ['synthetic-file'],
        copied: 3, deferred: 2, partial: true, privateKeyPath: 'DO-NOT-RENDER', token: 'DO-NOT-RENDER',
      },
    } })
    assert.equal(snapshot.onlineAvailable, onlineAvailable === true)
    assert.equal(snapshot.job.mode, 'online')
    assert.equal(snapshot.job.result.copied, 3)
    assert.equal(snapshot.job.result.deferred, 2)
    assert.equal(snapshot.job.result.partial, true)
    assert.equal(snapshot.job.result.summary, 'only safe scope applied')
    assert.equal(snapshot.job.result.offlineCommand, 'synthetic offline command')
    assert.equal(JSON.stringify(snapshot.job.result.stagedFiles), '["synthetic-file"]')
    assert.doesNotMatch(JSON.stringify(snapshot), /DO-NOT-RENDER|privateKeyPath|"token"/)
  }
  const legacy = normalizeSnapshot({ config: {}, status: {}, job: { action: 'download', status: 'succeeded' } })
  assert.equal(legacy.onlineAvailable, false)
  assert.equal(legacy.job.mode, 'offline')
})

test('online results warn for partial or deferred scope while offline and legacy retain exit instructions', () => {
  const { Result, normalizeSnapshot } = clientHarness()
  for (const partial of [{ partial: true, deferred: 0 }, { deferred: 4 }, { partial: false, deferred: 2 }]) {
    const job = normalizeSnapshot({ config: {}, status: {}, job: { action: 'download', mode: 'online', status: 'succeeded',
      result: { copied: 3, ...partial, offlineCommand: 'OFFLINE-ONLY-COMMAND' } } }).job
    const tree = Result({ job })
    const output = renderedText(tree)
    assert.match(output, /部分完成，不代表全量恢复/)
    assert.match(output, /无需关闭或重启 DSH/)
    assert.match(output, /手动刷新页面更新会话列表/)
    assert.match(output, /已应用 3 项/)
    assert.doesNotMatch(output, /任务已完成|请先完全退出|退出 DSH 后运行|OFFLINE-ONLY-COMMAND/)
    assert.doesNotMatch(JSON.stringify(tree), /dsh-sync-success/)
    assert.match(JSON.stringify(tree), /dsh-sync-warning/)
  }
  const partialStatus = Result({ job: { action: 'download', mode: 'online', status: 'partial', result: {} } })
  assert.match(renderedText(partialStatus), /部分完成/)
  assert.doesNotMatch(JSON.stringify(partialStatus), /dsh-sync-success/)
  for (const mode of [undefined, 'offline']) {
    const job = normalizeSnapshot({ config: {}, status: {}, job: { action: 'download', mode, status: 'succeeded',
      result: { offlineCommand: 'OFFLINE-ONLY-COMMAND', stagedFiles: ['SYNTHETIC-STAGED'] } } }).job
    const output = renderedText(Result({ job }))
    assert.match(output, /请先完全退出 DSH/)
    assert.match(output, /退出 DSH 后运行.*OFFLINE-ONLY-COMMAND/)
    assert.match(output, /SYNTHETIC-STAGED/)
    assert.doesNotMatch(output, /无需关闭或重启/)
  }
  const complete = renderedText(Result({ job: { action: 'download', mode: 'online', status: 'succeeded', result: { copied: 3, deferred: 0 } } }))
  assert.match(complete, /下载并在线应用完成/)
  assert.doesNotMatch(complete, /部分完成|请先完全退出/)
})

test('store defaults to online, forwards explicit offline, and blocks unsupported or invalid modes without POST', async () => {
  for (const [onlineAvailable, requested, expected] of [
    [true, undefined, 'online'], [true, 'online', 'online'], [true, 'offline', 'offline'],
    [undefined, undefined, null], [undefined, 'online', null], [false, 'online', null], ['true', 'online', null],
    [undefined, 'offline', 'offline'], [false, 'offline', 'offline'],
    [true, 'invalid', null], [true, '', null], [true, null, null], [true, false, null],
  ]) {
    const posts = []
    const { makeStore } = clientHarness(async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
      return response({ onlineAvailable, config: { ready: true }, status: {} })
    })
    const store = makeStore(), unsubscribe = store.subscribe(() => {})
    try {
      await tick()
      const body = { action: 'download', confirmed: true, ...(requested === undefined ? {} : { mode: requested }) }
      assert.equal(await store.post(body), expected !== null)
      assert.equal(posts.length, expected === null ? 0 : 1)
      if (expected) assert.deepEqual(posts, [{ action: 'download', confirmed: true, mode: expected }])
      else assert.match(store.get().error, /安全在线恢复接口|online.*offline/)
      await store.refresh()
      assert.equal(posts.length, expected === null ? 0 : 1, 'refresh must not repeat a transfer')
    } finally { unsubscribe(); store.dispose() }
  }
})

function treeNodes(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(treeNodes)
  return [node, ...(node.children || []).flatMap(treeNodes)]
}
function mountPanel(fetch) {
  const registrations = {}, disposers = []
  let current
  const React = {
    Fragment: 'fragment', createElement(type, props, ...children) { return { type, props, children } },
    useState(init) { const owner = current, i = owner.cursor++; if (!(i in owner.values)) owner.values[i] = typeof init === 'function' ? init() : init; return [owner.values[i], value => { owner.values[i] = typeof value === 'function' ? value(owner.values[i]) : value }] },
    useRef(value) { const [ref] = React.useState(() => ({ current: value })); return ref },
    useCallback(fn) { current.cursor++; return fn },
    useEffect(fn, deps) {
      const owner = current, i = owner.cursor++, prev = owner.effects[i]
      if (!prev || deps.some((dep, index) => dep !== prev.deps[index])) {
        if (prev && prev.cleanup) prev.cleanup()
        owner.effects[i] = { deps, cleanup: fn() }
      }
    },
  }
  const { plugin } = clientHarness(fetch, { React,
    document: { createElement() { return { setAttribute() {}, remove() {} } }, head: { appendChild() {} } },
  })
  plugin.apply({ effect(fn) { disposers.push(fn()) }, slots: { inject(_name, fn) { disposers.push(fn()) }, register(options, component) { registrations[options.name] = component; return () => {} } } })
  const owner = { cursor: 0, values: [], effects: [] }
  return {
    render() { current = owner; owner.cursor = 0; return registrations['settings.section']({}) },
    dispose() { owner.effects.forEach(effect => effect.cleanup && effect.cleanup()); for (const dispose of disposers.reverse()) dispose() },
  }
}

test('real panel gates online for legacy hosts but leaves explicitly offline available', async () => {
  for (const onlineAvailable of [undefined, false, 'true', true]) {
    let posts = 0
    const panel = mountPanel(async (_url, options) => {
      if (options.method === 'POST') { posts++; return response({ ok: true }) }
      return response({ onlineAvailable, config: { ready: true }, status: {} })
    })
    try {
      panel.render(); await tick()
      const tree = panel.render(), buttons = treeNodes(tree).filter(node => node.type === 'button')
      const online = buttons.find(node => renderedText(node) === '下载并在线应用')
      const offline = buttons.find(node => renderedText(node) === '仅下载（离线恢复）')
      assert.equal(online.props.disabled, onlineAvailable !== true)
      assert.equal(offline.props.disabled, false)
      if (onlineAvailable !== true) assert.match(renderedText(tree), /在线应用已禁用/)
      assert.equal(posts, 0, 'mount, status reads and capability checks never start a transfer')
    } finally { panel.dispose() }
  }
})

test('real download buttons confirm different scopes and submit exactly the chosen mode', async () => {
  for (const mode of ['online', 'offline']) {
    const posts = []
    const panel = mountPanel(async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
      return response({ onlineAvailable: true, config: { ready: true }, status: {} })
    })
    try {
      panel.render(); await tick()
      const label = mode === 'online' ? '下载并在线应用' : '仅下载（离线恢复）'
      treeNodes(panel.render()).find(node => node.type === 'button' && renderedText(node) === label).props.onClick({ currentTarget: {} })
      assert.equal(posts.length, 0)
      const tree = panel.render(), confirmation = treeNodes(tree).find(node => node.props?.className === 'dsh-sync-card dsh-sync-confirm')
      const scope = renderedText(confirmation)
      if (mode === 'online') {
        assert.match(scope, /完成当前任务并暂停其它编辑器写入/)
        assert.match(scope, /宿主接口导入新历史会话/)
        assert.match(scope, /仅追加未加载且未分叉/)
        assert.match(scope, /已加载或分叉会话不覆盖；正在执行任务的工程路径跳过/)
        assert.match(scope, /不会锁定工作区或其它编辑器/)
        assert.match(scope, /覆盖前备份并校验冲突/)
        assert.match(scope, /内容寻址附件校验哈希/)
        assert.match(scope, /运行时配置、插件安装、状态与预设延后/)
        assert.match(scope, /无需关闭 DSH.*手动刷新页面/)
        assert.doesNotMatch(scope, /请完全退出 DSH/)
      } else assert.match(scope, /只下载到暂存区.*完成后请完全退出 DSH/)
      const confirmLabel = mode === 'online' ? '确认下载并在线应用' : '确认仅下载到暂存区'
      treeNodes(confirmation).find(node => node.type === 'button' && renderedText(node) === confirmLabel).props.onClick()
      await tick(); await tick()
      assert.deepEqual(posts, [{ action: 'download', mode, confirmed: true }])
      assert.doesNotMatch(source, /location\.reload\s*\(/, 'download must never trigger a page reload')
    } finally { panel.dispose() }
  }
})

test('pendingApply normalization keeps only a redacted reason and never the stage or private fields', () => {
  const { normalizeSnapshot } = clientHarness()
  for (const pendingApply of [undefined, null]) assert.equal(normalizeSnapshot({ config: {}, status: {}, pendingApply }).pendingApply, null)
  const normalized = normalizeSnapshot({ config: {}, status: {}, pendingApply: {
    reason: '下载尚未完整应用 token=CANARY-SECRET', stage: 'PRIVATE-STAGING-PATH', privateKeyPath: 'PRIVATE-KEY-PATH', other: 'PRIVATE-OTHER',
  } })
  assert.deepEqual(Object.keys(normalized.pendingApply), ['reason'])
  assert.match(normalized.pendingApply.reason, /下载尚未完整应用/)
  assert.doesNotMatch(JSON.stringify(normalized), /CANARY-SECRET|PRIVATE|stage|privateKeyPath|other/)
  for (const pendingApply of [{}, false, [], { reason: { stage: 'PRIVATE' } }]) {
    assert.match(normalizeSnapshot({ config: {}, status: {}, pendingApply }).pendingApply.reason, /真实上传受到保护/)
  }
})

test('upload fence store guard requires literal consent and dry run or clear-result never clears pending state', async () => {
  for (const consent of [undefined, false, 'true', 1, true]) {
    const posts = []
    const { makeStore } = clientHarness(async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
      return response({ pendingApply: { reason: 'synthetic pending', stage: 'DO-NOT-KEEP' }, config: { ready: true }, status: {} })
    })
    const store = makeStore(), unsubscribe = store.subscribe(() => {})
    try {
      await tick()
      const allowed = consent === true
      assert.equal(await store.post({ action: 'upload', confirmed: true, allowUnapplied: consent }), allowed)
      assert.equal(posts.length, allowed ? 1 : 0)
      if (!allowed) assert.match(store.get().error, /未应用项.*明确勾选/)
      await store.refresh(); await tick() // An accepted POST already schedules its own status read.
      assert.equal(store.get().data.pendingApply.reason, 'synthetic pending')
      assert.equal(await store.post({ action: 'upload', dryRun: true, confirmed: true }), true)
      await tick()
      assert.equal(store.get().data.pendingApply.reason, 'synthetic pending')
      assert.equal(await store.post({ action: 'clear-result' }), true)
      await tick()
      assert.equal(store.get().data.pendingApply.reason, 'synthetic pending')
      assert.equal(posts.length, (allowed ? 1 : 0) + 2)
      assert.doesNotMatch(JSON.stringify(store.get()), /DO-NOT-KEEP/)
    } finally { unsubscribe(); store.dispose() }
  }
})

test('upload fence confirmation defaults unchecked, blocks submission, and opts in for only one upload', async () => {
  const posts = []
  const panel = mountPanel(async (_url, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
    return response({ pendingApply: { reason: '上次会话和配置尚未应用', stage: 'PRIVATE-STAGE' }, config: { ready: true }, status: {} })
  })
  const button = (tree, label) => treeNodes(tree).find(node => node.type === 'button' && renderedText(node) === label)
  const consent = tree => treeNodes(tree).find(node => node.type === 'label' && renderedText(node).includes('我已核对未应用项')).children[0]
  try {
    panel.render(); await tick()
    button(panel.render(), '上传').props.onClick({ currentTarget: {} })
    let tree = panel.render()
    assert.match(renderedText(tree), /警告：上传可能丢弃远端未应用内容/)
    assert.match(renderedText(tree), /上次会话和配置尚未应用/)
    assert.match(renderedText(tree), /本次将用本机会话、工程和配置快照替换远端；不会先合并未应用项/)
    assert.doesNotMatch(renderedText(tree), /PRIVATE-STAGE/)
    assert.equal(consent(tree).props.checked, false)
    assert.equal(button(tree, '确认上传').props.disabled, true)
    button(tree, '确认上传').props.onClick(); await tick()
    assert.equal(posts.length, 0, 'even direct invocation of a disabled handler cannot bypass consent')
    consent(tree).props.onChange({ target: { checked: true } })
    tree = panel.render()
    assert.equal(button(tree, '确认上传').props.disabled, false)
    button(tree, '确认上传').props.onClick(); await tick(); await tick()
    assert.deepEqual(posts, [{ action: 'upload', dryRun: false, allowLarge: false, allowUnapplied: true, confirmed: true }])
    button(panel.render(), '上传').props.onClick({ currentTarget: {} })
    tree = panel.render()
    assert.equal(consent(tree).props.checked, false)
    assert.equal(button(tree, '确认上传').props.disabled, true)
    assert.equal(posts.length, 1)
  } finally { panel.dispose() }
})

test('upload fence permits dry-run confirmation without opt-in and does not invent an override for legacy hosts', async () => {
  for (const [pendingApply, dryRun] of [[{ reason: 'still pending', stage: 'PRIVATE-STAGE' }, true], [null, false]]) {
    const posts = []
    const panel = mountPanel(async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
      return response({ pendingApply, config: { ready: true }, status: {} })
    })
    try {
      panel.render(); await tick()
      const opener = treeNodes(panel.render()).find(node => node.type === 'button' && renderedText(node) === (dryRun ? '本地预演' : '上传'))
      opener.props.onClick({ currentTarget: {} })
      const tree = panel.render()
      assert.ok(!treeNodes(tree).some(node => node.type === 'label' && renderedText(node).includes('我已核对未应用项')))
      const confirm = treeNodes(tree).find(node => node.type === 'button' && renderedText(node) === (dryRun ? '开始本地预演' : '确认上传'))
      assert.equal(Boolean(confirm.props.disabled), false)
      if (dryRun) assert.match(renderedText(tree), /本地预演不推送，也不会解除上传保护/)
      confirm.props.onClick(); await tick(); await tick()
      assert.deepEqual(posts, [{ action: 'upload', dryRun, allowLarge: false, allowUnapplied: false, confirmed: true }])
    } finally { panel.dispose() }
  }
})

test('local dry run stays available without backend readiness', async () => {
  const posts = []
  const { makeStore } = clientHarness(async (_url, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
    return response({ config: { backend: 'sftp', ready: false }, status: {} })
  })
  const store = makeStore(), unsubscribe = store.subscribe(() => {})
  try {
    await tick()
    assert.equal(await store.post({ action: 'upload', dryRun: true, confirmed: true }), true)
    assert.equal(posts.length, 1)
  } finally { unsubscribe(); store.dispose() }
})

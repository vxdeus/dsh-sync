import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client-panel.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const response = payload => ({ ok: true, status: 200, json: async () => payload })
const offer = (id = 'offer-a', extra = {}) => ({ id, profile: 'desktop', name: 'example-plugin', currentVersion: '1.0.0', targetVersion: '1.1.0', kind: 'upgrade', canInstall: true, sourceLabel: '已校验的快照安装包', advice: '源机版本较新，建议核对后更新', notes: ['需要手动重启'], ...extra })
const plan = (extra = {}) => ({ planId: 'plan-1', snapshot: 'snapshot-123', checkedAt: '2026-10-16T00:00:00Z', offers: [offer()], warnings: [], ...extra })
const snapshot = (extra = {}) => ({ config: { ready: true }, status: {}, onlineAvailable: true, pluginUpdateAvailable: true, pluginUpdates: plan(), ...extra })

function harness(fetch, overrides = {}) {
  let declaration
  const sandbox = { window: { __ModuleLoader__: { load(value) { declaration = value } } }, fetch, AbortController, setTimeout, clearTimeout, URL, ...overrides }
  const instrumented = source.replace("    return {\n      name: 'dsh-sync-ui',", "    window.__test = { normalizeSnapshot, normalizePluginUpdates, pluginTargetsAllowed, makeStore, Result, canCancel };\n    return {\n      name: 'dsh-sync-ui',")
  assert.notEqual(instrumented, source)
  vm.runInNewContext(instrumented, sandbox, { filename: 'client-panel.js' })
  const plugin = declaration.factory(name => {
    if (name === 'react') return overrides.React || { createElement(type, props, ...children) { return { type, props, children } } }
    throw new Error('optional dependency')
  })
  return { ...sandbox.window.__test, plugin }
}
function nodes(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...(node.children || []).flatMap(nodes)]
}
function text(node) {
  if (node == null) return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (typeof node.type === 'function') return text(node.type({ ...node.props, children: node.children }))
  return (node.children || []).map(text).join(' ')
}
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)
const checkbox = (tree, name = 'example-plugin') => nodes(tree).find(node => node.type === 'input' && node.props?.['aria-label'] === `选择更新 ${name}`)
function mount(fetch) {
  let current
  const registered = {}, disposers = []
  const React = {
    Fragment: 'fragment', createElement(type, props, ...children) { return { type, props, children } },
    useState(init) { const owner = current, i = owner.cursor++; if (!(i in owner.values)) owner.values[i] = typeof init === 'function' ? init() : init; return [owner.values[i], value => { owner.values[i] = typeof value === 'function' ? value(owner.values[i]) : value }] },
    useRef(value) { const [ref] = React.useState(() => ({ current: value })); return ref },
    useCallback(fn) { current.cursor++; return fn },
    useEffect(fn, deps) {
      const owner = current, i = owner.cursor++, previous = owner.effects[i]
      if (!previous || deps.some((dep, index) => dep !== previous.deps[index])) {
        if (previous?.cleanup) previous.cleanup()
        owner.effects[i] = { deps, cleanup: fn() }
      }
    },
  }
  const { plugin } = harness(fetch, { React, document: { createElement() { return { setAttribute() {}, remove() {} } }, head: { appendChild() {} } } })
  plugin.apply({ effect(fn) { disposers.push(fn()) }, slots: { inject(_name, fn) { disposers.push(fn()) }, register(options, component) { registered[options.name] = component; return () => {} } } })
  const owner = { cursor: 0, values: [], effects: [] }
  return {
    render() { current = owner; owner.cursor = 0; return registered['settings.section']({}) },
    dispose() { owner.effects.forEach(effect => effect.cleanup?.()); for (const dispose of disposers.reverse()) dispose?.() },
  }
}

test('plugin reminder DTO keeps only allowlisted redacted fields and does not copy raw snapshot metadata', () => {
  const { normalizeSnapshot } = harness()
  const result = normalizeSnapshot(snapshot({ private: 'PRIVATE-ROOT', pluginUpdates: plan({ token: 'PRIVATE-TOKEN', packagePath: 'PRIVATE-PATH', meta: { any: 'PRIVATE-META' },
    offers: [offer('offer-a', { privateKeyPath: 'PRIVATE-KEY', spec: 'PRIVATE-SPEC', manifest: { unsafe: 'PRIVATE-MANIFEST' }, advice: '建议 token=HIDDEN_SECRET', notes: ['正常备注', { private: 'PRIVATE-NOTE' }] })], warnings: ['正常警告', { other: 'PRIVATE-WARNING' }] }) }))
  assert.equal(result.pluginUpdates.planId, 'plan-1')
  assert.equal(result.pluginUpdates.snapshot, 'snapshot-123')
  assert.deepEqual(Object.keys(result.pluginUpdates).sort(), ['checkedAt', 'offers', 'planId', 'snapshot', 'warnings'])
  assert.deepEqual(Object.keys(result.pluginUpdates.offers[0]).sort(), ['advice', 'canInstall', 'currentVersion', 'id', 'kind', 'name', 'notes', 'profile', 'sourceLabel', 'targetVersion'])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|HIDDEN_SECRET|packagePath|manifest|privateKeyPath/)
  assert.match(result.pluginUpdates.offers[0].advice, /已隐藏/)
  for (const value of [undefined, null, [], false, {}, { planId: 123 }]) assert.equal(normalizeSnapshot(snapshot({ pluginUpdates: value })).pluginUpdates, null)
  for (const value of [undefined, false, 'true', 1, true]) assert.equal(normalizeSnapshot(snapshot({ pluginUpdateAvailable: value })).pluginUpdateAvailable, value === true)
})

test('reminder renders exact versions, source and suggestions; everything starts unselected with no write', async () => {
  let posts = 0
  const panel = mount(async (_url, options) => { if (options.method === 'POST') posts++; return response(snapshot({ pluginUpdates: plan({ offers: [offer(), offer('read-only', { name: 'dsh-sync', currentVersion: '0.4.0', targetVersion: '0.5.0', canInstall: false, advice: '请通过宿主插件管理更新同步插件' })] }) })) })
  try {
    panel.render(); await tick()
    const tree = panel.render(), output = text(tree)
    assert.match(output, /插件版本差异提醒/)
    assert.match(output, /1.0.0.*1.1.0/)
    assert.match(output, /已校验的快照安装包/)
    assert.match(output, /源机版本较新.*建议/)
    assert.match(output, /需要手动重启/)
    assert.match(output, /此项只作提醒/)
    assert.equal(checkbox(tree).props.checked, false)
    assert.equal(checkbox(tree, 'dsh-sync'), undefined)
    assert.equal(button(tree, '确认更新所选插件').props.disabled, true)
    button(tree, '确认更新所选插件').props.onClick({ currentTarget: {} }); await tick()
    assert.equal(posts, 0)
  } finally { panel.dispose() }
})

test('only specifically selected plugins enter a separate explicit confirmation and typed update POST', async () => {
  const posts = []
  const panel = mount(async (_url, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true, job: { id: 'update-job', action: 'plugin-update', status: 'running', cancellable: true } }) }
    return response(snapshot({ pluginUpdates: plan({ offers: [offer(), offer('offer-b', { name: 'another-plugin', currentVersion: null, targetVersion: '2.0.0', kind: 'missing' })] }) }))
  })
  try {
    panel.render(); await tick()
    checkbox(panel.render()).props.onChange({ target: { checked: true } })
    let tree = panel.render()
    assert.equal(button(tree, '确认更新所选插件').props.disabled, false)
    button(tree, '确认更新所选插件').props.onClick({ currentTarget: {} })
    tree = panel.render()
    const confirmation = nodes(tree).find(node => node.props?.className === 'dsh-sync-card dsh-sync-confirm'), scope = text(confirmation)
    assert.match(scope, /example-plugin：1.0.0 → 1.1.0/)
    assert.doesNotMatch(scope, /another-plugin/)
    assert.match(scope, /所有会话/)
    assert.match(scope, /手动重启 DSH.*不会自动退出/)
    assert.match(scope, /不会自动授权构建脚本/)
    assert.match(scope, /不是对以后下载或其它插件的授权/)
    assert.equal(posts.length, 0)
    button(confirmation, '同意并更新这些插件').props.onClick(); await tick(); await tick()
    assert.equal(posts.length, 1)
    assert.deepEqual(Object.keys(posts[0]).sort(), ['action', 'confirmed', 'planId', 'requestId', 'targets'])
    assert.equal(posts[0].action, 'plugin-updates-install')
    assert.equal(posts[0].confirmed, true)
    assert.equal(posts[0].planId, 'plan-1')
    assert.deepEqual(posts[0].targets, ['offer-a'])
    assert.match(posts[0].requestId, /^sync-plugin-update-/)
    assert.equal(checkbox(panel.render()).props.checked, false)
  } finally { panel.dispose() }
})

test('stale plan invalidates open update confirmation and resets selection instead of silently reusing consent', async () => {
  let currentPlan = plan(), posts = 0
  const panel = mount(async (_url, options) => { if (options.method === 'POST') posts++; return response(snapshot({ pluginUpdates: currentPlan })) })
  try {
    panel.render(); await tick()
    checkbox(panel.render()).props.onChange({ target: { checked: true } })
    button(panel.render(), '确认更新所选插件').props.onClick({ currentTarget: {} })
    currentPlan = plan({ planId: 'plan-2', snapshot: 'snapshot-456' })
    button(panel.render(), '刷新').props.onClick(); await tick()
    let tree = panel.render()
    assert.match(text(tree), /本次确认已失效/)
    assert.equal(button(tree, '同意并更新这些插件').props.disabled, true)
    button(tree, '同意并更新这些插件').props.onClick(); await tick()
    assert.equal(posts, 0)
    tree = panel.render()
    assert.equal(checkbox(tree).props.checked, false)
    const confirmation = nodes(tree).find(node => node.props?.className === 'dsh-sync-card dsh-sync-confirm')
    button(confirmation, '取消').props.onClick()
    assert.equal(button(panel.render(), '确认更新所选插件').props.disabled, true)
  } finally { panel.dispose() }
})

test('unavailable host installation service shows advice and cannot submit despite offer eligibility', async () => {
  let posts = 0
  const panel = mount(async (_url, options) => { if (options.method === 'POST') posts++; return response(snapshot({ pluginUpdateAvailable: false })) })
  try {
    panel.render(); await tick()
    const tree = panel.render()
    assert.match(text(tree), /官方插件安装服务不可用/)
    assert.equal(checkbox(tree).props.disabled, true)
    assert.equal(button(tree, '确认更新所选插件').props.disabled, true)
    checkbox(tree).props.onChange({ target: { checked: true } })
    button(panel.render(), '确认更新所选插件').props.onClick({ currentTarget: {} }); await tick()
    assert.equal(posts, 0)
  } finally { panel.dispose() }
})

test('store independently guards update consent, exact current plan, eligibility and unique targets', async () => {
  for (const [patch, allowed] of [
    [{}, true], [{ confirmed: false }, false], [{ confirmed: 'true' }, false], [{ planId: 'stale' }, false],
    [{ targets: [] }, false], [{ targets: ['unknown'] }, false], [{ targets: ['offer-a', 'offer-a'] }, false],
    [{ targets: ['read-only'] }, false], [{ requestId: '' }, false],
  ]) {
    const posts = [], { makeStore } = harness(async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }) }
      return response(snapshot({ pendingApply: { reason: '仍有未应用配置' }, pluginUpdates: plan({ offers: [offer(), offer('read-only', { canInstall: false })] }) }))
    })
    const store = makeStore(), unsubscribe = store.subscribe(() => {})
    try {
      await tick()
      assert.equal(await store.post({ action: 'plugin-updates-install', confirmed: true, planId: 'plan-1', targets: ['offer-a'], requestId: 'request-1', approvedBuilds: ['DO-NOT-FORWARD'], spec: 'DO-NOT-FORWARD', ...patch }), allowed)
      assert.equal(posts.length, allowed ? 1 : 0)
      if (allowed) assert.deepEqual(posts[0], { action: 'plugin-updates-install', confirmed: true, planId: 'plan-1', targets: ['offer-a'], requestId: 'request-1' })
      else assert.match(store.get().error, /明确确认.*具体插件/)
      assert.equal(store.get().data.pendingApply.reason, '仍有未应用配置')
    } finally { unsubscribe(); store.dispose() }
  }
})

test('failed update network response stays uncertain and is never retried automatically', async () => {
  let posts = 0
  const { makeStore } = harness(async (_url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('synthetic response lost') }
    return response(snapshot())
  })
  const store = makeStore(), unsubscribe = store.subscribe(() => {})
  const body = { action: 'plugin-updates-install', confirmed: true, planId: 'plan-1', targets: ['offer-a'], requestId: 'request-1' }
  try {
    await tick()
    assert.equal(await store.post(body), false)
    assert.equal(store.get().uncertain, true)
    assert.equal(await store.post(body), false)
    assert.equal(posts, 1)
    await store.refresh(); await tick()
    assert.equal(posts, 1)
    assert.match(store.get().notice, /未自动重复提交/)
  } finally { unsubscribe(); store.dispose() }
})

test('plugin update jobs use shared cancel and terminal result without promising new code is loaded', async () => {
  const posts = []
  let job = { id: 'update-job', action: 'plugin-update', status: 'running', cancellable: true }
  const { makeStore, canCancel, Result } = harness(async (_url, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); job = { ...job, cancelRequested: true }; return response({ ok: true, job }) }
    return response(snapshot({ job }))
  })
  const store = makeStore(), unsubscribe = store.subscribe(() => {})
  try {
    await tick()
    assert.equal(canCancel(store.get(), 'update-job'), true)
    assert.equal(await store.post({ action: 'cancel', jobId: 'update-job' }), true)
    await tick()
    assert.deepEqual(posts, [{ action: 'cancel', jobId: 'update-job' }])
    assert.equal(canCancel(store.get(), 'update-job'), false)
    const output = text(Result({ job: { ...job, status: 'succeeded', result: { summary: '已安装，restart-required' } } }))
    assert.match(output, /插件更新完成/)
    assert.match(output, /安装完成不一定已加载新版本/)
    assert.match(output, /手动重启 DSH/)
    assert.match(output, /不会自动关闭程序.*不会解除.*上传保护/)
    assert.doesNotMatch(output, /在线范围已处理|无需关闭或重启/)
  } finally { unsubscribe(); store.dispose() }
})

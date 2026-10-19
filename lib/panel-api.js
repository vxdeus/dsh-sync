import { randomUUID } from 'node:crypto'
import { isCancellation } from './transfer-control.js'

export const API_PATH = '/plugins/dsh-sync-ui/api'
export const UI_VERSION = '0.6.0'

const PROGRESS_PHASES = ['scan', 'connect', 'upload', 'verify', 'publish', 'download', 'restore', 'apply', 'install', 'done']
const PROGRESS_NUMBERS = ['completedBytes', 'totalBytes', 'completedFiles', 'totalFiles', 'transferredBytes', 'connections', 'elapsedMs', 'speedBytesPerSecond']
export function sanitizeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const output = {}
  if (PROGRESS_PHASES.includes(value.phase)) output.phase = value.phase
  for (const key of PROGRESS_NUMBERS) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) output[key] = value[key]
  }
  for (const [completed, total] of [['completedBytes', 'totalBytes'], ['completedFiles', 'totalFiles']]) {
    if (output[completed] !== undefined && output[total] > 0) output[completed] = Math.min(output[completed], output[total])
  }
  return Object.keys(output).length ? output : null
}

// One executor shared by the GUI and Agent tools. Closing the panel does not repeat a job.
export function createCoordinator() {
  let busy = false
  return {
    get busy() { return busy },
    async run(fn) {
      if (busy) throw new Error('已有同步或配置任务在进行，请等待完成')
      busy = true
      try { return await fn() } finally { busy = false }
    },
  }
}

export function sanitizeError(value, secrets = [], maxLength = 2000) {
  let result = String(value?.message || value || '未知错误')
  for (const secret of secrets) if (secret) result = result.split(secret).join('[已隐藏]')
  return result.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[已隐藏]@')
    .replace(/([?&](?:token|access_token|password)=)[^&\s]+/gi, '$1[已隐藏]')
    .slice(0, maxLength)
}
export function sanitizePayload(value, secrets = []) {
  if (typeof value === 'string') return value === '' ? '' : sanitizeError(value, secrets, Infinity)
  if (Array.isArray(value)) return value.map(item => sanitizePayload(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePayload(item, secrets)]))
  return value
}

export function createPanelController({ getState, runUpload, runDownload, runPluginUpdates, saveExtra, removeExtra, saveBackend, lock, supportsCancellation = false, getSecrets = () => [] }) {
  let job = null
  let cancelController = null
  let disposed = false
  const seen = new Map()
  const seenBindings = new Map()
  const clean = e => sanitizeError(e, getSecrets())
  const clone = value => JSON.parse(JSON.stringify(value))
  let snapshot = null
  const state = () => {
    // Progress polling must not rescan a large workspace every 1.5 seconds.
    if (!snapshot || job?.status !== 'running') snapshot = getState()
    return sanitizePayload({ ...snapshot, version: UI_VERSION, busy: lock.busy, job: job ? clone(job) : null }, getSecrets())
  }
  const start = (action, input) => {
    if (disposed) throw new Error('同步面板已关闭，请刷新页面')
    if (input.confirmed !== true) throw new Error('需要明确确认后才能开始')
    const mode = action === 'download' ? (input.mode === undefined ? 'online' : input.mode) : undefined
    if (action === 'download' && mode !== 'online' && mode !== 'offline') throw new Error('下载模式只允许 online 或 offline')
    if (action === 'plugin-update' && (typeof input.planId !== 'string' || !/^[a-f0-9]{64}$/.test(input.planId) || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100 || input.targets.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(input.targets).size !== input.targets.length)) throw new Error('请提供当前升级计划与明确选中的插件 id')
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || input.requestId.length > 200 || !input.requestId)) throw new Error('请求标识无效')
    const binding = JSON.stringify({ action, mode, ...(action === 'plugin-update' ? { planId: input.planId, targets: [...input.targets].sort() } : {}) })
    if (input.requestId && seen.has(input.requestId)) {
      const previous = seen.get(input.requestId)
      if (seenBindings.get(input.requestId) !== binding) throw new Error('同一请求标识不能更改操作、下载模式或已确认的插件选择')
      return previous
    }
    if (lock.busy || job?.status === 'running') throw new Error('已有同步任务在进行，请勿重复点击')
    job = { id: randomUUID(), action, ...(mode ? { mode } : {}), status: 'running', startedAt: new Date().toISOString(), progress: null, cancellable: supportsCancellation, cancelRequested: false }
    const current = job
    const abort = new AbortController()
    cancelController = abort
    const onProgress = value => {
      if (disposed || job !== current || current.status !== 'running') return
      // A stage snapshot, never a cumulative task percentage or an arbitrary store payload.
      const progress = sanitizeProgress(value)
      if (progress) current.progress = progress
    }
    const response = { ok: true, job: clone(current) }
    if (input.requestId) {
      seen.set(input.requestId, response); seenBindings.set(input.requestId, binding)
      while (seen.size > 30) { const oldest = seen.keys().next().value; seen.delete(oldest); seenBindings.delete(oldest) }
    }
    // These callbacks already acquire the same coordinator used by the Agent tools.
    Promise.resolve().then(() => action === 'upload'
      ? runUpload({ dryRun: input.dryRun === true, allowLarge: input.allowLarge === true, allowUnapplied: input.allowUnapplied === true }, { onProgress, signal: abort.signal })
      : action === 'plugin-update'
        ? (typeof runPluginUpdates === 'function' ? runPluginUpdates({ planId: input.planId, targets: [...input.targets] }, { onProgress, signal: abort.signal }) : Promise.reject(new Error('当前主机缺少插件更新服务')))
        : runDownload({ onProgress, signal: abort.signal, mode }))
      .then(result => {
        const partial = result?.partial === true || (Number.isFinite(result?.deferred) && result.deferred > 0)
        current.status = result?.confirmationPending ? 'unconfirmed' : result?.ok === false ? 'failed' : partial ? 'partial' : 'succeeded'
        result = sanitizePayload(result, getSecrets())
        current.result = result
        if (result?.ok === false) current.error = clean(result.summary)
      }, error => {
        current.status = isCancellation(error) ? 'cancelled' : 'failed'
        current.error = clean(error)
      })
      .finally(() => { current.finishedAt = new Date().toISOString(); if (cancelController === abort) cancelController = null })
    return response
  }
  return {
    state,
    dispose() { disposed = true },
    async command(input) {
      if (disposed) throw new Error('同步面板已卸载')
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求格式不正确')
      if (input.action === 'upload' || input.action === 'download') return start(input.action, input)
      if (input.action === 'plugin-updates-install') return start('plugin-update', input)
      if (input.action === 'cancel') {
        if (!job || typeof input.jobId !== 'string' || input.jobId !== job.id) throw new Error('任务已变化，请刷新后再取消')
        // Retried cancellation is idempotent, but never releases the operation lock early.
        if (job.status !== 'running') return { ok: true, job: clone(job) }
        if (!job.cancellable || !cancelController) throw new Error('当前任务不支持取消，请等待结束')
        job.cancelRequested = true
        cancelController.abort()
        return { ok: true, job: clone(job) }
      }
      if (job?.status === 'running') throw new Error('请等同步任务完成后再修改映射')
      if (input.action === 'clear-result') return lock.run(() => {
        job = null
        return { ok: true, ...state(), summary: '已清除面板结果，未修改本地文件或远端仓库。' }
      })
      if (input.action === 'backend-save') {
        if (input.backend !== 'gitee' && input.backend !== 'sftp') throw new Error('请选择 Gitee 或 SFTP 存储后端')
        return lock.run(() => {
          if (typeof saveBackend !== 'function') throw new Error('当前主机尚不支持保存存储选择，请更新同步插件')
          // The host validates local preconfiguration and commits atomically; never pass web-supplied server or key fields.
          return saveBackend({ action: 'backend-save', backend: input.backend })
        })
      }
      if (input.action === 'extra-save') return lock.run(() => saveExtra(input))
      if (input.action === 'extra-remove') return lock.run(() => removeExtra(input))
      throw new Error('不支持的操作')
    },
    clean,
  }
}

// HTTP transport deliberately uses the Host's existing authentication/Origin checks.
export function createHttpHandler(controller, connection) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  return async (req, res) => {
    const denied = connection.requestRejection(req)
    if (denied !== undefined) { send(res, denied, { ok: false, error: '需要当前 DSH 登录授权' }); return }
    try {
      if (req.method === 'GET') { send(res, 200, controller.state()); return }
      if (req.method !== 'POST') { send(res, 405, { ok: false, error: '方法不支持' }); return }
      if (req.headers['x-dsh-sync-ui'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        send(res, 403, { ok: false, error: '缺少同源操作标记' }); return
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, { ok: false, error: '拒绝跨站操作' }); return }
      let raw = '', bytes = 0
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 65536) { send(res, 413, { ok: false, error: '请求过大' }); return }
        raw += chunk.toString('utf8')
      }
      const output = await controller.command(JSON.parse(raw))
      send(res, output?.job ? 202 : 200, output)
    } catch (error) {
      send(res, 400, { ok: false, error: controller.clean(error) })
    }
  }
}

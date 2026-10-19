/**
 * dsh-sync —— DSH 跨机同步插件
 *
 * 五个模型可调用的工具（含需另行确认/授权的插件升级）：
 *   dsh_sync_status    查看配置、凭据、本次将要同步的内容
 *   dsh_sync_upload    把 DSH 状态 + 自定义路径提交并推送到私有 Git 仓库
 *   dsh_sync_download  从仓库拉取并恢复到本机
 *   dsh_sync_extras    增删查"自定义同步项"（本地工程 / 任意文件夹或文件）
 *
 * 设计要点（都是踩过坑换来的）：
 *   1. 只同步"该走的"目录（profiles 配置 / sessions / storages / state /
 *      .agent-presets / attachments / dsh-pet 配置），**绝不碰** node_modules、
 *      .credentials.yaml、integrations、im、cache、dsh-runtimes、electron。
 *   2. 会话目录名与 workspace.json 里含**绝对路径**，用户名不同会失效，所以同步时
 *      把本机 home 换成占位符，落地时再换回目标机器的 home。
 *   3. 自定义同步项按**逻辑名**存进仓库的 extras/<name>/，每台机器在自己的
 *      dsh-sync.json 里把同一个名字映射到各自的本地路径 —— 这样两台机器路径不同也能对上。
 *   4. 用 isomorphic-git（纯 JS）而不是系统 git —— 新机器不需要预装 git。
 *   5. 访问令牌存在 ~/.dsh/dsh-sync.json，该文件**永不参与同步**。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCoordinator, createPanelController, createHttpHandler, API_PATH, UI_VERSION, sanitizeError, sanitizePayload } from './panel-api.js'
import { pushAndVerify } from './upload-verification.js'
import { createHash } from 'node:crypto'
import { createSftpStore, validateSftpConfig } from './sftp-store.js'
import { installedPluginInventory } from './bootstrap-policy.js'
import { collectPluginSnapshot, detectPluginUpdates, savePluginUpdatePlan, readPluginUpdatePlan, pluginUpdateView, installConfirmedPluginUpdates, localProfileRestoreOverrides } from './plugin-packages.js'
import { buildUpgradeGuidance } from './upgrade-guidance.js'
import { DEFAULT_CONFIG, readConfig, configured, assertRemoteConfigured, gitWorkDir } from './config.js'
import { loadHostModule } from './host-module.js'
import { snapshotTimestamp } from './snapshot-meta.js'
import { throwIfCancelled, isCancellation, cancellableHttp } from './transfer-control.js'
import { prepareRestore, validateExtraTarget, noLinks, safeRelative, allowedDsh, inside } from './restore-safety.js'
import { applyLiveRestore, liveRuntime } from './live-restore.js'
import { readPending, writePending, assertUploadAllowed } from './sync-guard.js'

import {
  buildManifest, buildExtraManifest, extraStats, manifestStats, isTextFile, createCodec,
  splitExtraRel, isValidExtraName, DEFAULT_EXTRA_EXCLUDE,
  SYNC_TREES, ATTACHMENT_TREE, PROFILE_FILES, PET_CONFIG,
  DENY_DIRS, DENY_FILES, PH_RAW, EXTRA_PREFIX,
} from './pathcodec.js'

export const name = 'dsh-sync'

// Cordis 要求插件显式声明要注入的服务，否则访问 ctx.tools 会抛
//   Error: cannot get property tools without inject
// 这是宿主加载插件后的第一道校验。
export const inject = ['tools']

// ───────────────────────────────────────── 工具定义助手（双保险）

/**
 * 本地等价实现：把友好写法转成宿主 ToolDefinition 需要的 JSON Schema。
 * 只在取不到宿主 @deepseek-ai/dsh-tools 时启用 —— 这样插件不依赖宿主内部包，
 * 在任何解析环境下都能加载。
 */
function localDefineTool(def) {
  // 与官方 @deepseek-ai/dsh-tools 的 defineTool 产出一致（已用官方转换函数逐字比对）：
  //   parameters      : 传"参数名 -> 声明"的友好映射，转成标准 JSON Schema，required 提到顶层
  //   output.schema   : 传已带外壳的 { type, properties }，同样把子项 required 提上来
  // 注意：可选参数**不能写 required: false**，必须整个省略。
  const toSchema = (input) => {
    const source = input && input.properties ? input.properties : (input ?? {})
    const properties = {}
    const required = []
    for (const [key, spec] of Object.entries(source)) {
      const { required: isRequired, ...rest } = spec || {}
      properties[key] = rest
      if (isRequired === true) required.push(key)
    }
    const schema = { type: 'object', properties }
    if (input && input.additionalProperties !== undefined) schema.additionalProperties = input.additionalProperties
    if (required.length > 0) schema.required = required
    return schema
  }
  return {
    name: def.name,
    description: def.description,
    parameters: toSchema(def.parameters),
    output: {
      schema: toSchema(def.output?.schema),
      render: def.output?.render ?? (() => []),
    },
    execute: def.execute,
    ...(def.presentCall ? { presentCall: def.presentCall } : {}),
  }
}
// Tool schemas are validated against the current Host contract.
const defineTool = localDefineTool
const toolHelperSource = 'built-in'
const operationLock = createCoordinator()

// ───────────────────────────────────────── 路径与配置

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-sync.json')
const BOOT_LOG = path.join(DSH_HOME, 'dsh-sync-boot.json')
const META_FILE = 'meta.json'

const codec = createCodec(os.homedir())

// Load the Git transport only for explicit operations.
let gitModules = null
async function loadGit() {
  if (gitModules === null) {
    const [g, h] = await Promise.all([
      import('isomorphic-git'),
      import('isomorphic-git/http/node'),
    ])
    gitModules = { git: g.default ?? g, http: h.default ?? h }
  }
  return gitModules
}

function loadConfig() { return readConfig(CONFIG_FILE) }
function saveConfig(cfg) {
  const tmp = CONFIG_FILE + '.tmp'
  noLinks(CONFIG_FILE); noLinks(tmp)
  fs.mkdirSync(DSH_HOME, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE)
}

function writeDefaultConfigIfMissing() {
  if (fs.existsSync(CONFIG_FILE)) return false
  try { saveConfig({ ...DEFAULT_CONFIG }); return true } catch { return false }
}

function sftpLocalRoot(cfg) {
  const s = validateSftpConfig(cfg.sftp)
  const key = createHash('sha256').update(JSON.stringify([s.host, s.port, s.username, s.remoteRoot, s.hostKey])).digest('hex').slice(0, 24)
  return path.join(DSH_HOME, '.dsh-sync-sftp', key)
}
function activeWorkDir(cfg) { return cfg.backend === 'sftp' ? path.join(sftpLocalRoot(cfg), 'snapshot') : gitWorkDir(DSH_HOME, cfg) }
function pendingFile(cfg) {
  if (cfg.backend === 'sftp') return path.join(sftpLocalRoot(cfg), 'pending.json')
  const identity = [cfg.backend, cfg.repoUrl ? new URL(cfg.repoUrl).href : 'unconfigured', cfg.branch]
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)
  return path.join(DSH_HOME, '.dsh-sync-safety', key, 'pending.json')
}
function sftpStore(cfg, onProgress, signal) { return createSftpStore(cfg.sftp, { cacheDir: path.join(sftpLocalRoot(cfg), 'transport'), onProgress, signal }) }
function readSftpBase(cfg) {
  const file = path.join(sftpLocalRoot(cfg), 'base.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8')).id || null
}
function saveSftpBase(cfg, id) {
  const file = path.join(sftpLocalRoot(cfg), 'base.json')
  noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ id }) + '\n', 'utf8')
}
function sftpReady(cfg) {
  try { const s = validateSftpConfig(cfg.sftp); return fs.existsSync(s.privateKeyPath) } catch { return false }
}
function saveBackend(input) {
  if (!['gitee', 'sftp'].includes(input.backend)) throw new Error('不支持的存储后端')
  const cfg = loadConfig()
  if (input.backend === 'sftp' && !sftpReady(cfg)) throw new Error('请先在本机 dsh-sync.json 配置自己的 SFTP，并完成本设备密钥授权')
  cfg.backend = input.backend
  saveConfig(cfg)
  return { ok: true, summary: '已保存存储选择；没有上传或下载数据。' }
}

// ───────────────────────────────────────── Git 操作

function authOf(cfg, token) {
  return () => ({ username: cfg.username, password: token || cfg.token })
}

async function ensureRepo(cfg) {
  const workDir = activeWorkDir(cfg)
  const { git } = await loadGit()
  await fsp.mkdir(workDir, { recursive: true })
  if (!fs.existsSync(path.join(workDir, '.git'))) {
    await git.init({ fs, dir: workDir, defaultBranch: cfg.branch })
  }
  try { await git.deleteRemote({ fs, dir: workDir, remote: 'origin' }) } catch { /* may not exist */ }
  await git.addRemote({ fs, dir: workDir, remote: 'origin', url: cfg.repoUrl })
}

async function syncFromRemote(cfg, token, forUpload = false, signal) {
  const workDir = activeWorkDir(cfg)
  throwIfCancelled(signal)
  const modules = await loadGit()
  const git = modules.git, http = cancellableHttp(modules.http, signal)
  const refs = await git.listServerRefs({ http, url: cfg.repoUrl, onAuth: authOf(cfg, token) })
  const ref = 'refs/heads/' + cfg.branch
  if (!refs.some(r => r.ref === ref)) return { ok: false, missing: true, reason: '已验证远端尚无此分支' }
  await git.fetch({ fs, http, dir: workDir, remote: 'origin', ref: cfg.branch, singleBranch: true, onAuth: authOf(cfg, token) })
  const oid = await git.resolveRef({ fs, dir: workDir, ref: 'refs/remotes/origin/' + cfg.branch })
  const local = await git.resolveRef({ fs, dir: workDir, ref }).catch(() => null)
  if (forUpload && local !== oid) {
    const ahead = local && await git.isDescendent({ fs, dir: workDir, oid: local, ancestor: oid }).catch(() => false)
    if (!ahead) throw new Error('远端已有更新，请先下载并核对；为避免覆盖其他电脑的数据，上传已停止')
    return { ok: true, oid }
  }
  throwIfCancelled(signal)
  // Finish the local ref/checkout pair once it starts; never leave a half checkout.
  await git.writeRef({ fs, dir: workDir, ref, value: oid, force: true })
  await git.checkout({ fs, dir: workDir, ref: cfg.branch, force: true })
  return { ok: true, oid }
}

/** 清空工作区（保留 .git），保证上传的是完整快照而不是叠加。 */
async function clearWorktree(workDir, signal) {
  throwIfCancelled(signal)
  noLinks(workDir)
  await fsp.mkdir(workDir, { recursive: true })
  const entries = await fsp.readdir(workDir, { withFileTypes: true })
  for (const e of entries) {
    throwIfCancelled(signal)
    if (e.name === '.git') continue
    await fsp.rm(path.join(workDir, e.name), { recursive: true, force: true })
  }
}

/** 把 HOME 的同步内容 + 自定义项写进工作区（带占位符改写）。 */
async function stageIntoWorktree(manifest, cfg, extraSummary, workDir, onProgress = () => {}, previousMeta = null, signal, pluginSnapshot = collectPluginSnapshot(DSH_HOME, cfg.profiles)) {
  throwIfCancelled(signal)
  let written = 0, preparedBytes = 0
  const contentRows = []
  const totalBytes = manifestStats(manifest).bytes
  for (const item of manifest) {
    throwIfCancelled(signal)
    const originalRel = item.rel.split(path.sep).join('/')
    const isExtra = originalRel.startsWith('extras/')
    const rel = safeRelative(isExtra ? originalRel : codec.toPortable(originalRel))
    noLinks(item.abs)
    const dest = path.join(workDir, rel)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    if (!isExtra && isTextFile(item.abs)) {
      const text = await fsp.readFile(item.abs, 'utf8')
      await fsp.writeFile(dest, codec.toPortable(text), 'utf8')
    } else {
      await fsp.copyFile(item.abs, dest)
    }
    written += 1
    preparedBytes += (await fsp.stat(dest)).size
    const stagedHash = createHash('sha256').update(await fsp.readFile(dest)).digest('hex')
    if (item.sha256 && stagedHash !== item.sha256) throw new Error('插件安装包在上传准备期间发生变化，请重新上传')
    contentRows.push([rel, stagedHash])
    onProgress({ phase: 'scan', completedBytes: preparedBytes, totalBytes, completedFiles: written, totalFiles: manifest.length })
  }
  throwIfCancelled(signal)
  const meta = {
    schema: 2,
    contentId: createHash('sha256').update(JSON.stringify(contentRows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))).digest('hex'),
    machine: os.hostname(),
    user: os.userInfo().username,
    dshHome: PH_RAW,
    profiles: cfg.profiles,
    uploadedAt: new Date().toISOString(),
    files: written,
    bytes: manifestStats(manifest).bytes,
    extras: extraSummary,
    installedPlugins: installedPluginInventory(DSH_HOME, cfg.profiles),
    pluginInstallManifest: { schema: 1, items: pluginSnapshot.inventory },
    upgradeGuidance: buildUpgradeGuidance(DSH_HOME),
    note: 'absolute home paths are stored as __DSHHOME__ / __DSHHOME_ESC__ / __DSHHOME_ENC__ and rewritten on download; extras/<name> maps to a per-machine local path configured in dsh-sync.json',
  }
  meta.uploadedAt = snapshotTimestamp(previousMeta, meta, meta.uploadedAt)
  await fsp.writeFile(path.join(workDir, META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return written
}

async function commitChanges(cfg, message) {
  const workDir = activeWorkDir(cfg)
  const { git } = await loadGit()
  const matrix = await git.statusMatrix({ fs, dir: workDir })
  const changed = matrix.filter(([, head, work, stage]) => !(head === 1 && work === 1 && stage === 1))
  if (changed.length === 0) return { committed: false, changed: 0 }

  for (const [filepath, , work] of changed) {
    if (work === 0) await git.remove({ fs, dir: workDir, filepath })
    else await git.add({ fs, dir: workDir, filepath })
  }
  await git.commit({
    fs, dir: workDir, message,
    author: { name: cfg.username || 'dsh-sync', email: `${cfg.username || 'dsh-sync'}@localhost` },
  })
  return { committed: true, changed: changed.length }
}

// ───────────────────────────────────────── 落地（下载方向）

/** 读工作副本里的 meta.json（了解仓库里有哪些 extras）。 */
function readRepoMeta(cfg = loadConfig()) {
  try { return JSON.parse(fs.readFileSync(path.join(activeWorkDir(cfg), META_FILE), 'utf8')) } catch { return null }
}

// ───────────────────────────────────────── 工具

function textOut(t) {
  return [{ type: 'text', text: t }]
}

function progressReporter(exec) {
  return value => { try { if (typeof exec?.onProgress === 'function') exec.onProgress(value) } catch {} }
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function extrasLines(cfg) {
  const stats = extraStats(cfg)
  if (stats.length === 0) return ['  （没有配置自定义同步项）']
  return stats.map((s) =>
    `  · ${s.name}  →  ${s.path}   ${s.missing ? '❌ 路径不存在' : `${s.files} 个文件 / ${human(s.bytes)}`}`)
}

/**
 * 状态页、面板与上传共用同一份清单。
 * buildManifest 只挡 DENY_DIRS / DENY_FILES，目录与扩展名白名单由 allowedDsh 裁决；
 * 三处都走这里，显示的文件数与体积才等于真正会被上传/恢复的量。
 */
function uploadManifest(cfg, pluginSnapshot = collectPluginSnapshot(DSH_HOME, cfg.profiles)) {
  const data = buildManifest(DSH_HOME, cfg).filter(item => {
    const rel = item.rel.split(path.sep).join('/')
    return rel.startsWith(EXTRA_PREFIX + '/') || allowedDsh(codec.toPortable(rel), cfg)
  })
  return [...data, ...pluginSnapshot.artifacts]
}

function registerStatusTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'dsh_sync_status',
    description: '查看 DSH 跨机同步的配置、自定义同步项和本次将要上传的内容（只读，不推送任何东西）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          configured: { type: 'boolean', required: true },
          repoUrl: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          tokenPresent: { type: 'boolean', required: true },
          fileCount: { type: 'number', required: true },
          totalBytes: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(value.summary),
    },
    async execute() {
      const cfg = loadConfig()
      const manifest = uploadManifest(cfg)
      const stats = manifestStats(manifest)
      const tokenPresent = cfg.backend === 'sftp' ? sftpReady(cfg) : Boolean(cfg.token) || Boolean(process.env.DSH_SYNC_TOKEN)
      const repoMeta = readRepoMeta()

      const lines = [
        `存储      : ${cfg.backend === 'sftp' ? 'SFTP ' + cfg.sftp.host : 'Gitee ' + cfg.repoUrl}`,
        `分支      : ${cfg.branch}`,
        `账号      : ${cfg.username}`,
        `私有仓库确认 : ${cfg.privateRepoConfirmed ? '已确认' : '未确认（Git 传输前需在本机设置 privateRepoConfirmed: true）'}`,
        `访问令牌  : ${tokenPresent ? '已配置' : '❌ 未配置 —— 在下面这个文件里填 "token"（Gitee 私人令牌，需勾 projects 权限）'}`,
        `配置文件  : ${CONFIG_FILE}`,
        `工作副本  : ${activeWorkDir(cfg)}`,
        `本机 home : ${codec.raw}`,
        `会话目录编码形式 : ${codec.enc}`,
        `本次同步  : ${stats.files} 个文件 / ${human(stats.bytes)}`,
        '',
        '包含：' + [...SYNC_TREES, ...(cfg.includeAttachments ? [ATTACHMENT_TREE] : []), `profiles/${cfg.profiles.join(', profiles/')} 的 ${PROFILE_FILES.join(' / ')}`, PET_CONFIG].join('、'),
        '排除：node_modules、.credentials.yaml、integrations、im、cache、dsh-runtimes、electron、dsh-sync.json',
        '仅本机保留：cost-meter 原生搜索覆盖诊断、Codex 额度预测缓存（真实费用账本和搜索用量日志仍同步）',
        '插件升级：上传精确版本与本地安装包；下载后仅提醒，明确确认所选插件后才安装，不自动重启。',
        '',
        `自定义同步项（上限 ${human(cfg.maxExtraBytes)} / 项）：`,
        ...extrasLines(cfg),
      ]

      if (repoMeta?.extras) {
        const localNames = new Set((cfg.extras ?? []).map((e) => e.name))
        const repoExtras = repoMeta.extras.map((e) => e.name)
        const missingHere = repoExtras.filter((n) => !localNames.has(n))
        lines.push('')
        lines.push(`仓库里上次上传的 extras：${repoExtras.length ? repoExtras.join(', ') : '（无）'}`)
        if (missingHere.length) lines.push(`⚠️ 本机尚未配置：${missingHere.join(', ')} —— 用 dsh_sync_extras 添加同名项并指向本机路径`)
      }

      const upgradePlan = pluginUpdateView(readPluginUpdatePlan(DSH_HOME, cfg))
      if (upgradePlan) {
        lines.push('', '插件升级提醒（只检测，不自动执行）：', ...upgradePlan.warnings)
        if (upgradePlan.planId) lines.push('planId: ' + upgradePlan.planId)
        for (const offer of upgradePlan.offers) lines.push(`  ${offer.name}: ${offer.currentVersion || '未安装'} → ${offer.targetVersion}\n    ${offer.advice}\n    ${offer.notes || ''}\n    id: ${offer.id}；可确认更新：${offer.canInstall ? '是' : '否'}`)
      }
      return {
        configured: configured(cfg, process.env.DSH_SYNC_TOKEN),
        repoUrl: cfg.repoUrl,
        branch: cfg.branch,
        tokenPresent,
        fileCount: stats.files,
        totalBytes: stats.bytes,
        summary: lines.join('\n'),
      }
    },
  }))
}

function registerExtrasTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'dsh_sync_extras',
    description: '管理"自定义同步项"：把本机的工程目录或任意文件加入跨机同步（会存到仓库的 extras/<name>/），或查看、移除它们。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove'], description: 'list 查看 / add 添加 / remove 移除。' },
      name: { type: 'string', description: 'add 与 remove 需要的逻辑名（字母数字、点、下划线、短横）。' },
      targetPath: { type: 'string', description: 'add 时的本机绝对路径（文件夹或单个文件）。' },
      kind: { type: 'string', enum: ['file', 'directory'], description: '目标类型；下载目的地尚不存在时请明确指定。' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'add 时可选：要排除的子目录/文件名；传空数组表示默认排除也取消。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(value.summary),
    },
    async execute(args) {
      if (args.action === 'add') return saveExtraMapping({ ...args, kind: args.kind })
      if (args.action === 'remove') return removeExtraMapping(args)
      const cfg = loadConfig()
      return { ok: true, count: cfg.extras.length, summary: extrasLines(cfg).join('\n') }

    },
  }))
}

function registerUploadTool(ctx, getRuntime = () => null) {
  ctx.tools.register(defineTool({
    name: 'dsh_sync_upload',
    description: '把本机 DSH 状态（插件配置、会话历史、附件）以及已配置的自定义同步项（工程/任意文件）提交并推送到私有 Git 仓库，方便换电脑后继续任务。dryRun=true 时只做本地暂存与提交，不推送。',
    parameters: {
      message: { type: 'string', description: '提交信息，默认自动生成。' },
      dryRun: { type: 'boolean', description: 'true = 只暂存并本地提交，不推送。' },
      allowLarge: { type: 'boolean', description: 'true = 允许上传超过 maxExtraBytes 的自定义项。' },
      allowUnapplied: { type: 'boolean', description: '仅用户明确确认后传 true：允许用本机快照替换上次下载未应用的远端内容，可能丢弃远端更改。默认阻止。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          staged: { type: 'number', required: true },
          committed: { type: 'boolean', required: true },
          pushed: { type: 'boolean', required: true },
          confirmationPending: { type: 'boolean' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(value.summary),
    },
    async execute(args, exec) {
      const onProgress = progressReporter(exec)
      const signal = exec?.signal
      throwIfCancelled(signal)
      onProgress({ phase: 'scan' })
      const cfg = loadConfig()
      const token = cfg.token || process.env.DSH_SYNC_TOKEN || ''
      const dryRun = Boolean(args.dryRun)
      const allowLarge = Boolean(args.allowLarge)
      if (!dryRun) assertRemoteConfigured(cfg, token)
      assertUploadAllowed(pendingFile(cfg), DSH_HOME, args)

      const isSftp = cfg.backend === 'sftp'
      const workDir = activeWorkDir(cfg)
      if (!dryRun && !(isSftp ? sftpReady(cfg) : token)) {
        return {
          ok: false, staged: 0, committed: false, pushed: false,
          summary: isSftp ? '❌ SFTP 本机密钥或配置未就绪，请先完成本设备的一次公钥授权。' : `❌ 没有访问令牌。请在 ${CONFIG_FILE} 里填 "token"（Gitee 私人令牌），或设置环境变量 DSH_SYNC_TOKEN。`,
        }
      }

      const lines = []
      throwIfCancelled(signal)
      if (!isSftp && cfg.repoUrl) await ensureRepo(cfg)
      const remote = dryRun || isSftp ? { ok: false, reason: isSftp && !dryRun ? 'SFTP：发布前将在服务器锁内核对快照版本' : '本地预演：未访问远端' } : await syncFromRemote(cfg, token, true, signal)
      lines.push(remote.ok ? `远端已核对（${String(remote.oid).slice(0, 8)}）` : remote.reason)

      // 自定义项大小守门
      const statsRows = extraStats(cfg)
      const skippedExtras = []
      const extraSummary = []
      for (const row of statsRows) {
        if (row.missing) throw new Error(`自定义项 ${row.name} 的路径不存在，已停止而非删除旧备份`)
        if (row.bytes > cfg.maxExtraBytes && !allowLarge) {
          throw new Error(`自定义项 ${row.name} 超过大小上限；已停止上传，未删除旧备份`)
        }
        extraSummary.push({ name: row.name, kind: fs.statSync(row.path).isFile() ? 'file' : 'directory', files: row.files, bytes: row.bytes })
      }

      const effectiveCfg = {
        ...cfg,
        extras: (cfg.extras ?? []).filter((e) => extraSummary.some((s) => s.name === e.name)),
      }

      for (const item of effectiveCfg.extras) validateExtraTarget(item.path, item.kind || (fs.statSync(item.path).isFile() ? 'file' : 'directory'), DSH_HOME)
      // Flush buffered live logs before snapshotting; uploading never stops Agents.
      await getRuntime()?.persistence.flush()
      throwIfCancelled(signal)
      const pluginSnapshot = collectPluginSnapshot(DSH_HOME, effectiveCfg.profiles)
      const manifest = uploadManifest(effectiveCfg, pluginSnapshot)
      // Preserve unmapped remote extras. A different machine must not delete their backups.
      const oldExtraNames = fs.existsSync(path.join(workDir, 'extras')) ? fs.readdirSync(path.join(workDir, 'extras')) : []
      const selectedNames = new Set(effectiveCfg.extras.map(e => e.name))
      if (oldExtraNames.some(n => !selectedNames.has(n))) throw new Error('仓库还有本机未配置的自定义项，请先添加同名映射；上传已停止以保留旧备份')
      const stats = manifestStats(manifest)
      const previousMeta = readRepoMeta(cfg)
      throwIfCancelled(signal)
      await clearWorktree(workDir, signal)
      const staged = await stageIntoWorktree(manifest, effectiveCfg, extraSummary, workDir, onProgress, previousMeta, signal, pluginSnapshot)
      if (dryRun && !isSftp && !cfg.repoUrl) return { ok: true, staged, committed: false, pushed: false, summary: `已本地暂存 ${staged} 个文件；尚未配置仓库，未访问远端或创建 Git 提交。` }
      if (isSftp) {
        if (dryRun) return { ok: true, staged, committed: false, pushed: false, summary: `已本地暂存 ${staged} 个文件；未访问服务器。` }
        const result = await sftpStore(cfg, onProgress, signal).upload(workDir, { expectedId: readSftpBase(cfg) })
        saveSftpBase(cfg, result.id)
        if (result.verified === true) writePending(pendingFile(cfg), { pending: false })
        return { ok: result.verified === true, staged, committed: false, pushed: true, summary: `SFTP 快照发布并回读核验成功：${result.id.slice(0, 12)}\n${staged} 个文件 / ${human(stats.bytes)}；未覆盖本机数据。` }
      }
      lines.push(`已暂存 ${staged} 个文件 / ${human(stats.bytes)}`)
      if (extraSummary.length) {
        lines.push('自定义同步项：')
        for (const s of extraSummary) lines.push(`  · ${s.name}  ${s.files} 个文件 / ${human(s.bytes)}`)
      }
      if (skippedExtras.length) lines.push(`⏭️ 已跳过：${skippedExtras.join('；')}`)

      const message = args.message || `dsh-sync: ${os.hostname()} @ ${new Date().toISOString()}`
      throwIfCancelled(signal)
      const commit = await commitChanges(cfg, message)
      lines.push(commit.committed ? `本地提交完成（${commit.changed} 个变更）` : '内容无变化，跳过提交')

      let verification = { ok: true, pushed: false, verified: false, confirmationPending: false }
      if (!dryRun) {
        throwIfCancelled(signal)
        const { git, http } = await loadGit()
        const localOid = await git.resolveRef({ fs, dir: workDir, ref: `refs/heads/${cfg.branch}` })
        throwIfCancelled(signal)
        verification = await pushAndVerify({
          localOid,
          push: async () => {
            try { return await git.push({ fs, http: cancellableHttp(http, signal), dir: workDir, remote: 'origin', ref: cfg.branch, onAuth: authOf(cfg, token) }) }
            catch (error) { throwIfCancelled(signal); throw error }
          },
          readRemote: async () => {
            // A cancelled push may already be committed remotely. Confirm once,
            // using a fresh bounded read signal; never retry the write.
            const readHttp = signal?.aborted ? cancellableHttp(http, AbortSignal.timeout(30000)) : http
            const refs = await git.listServerRefs({ http: readHttp, url: cfg.repoUrl, onAuth: authOf(cfg, token) })
            return refs.find(r => r.ref === `refs/heads/${cfg.branch}`)?.oid
          },
        })
        if (verification.verified) {
          writePending(pendingFile(cfg), { pending: false })
          if (verification.recoveredFromCancellation) lines.push('已请求取消，但远端已收到本次提交并核验一致；没有重复推送，也不会撤销已发布快照。')
          else if (verification.recoveredFromTimeout) lines.push('上传响应超时，但已通过只读查询确认远端收到本次提交；没有重复推送。')
          lines.push(`✅ 上传成功；远端校验通过：${localOid.slice(0, 8)}（与本地一致）`)
        } else {
          lines.push('⚠️ 上传结果待确认：暂未确认远端收到本次提交。不要视为已备份成功；未自动重复上传。')
          if (verification.remoteOid) lines.push(`远端 ${verification.remoteOid.slice(0, 8)} / 本地 ${localOid.slice(0, 8)}`)
        }
      } else {
        lines.push('（dryRun：未推送）')
      }

      return { ok: verification.ok, staged, committed: commit.committed, pushed: verification.pushed,
        confirmationPending: Boolean(verification.confirmationPending), summary: lines.join('\n') }
    },
  }))
}

function registerDownloadTool(ctx, getRuntime = () => null) {
  ctx.tools.register(defineTool({
    name: 'dsh_sync_download',
    description: '下载并在线应用历史会话、附件和工程，无需退出 DSH。已加载/分叉会话、忙碌工程和运行时配置会保留并报告未应用项。mode=offline 仅暂存并生成离线全量恢复命令。不会自动上传。',
    parameters: {
      dryRun: { type: 'boolean', description: 'true = 仅更新本地下载副本，不应用会话、配置或工程。' },
      mode: { type: 'string', enum: ['online', 'offline'], description: '默认 online 安全在线应用；offline 仅暂存，需退出 DSH 后全量恢复。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          copied: { type: 'number', required: true },
          backedUp: { type: 'number', required: true },
          partial: { type: 'boolean' },
          deferred: { type: 'number' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textOut(value.summary),
    },
    async execute(args, exec) {
      const onProgress = progressReporter(exec)
      const signal = exec?.signal
      throwIfCancelled(signal)
      const mode = args.mode === undefined ? 'online' : args.mode
      if (!['online', 'offline'].includes(mode)) throw new Error('下载模式只能是 online 或 offline')
      const runtime = getRuntime()
      if (mode === 'online' && !args.dryRun) {
        if (!runtime) throw new Error('宿主在线接口不可用；请选择仅下载（离线恢复）')
        await runtime.catalog() // Fail before transport, never silently downgrade to raw writes.
      }
      onProgress({ phase: 'connect' })
      const cfg = loadConfig()
      const token = cfg.token || process.env.DSH_SYNC_TOKEN || ''
      const isSftp = cfg.backend === 'sftp'
      assertRemoteConfigured(cfg, token)
      const workDir = activeWorkDir(cfg)
      if (!(isSftp ? sftpReady(cfg) : token)) return { ok: false, copied: 0, backedUp: 0, summary: '请先配置当前存储端的本机凭据' }
      // Record intent BEFORE download can advance Git refs / the SFTP baseline.
      // Failures, preview-only downloads and dry-runs cannot silently erase it.
      writePending(pendingFile(cfg), { pending: true, reason: '下载尚未完整应用或结果待确认，请先核对再上传。', mode })
      savePluginUpdatePlan(DSH_HOME, null)
      let remote
      if (isSftp) {
        const received = await sftpStore(cfg, onProgress, signal).download(workDir)
        saveSftpBase(cfg, received.id)
        remote = { ok: true, oid: received.id }
      } else {
        await ensureRepo(cfg)
        remote = await syncFromRemote(cfg, token, false, signal)
      }
      if (!remote.ok) return { ok: false, copied: 0, backedUp: 0, summary: remote.reason }
      const pluginPlan = detectPluginUpdates({ workDir, dshHome: DSH_HOME, cfg, snapshot: remote.oid })
      savePluginUpdatePlan(DSH_HOME, pluginPlan)
      const pluginNotice = '\n' + [
        pluginPlan?.offers?.length ? `发现 ${pluginPlan.offers.length} 项插件版本差异；已读取升级建议，请询问用户同意哪些操作。未自动安装。` : '插件版本检查完成，没有需要更新的插件。',
        ...(pluginPlan?.warnings || []),
        ...(pluginPlan?.offers || []).slice(0, 12).map(offer => `${offer.name}：${offer.currentVersion || '未安装'} → ${offer.targetVersion}；${offer.advice}${offer.notes ? '\n变更说明／发布者描述：' + offer.notes : ''}`),
        pluginPlan?.offers?.length ? '用户同意前不要安装；需要执行时先用状态工具取得当前 planId 与明确同意的插件 id。设置／登录／工程路径等建议只供解释与询问，不从文档执行命令。' : '',
      ].filter(Boolean).join('\n')
      if (args.dryRun) return { ok: true, copied: 0, backedUp: 0, summary: '已拉取到工作副本，未写入任何会话、配置或工程文件。' + pluginNotice }
      throwIfCancelled(signal)
      onProgress({ phase: 'restore' })
      const downloadedMeta = readRepoMeta(cfg)
      const profileOverrides = mode === 'offline' && downloadedMeta?.pluginInstallManifest?.schema === 1
        ? localProfileRestoreOverrides(workDir, DSH_HOME, downloadedMeta.pluginInstallManifest.items) : null
      const staged = await prepareRestore({ workDir, dshHome: DSH_HOME, cfg, codec, oid: remote.oid, signal, onProgress, online: mode === 'online', profileOverrides })
      writePending(pendingFile(cfg), { pending: true, reason: mode === 'online' ? '在线应用尚未完成，请等待并核对结果。' : '快照仅暂存，尚未完成离线恢复。', mode, oid: remote.oid, stage: staged.stage })
      if (mode === 'online') {
        const result = await applyLiveRestore(staged.stage, { dshHome: DSH_HOME, cfg, codec, runtime, signal, onProgress })
        writePending(pendingFile(cfg), { pending: result.ok !== true || result.partial === true, reason: '上次在线下载有未应用项或执行中断；上传前必须先核对，避免丢弃远端内容。', mode, oid: remote.oid, stage: staged.stage })
        return { ...result, summary: result.summary + pluginNotice }
      }
      onProgress({ phase: 'done', completedFiles: staged.files, totalFiles: staged.files })
      const command = writeOfflineLauncher(staged.stage)
      return {
        ok: true, copied: 0, backedUp: 0,
        summary: `已下载并暂存 ${staged.files} 个文件；其中 ${staged.overwrites} 个目标已存在。\n未覆盖任何会话或工程。请先完全退出 DSH，再运行：\n${command}\n覆盖前将备份全部被改文件。` +
          `\n其中 ${staged.unchanged} 个目标内容已一致，执行时复核后保持原样，不重复覆盖。` +
          (staged.preservedLocal.length ? `\n保留本机状态、不覆盖（${staged.preservedLocal.length} 项）：${staged.preservedLocal.map(item => item.repoPath).join(', ')}` : '') +
          (staged.unmapped.length ? `\n尚未映射：${staged.unmapped.join(', ')}（先配置路径再重新下载）` : '') +
          (staged.legacy ? '\n注意：这是旧格式快照，工程文本曾经被旧版改写；建议源电脑用新版本重新上传。' : '') +
          '\n恢复脚本会拒绝覆盖下载后又被修改的文件。插件须在升级提醒中确认安装；安装后请重新下载离线恢复计划，避免使用安装前的旧基线。' + pluginNotice,
      }

    },
  }))
}

async function approvePluginUpdates(ctx, exec) {
  const policyService = ctx.get?.('sandboxPolicy')
  if (!policyService || !exec?.agent) throw new Error('当前 Agent 缺少插件管理授权上下文；请在同步面板确认所选更新')
  const { approveEscalation } = await loadHostModule('@deepseek-ai/dsh-sandbox')
  const policy = policyService.resolve({ session: exec.agent.session })
  await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: '同步插件升级',
    justification: '安装用户确认的同步插件更新；Host 插件代码在工作区沙箱之外执行，影响当前 profile 的全部会话。不会自动批准构建脚本或关闭 DSH。' },
    { approver: ctx.get?.('approval'), agent: exec.agent, callId: exec.callId, toolName: 'dsh_sync_update_plugins', signal: exec.signal })
}
function registerPluginUpdatesTool(ctx, hostContext, runUpdates) {
  ctx.tools.register(defineTool({
    name: 'dsh_sync_update_plugins',
    description: '根据下载后的插件升级提醒，更新用户明确确认的插件。先调用状态查看精确版本、建议和 planId/插件 id；用户同意后再执行。安装前请求本次插件管理授权，不批准构建脚本，不自动关闭 DSH。',
    parameters: {
      planId: { type: 'string', required: true, description: '当前插件升级提醒的 planId。' },
      targets: { type: 'array', required: true, items: { type: 'string' }, description: '用户明确同意更新的插件提醒 id；不是包名或任意安装 spec。' },
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean', required: true }, summary: { type: 'string', required: true } } }, render: (_args, value) => textOut(value.summary) },
    async execute(args, exec) { await approvePluginUpdates(hostContext, exec); return runUpdates(args, exec) },
  }))
}

// ───────────────────────────────────────── 生命周期

// ── GUI integration: allowlisted DTO, authenticated API, shared operation lock.
function saveExtraMapping(input) {
  const cfg = loadConfig()
  const nm = String(input.name || '').trim()
  if (!isValidExtraName(nm)) throw new Error('逻辑名只允许字母、数字、点、下划线和短横')
  const target = String(input.targetPath || '').trim()
  const kind = input.kind || (fs.existsSync(target) && fs.statSync(target).isFile() ? 'file' : 'directory')
  const absolute = validateExtraTarget(target, kind, DSH_HOME)
  if (input.exclude !== undefined && (!Array.isArray(input.exclude) || input.exclude.some(x => typeof x !== 'string' || /[\\/]/.test(x)))) throw new Error('排除列表应为文件或目录名数组')
  const previous = cfg.extras.find(x => x.name === nm)
  const entry = { name: nm, path: absolute, kind }
  if (input.exclude !== undefined) entry.exclude = input.exclude
  else if (previous?.exclude !== undefined) entry.exclude = previous.exclude
  for (const other of cfg.extras) {
    if (other.name !== nm && (inside(other.path, absolute) || inside(absolute, other.path))) throw new Error('与已有同步项路径重叠：' + other.name)
  }
  cfg.extras = cfg.extras.filter(e => e.name !== nm).concat(entry)
  saveConfig(cfg)
  return { ok: true, count: cfg.extras.length, summary: `已保存映射 ${nm}；此操作不会上传或删除本地文件。` }
}
function removeExtraMapping(input) {
  const cfg = loadConfig(), nm = String(input.name || '')
  if (!cfg.extras.some(e => e.name === nm)) throw new Error('找不到此同步项')
  cfg.extras = cfg.extras.filter(e => e.name !== nm)
  saveConfig(cfg)
  return { ok: true, count: cfg.extras.length, summary: `已移除映射 ${nm}，未删除本地文件或远端备份。` }
}
function getPanelState() {
  const cfg = loadConfig()
  const stats = manifestStats(uploadManifest(cfg))
  const pending = readPending(pendingFile(cfg), DSH_HOME)
  const pluginUpdates = pluginUpdateView(readPluginUpdatePlan(DSH_HOME, cfg))
  return {
    pluginUpdates,
    pendingApply: pending ? { reason: pending.reason || '上次下载尚未完整应用。' } : null,
    config: {
      backend: cfg.backend, ready: configured(cfg, process.env.DSH_SYNC_TOKEN),
      sftp: cfg.sftp ? { host: cfg.sftp.host, port: cfg.sftp.port || 22, username: cfg.sftp.username || 'dshsync', remoteRoot: cfg.sftp.remoteRoot || '/data/dsh-sync', configured: sftpReady(cfg) } : null,
      repoUrl: cfg.repoUrl, branch: cfg.branch, username: cfg.username, privateRepoConfirmed: cfg.privateRepoConfirmed,
      tokenPresent: Boolean(cfg.token || process.env.DSH_SYNC_TOKEN),
      includeAttachments: cfg.includeAttachments, maxExtraBytes: cfg.maxExtraBytes,
    },
    status: {
      fileCount: stats.files, totalBytes: stats.bytes,
      extras: extraStats(cfg).map(e => {
        const conf = cfg.extras.find(c => c.name === e.name)
        return { name: e.name, path: e.path, kind: conf.kind || (!e.missing && fs.statSync(e.path).isFile() ? 'file' : 'directory'), files: e.files, bytes: e.bytes, missing: e.missing, exclude: conf.exclude }
      }),
      remoteExtras: (readRepoMeta()?.extras || []).map(e => ({ name: e.name, kind: e.kind || 'directory', files: e.files, bytes: e.bytes })),
    },
  }
}
export function writeOfflineLauncher(stage) {
  const local = path.dirname(fileURLToPath(import.meta.url))
  for (const file of ['restore-safety.js', 'restore-offline.mjs', 'pathcodec.js', 'transfer-control.js', 'plugin-packages.js', 'plugin-archive.js', 'upgrade-guidance.js', 'upgrade-guidance.json']) fs.copyFileSync(path.join(local, file), path.join(stage, file))
  fs.writeFileSync(path.join(stage, 'package.json'), '{"type":"module"}\n', 'utf8')
  const quote = p => "'" + p.replace(/'/g, "''") + "'"
  const exeRoot = path.dirname(process.execPath)
  const candidates = [
    path.join(exeRoot, 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'),
    path.join(DSH_HOME, 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'),
  ]
  const node = candidates.find(p => fs.existsSync(p))
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '# Close DSH before applying this snapshot. This file contains no credentials.',
    node ? `$nodeExe = ${quote(node)}` : "$nodeExe = (Get-Command node -ErrorAction Stop).Source",
    `& $nodeExe (Join-Path $PSScriptRoot 'restore-offline.mjs') --apply $PSScriptRoot`,
    'exit $LASTEXITCODE',
  ].join('\r\n')
  fs.writeFileSync(path.join(stage, 'restore.ps1'), '\uFEFF' + script, 'utf8')
  return 'powershell -NoProfile -File ' + '"' + path.join(stage, 'restore.ps1') + '"'
}

export function apply(ctx) {
  const registered = new Map()
  const getSecrets = () => {
    try { return [loadConfig().token, process.env.DSH_SYNC_TOKEN] } catch { return [] }
  }
  const registration = {
    tools: {
      register(def) {
        const original = def.execute
        const invoke = async (args, exec) => {
          try { return sanitizePayload(await original(args || {}, exec), getSecrets()) }
          catch (err) {
            const safe = new Error(sanitizeError(err, getSecrets()))
            if (isCancellation(err)) { safe.name = 'AbortError'; safe.code = 'ABORT_ERR' }
            throw safe
          }
        }
        const readOnly = def.name === 'dsh_sync_status'
        def.execute = (args, exec) => readOnly ? invoke(args, exec) : operationLock.run(() => invoke(args, exec))
        registered.set(def.name, def)
        ctx.effect(() => ctx.tools.register(def), 'dsh-sync: ' + def.name)
      },
    },
  }
  writeDefaultConfigIfMissing()
  registerStatusTool(registration)
  registerExtrasTool(registration)
  const getRuntime = () => liveRuntime(ctx)
  registerUploadTool(registration, getRuntime)
  registerDownloadTool(registration, getRuntime)
  const getManager = () => { try { return ctx.get?.('pluginManager') || null } catch { return null } }
  const runUpdates = async (args, exec) => {
    const cfg = loadConfig()
    return installConfirmedPluginUpdates({ workDir: activeWorkDir(cfg), dshHome: DSH_HOME, cfg, manager: getManager(),
      planId: args.planId, targets: args.targets, signal: exec?.signal, onProgress: progressReporter(exec) })
  }
  registerPluginUpdatesTool(registration, ctx, runUpdates)

  const panel = createPanelController({
    getState: () => ({ ...getPanelState(), onlineAvailable: Boolean(getRuntime()), pluginUpdateAvailable: Boolean(getManager()?.installBundle) }),
    runPluginUpdates: (args, exec) => operationLock.run(() => runUpdates(args, exec)),
    runUpload: (args, exec) => registered.get('dsh_sync_upload').execute(args, exec),
    runDownload: exec => registered.get('dsh_sync_download').execute({ mode: exec.mode }, exec),
    saveExtra: saveExtraMapping,
    saveBackend,
    removeExtra: removeExtraMapping,
    lock: operationLock, supportsCancellation: true, getSecrets,
  })
  ctx.effect(() => () => panel.dispose(), 'dsh-sync: panel jobs')
  ctx.inject(['connection', 'webServer'], cctx => {
    cctx.effect(() => cctx.webServer.register({
      kind: 'exact', path: API_PATH,
      handler: createHttpHandler(panel, cctx.connection),
    }), 'dsh-sync: authenticated panel API')
  })
  fs.writeFileSync(BOOT_LOG, JSON.stringify({ at: new Date().toISOString(), version: UI_VERSION, results: [...registered.keys()].map(n => n + ': ok'), panelApi: API_PATH }, null, 2), 'utf8')
}

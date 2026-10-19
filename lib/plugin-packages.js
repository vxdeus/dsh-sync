import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { inspectPluginArchive } from './plugin-archive.js'
import { noLinks, safeRelative, inside } from './restore-safety.js'
import { throwIfCancelled } from './transfer-control.js'
import { guidanceMessages, validateUpgradeGuidance } from './upgrade-guidance.js'

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = file => { noLinks(file); return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
const text = (value, max = 1200) => typeof value === 'string' ? value.slice(0, max) : ''
export const PACKAGE_TREE = 'plugin-packages'
export function validateVersion(value) {
  if (typeof value !== 'string' || value.length > 160 || !VERSION.test(value)) throw new Error('插件版本必须为精确 SemVer')
  const pre = VERSION.exec(value)[4]
  if (pre?.split('.').some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === '0')) throw new Error('插件预发布版本无效')
  return value
}
export function validatePortablePlugins(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('插件清单缺失或过大')
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.profile) || !NAME.test(row.name || '')) throw new Error('插件清单名称或 profile 无效')
    validateVersion(row.version)
    const key = row.profile + ':' + row.name
    if (seen.has(key)) throw new Error('插件清单重复')
    seen.add(key)
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error('插件启用状态无效')
    if (row.source === 'archive') {
      if (!/^[a-f0-9]{64}$/.test(row.sha256 || '') || row.archive !== `${PACKAGE_TREE}/${row.sha256}.tgz` || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 64 * 1024 * 1024) throw new Error('插件安装包清单无效')
    } else if (!['npm', 'unavailable'].includes(row.source) && !(row.source === 'bundle' && row.name === 'dsh-sync')) throw new Error('不支持的插件来源：' + row.name)
  }
  return rows
}
function localArchive(root, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return null
  const source = spec.slice(5)
  if (!source || !/\.(?:tgz|tar\.gz)$/i.test(source)) return null
  return path.resolve(root, source)
}
function inspectFile(file) {
  noLinks(file)
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('插件安装包类型或大小无效')
  return inspectPluginArchive(fs.readFileSync(file))
}
// Local archive bytes, never node_modules or a source-machine command, travel with the snapshot.
export function collectPluginSnapshot(dshHome, profiles) {
  const inventory = [], artifacts = new Map()
  for (const profile of profiles) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) throw new Error('profile 无效')
    const root = path.join(dshHome, 'profiles', profile), manifestPath = path.join(root, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
      if (!NAME.test(name)) throw new Error('插件名无效')
      const installed = readJson(path.join(root, 'node_modules', name, 'package.json'))
      if (installed.name !== name) throw new Error('已安装插件名称不匹配：' + name)
      const row = { profile, name, version: validateVersion(installed.version), enabled: (manifest.dsh?.profile?.bundles || []).includes(name), source: 'npm', description: text(installed.description, 500), notes: text(installed.dsh?.sync?.releaseNotes) }
      const archive = localArchive(root, spec)
      if (archive) {
        if (!fs.existsSync(archive)) { row.source = 'unavailable'; row.problem = '源设备的本地安装包已不存在；请重新提供安装包后上传。' }
        else {
          const info = inspectFile(archive)
          if (info.name !== name || info.version !== row.version) throw new Error('本地安装包与已安装插件名称/版本不符：' + name)
          Object.assign(row, { source: 'archive', archive: `${PACKAGE_TREE}/${info.sha256}.tgz`, sha256: info.sha256, bytes: info.bytes })
          artifacts.set(row.archive, { abs: archive, rel: row.archive, sha256: row.sha256, size: row.bytes })
        }
      } else if (typeof spec !== 'string' || /^(?:file:|link:|workspace:|github:|git(?:\+|:)|https?:|npm:)/i.test(spec)) {
        row.source = 'unavailable'; row.problem = '此插件不是可移植的本地压缩包或 npm 来源；请先提供可信安装包。'
      }
      if (!installed.dsh?.bundle?.patch) { row.source = 'unavailable'; row.problem = '普通依赖不是可由插件管理器安装的组合包。' }
      inventory.push(row)
    }
  }
  const referenced = new Set(inventory.filter(row => row.source === 'archive').map(row => row.archive))
  return { inventory: validatePortablePlugins(inventory), artifacts: [...artifacts.values()].filter(row => referenced.has(row.rel)) }
}
// Full offline restores must keep sources/lock/build policy produced on THIS machine.
// Return trusted byte overrides for staging; never rewrite the downloaded snapshot in place.
export function localProfileRestoreOverrides(workDir, dshHome, rows) {
  validatePortablePlugins(rows)
  const overrides = new Map()
  for (const profile of [...new Set(rows.map(row => row.profile))]) {
    const repoPath = `profiles/${profile}/package.json`
    const remoteFile = path.join(workDir, repoPath)
    if (!fs.existsSync(remoteFile)) continue
    const from = readJson(remoteFile), localRoot = path.join(dshHome, 'profiles', profile)
    const localFile = path.join(localRoot, 'package.json')
    if (!fs.existsSync(localFile)) throw new Error('离线全量恢复前，请先确认安装快照所需插件：' + profile)
    const local = readJson(localFile), items = rows.filter(row => row.profile === profile)
    const names = new Set(items.map(row => row.name))
    if (Object.keys(from.dependencies || {}).some(name => !names.has(name))) throw new Error('快照 profile 依赖没有列入升级清单')
    for (const row of items) {
      const installed = localPackage(dshHome, row)
      if (installed.version !== row.version || !Object.hasOwn(local.dependencies || {}, row.name)) throw new Error('离线全量恢复前插件版本尚未就绪；请先确认更新或核对本机较新版本：' + row.name)
    }
    from.dependencies = { ...(local.dependencies || {}) }
    overrides.set(repoPath, Buffer.from(JSON.stringify(from, null, 2) + '\n'))
    for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const rel = `profiles/${profile}/${name}`, file = path.join(localRoot, name)
      noLinks(file)
      if (fs.existsSync(file)) overrides.set(rel, fs.readFileSync(file))
      else if (fs.existsSync(path.join(workDir, rel))) throw new Error('本机缺少安装锁文件或构建策略；拒绝恢复源设备的安装路径/构建授权：' + rel)
    }
  }
  return overrides
}
export function verifySnapshotPackages(workDir, rows) {
  validatePortablePlugins(rows)
  const packages = new Map()
  for (const row of rows.filter(row => row.source === 'archive')) {
    const file = path.resolve(workDir, safeRelative(row.archive))
    if (!inside(workDir, file)) throw new Error('安装包超出快照目录')
    const info = inspectFile(file)
    if (info.sha256 !== row.sha256 || info.bytes !== row.bytes || info.name !== row.name || info.version !== row.version) throw new Error('插件安装包校验失败：' + row.name)
    packages.set(row.archive, file)
  }
  return packages
}
export function cachePluginArchive(workDir, dshHome, row) {
  const packages = verifySnapshotPackages(workDir, [row])
  if (row.source !== 'archive') throw new Error('此条目没有可缓存的安装包')
  const cache = path.join(dshHome, '.dsh-sync-plugin-updates', 'packages', row.sha256 + '.tgz')
  noLinks(cache); fs.mkdirSync(path.dirname(cache), { recursive: true })
  const bytes = fs.readFileSync(packages.get(row.archive))
  if (digest(bytes) !== row.sha256 || bytes.length !== row.bytes) throw new Error('缓存前安装包内容发生变化')
  if (fs.existsSync(cache)) { if (digest(fs.readFileSync(cache)) !== row.sha256) throw new Error('本机安装包缓存哈希不符') }
  else fs.writeFileSync(cache, bytes, { flag: 'wx', mode: 0o600 })
  if (digest(fs.readFileSync(cache)) !== row.sha256) throw new Error('安装前安装包哈希不符')
  return cache
}
export function compareVersions(a, b) {
  validateVersion(a); validateVersion(b)
  const left = VERSION.exec(a), right = VERSION.exec(b)
  for (let i = 1; i <= 3; i++) if (BigInt(left[i]) !== BigInt(right[i])) return BigInt(left[i]) > BigInt(right[i]) ? 1 : -1
  if (left[4] === right[4]) return 0
  if (!left[4]) return 1
  if (!right[4]) return -1
  const aa = left[4].split('.'), bb = right[4].split('.')
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue
    if (aa[i] === undefined) return -1
    if (bb[i] === undefined) return 1
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i])
    if (an && bn) return BigInt(aa[i]) > BigInt(bb[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return aa[i] > bb[i] ? 1 : -1
  }
  return 0
}
export function pluginSourceKey(cfg) {
  const source = cfg.backend === 'sftp' ? ['sftp', cfg.sftp?.host, cfg.sftp?.port || 22, cfg.sftp?.username, cfg.sftp?.remoteRoot, cfg.sftp?.hostKey] : ['gitee', cfg.repoUrl, cfg.branch]
  return digest(JSON.stringify(source))
}
function planPath(home) { return path.join(home, '.dsh-sync-plugin-updates', 'plan.json') }
function localPackage(home, row) {
  const root = path.join(home, 'profiles', row.profile), file = path.join(root, 'node_modules', row.name, 'package.json')
  const manifest = fs.existsSync(path.join(root, 'package.json')) ? readJson(path.join(root, 'package.json')) : {}
  if (!fs.existsSync(file)) return { version: null, spec: manifest.dependencies?.[row.name] || null, enabled: (manifest.dsh?.profile?.bundles || []).includes(row.name) }
  const installed = readJson(file)
  if (installed.name !== row.name) throw new Error('本机插件名称不匹配：' + row.name)
  return { version: validateVersion(installed.version), spec: manifest.dependencies?.[row.name] || null, enabled: (manifest.dsh?.profile?.bundles || []).includes(row.name) }
}
// Detection is read-only with respect to plugins. Merely downloading never installs code.
export function detectPluginUpdates({ workDir, dshHome, cfg, snapshot }) {
  const meta = readJson(path.join(workDir, 'meta.json'))
  const guidance = validateUpgradeGuidance(meta.upgradeGuidance)
  const guidanceNotes = guidanceMessages(guidance)
  if (!meta.pluginInstallManifest) return { planId: null, snapshot, sourceKey: pluginSourceKey(cfg), checkedAt: new Date().toISOString(), offers: [], warnings: ['此快照没有新版插件更新清单；请源设备升级同步插件后重新上传。', ...guidanceNotes] }
  if (meta.pluginInstallManifest.schema !== 1) throw new Error('不支持的插件更新清单格式')
  const rows = validatePortablePlugins(meta.pluginInstallManifest.items)
  verifySnapshotPackages(workDir, rows)
  const offers = [], warnings = [...guidanceNotes]
  const currentProfile = process.env.DSH_PROFILE || 'desktop'
  for (const row of rows) {
    if (!cfg.profiles.includes(row.profile)) { warnings.push('未配置的 profile，未提供更新：' + row.profile); continue }
    const local = localPackage(dshHome, row)
    let kind = !local.version ? 'install' : compareVersions(row.version, local.version) > 0 ? 'upgrade' : compareVersions(row.version, local.version) < 0 ? 'local-newer' : 'same'
    if (kind === 'same') {
      // Reusing a release version for different archive bytes is suspicious, not an automatic upgrade.
      const archive = localArchive(path.join(dshHome, 'profiles', row.profile), local.spec)
      if (row.source === 'archive' && archive && fs.existsSync(archive) && inspectFile(archive).sha256 !== row.sha256) kind = 'repacked'
      else continue
    }
    let canInstall = ['install', 'upgrade'].includes(kind) && ['npm', 'archive'].includes(row.source) && row.profile === currentProfile
    let advice = kind === 'install' ? '本机缺少此插件；确认来源可信后可安装。' : kind === 'upgrade' ? '源设备版本较新，建议查看变更说明并确认升级。' : kind === 'local-newer' ? '本机版本较新，建议保留；不会自动降级。' : '同版本安装包内容不同，建议先核对来源；不会自动替换。'
    if (!['npm', 'archive'].includes(row.source)) { canInstall = false; advice += ' ' + (row.problem || '旧快照没有携带可安装包；请源设备用新版重新上传。') }
    if (row.profile !== currentProfile) advice += ' 只能管理当前 profile，请切换对应应用后处理。'
    if (row.name === 'dsh-sync' && kind === 'upgrade') advice += ' 建议最后更新同步插件，完成后手动重启一次以加载新功能。'
    const id = digest(JSON.stringify([snapshot, row.profile, row.name, local.version, local.spec, row.version, row.sha256 || row.source]))
    offers.push({ id, profile: row.profile, name: row.name, currentVersion: local.version, targetVersion: row.version, currentSpec: local.spec, currentEnabled: local.enabled, kind, canInstall, sourceLabel: row.source === 'archive' ? '已校验的同步安装包' : row.source === 'npm' ? 'npm 精确版本' : '安装来源未就绪', advice, notes: text(row.notes || row.description), row })
  }
  const core = { snapshot, sourceKey: pluginSourceKey(cfg), offers, warnings: [...new Set(warnings)], inventoryHash: digest(JSON.stringify(rows)), guidanceHash: digest(JSON.stringify(guidance)) }
  return { ...core, planId: digest(JSON.stringify(core)), checkedAt: new Date().toISOString() }
}
export function savePluginUpdatePlan(home, plan) {
  const file = planPath(home); noLinks(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + randomUUID() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  fs.renameSync(tmp, file)
}
export function readPluginUpdatePlan(home, cfg) {
  const file = planPath(home)
  if (!fs.existsSync(file)) return null
  const plan = readJson(file)
  if (!plan || plan.sourceKey !== pluginSourceKey(cfg)) return null
  return plan
}
export function pluginUpdateView(plan) {
  if (!plan) return null
  return { planId: plan.planId, snapshot: text(plan.snapshot, 128), checkedAt: plan.checkedAt, warnings: (plan.warnings || []).map(w => text(w)), offers: (plan.offers || []).map(({ id, profile, name, currentVersion, targetVersion, kind, canInstall, sourceLabel, advice, notes }) => ({ id, profile, name, currentVersion, targetVersion, kind, canInstall, sourceLabel, advice, notes })) }
}
export async function installConfirmedPluginUpdates({ workDir, dshHome, cfg, manager, planId, targets, signal, onProgress = () => {} }) {
  throwIfCancelled(signal)
  if (!manager || typeof manager.installBundle !== 'function') throw new Error('当前宿主插件管理器不可用，请升级 DSH；未安装任何插件')
  const saved = readPluginUpdatePlan(dshHome, cfg)
  if (!saved || saved.planId !== planId) throw new Error('升级提醒已变化，请重新下载并确认')
  if (!Array.isArray(targets) || !targets.length || targets.length > 100 || new Set(targets).size !== targets.length || targets.some(id => typeof id !== 'string')) throw new Error('请明确选择要更新的插件')
  const current = detectPluginUpdates({ workDir, dshHome, cfg, snapshot: saved.snapshot })
  if (!current || current.planId !== saved.planId) throw new Error('快照或本机插件已经变化，请重新下载并确认')
  const selected = targets.map(id => current.offers.find(row => row.id === id))
  if (selected.some(offer => !offer?.canInstall)) throw new Error('选择包含不可自动更新的插件，未安装任何插件')
  // Updating this plugin is deliberately last: never unload the code running this operation mid-batch.
  selected.sort((a, b) => Number(a.name === 'dsh-sync') - Number(b.name === 'dsh-sync'))
  const result = { ok: true, copied: 0, backedUp: 0, installed: [], pendingBuilds: [], restartRequired: false, summary: '' }
  const journalFile = path.join(dshHome, '.dsh-sync-plugin-updates', 'attempts', randomUUID() + '.json')
  noLinks(journalFile); fs.mkdirSync(path.dirname(journalFile), { recursive: true })
  const journal = { planId, snapshot: saved.snapshot, targets, startedAt: new Date().toISOString(), status: 'running', steps: [] }
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 })
  const saveJournal = () => {
    const tmp = journalFile + '.' + randomUUID() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(journal, null, 2), { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, journalFile)
  }
  try {
  for (const [index, offer] of selected.entries()) {
    throwIfCancelled(signal)
    const row = offer.row
    const now = localPackage(dshHome, row)
    if (now.version !== offer.currentVersion || now.spec !== offer.currentSpec || now.enabled !== offer.currentEnabled) throw new Error('安装期间插件被其他操作修改，已停止后续更新：' + row.name)
    let spec = row.name + '@' + row.version
    if (row.source === 'archive') spec = cachePluginArchive(workDir, dshHome, row)
    const requestId = 'dsh-sync-' + randomUUID()
    const cancel = () => { Promise.resolve(manager.cancelInstall?.(requestId)).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    let outcome
    const step = { name: row.name, version: row.version, requestId, status: 'installing' }
    journal.steps.push(step); saveJournal()
    try {
      throwIfCancelled(signal)
      onProgress({ phase: 'install', completedFiles: index, totalFiles: selected.length })
      // Never import approvedBuilds, registry overrides, arbitrary commands or version exemptions from the snapshot.
      outcome = await manager.installBundle(spec, { enabled: offer.currentVersion ? offer.currentEnabled : row.enabled !== false, requestId })
    } catch (error) {
      outcome = { application: signal?.aborted ? 'cancelled' : 'failed', error: { diagnostic: text(error?.message || '安装器调用异常') } }
    } finally { signal?.removeEventListener('abort', cancel) }
    step.status = outcome?.application || 'unknown'; step.error = outcome?.error
    if (!outcome || outcome.error || !['applied', 'restart-required'].includes(outcome.application) || (outcome.packageResult && (outcome.packageResult.exitCode !== 0 || outcome.packageResult.timedOut))) {
      result.ok = false
      result.pendingBuilds = Array.isArray(outcome?.pendingBuilds) ? outcome.pendingBuilds.filter(n => typeof n === 'string') : []
      result.summary = '更新未全部完成，已停止后续安装：' + row.name + '。' + text(outcome?.error?.diagnostic || outcome?.error?.code || outcome?.packageResult?.output, 1600)
      if (result.pendingBuilds.length) result.summary += '\n构建脚本需要另行明确授权，未自动批准：' + result.pendingBuilds.join(', ')
      break
    }
    const installed = localPackage(dshHome, row)
    if (installed.version !== row.version) { result.ok = false; result.summary = '安装器返回成功，但实际版本不一致，请检查：' + row.name; break }
    result.installed.push({ name: row.name, version: row.version, application: outcome.application })
    result.restartRequired ||= outcome.application === 'restart-required'
    saveJournal()
    onProgress({ phase: 'install', completedFiles: index + 1, totalFiles: selected.length })
    if (signal?.aborted) break
  }
  } catch (error) {
    result.ok = false
    result.summary = '已停止后续更新；先前成功的项目仍保留：' + text(error?.message || '安装期间发生异常')
  }
  result.copied = result.installed.length
  result.partial = result.installed.length !== selected.length
  if (!result.summary) result.summary = result.partial ? '已停止后续更新，请核对已完成项。' : '所选插件更新完成。'
  result.summary += '\n' + result.installed.map(p => `${p.name}@${p.version}`).join('\n')
  result.summary += result.restartRequired ? '\n需要时请手动退出并重新打开 DSH 一次以加载新代码；本插件不会自动关闭 DSH。' : '\n未自动关闭或重启 DSH。'
  if (signal?.aborted) { result.ok = false; result.summary += '\n收到取消请求；安装成功的项目不会自动卸载回滚。' }
  journal.status = result.ok && !result.partial ? 'completed' : 'partial-or-failed'
  journal.finishedAt = new Date().toISOString(); journal.installed = result.installed
  try { saveJournal() } catch { result.ok = false; result.partial = true; result.summary += '\n结果日志未完整落盘，请保留当前目录核对，勿视为全部成功。' }
  result.summary += '\n安装记录：' + journalFile
  try { savePluginUpdatePlan(dshHome, detectPluginUpdates({ workDir, dshHome, cfg, snapshot: saved.snapshot })) }
  catch {
    result.partial = true
    result.summary += '\n更新提醒无法刷新，请重新下载后再确认；不会重试已经完成的安装。'
    try { savePluginUpdatePlan(dshHome, null) } catch { /* old plan revalidation still rejects changed installed versions */ }
  }
  return result
}

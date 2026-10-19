import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { throwIfCancelled } from './transfer-control.js'
import { PROFILE_FILES, SYNC_TREES, PET_CONFIG, isDenied, isTextFile, splitExtraRel, isValidExtraName, machineLocalStateReason, sensitiveName } from './pathcodec.js'

export const hash = (buf) => createHash('sha256').update(buf).digest('hex')

// DSH attachment objects are immutable, content-addressed bytes. A snapshot
// must never replace an object with different bytes under the same identifier.
function validateAttachmentContent(repoPath, digest) {
  const match = /^attachments\/v1\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/i.exec(repoPath)
  if (!match) return false
  const id = match[2].toLowerCase()
  if (match[1].toLowerCase() !== id.slice(0, 2) || digest !== id) throw new Error('内容寻址附件的路径与内容哈希不符，停止恢复：' + repoPath)
  return true
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/.test(value) || path.posix.isAbsolute(value)) throw new Error('不安全的仓库路径')
  const parts = value.split('/')
  if (parts.some(x => !x || x === '.' || x === '..' || x.endsWith('.') || x.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw new Error('不安全的仓库路径')
  return value
}
export function inside(root, dest) {
  const rel = path.relative(path.resolve(root), path.resolve(dest))
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
}
export function noLinks(target) {
  let cur = path.resolve(target)
  for (;;) {
    try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error('拒绝通过符号链接或 junction 写入：' + cur) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    const parent = path.dirname(cur)
    if (cur === parent) break
    cur = parent
  }
}
export function validateExtraTarget(target, kind, dshHome) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !['file', 'directory'].includes(kind)) throw new Error('请填写绝对路径并选择文件/目录类型')
  const abs = path.resolve(target)
  noLinks(abs)
  if (abs === path.parse(abs).root || abs === os.homedir() || inside(abs, dshHome) || inside(dshHome, abs)) throw new Error('不能把整个用户目录、磁盘或 DSH 状态目录作为自定义项')
  if (/(^|[\\/])(?:\.ssh|\.gnupg|\.aws)(?:[\\/]|$)/i.test(abs) || (kind === 'file' && sensitiveName(path.basename(abs).toLowerCase()))) throw new Error('拒绝同步凭据目录或敏感文件')
  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs)
    if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) throw new Error('路径类型与选择不一致')
  }
  return abs
}
// 放行整棵目录时，凭据类路径段必须在这里兜住；与 sftp-store 的清单保持一致。
const DENY_NAME_SEGMENTS = new Set([
  '.ssh', '.gnupg', '.aws', 'id_rsa', 'id_ed25519', '.git-credentials', '.npmrc',
  '.credentials.yaml', 'dsh-sync.json', 'dsh-sync-auth.json',
])
export function allowedExtra(rel) {
  safeRelative(rel)
  return !isDenied(rel) && !rel.split('/').some(part => DENY_NAME_SEGMENTS.has(part.toLowerCase()) || sensitiveName(part.toLowerCase()))
}
export function allowedDsh(rel, cfg) {
  safeRelative(rel)
  const parts = rel.split('/')
  if (isDenied(rel) || machineLocalStateReason(rel) || /\.bak-|(?:^|\/)\.env(?:\.|$)|\.(?:key|pem|p12|pfx)$/i.test(rel)) return false
  if (parts.some(p => DENY_NAME_SEGMENTS.has(p.toLowerCase()))) return false
  if (parts[0] === 'profiles') return parts.length === 3 && cfg.profiles.includes(parts[1]) && PROFILE_FILES.includes(parts[2])
  if (rel === PET_CONFIG) return true
  if (parts[0] === 'sessions') return parts.length >= 3 && /session\.v\d+\.jsonl(?:\.zstd)?$/.test(parts.at(-1))
  if (parts[0] === 'attachments') return cfg.includeAttachments === true && parts.length > 1
  // preset 目录里除了 agent.cordis.yml / preset.yml，还有它们引用的插件脚本
  // （如 ./restrict.mjs、./delegation-labels.mjs）和无扩展名的生成器标记。
  // 只认 json/yaml 会把 preset 同步成缺脚本的残件，因此整棵子树放行 ——
  // 路径穿越与凭据已由 safeRelative / isDenied / 上面的段名单挡住。
  if (parts[0] === '.agent-presets') return parts.length > 1
  return ['storages', 'state'].includes(parts[0]) && parts.length > 1 && /\.(?:json|jsonl|jsonc|yaml|yml)$/.test(rel)
}

// Downloads are materialized to a separate area. Never apply remote files to a running host.
export async function prepareRestore({ workDir, dshHome, cfg, codec, oid, hostPid = process.pid, signal, onProgress = () => {}, online = false, profileOverrides = null }) {
  throwIfCancelled(signal)
  noLinks(workDir)
  const files = [], unmapped = new Set(), preservedLocal = []
  const metaPath = path.join(workDir, 'meta.json')
  noLinks(metaPath)
  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
  if (![1, 2].includes(meta.schema)) throw new Error('不支持的同步快照格式')
  const verifiedPackages = new Set()
  if (meta.pluginInstallManifest !== undefined) {
    if (meta.pluginInstallManifest?.schema !== 1) throw new Error('不支持的插件更新清单格式')
    const { verifySnapshotPackages } = await import('./plugin-packages.js')
    for (const rel of verifySnapshotPackages(workDir, meta.pluginInstallManifest.items).keys()) verifiedPackages.add(rel)
  }
  const stack = ['']
  while (stack.length) {
    const sub = stack.pop()
    const dir = path.join(workDir, sub)
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      throwIfCancelled(signal)
      if (!sub && entry.name === '.git') continue
      const rel = safeRelative(sub ? sub + '/' + entry.name : entry.name)
      const src = path.join(workDir, rel)
      if (entry.isSymbolicLink()) throw new Error('仓库包含链接，恢复已停止')
      if (entry.isDirectory()) { stack.push(rel); continue }
      if (!entry.isFile()) throw new Error('仓库包含不支持的文件类型')
      if (rel === 'meta.json') continue
      noLinks(src)
      // Packages are transport artifacts, never data/profile restore targets or executable scripts.
      if (rel.startsWith('plugin-packages/')) {
        if (!verifiedPackages.has(rel)) throw new Error('快照包含未在插件清单中声明的安装包：' + rel)
        continue
      }
      // Old snapshots may still contain these two machine-local files. They are
      // not restore targets: never read a target, capture its hash, overwrite it,
      // or relax the conflict check for any real user data.
      const localReason = machineLocalStateReason(rel)
      if (localReason) { preservedLocal.push({ repoPath: rel, reason: localReason }); continue }
      let bytes = await fsp.readFile(src), dest
      const item = splitExtraRel(rel)
      if (item) {
        if (!isValidExtraName(item.name) || !allowedExtra(item.rest)) throw new Error('仓库含敏感或受限自定义文件：' + rel)
        const extra = (cfg.extras || []).find(x => x.name === item.name)
        if (!extra) { unmapped.add(item.name); continue }
        const declared = (meta.extras || []).find(x => x.name === item.name)
        const kind = extra.kind || (fs.existsSync(extra.path) && fs.statSync(extra.path).isFile() ? 'file' : 'directory')
        const root = validateExtraTarget(extra.path, kind, dshHome)
        if (declared?.kind && declared.kind !== kind) throw new Error('自定义项类型不一致：' + item.name)
        dest = kind === 'file' ? root : path.resolve(root, safeRelative(item.rest))
        if (kind === 'file' && item.rest.includes('/')) throw new Error('单文件项却包含多个层级')
        if (kind === 'directory' && !inside(root, dest)) throw new Error('恢复路径超出指定工程')
        // schema 2 extras are byte-preserving; schema 1 was rewritten by the old exporter.
        if (meta.schema === 1 && isTextFile(src)) bytes = Buffer.from(codec.fromPortable(bytes.toString('utf8')), 'utf8')
      } else {
        if (!allowedDsh(rel, cfg)) throw new Error('仓库文件不在恢复白名单内：' + rel)
        const mapped = safeRelative(codec.fromPortable(rel))
        dest = path.resolve(dshHome, mapped)
        if (!inside(dshHome, dest)) throw new Error('恢复路径超出 DSH 目录')
        if (isTextFile(src)) bytes = Buffer.from(codec.fromPortable(bytes.toString('utf8')), 'utf8')
        if (profileOverrides?.has(rel)) {
          if (online || !/^profiles\/[A-Za-z0-9._-]+\/(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(rel)) throw new Error('无效的本机 profile 字节覆盖项')
          bytes = Buffer.from(profileOverrides.get(rel))
        }
      }
      noLinks(dest)
      const sha256 = hash(bytes)
      const immutable = validateAttachmentContent(rel, sha256)
      // Online plans never read mutable Host-owned files as filesystem targets.
      // Sessions use the persistence writer API; runtime config/state is deferred.
      const previousHash = online && !item && !immutable ? null : fs.existsSync(dest) ? hash(await fsp.readFile(dest)) : null
      files.push({ repoPath: rel, destination: dest, sha256, bytes, previousHash })
    }
  }
  const keys = new Set()
  for (const f of files) {
    const key = process.platform === 'win32' ? f.destination.toLowerCase() : f.destination
    if (keys.has(key)) throw new Error('多个仓库文件映射到相同目标')
    keys.add(key)
  }
  // All validation above finishes before any snapshot write.
  throwIfCancelled(signal)
  const stage = path.join(dshHome, 'sync-restores', randomUUID())
  noLinks(stage)
  await fsp.mkdir(path.join(stage, 'files'), { recursive: true })
  let port = 19387
  try { port = Number(new URL(process.env.DSH_WEB_URL || 'http://127.0.0.1:19387').port) || 19387 } catch {}
  const plan = { schema: 1, ...(online ? { mode: 'online' } : {}), oid, createdAt: new Date().toISOString(), machine: os.hostname(), dshHome, hostPid, port, files: [], unmapped: [...unmapped], preservedLocal }
  let completedBytes = 0
  const totalBytes = files.reduce((n, f) => n + f.bytes.length, 0)
  try {
    for (const [index, f] of files.entries()) {
      throwIfCancelled(signal)
      const blob = `files/${index}.bin`
      await fsp.writeFile(path.join(stage, blob), f.bytes, { flag: 'wx' })
      plan.files.push({ source: blob, destination: f.destination, sha256: f.sha256, previousHash: f.previousHash, size: f.bytes.length, repoPath: f.repoPath })
      completedBytes += f.bytes.length
      try {
        const observed = onProgress({ phase: 'restore', completedBytes, totalBytes, completedFiles: plan.files.length, totalFiles: files.length })
        if (observed?.catch) observed.catch(() => {})
      } catch {}
    }
    throwIfCancelled(signal)
    await fsp.writeFile(path.join(stage, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8')
    throwIfCancelled(signal)
    return { stage, files: plan.files.length, overwrites: files.filter(f => f.previousHash !== null).length, unchanged: files.filter(f => f.previousHash !== null && f.previousHash === f.sha256).length, unmapped: [...unmapped], preservedLocal, legacy: meta.schema === 1 }
  } catch (error) {
    // Only remove this newly allocated staging directory, never user targets.
    await fsp.rm(stage, { recursive: true, force: true })
    throw error
  }
}

export async function applyRestore(stage, { assertStopped = true, signal, beforeReplace = () => {}, exclusiveCreate = false } = {}) {
  throwIfCancelled(signal)
  stage = path.resolve(stage)
  noLinks(stage)
  const plan = JSON.parse(await fsp.readFile(path.join(stage, 'plan.json'), 'utf8'))
  if (plan.schema !== 1 || plan.machine !== os.hostname() || !Array.isArray(plan.files)) throw new Error('无效的本机恢复计划')
  if (plan.mode === 'online') throw new Error('在线计划不能作为整机离线覆盖计划执行；请使用在线入口或重新下载离线计划')
  if (assertStopped && plan.hostPid > 0) {
    try { process.kill(plan.hostPid, 0); throw new Error('请先完全退出下载时运行的 DSH，再执行离线恢复') }
    catch (e) { if (e.code !== 'ESRCH') throw e }
  }
  const appliedPath = path.join(stage, 'applied.json')
  const journalPath = path.join(stage, 'journal.json')
  // existsSync follows links and returns false for a dangling junction. Reject
  // marker links before any artifact or target write, not only at final wx.
  noLinks(appliedPath); noLinks(journalPath)
  if (fs.existsSync(appliedPath)) throw new Error('这份恢复计划已经执行过')
  if (fs.existsSync(journalPath)) throw new Error('这份计划已尝试过恢复；请保留日志和备份，核对失败原因后重新下载，不要重复执行旧计划')
  const entries = []
  for (const f of plan.files) {
    const repoPath = safeRelative(f.repoPath)
    const destinationRel = path.relative(plan.dshHome, f.destination).split(path.sep).join('/')
    if (machineLocalStateReason(repoPath) || machineLocalStateReason(destinationRel)) throw new Error('恢复计划仍包含本机保留状态，请用新版重新下载生成计划：' + repoPath)
    const src = path.resolve(stage, safeRelative(f.source))
    if (!inside(stage, src) || !path.isAbsolute(f.destination)) throw new Error('恢复计划路径无效')
    noLinks(src); noLinks(f.destination)
    const buf = await fsp.readFile(src)
    if (hash(buf) !== f.sha256) throw new Error('暂存文件哈希不符，停止恢复')
    const now = fs.existsSync(f.destination) ? hash(await fsp.readFile(f.destination)) : null
    if (now !== f.previousHash) throw new Error('下载后本机文件已发生变化，停止覆盖，请重新下载：' + f.destination)
    const immutableObject = validateAttachmentContent(repoPath, f.sha256)
    if (immutableObject && now !== null && now !== f.sha256) throw new Error('现有内容寻址附件与快照不一致；保留原件，停止覆盖：' + repoPath)
    const unchanged = now !== null && now === f.sha256
    if (!unchanged && now !== null && process.platform === 'win32' && !(fs.statSync(f.destination).mode & 0o200)) throw new Error('目标文件只读且内容不同，未写入任何恢复文件：' + f.destination)
    // Package checks still run even if the manifest itself is unchanged.
    if (/profiles\/[A-Za-z0-9._-]+\/package\.json$/.test(f.repoPath)) {
      const pkg = JSON.parse(buf.toString('utf8'))
      for (const name of Object.keys(pkg.dependencies || {})) {
        if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('插件名无效')
        if (!fs.existsSync(path.join(path.dirname(f.destination), 'node_modules', name, 'package.json'))) throw new Error('请先安装快照需要的插件：' + name + '；尚未写入任何恢复文件')
      }
    }
    entries.push({ ...f, buf, unchanged })
  }
  const backup = path.join(stage, 'backup')
  noLinks(backup)
  // Validate pre-existing artifacts before any write. Never overwrite an old
  // backup, including an otherwise valid backup with the Windows readonly bit.
  for (const [i, f] of entries.entries()) if (!f.unchanged && f.previousHash !== null) {
    const target = path.join(backup, `${i}.bin`)
    noLinks(target)
    if (fs.existsSync(target) && hash(await fsp.readFile(target)) !== f.previousHash) throw new Error('已有备份哈希不符；保留备份，停止恢复：' + target)
  }
  const journal = {
    startedAt: new Date().toISOString(), phase: 'backing-up', applied: [], unchanged: [],
    rolledBack: [], rollbackSkipped: [], rollbackErrors: [], journalErrors: [], tempCleanupErrors: [], error: null,
  }
  const log = async () => { noLinks(journalPath); await fsp.writeFile(journalPath, JSON.stringify(journal, null, 2), 'utf8') }
  // Exclusive journal creation also prevents two invocations using one plan.
  noLinks(journalPath)
  await fsp.writeFile(journalPath, JSON.stringify(journal, null, 2), { encoding: 'utf8', flag: 'wx' })
  try {
    await fsp.mkdir(backup, { recursive: true })
    // Every file we will overwrite must have a verified preimage before the
    // first target write. Identical files are not overwritten and need no copy.
    for (const [i, f] of entries.entries()) if (!f.unchanged && f.previousHash !== null) {
      const target = path.join(backup, `${i}.bin`)
      noLinks(f.destination); noLinks(target)
      if (hash(await fsp.readFile(f.destination)) !== f.previousHash) throw new Error('备份时检测到并发修改，已停止：' + f.destination)
      if (!fs.existsSync(target)) await fsp.copyFile(f.destination, target, fs.constants.COPYFILE_EXCL)
      if (hash(await fsp.readFile(target)) !== f.previousHash) throw new Error('备份哈希不符，尚未写入恢复目标：' + target)
    }
    journal.phase = 'applying'; await log()
    for (const [i, f] of entries.entries()) {
      throwIfCancelled(signal)
      noLinks(f.destination)
      const now = fs.existsSync(f.destination) ? hash(await fsp.readFile(f.destination)) : null
      if (now !== f.previousHash) throw new Error('恢复时检测到并发修改，已停止')
      if (f.unchanged) { journal.unchanged.push(i); continue }
      await fsp.mkdir(path.dirname(f.destination), { recursive: true })
      const tmp = f.destination + '.sync-' + randomUUID() + '.tmp'
      let replacementError
      try {
        await fsp.writeFile(tmp, f.buf, { flag: 'wx' })
        // Recheck after asynchronous staging, not only before it. The online
        // caller supplies a synchronous workspace guard; no awaited user hook.
        throwIfCancelled(signal)
        beforeReplace(f)
        noLinks(f.destination)
        const latest = fs.existsSync(f.destination) ? hash(fs.readFileSync(f.destination)) : null
        if (latest !== f.previousHash) throw new Error('写入前检测到并发修改，已停止')
        if (exclusiveCreate && f.previousHash === null) {
          // Publish a new file without ever replacing a concurrently created one.
          await fsp.link(tmp, f.destination)
        } else {
          await fsp.rename(tmp, f.destination)
        }
        // Track a successful replacement before cleanup/logging can fail.
        journal.applied.push(i)
      } catch (e) { replacementError = e; throw e }
      finally {
        if (fs.existsSync(tmp)) {
          try { await fsp.unlink(tmp) }
          catch (e) {
            journal.tempCleanupErrors.push({ index: i, path: tmp, message: e?.message || String(e) })
            if (!replacementError) throw e
          }
        }
      }
      await log()
    }
    journal.phase = 'applied'; journal.finishedAt = new Date().toISOString(); await log()
    const result = { files: entries.length, changed: journal.applied.length, unchanged: journal.unchanged.length, backedUp: entries.filter(f => !f.unchanged && f.previousHash !== null).length, backup }
    await fsp.writeFile(path.join(stage, 'applied.json'), JSON.stringify({ finishedAt: journal.finishedAt, ...result }), { encoding: 'utf8', flag: 'wx' })
    return result
  } catch (error) {
    journal.error = error?.message || String(error)
    journal.failedPhase = journal.phase
    journal.phase = 'rolling-back'
    // Record the original failure before rollback, but a log failure must not
    // prevent restoring other files. Keep backups and report every failure.
    const tryLog = async () => { try { await log() } catch (e) { journal.journalErrors.push(e?.message || String(e)) } }
    await tryLog()
    for (const i of [...journal.applied].reverse()) {
      const f = entries[i]
      try {
        noLinks(f.destination)
        if (!fs.existsSync(f.destination) || hash(await fsp.readFile(f.destination)) !== f.sha256) { journal.rollbackSkipped.push(i); continue }
        if (f.previousHash !== null) {
          const original = path.join(backup, `${i}.bin`)
          noLinks(original)
          if (hash(await fsp.readFile(original)) !== f.previousHash) throw new Error('回滚备份哈希不符：' + original)
          await fsp.copyFile(original, f.destination)
          if (hash(await fsp.readFile(f.destination)) !== f.previousHash) throw new Error('回滚后校验不符：' + f.destination)
        } else {
          await fsp.unlink(f.destination)
        }
        journal.rolledBack.push(i)
      } catch (e) {
        journal.rollbackErrors.push({ index: i, message: e?.message || String(e) })
      }
    }
    journal.phase = journal.rollbackErrors.length || journal.rollbackSkipped.length ? 'rollback-incomplete' : 'rolled-back'
    journal.finishedAt = new Date().toISOString()
    await tryLog()
    const status = journal.phase === 'rolled-back' ? `已回滚 ${journal.rolledBack.length} 项` : '回滚未完整完成，必须检查日志和备份'
    const logWarning = journal.journalErrors.length ? '；另有日志写入失败，请保留现场' : ''
    const cleanupWarning = journal.tempCleanupErrors.length ? '；另有临时文件未清理，请保留现场' : ''
    throw new Error(`${journal.error}；${status}${logWarning}${cleanupWarning}。不要重复执行这份计划。`, { cause: error })
  }
}

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { applyRestore, allowedDsh, allowedExtra, hash, inside, noLinks, safeRelative, validateExtraTarget } from './restore-safety.js'
import { splitExtraRel } from './pathcodec.js'
import { decodeSession, loadSessionCatalog } from './live-session.js'
import { throwIfCancelled, isCancellation } from './transfer-control.js'

const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const objectPath = /^attachments\/v1\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/
const sessionPath = /^sessions\/.+\/session\.v\d+\.jsonl(?:\.zstd)?$/
const databasePath = /\.(?:db|db3|sqlite|sqlite3|mdb|accdb)(?:-(?:wal|shm|journal))?$|-(?:wal|shm|journal)$/i
const sqliteMagic = Buffer.from('SQLite format 3\0')
function localSqlite(destination) {
  let fd
  try {
    noLinks(destination)
    fd = fs.openSync(destination, 'r')
    const header = Buffer.alloc(16)
    return fs.readSync(fd, header, 0, 16, 0) === 16 && header.equals(sqliteMagic)
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

// Only public, inspected Host services. No cold session is activated, no live
// session is replaced, and no loader/config/storage cache is edited behind it.
export function liveRuntime(ctx) {
  const get = key => { try { return ctx.get?.(key) } catch { return undefined } }
  const sessions = get('sessions'), persistence = get('sessionPersistence')
  const query = get('sessionQuery'), workspaces = get('workspaceRegistry'), agents = get('agents')
  if (!sessions?.get || !sessions?.prepare || !sessions?.list || !persistence?.open || !persistence?.create || !persistence?.stat || !query?.readSession) return null
  return {
    sessions, persistence, query, workspaces,
    catalog: loadSessionCatalog,
    // An open durable turn may be executing filesystem tools. Check this again
    // just before each replacement; idle loaded sessions still protect their log.
    busyPaths() {
      if (agents?.list) return agents.list().filter(agent => agent.status === 'running').map(agent => agent.session.header.cwd).filter(p => typeof p === 'string' && path.isAbsolute(p))
      return sessions.list().filter(session => {
        for (let n = session.seq - 1; n >= 0; n--) {
          const type = session.eventAt(n)?.type
          if (type === 'turn/end') return false
          if (type === 'turn/start') return true
        }
        return false
      }).map(session => session.header.cwd).filter(p => typeof p === 'string' && path.isAbsolute(p))
    },
  }
}

function expectedDestination(rel, { cfg, codec, dshHome }) {
  const extra = splitExtraRel(rel)
  if (extra) {
    if (!allowedExtra(extra.rest)) throw new Error('拒绝敏感自定义文件：' + rel)
    const mapping = (cfg.extras || []).find(item => item.name === extra.name)
    if (!mapping) throw new Error('在线恢复映射已变化，请重新下载：' + extra.name)
    const kind = mapping.kind || (fs.existsSync(mapping.path) && fs.statSync(mapping.path).isFile() ? 'file' : 'directory')
    const root = validateExtraTarget(mapping.path, kind, dshHome)
    if (kind === 'file' && extra.rest.includes('/')) throw new Error('单文件映射包含子目录')
    const destination = kind === 'file' ? root : path.resolve(root, safeRelative(extra.rest))
    if (!inside(root, destination)) throw new Error('在线恢复路径超出工程')
    return destination
  }
  if (!allowedDsh(rel, cfg)) throw new Error('在线计划包含受限文件：' + rel)
  const destination = path.resolve(dshHome, safeRelative(codec.fromPortable(rel)))
  if (!inside(dshHome, destination)) throw new Error('在线计划路径超出 DSH')
  return destination
}

function relation(local, remote) {
  if (!isDeepStrictEqual(local.header, remote.header) || local.inheritedEventCount !== remote.inheritedEventCount) return 'conflict'
  const common = Math.min(local.events.length, remote.events.length)
  for (let n = 0; n < common; n++) if (!isDeepStrictEqual(local.events[n], remote.events[n])) return 'conflict'
  return local.events.length === remote.events.length ? 'same' : local.events.length > remote.events.length ? 'local-newer' : 'append'
}
function liveSnapshot(session) {
  return { header: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
}
function reportProgress(callback, value) {
  try { const p = callback(value); if (p?.catch) p.catch(() => {}) } catch {}
}

export async function applyLiveRestore(stage, { dshHome, cfg, codec, runtime, signal, onProgress = () => {} }) {
  if (!runtime) throw new Error('宿主缺少在线会话接口，请选择离线恢复；不会退回直接覆盖')
  throwIfCancelled(signal)
  stage = path.resolve(stage)
  if (!inside(path.join(dshHome, 'sync-restores'), stage)) throw new Error('在线暂存位置无效')
  noLinks(stage)
  const planFile = path.join(stage, 'plan.json'); noLinks(planFile)
  const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'))
  if (plan.schema !== 1 || plan.mode !== 'online' || plan.machine !== os.hostname() || !samePath(plan.dshHome, dshHome) || !Array.isArray(plan.files)) throw new Error('无效的本机在线计划')
  const catalog = await runtime.catalog()
  const deferred = [], candidates = [], fileEntries = [], kept = []
  const defer = (entry, reason) => deferred.push({ repoPath: entry.repoPath, reason })
  const ids = new Set(), destinations = new Set()
  const busy = destination => (runtime.busyPaths?.() || []).some(root => inside(root, destination))
  // Fully validate staging and destinations before the first user-data write.
  for (const entry of plan.files) {
    throwIfCancelled(signal)
    const rel = safeRelative(entry.repoPath), sourceRel = safeRelative(entry.source)
    if (!/^files\/\d+\.bin$/.test(sourceRel)) throw new Error('在线暂存来源无效')
    const destination = expectedDestination(rel, { cfg, codec, dshHome })
    if (typeof entry.destination !== 'string' || !samePath(entry.destination, destination)) throw new Error('在线计划目标被修改，停止恢复')
    const key = process.platform === 'win32' ? destination.toLowerCase() : destination
    if (destinations.has(key)) throw new Error('在线计划有重复目标')
    destinations.add(key)
    const src = path.join(stage, sourceRel); noLinks(src); noLinks(destination)
    const bytes = await fsp.readFile(src)
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error('在线暂存文件哈希或大小不符')
    if (sessionPath.test(rel)) {
      let log
      try { log = await decodeSession(bytes, { compressed: rel.endsWith('.zstd'), codec, catalog }) }
      catch { defer(entry, '会话格式不兼容或日志不完整，未导入；请保留暂存并核对源机快照'); continue }
      if (ids.has(log.header.id)) throw new Error('快照包含重复会话 ID，停止在线恢复')
      ids.add(log.header.id)
      const live = runtime.sessions.get(log.header.id)
      if (live) {
        const kind = relation(liveSnapshot(live), log)
        if (kind === 'same' || kind === 'local-newer') kept.push({ repoPath: rel, reason: kind })
        else defer(entry, '会话已加载，保留当前会话；不会中断或覆盖')
        continue
      }
      try {
        runtime.sessions.prepare(log.header.id, { seed: log.events, meta: log.header, inheritedEventCount: log.inheritedEventCount, eventState: 'detached' })
      } catch { defer(entry, '宿主无法完整回放该会话，未写入'); continue }
      candidates.push({ entry, log })
    } else if (splitExtraRel(rel) || objectPath.test(rel)) {
      const match = objectPath.exec(rel)
      if (match && (entry.sha256 !== match[2] || match[1] !== match[2].slice(0, 2))) throw new Error('附件路径与内容哈希不符')
      if (splitExtraRel(rel) && (databasePath.test(destination) || databasePath.test(rel) || bytes.subarray(0, 16).equals(sqliteMagic) || localSqlite(destination))) { defer(entry, '数据库或其事务文件不在线覆盖；请停止相关程序后使用离线恢复'); continue }
      if (splitExtraRel(rel) && busy(destination)) { defer(entry, '工程正在执行会话任务，完成任务后重新同步'); continue }
      fileEntries.push(entry)
    } else {
      // No target reads, config reload, plugin install or arbitrary script execution.
      defer(entry, '运行时配置、预设或状态不支持安全在线替换，已保留本机原件')
    }
  }
  for (const name of plan.unmapped || []) deferred.push({ repoPath: 'extras/' + name, reason: '尚未配置本机映射' })
  throwIfCancelled(signal)
  const journalFile = path.join(stage, 'online-result.json'); noLinks(journalFile)
  const journal = { schema: 1, phase: 'applying', startedAt: new Date().toISOString(), files: null, sessions: [], deferred, kept, warnings: [], error: null }
  // Exclusive claim: neither successful nor partially applied plans may replay.
  await fsp.writeFile(journalFile, JSON.stringify(journal, null, 2), { encoding: 'utf8', flag: 'wx' })
  const save = async () => { noLinks(journalFile); await fsp.writeFile(journalFile, JSON.stringify(journal, null, 2), 'utf8') }
  let completed = 0, fileStarted = false
  const attempted = new Set()
  const total = fileEntries.length + candidates.length
  try {
    reportProgress(onProgress, { phase: 'apply', completedFiles: 0, totalFiles: total })
    if (fileEntries.length) {
      const fileStage = path.join(stage, 'online-files'); noLinks(fileStage)
      noLinks(path.join(fileStage, 'files'))
      await fsp.mkdir(path.join(fileStage, 'files'), { recursive: true })
      const subset = []
      for (const [n, entry] of fileEntries.entries()) {
        throwIfCancelled(signal)
        const source = `files/${n}.bin`
        noLinks(path.join(stage, entry.source)); noLinks(path.join(fileStage, source))
        await fsp.copyFile(path.join(stage, entry.source), path.join(fileStage, source), fs.constants.COPYFILE_EXCL)
        subset.push({ ...entry, source })
      }
      const { mode: _, ...basePlan } = plan
      noLinks(path.join(fileStage, 'plan.json'))
      await fsp.writeFile(path.join(fileStage, 'plan.json'), JSON.stringify({ ...basePlan, files: subset }), { flag: 'wx' })
      fileStarted = true
      journal.files = await applyRestore(fileStage, {
        assertStopped: false, exclusiveCreate: true, signal,
        beforeReplace(entry) {
          if (splitExtraRel(entry.repoPath) && busy(entry.destination)) throw new Error('工程开始执行新任务，停止在线覆盖')
        },
      })
      completed += fileEntries.length
      await save()
    }
    // Files are durable first, so imported history never precedes its attachments.
    // Sessions commit independently through exclusive append-only writer handles;
    // already committed prefixes are never rolled back by deleting session files.
    for (const { entry, log } of candidates) {
      throwIfCancelled(signal)
      attempted.add(entry.repoPath)
      const id = log.header.id
      if (runtime.sessions.get(id)) { defer(entry, '会话在同步期间被加载，已跳过'); continue }
      let handle, operation
      const exists = await runtime.persistence.stat(id, { signal })
      try {
        handle = exists ? await runtime.persistence.open(id, 'write', { signal }) : await runtime.persistence.create(log.header, { inheritedEventCount: log.inheritedEventCount, signal })
      } catch (error) {
        if (isCancellation(error)) throw error
        // A concurrent creator/owner can win this race; never fall back to fs writes.
        if (['SessionAlreadyOwnedError', 'SessionAlreadyExistsError'].includes(error?.name)) { defer(entry, '会话写入权已被占用，请稍后再同步'); continue }
        throw error
      }
      try {
        if (runtime.sessions.get(id)) { defer(entry, '会话在获取写入权后被加载，已跳过'); continue }
        const local = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events }
        const kind = relation(local, log)
        if (kind === 'conflict') { defer(entry, '两机历史已分叉或会话头不一致，保留两份，不自动合并'); continue }
        if (kind === 'same' || kind === 'local-newer') {
          if (exists) kept.push({ repoPath: entry.repoPath, reason: kind })
          else {
            // Header-only creation is a real persisted change, not an unchanged log.
            operation = { repoPath: entry.repoPath, id, kind: 'create', beforeEvents: 0, afterEvents: 0, status: 'writing' }
            journal.sessions.push(operation)
            await save()
            await handle.flush()
            operation.status = 'applied'
          }
        } else {
          throwIfCancelled(signal)
          operation = { repoPath: entry.repoPath, id, kind: exists ? 'append' : 'create', beforeEvents: local.events.length, afterEvents: log.events.length, status: 'writing' }
          journal.sessions.push(operation)
          await save()
          // Once this one append begins, finish flush+close even if cancellation
          // arrives. The next session honours cancellation; reports stay truthful.
          await handle.append(log.events.slice(local.events.length))
          await handle.flush()
          operation.status = 'applied'
        }
      } finally { await handle.close() }
      // Keep workspace accounting coherent using the public registry, never
      // overwrite its JSON state or fabricate session/created notifications.
      if (runtime.workspaces && log.header.cwd) {
        try {
          noLinks(log.header.cwd)
          if (fs.statSync(log.header.cwd).isDirectory()) {
            const workspace = await runtime.workspaces.resolveByPath(log.header.cwd) || await runtime.workspaces.create(log.header.cwd)
            await workspace.attachSession(id)
          }
        } catch { journal.warnings.push('会话已保存，但工作区路径不可用或关联失败：' + id) }
      }
      completed++
      await save()
      reportProgress(onProgress, { phase: 'apply', completedFiles: completed, totalFiles: total })
    }
    journal.phase = deferred.length || journal.warnings.length ? 'partial' : 'applied'
  } catch (error) {
    journal.phase = 'failed'
    journal.error = isCancellation(error) ? '已取消后续应用；已提交的会话/文件不会被撤销' : '在线应用中断，请保留暂存、日志和备份并核对；已提交项不会自动撤销'
    // Do not include raw error payloads: a malformed remote event may contain secrets.
    journal.warnings.push('文件事务若失败请检查 online-files/journal.json 的回滚状态')
  }
  journal.notAttempted = candidates.filter(({ entry }) => !attempted.has(entry.repoPath)).map(({ entry }) => entry.repoPath)
  if (!fileStarted) journal.notAttempted.push(...fileEntries.map(entry => entry.repoPath))
  const settled = new Set([...journal.sessions.filter(row => row.status === 'applied'), ...deferred, ...kept].map(row => row.repoPath))
  journal.uncertain = [...attempted].filter(rel => !settled.has(rel))
  if (fileStarted && !journal.files) journal.uncertain.push(...fileEntries.map(entry => entry.repoPath))
  journal.finishedAt = new Date().toISOString()
  try { await save() } catch { throw new Error('在线结果日志保存失败；可能已有部分内容生效，请保留暂存目录核对：' + stage) }
  const imported = journal.sessions.filter(row => row.status === 'applied').length
  const changed = journal.files?.changed || 0
  const pending = deferred.length + journal.notAttempted.length + journal.uncertain.length
  const summary = [
    journal.phase === 'failed' ? journal.error : pending || journal.warnings.length ? '在线同步部分完成，未应用项已明确保留。' : '在线同步完成，无需关闭或重启 DSH。',
    `文件写入 ${changed} 个；会话导入/追加 ${imported} 个；保留已有/较新历史 ${kept.length} 个；未应用 ${pending} 项。`,
    '已加载会话不会覆盖；运行时配置、插件安装、预设和状态不会在线替换。',
    `暂存与结果记录：${stage}`,
    journal.files?.backup ? `文件备份：${journal.files.backup}` : '',
    ...deferred.slice(0, 20).map(row => `· ${row.repoPath}：${row.reason}`),
    pending > 20 ? `其余 ${pending - 20} 项见 online-result.json。` : '',
    ...journal.warnings,
    journal.notAttempted.length ? `尚未尝试 ${journal.notAttempted.length} 项，详见结果日志。` : '',
    journal.uncertain.length ? `写入/回滚结果需核对 ${journal.uncertain.length} 项，不能视为未写入或成功；请检查结果日志及文件事务日志。` : '',
    '会话列表若未更新，刷新当前页面即可；不要用旧离线计划覆盖在线结果。',
  ].filter(Boolean).join('\n')
  return { ok: journal.phase !== 'failed', partial: journal.phase !== 'applied', copied: changed + imported, backedUp: journal.files?.backedUp || 0, deferred: pending, summary }
}

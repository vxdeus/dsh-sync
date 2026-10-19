import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { inside, noLinks } from './restore-safety.js'

// This machine-local fence lives OUTSIDE either mutable download/upload worktree.
// A dry-run, crash, plugin reload or backend switch must not erase unapplied data
// protection after download has advanced the remote compare-and-swap baseline.
export function readPending(file, dshHome) {
  noLinks(file)
  if (!fs.existsSync(file)) return null
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (value.schema !== 1 || typeof value.pending !== 'boolean') throw new Error('同步应用状态异常，已阻止上传；请保留状态文件核对')
  if (!value.pending) return null
  if (value.mode === 'offline' && typeof value.stage === 'string' && inside(path.join(dshHome, 'sync-restores'), value.stage)) {
    try {
      const planPath = path.join(value.stage, 'plan.json'), donePath = path.join(value.stage, 'applied.json'), journalPath = path.join(value.stage, 'journal.json')
      noLinks(planPath); noLinks(donePath); noLinks(journalPath)
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
      const done = JSON.parse(fs.readFileSync(donePath, 'utf8'))
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      if (plan.schema === 1 && plan.mode !== 'online' && plan.oid === value.oid && plan.dshHome === dshHome && done.finishedAt && journal.phase === 'applied' && done.files === plan.files.length && !(plan.unmapped || []).length) return null
    } catch { /* Missing/incomplete recovery is NOT permission to replace remote data. */ }
  }
  return value
}
export function writePending(file, value) {
  noLinks(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), ...value }, null, 2), { flag: 'wx', encoding: 'utf8' })
  fs.renameSync(temporary, file)
}
export function assertUploadAllowed(file, dshHome, args) {
  const pending = readPending(file, dshHome)
  if (pending && args.dryRun !== true && args.allowUnapplied !== true) throw new Error('上次下载仍有未应用或未确认内容，已阻止用本机快照覆盖远端。请先完成恢复；若确要以本机为准，核对未应用项后明确勾选“允许替换未应用内容”。')
  return pending
}

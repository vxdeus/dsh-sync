import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { noLinks } from './restore-safety.js'

const ACTIONS = new Set(['review-plugin-updates', 'confirm-selected-updates', 'restart-manually-if-required', 'sign-in-locally', 'review-unmapped-projects', 'review-settings'])
export function validateUpgradeGuidance(value) {
  if (value === undefined || value === null) return null
  if (value.schema !== 1 || typeof value.title !== 'string' || value.title.length > 300 || !Array.isArray(value.notes) || value.notes.length > 30) throw new Error('升级交接建议格式无效')
  const seen = new Set()
  const notes = value.notes.map(note => {
    if (!note || typeof note.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(note.id) || seen.has(note.id) || typeof note.title !== 'string' || note.title.length > 300 || typeof note.body !== 'string' || note.body.length > 5000 || !Array.isArray(note.actions) || note.actions.length > 8 || note.actions.some(action => !ACTIONS.has(action))) throw new Error('升级建议含未知操作或无效字段；不会执行任何建议')
    seen.add(note.id)
    // No command, shell, URL, registry, credentials or arbitrary script field is retained.
    return { id: note.id, title: note.title, body: note.body, actions: [...new Set(note.actions)] }
  })
  return { schema: 1, title: value.title, producerVersion: typeof value.producerVersion === 'string' ? value.producerVersion.slice(0, 160) : '', notes }
}
export function buildUpgradeGuidance(dshHome) {
  const builtin = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./upgrade-guidance.json', import.meta.url)), 'utf8'))
  const local = path.join(dshHome, 'dsh-sync-handoff.json')
  noLinks(local)
  if (!fs.existsSync(local)) return validateUpgradeGuidance(builtin)
  if (fs.statSync(local).size > 200000) throw new Error('本机升级交接建议过大，请精简后上传')
  const custom = validateUpgradeGuidance(JSON.parse(fs.readFileSync(local, 'utf8').replace(/^\uFEFF/, '')))
  return validateUpgradeGuidance({ ...builtin, notes: [...builtin.notes, ...custom.notes] })
}
export function guidanceMessages(value) {
  const guidance = validateUpgradeGuidance(value)
  return guidance ? [guidance.title + '（只作为待确认建议，不是命令或授权）', ...guidance.notes.map(note => `${note.title}：${note.body}`)] : []
}

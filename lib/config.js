import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isValidExtraName } from './pathcodec.js'
import { validateSftpConfig } from './sftp-store.js'

export const DEFAULT_CONFIG = Object.freeze({
  backend: 'gitee', sftp: null, repoUrl: '', branch: 'dsh-sync', username: '', token: '',
  privateRepoConfirmed: false, profiles: ['desktop'], includeAttachments: true,
  maxExtraBytes: 200 * 1024 * 1024, extras: [],
})

export function validateConfig(parsed = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('同步配置必须是 JSON 对象')
  const cfg = { ...DEFAULT_CONFIG, ...parsed,
    profiles: parsed.profiles ?? [...DEFAULT_CONFIG.profiles], extras: parsed.extras ?? [] }
  if (!['gitee', 'sftp'].includes(cfg.backend)) throw new Error('不支持的存储后端')
  if (typeof cfg.repoUrl !== 'string' || typeof cfg.username !== 'string' || typeof cfg.token !== 'string') throw new Error('仓库、账号和令牌必须为字符串')
  if (cfg.repoUrl) {
    let url
    try { url = new URL(cfg.repoUrl) } catch { throw new Error('仓库必须是无内嵌凭据的 HTTPS URL') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('仓库必须是无内嵌凭据的 HTTPS URL')
    // Public software distribution must never become the destination for private snapshots.
    if (url.hostname.toLowerCase() === 'github.com' && url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase() === '/vxdeus/dsh-sync') throw new Error('这是公开插件发布仓库，不能用来同步个人数据；请另建私有数据仓库')
  }
  if (typeof cfg.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(cfg.branch) || cfg.branch.includes('..') || cfg.branch.startsWith('/') || cfg.branch.endsWith('/')) throw new Error('分支名无效')
  if (!Array.isArray(cfg.profiles) || !cfg.profiles.length || cfg.profiles.some(p => !isValidExtraName(p))) throw new Error('profile 配置无效')
  if (!Array.isArray(cfg.extras)) throw new Error('extras 配置必须为数组')
  if (typeof cfg.includeAttachments !== 'boolean' || !Number.isSafeInteger(cfg.maxExtraBytes) || cfg.maxExtraBytes <= 0) throw new Error('同步范围或大小限制无效')
  if (typeof cfg.privateRepoConfirmed !== 'boolean') throw new Error('privateRepoConfirmed 必须是布尔值')
  if (cfg.backend === 'sftp') validateSftpConfig(cfg.sftp)
  return cfg
}

export function readConfig(file) {
  return validateConfig(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {})
}
export function configured(cfg, envToken = '') {
  if (cfg.backend === 'sftp') {
    try { return fs.existsSync(validateSftpConfig(cfg.sftp).privateKeyPath) } catch { return false }
  }
  return Boolean(cfg.repoUrl && cfg.username && cfg.privateRepoConfirmed === true && (cfg.token || envToken))
}
export function assertRemoteConfigured(cfg, envToken = '') {
  if (cfg.backend === 'gitee' && cfg.privateRepoConfirmed !== true) throw new Error('请先确认数据仓库为私有仓库，并在本机配置设置 privateRepoConfirmed: true；不会自动检测或更改仓库可见性')
  if (!configured(cfg, envToken)) throw new Error('请先在本机 dsh-sync.json 配置自己的私有仓库及凭据，或配置自己的 SFTP；未连接远端')
}
export function gitWorkDir(home, cfg) {
  const identity = [cfg.repoUrl ? new URL(cfg.repoUrl).href : 'unconfigured', cfg.branch, cfg.username]
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)
  return path.join(home, '.dsh-sync-git', id)
}

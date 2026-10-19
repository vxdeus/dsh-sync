/**
 * dsh-sync / pure.js —— 与 DSH 运行时无关的纯逻辑，可独立单测。
 *
 * 这里只依赖 node 内置模块，不 import 任何 @deepseek-ai/* 或第三方包，
 * 所以可以直接用 node 跑测试（见 test/pure-test.mjs）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 同步树根（相对 DSH_HOME）。 */
export const SYNC_TREES = ['sessions', 'storages', 'state', '.agent-presets']
export const ATTACHMENT_TREE = 'attachments'
export const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
export const PET_CONFIG = 'dsh-pet/main-config.jsonc'

/** 自定义同步项在仓库里的前缀。 */
export const EXTRA_PREFIX = 'extras'

/** 永远不进入同步包的目录名 / 文件名（硬护栏）。 */
export const DENY_DIRS = new Set([
  'node_modules', '.git', 'cache', 'dsh-runtimes', 'electron',
  'integrations', 'im', '.dsh-sync-repo', '.plugin-manager', '.dsh-market', 'logs',
])
export const DENY_FILES = new Set([
  '.credentials.yaml', 'dsh-sync.json', 'dsh-sync-auth.json', '.anonymous-user-id',
])

/** 精确限定的本机状态：保留目标机原件，不跨机覆盖；真实账本及搜索用量日志不在此表。 */
export const MACHINE_LOCAL_STATE = Object.freeze({
  'storages/cost-meter/ledger.json.native-search-coverage.json': '本机进程诊断和按日搜索覆盖告警（不是费用账本）',
  'state/codex-subscription/quota-forecast.json': '本机账户额度的短期预测采样缓存',
})
export function machineLocalStateReason(rel) {
  const key = String(rel).replaceAll('\\', '/').toLowerCase()
  return Object.hasOwn(MACHINE_LOCAL_STATE, key) ? MACHINE_LOCAL_STATE[key] : null
}

/** 自定义同步项的默认排除（依赖 / 构建产物 / 版本库元数据）。 */
export const DEFAULT_EXTRA_EXCLUDE = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '__pycache__', '.venv', 'venv', 'env', 'target', '.pytest_cache', '.mypy_cache',
  '.cache', 'coverage', '.turbo', '.parcel-cache', '.DS_Store',
]

/** 只对这些扩展名做占位符改写；其余按二进制原样拷贝。 */
export const TEXT_EXT = new Set(['.json', '.jsonc', '.jsonl', '.yml', '.yaml', '.md', '.txt'])

export const PH_RAW = '__DSHHOME__'
export const PH_ESC = '__DSHHOME_ESC__'
export const PH_ENC = '__DSHHOME_ENC__'

/**
 * 复刻 DSH 的会话目录名编码：
 *   C:\Users\synthetic-source\Documents\x  ->  C-Users-synthetic-source-Documents-x
 *   D:\synthetic\示例                   ->  D-synthetic-~793A~4F8B
 */
export function encodeHome(p) {
  return p
    .replace(/^([A-Za-z]):\\/, '$1-')
    .replace(/\\/g, '-')
    .replace(/[^\x20-\x7E]/g, (ch) => '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
}

/** 按本机 home 造一对双向改写函数。 */
export function createCodec(userHome) {
  const raw = userHome
  const esc = userHome.replace(/\\/g, '\\\\')
  const enc = encodeHome(userHome)

  const toPortable = (text) =>
    text.split(esc).join(PH_ESC).split(raw).join(PH_RAW).split(enc).join(PH_ENC)

  const fromPortable = (text) =>
    text.split(PH_ESC).join(esc).split(PH_RAW).join(raw).split(PH_ENC).join(enc)

  return { raw, esc, enc, toPortable, fromPortable }
}

export function isTextFile(p) {
  return TEXT_EXT.has(path.extname(p).toLowerCase())
}

/** 判断 DSH_HOME 内的相对路径是否被护栏挡下。 */
export function isDenied(rel) {
  const parts = String(rel).toLowerCase().split(/[\\/]/)
  if (parts.some((p) => DENY_DIRS.has(p))) return true
  return DENY_FILES.has(parts[parts.length - 1])
}

/** 自定义同步项的 name 只允许简单标识符，避免路径穿越。 */
export function isValidExtraName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..'
}

/**
 * 收集一个自定义同步项的内容。
 * extra: { name, path, exclude?: string[] }
 * 返回 [{ rel, abs }]，rel 形如 extras/<name>/<子路径>。
 */
export function sensitiveName(name) {
  const folded = String(name).toLowerCase()
  return DENY_FILES.has(folded) || /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/.test(folded) || ['id_rsa', 'id_ed25519', '.npmrc', '.git-credentials'].includes(folded)
}

export function buildExtraManifest(extra) {
  const out = []
  if (!extra || !isValidExtraName(extra.name) || !extra.path) return out
  const root = extra.path
  if (!fs.existsSync(root)) return out
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink()) throw new Error('拒绝同步链接路径：' + root)
  if (rootStat.isFile()) {
    if (sensitiveName(path.basename(root))) throw new Error('拒绝同步敏感凭据文件')
    out.push({ rel: path.join(EXTRA_PREFIX, extra.name, path.basename(root)), abs: root })
    return out
  }
  if (!rootStat.isDirectory()) throw new Error('不支持的自定义项类型')
  const exclude = new Set(Array.isArray(extra.exclude) ? extra.exclude : DEFAULT_EXTRA_EXCLUDE)
  const stack = ['']
  while (stack.length) {
    const sub = stack.pop()
    const cur = path.join(root, sub)
    const entries = fs.readdirSync(cur, { withFileTypes: true })
    for (const e of entries) {
      if (exclude.has(e.name) || sensitiveName(e.name) || ['.ssh', '.gnupg', '.aws', '.git'].includes(e.name.toLowerCase())) continue
      if (e.isSymbolicLink()) throw new Error('自定义项含链接，已停止扫描：' + e.name)
      if (e.isDirectory()) stack.push(path.join(sub, e.name))
      else if (e.isFile()) out.push({ rel: path.join(EXTRA_PREFIX, extra.name, sub, e.name), abs: path.join(cur, e.name) })
    }
  }
  return out
}

/** 逐个自定义同步项统计体积，供大小守门使用。 */
export function extraStats(cfg) {
  const rows = []
  for (const extra of cfg.extras ?? []) {
    const manifest = buildExtraManifest(extra)
    let bytes = 0
    for (const item of manifest) {
      try { bytes += fs.statSync(item.abs).size } catch { /* ignore */ }
    }
    rows.push({ name: extra.name, path: extra.path, files: manifest.length, bytes, missing: !fs.existsSync(extra.path) })
  }
  return rows
}

/**
 * 收集"要同步什么"，返回 [{ rel, abs }]（rel 相对 DSH_HOME，extras 例外）。
 */
export function buildManifest(dshHome, cfg) {
  const out = []
  const push = (rel, abs) => {
    if (isDenied(rel) || machineLocalStateReason(rel)) return
    try {
      if (fs.statSync(abs).isFile()) out.push({ rel: rel.split('/').join(path.sep), abs })
    } catch { /* missing -> skip */ }
  }

  const walk = (relDir) => {
    const absDir = path.join(dshHome, relDir)
    if (!fs.existsSync(absDir)) return
    const stack = ['']
    while (stack.length) {
      const sub = stack.pop()
      const cur = path.join(absDir, sub)
      let entries
      try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (DENY_DIRS.has(e.name.toLowerCase())) continue
          stack.push(path.join(sub, e.name))
        } else if (e.isFile()) {
          if (DENY_FILES.has(e.name.toLowerCase())) continue
          push(path.join(relDir, sub, e.name).split(path.sep).join('/'), path.join(cur, e.name))
        }
      }
    }
  }

  for (const tree of SYNC_TREES) walk(tree)
  if (cfg.includeAttachments) walk(ATTACHMENT_TREE)

  for (const prof of cfg.profiles) {
    for (const f of PROFILE_FILES) {
      push(`profiles/${prof}/${f}`, path.join(dshHome, 'profiles', prof, f))
    }
  }
  push(PET_CONFIG, path.join(dshHome, PET_CONFIG))

  for (const extra of cfg.extras ?? []) {
    out.push(...buildExtraManifest(extra))
  }

  return out
}

/** 拆开 extras/<name>/<rest>，不是 extras 路径则返回 null。 */
export function splitExtraRel(rel) {
  const parts = String(rel).split(/[\\/]/)
  if (parts[0] !== EXTRA_PREFIX || parts.length < 3) return null
  return { name: parts[1], rest: parts.slice(2).join('/') }
}

/** 统计清单体积。 */
export function manifestStats(manifest) {
  let bytes = 0
  for (const item of manifest) {
    try { bytes += fs.statSync(item.abs).size } catch { /* ignore */ }
  }
  return { files: manifest.length, bytes }
}

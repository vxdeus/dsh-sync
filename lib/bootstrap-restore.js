import fs from 'node:fs'
import path from 'node:path'
import { validatePluginInventory } from './bootstrap-policy.js'
import { noLinks } from './restore-safety.js'

// Run only after the official installer has returned success. Reconcile machine-local
// dependency sources and lockfiles, rather than restoring invalid source-machine paths.
export function reconcileBootstrapProfiles(workDir, dshHome, inventory) {
  validatePluginInventory(inventory)
  const profiles = [...new Set(inventory.map(p => p.profile))]
  const prepared = []
  for (const profile of profiles) {
    const remotePkg = path.join(workDir, 'profiles', profile, 'package.json')
    const root = path.join(dshHome, 'profiles', profile)
    const localPkg = path.join(root, 'package.json')
    noLinks(remotePkg); noLinks(localPkg)
    if (!fs.existsSync(remotePkg) || !fs.existsSync(localPkg)) throw new Error('插件安装后缺少 profile 配置')
    const from = JSON.parse(fs.readFileSync(remotePkg, 'utf8'))
    const local = JSON.parse(fs.readFileSync(localPkg, 'utf8'))
    const rows = inventory.filter(p => p.profile === profile)
    const names = new Set(rows.map(p => p.name))
    for (const name of Object.keys(from.dependencies || {})) if (!names.has(name)) throw new Error('快照依赖未列入已确认安装清单：' + name)
    for (const item of rows) {
      const file = path.join(root, 'node_modules', item.name, 'package.json')
      if (!fs.existsSync(file)) throw new Error('插件安装未完成：' + item.name)
      const installed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (installed.name !== item.name || installed.version !== item.version || !(item.name in (local.dependencies || {}))) throw new Error('插件版本未达到快照要求：' + item.name)
    }
    from.dependencies = { ...(local.dependencies || {}) }
    const localLock = path.join(root, 'pnpm-lock.yaml')
    const remoteLock = path.join(workDir, 'profiles', profile, 'pnpm-lock.yaml')
    noLinks(localLock); noLinks(remoteLock)
    prepared.push({ remotePkg, text: JSON.stringify(from, null, 2) + '\n', remoteLock, lock: fs.existsSync(localLock) ? fs.readFileSync(localLock) : null })
  }
  for (const item of prepared) {
    fs.writeFileSync(item.remotePkg, item.text, 'utf8')
    if (item.lock) fs.writeFileSync(item.remoteLock, item.lock)
    else if (fs.existsSync(item.remoteLock)) throw new Error('缺少本机安装锁文件，拒绝恢复旧电脑的锁文件')
  }
}

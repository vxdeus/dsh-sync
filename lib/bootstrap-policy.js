import fs from 'node:fs'
import path from 'node:path'
import { noLinks } from './restore-safety.js'
import { validatePortablePlugins } from './plugin-packages.js'

export function validatePluginInventory(value) {
  if (Array.isArray(value) && value.some(row => row?.source === 'archive')) return validatePortablePlugins(value)
  if (!Array.isArray(value) || value.length > 100) throw new Error('插件清单缺失或过大，请源电脑用新版重新上传')
  const seen = new Set()
  for (const item of value) {
    if (!item || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.profile) || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(item.name) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(item.version)) throw new Error('快照插件清单无效')
    const key = item.profile + ':' + item.name
    if (seen.has(key)) throw new Error('插件清单重复')
    seen.add(key)
    if (item.source !== 'npm' && !(item.source === 'bundle' && item.name === 'dsh-sync')) throw new Error('不支持的插件来源：' + item.name)
  }
  return value
}
export function installedPluginInventory(dshHome, profiles) {
  const rows = []
  for (const profile of profiles) {
    const root = path.join(dshHome, 'profiles', profile)
    const file = path.join(root, 'package.json')
    if (!fs.existsSync(file)) continue
    noLinks(file)
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('插件名无效')
      const installed = path.join(root, 'node_modules', name, 'package.json')
      if (!fs.existsSync(installed)) throw new Error('快照需要的插件未安装：' + name)
      const info = JSON.parse(fs.readFileSync(installed, 'utf8').replace(/^\uFEFF/, ''))
      if (info.name !== name) throw new Error('已安装插件名称不匹配')
      rows.push({ profile, name, version: info.version, source: name === 'dsh-sync' ? 'bundle' : 'npm' })
    }
  }
  return validatePluginInventory(rows)
}

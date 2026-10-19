import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve only from the running Host, not unrelated user directories or downloaded code.
export async function loadHostModule(name) {
  if (name !== '@deepseek-ai/dsh-sandbox') throw new Error('Host module is not allowlisted')
  try { return await import(name) } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error }
  const anchors = new Set()
  for (const resources of [process.resourcesPath, path.join(path.dirname(process.execPath), 'resources')]) {
    if (typeof resources !== 'string' || !path.isAbsolute(resources)) continue
    for (const part of ['app.asar/dsh', 'app/dsh', 'dsh']) anchors.add(path.join(resources, part, 'package.json'))
  }
  if (process.argv[1] && path.isAbsolute(process.argv[1])) {
    let directory = path.dirname(process.argv[1])
    for (let n = 0; n < 6; n++) {
      anchors.add(path.join(directory, 'package.json'))
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    let entry
    try { entry = createRequire(anchor).resolve(name) } catch { continue }
    return import(pathToFileURL(entry).href)
  }
  throw new Error('当前 DSH 未提供插件升级授权接口，请在同步面板明确确认，或通过插件市场更新')
}

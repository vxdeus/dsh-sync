import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { applyRestore } from './restore-safety.js'

async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const end = value => { socket.destroy(); resolve(value) }
    socket.once('connect', () => end(true)); socket.once('error', () => end(false)); socket.setTimeout(1500, () => end(true))
  })
}
const args = process.argv.slice(2)
try {
  if (args[0] !== '--apply' || !args[1]) throw new Error('用法：node restore-offline.mjs --apply <暂存目录>。请先退出 DSH。')
  const stage = path.resolve(args[1])
  const plan = JSON.parse(await fs.readFile(path.join(stage, 'plan.json'), 'utf8'))
  if (plan.port && await listening(plan.port)) throw new Error('DSH 端口仍在监听；请完全退出 DSH 再恢复')
  const result = await applyRestore(stage)
  console.log(`恢复完成：处理 ${result.files} 个文件，实际写入 ${result.changed} 个，内容一致保持原样 ${result.unchanged} 个；备份：${result.backup}`)
  if (plan.preservedLocal?.length) console.log(`本机诊断/预测状态保持不动：${plan.preservedLocal.map(item => item.repoPath).join(', ')}`)
  console.log('现在可以重新打开 DSH。若有新的插件依赖，请先按清单安装，不要绕过兼容性检查。')
} catch (e) {
  console.error('恢复未完成：' + e.message)
  process.exitCode = 1
}

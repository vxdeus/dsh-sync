#!/usr/bin/env node
// Read-only release hygiene checks. This is not a general-purpose secret scanner.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, validateConfig } from '../lib/config.js'

const forbiddenName = name => /^(?:\.env(?:\..*)?|\.npmrc|\.credentials\.yaml|dsh-sync(?:-auth)?\.json|id_rsa|id_ed25519)$/i.test(name)
  || /\.(?:pem|key|p12|pfx|log|stdout|stderr|tgz|zip|bak)$/i.test(name)
const forbiddenDirectory = /^(?:\.git|node_modules|dist|coverage|\.npm-cache|\.dsh|\.dsh-sync.*|sessions|attachments|storages|state|extras|plugin-packages|\.ssh|\.aws|\.gnupg)$/i
const sourceDirectories = new Set(['lib', 'test', 'scripts', 'docs', '.github'])
const sourceFiles = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'PUBLISHING.md', 'SECURITY.md', 'LICENSE', 'cordis.patch.yml', '.gitignore'])
const omitted = new Set(['.git', 'node_modules', 'dist', 'coverage', '.npm-cache'])
const removed = ['lib/server-defaults.json', 'lib/new-device-bootstrap.mjs', 'lib/portable-install.cjs']

export function scanPublicText(text, name = 'input') {
  const problems = []
  const flag = (kind, index) => problems.push(`${name}:${text.slice(0, index).split('\n').length}: ${kind}`)
  for (const match of text.matchAll(/https?:\/\/(?:www\.)?gitee\.com\/[^\s'"<>]+/gi)) flag('non-placeholder Gitee address', match.index)
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (match[0] !== '127.0.0.1') flag('non-loopback IPv4 literal', match.index)
  }
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/(?:home|Users)\/)([^\\/\r\n'"`]+)/g)) {
    if (!/^(?:synthetic(?:[- ][a-z]+)*|your-user)$/i.test(match[1])) flag('non-synthetic user home path', match.index)
  }
  for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g)) flag('private key material marker', match.index)
  for (const match of text.matchAll(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/g)) flag('credential-like literal', match.index)
  return problems
}

export function verifyPublicTree(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'dsh-sync' || manifest.private === true) throw new Error('Expected publishable dsh-sync manifest')
  if (manifest.repository?.url !== 'git+https://github.com/vxdeus/dsh-sync.git') throw new Error('Unexpected public source repository')
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
    if (manifest.scripts?.[hook]) throw new Error(`Release must not run lifecycle hook: ${hook}`)
  }
  if (!Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length) throw new Error('Invalid release allowlist')
  for (const required of ['README.md', 'CHANGELOG.md', 'PUBLISHING.md', 'SECURITY.md', 'LICENSE']) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`Missing public documentation: ${required}`)
  }
  for (const file of removed) if (fs.existsSync(path.join(root, file)) || manifest.files.includes(file)) throw new Error(`Device-specific source is forbidden: ${file}`)
  for (const file of manifest.files) {
    if (typeof file !== 'string' || (!file.startsWith('lib/') && !['README.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml'].includes(file))
        || file.split('/').some(part => !part || part === '.' || part === '..' || forbiddenName(part) || forbiddenDirectory.test(part))) throw new Error('Unsafe release allowlist member')
  }
  const defaults = validateConfig()
  if (defaults.repoUrl || defaults.username || defaults.token || defaults.sftp !== null || defaults.privateRepoConfirmed
      || DEFAULT_CONFIG.repoUrl || defaults.extras.length) throw new Error('Public defaults contain a remote, account or private mapping')
  const problems = [], files = []
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? relative + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) throw new Error(`Source tree contains a link: ${rel}`)
      if (!relative && omitted.has(entry.name)) continue
      if (forbiddenName(entry.name) || (entry.isDirectory() && forbiddenDirectory.test(entry.name))) throw new Error(`Private or generated source path: ${rel}`)
      if (!relative && !(entry.isDirectory() ? sourceDirectories : sourceFiles).has(entry.name)) throw new Error(`Unreviewed root source path: ${rel}`)
      const absolute = path.join(directory, entry.name)
      if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Source tree contains a link: ${rel}`)
      if (entry.isDirectory()) visit(absolute, rel)
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute)
        if (bytes.includes(0)) throw new Error(`Unexpected binary source: ${rel}`)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw new Error(`Unexpected UTF-8 BOM: ${rel}`)
        problems.push(...scanPublicText(text, rel)); files.push(rel)
      } else throw new Error(`Unexpected source file type: ${rel}`)
    }
  }
  visit(root)
  for (const file of manifest.files) if (!files.includes(file)) throw new Error(`Missing release source: ${file}`)
  if (problems.length) throw new Error('Public source hygiene checks failed (values withheld):\n' + problems.join('\n'))
  return { version: manifest.version, sourceFiles: files.length, packageFiles: new Set(['package.json', ...manifest.files]).size }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = verifyPublicTree(root)
  console.log(`Public source hygiene OK: ${result.sourceFiles} files; ${result.packageFiles} explicit package files; version ${result.version}.`)
  console.log('No sync operation performed. Manual review remains required for arbitrary secrets and personal content.')
}

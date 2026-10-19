import { createHash } from 'node:crypto'
import { constants as bufferConstants } from 'node:buffer'
import { gunzipSync } from 'node:zlib'
import { TextDecoder } from 'node:util'

const DEFAULT_COMPRESSED_BYTES = 64 * 1024 * 1024
const DEFAULT_UNPACKED_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_PAX_BYTES = 1024 * 1024
const MAX_PAX_RECORDS = 1024
const MAX_PATH_BYTES = 4096
const BLOCK = 512
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function fail(message) {
  throw new Error(`Invalid plugin archive: ${message}`)
}

function limit(value, fallback, name) {
  const result = value === undefined ? fallback : value
  if (!Number.isSafeInteger(result) || result < 1 || result > bufferConstants.MAX_LENGTH) {
    throw new TypeError(`${name} must be a positive safe integer no larger than Buffer.MAX_LENGTH`)
  }
  return result
}

function utf8(bytes, label) {
  try { return decoder.decode(bytes) } catch { fail(`${label} is not valid UTF-8`) }
}

function field(header, offset, length, label) {
  const bytes = header.subarray(offset, offset + length)
  const zero = bytes.indexOf(0)
  return utf8(zero < 0 ? bytes : bytes.subarray(0, zero), label)
}

function integer(bytes, label, binary = true) {
  let value
  if (bytes[0] & 0x80) {
    if (!binary || bytes[0] & 0x40) fail(`invalid ${label}`)
    value = BigInt(bytes[0] & 0x7f)
    for (const byte of bytes.subarray(1)) value = value * 256n + BigInt(byte)
  } else {
    const text = bytes.toString('latin1').replace(/^[\x00 ]+|[\x00 ]+$/g, '')
    if (!text && label !== 'checksum') return 0
    if (!/^[0-7]+$/.test(text)) fail(`invalid ${label}`)
    value = BigInt(`0o${text}`)
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} is too large`)
  return Number(value)
}

/** Normalize only harmless '.'/duplicate separators; never normalize away '..'. */
function safePath(value, { allowEmpty = false, pattern = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) fail('invalid or oversized path')
  if (/^[\/\\]/.test(value) || /[\x00-\x1f\x7f\\<>:"|?]/.test(value) || (!pattern && value.includes('*'))) {
    fail('unsafe absolute, Windows or backslash path')
  }
  const parts = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') fail('path traversal')
    if (/[. ]$/.test(part)) fail('Windows-ambiguous path')
    // Windows reserves these basenames even when an extension follows.
    const base = part.split('.')[0].trim().toUpperCase()
    if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/.test(base)) fail('Windows device path')
    parts.push(part)
  }
  const result = parts.join('/')
  if (!result && !allowEmpty) fail('empty path')
  return result
}

function paxSize(text, maxUnpackedBytes) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || text.length > 20) fail('invalid PAX size')
  const value = BigInt(text)
  if (value > BigInt(maxUnpackedBytes)) fail('PAX size exceeds unpacked limit')
  return Number(value)
}

function parsePax(data, maxUnpackedBytes) {
  if (data.length > MAX_PAX_BYTES) fail('PAX metadata byte limit exceeded')
  const result = Object.create(null)
  let offset = 0
  let count = 0
  while (offset < data.length) {
    if (++count > MAX_PAX_RECORDS) fail('PAX record count limit exceeded')
    const space = data.indexOf(32, offset)
    if (space < 0 || space - offset > 20) fail('invalid PAX record length')
    const rawLength = data.subarray(offset, space).toString('latin1')
    if (!/^[1-9][0-9]*$/.test(rawLength)) fail('invalid PAX record length')
    const length = Number(rawLength)
    if (!Number.isSafeInteger(length) || length <= space - offset + 3 || length > data.length - offset) fail('truncated PAX record')
    const end = offset + length
    if (data[end - 1] !== 10) fail('PAX record has no newline')
    const body = data.subarray(space + 1, end - 1)
    const equals = body.indexOf(61)
    if (equals < 1) fail('invalid PAX record')
    const key = body.subarray(0, equals).toString('latin1')
    if (!/^[\x21-\x3c\x3e-\x7e]+$/.test(key) || own(result, key)) fail('invalid or duplicate PAX key')
    const value = utf8(body.subarray(equals + 1), 'PAX value')
    if (value.includes('\0')) fail('NUL in PAX value')
    if (key === 'path' && value) safePath(value)
    if (key === 'linkpath' && value) {
      safePath(value)
      fail('PAX links are not allowed')
    }
    if (key === 'size' && value) paxSize(value, maxUnpackedBytes)
    if (key.startsWith('GNU.sparse') || key === 'SCHILY.filetype' || key === 'SCHILY.realsize') fail('sparse/special PAX entries are not supported')
    result[key] = value
    offset = end
  }
  return result
}

function parseTar(tar, maxUnpackedBytes) {
  const entries = new Map()
  const identities = new Set()
  let offset = 0
  let count = 0
  let globalPax = Object.create(null)
  let localPax = null
  let ended = false
  while (offset < tar.length) {
    if (tar.length - offset < BLOCK) fail('truncated tar header')
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < BLOCK * 2 || !tar.subarray(offset).every(byte => byte === 0)) fail('invalid or truncated tar end marker')
      if ((tar.length - offset) % BLOCK !== 0) fail('truncated tar padding')
      ended = true
      break
    }
    if (++count > MAX_ENTRIES) fail('tar entry count limit exceeded')
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    if (integer(header.subarray(148, 156), 'checksum', false) !== sum) fail('tar header checksum mismatch')
    const rawSize = integer(header.subarray(124, 136), 'file size')
    if (rawSize > maxUnpackedBytes) fail('file size exceeds unpacked limit')
    const magic = header.subarray(257, 263).toString('latin1')
    if (magic !== 'ustar\0' && magic !== 'ustar ' && !header.subarray(257, 263).every(byte => byte === 0)) fail('unsupported tar header format')
    const name = field(header, 0, 100, 'tar name')
    const prefix = magic.startsWith('ustar') ? field(header, 345, 155, 'tar prefix') : ''
    const rawPath = prefix ? `${prefix}/${name}` : name
    const type = String.fromCharCode(header[156] || 48)
    const directory = type === '5'
    // Inspect even overridden header fields: PAX must not hide hostile names/links.
    safePath(rawPath, { allowEmpty: directory })
    const rawLink = field(header, 157, 100, 'tar link name')
    if (rawLink) {
      safePath(rawLink)
      fail('tar links are not allowed')
    }
    if (!['0', '5', 'x', 'g'].includes(type)) fail('tar links or special entry types are not allowed')
    const metadata = type === 'x' || type === 'g'
    const effective = metadata ? null : { ...globalPax, ...localPax }
    const size = effective && effective.size ? paxSize(effective.size, maxUnpackedBytes) : rawSize
    const start = offset + BLOCK
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (padded > tar.length - start) fail('truncated tar file payload')
    const data = tar.subarray(start, start + size)
    offset = start + padded
    if (metadata) {
      const values = parsePax(data, maxUnpackedBytes)
      if (type === 'g') {
        for (const [key, value] of Object.entries(values)) {
          if (value === '') delete globalPax[key]
          else globalPax[key] = value
        }
        if (Object.keys(globalPax).length > MAX_PAX_RECORDS) fail('global PAX metadata count limit exceeded')
      } else {
        if (localPax) fail('ambiguous repeated local PAX headers')
        localPax = values
      }
      continue
    }
    const fullPath = effective.path || rawPath
    const normalized = safePath(fullPath, { allowEmpty: directory })
    if (!directory && fullPath.endsWith('/')) fail('regular file has directory path')
    if (effective.linkpath) fail('PAX links are not allowed')
    if (directory && size !== 0) fail('directory entry has file payload')
    const identity = normalized.normalize('NFC').toLowerCase()
    if (identities.has(identity)) fail('duplicate normalized tar entry')
    identities.add(identity)
    entries.set(normalized, { directory, data })
    localPax = null
  }
  if (!ended) fail('missing tar end marker')
  if (localPax) fail('dangling PAX header')
  const foldedEntries = new Map([...entries].map(([name, entry]) => [name.normalize('NFC').toLowerCase(), entry]))
  for (const filename of entries.keys()) {
    const segments = filename.split('/')
    for (let i = 1; i < segments.length; i++) {
      const ancestor = foldedEntries.get(segments.slice(0, i).join('/').normalize('NFC').toLowerCase())
      if (ancestor && !ancestor.directory) fail('file used as a parent directory')
    }
  }
  return entries
}

function validName(value) {
  if (typeof value !== 'string' || value.length > 214 || ['node_modules', 'favicon.ico'].includes(value)) return false
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)
}

function validVersion(value) {
  if (typeof value !== 'string' || value.length > 256) return false
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  return !!match && (!match[4] || match[4].split('.').every(part => !/^[0-9]+$/.test(part) || part.length === 1 || part[0] !== '0'))
}

function inspectManifest(entries) {
  let root = ''
  let manifestEntry = entries.get('package.json')
  if (!manifestEntry || manifestEntry.directory) {
    const candidates = [...entries].filter(([name, entry]) => !entry.directory && /^[^/]+\/package\.json$/.test(name))
    if (candidates.length !== 1) fail('root package.json must be unique')
    root = candidates[0][0].slice(0, -'package.json'.length)
    manifestEntry = candidates[0][1]
    for (const name of entries.keys()) {
      if (name !== '' && name !== root.slice(0, -1) && !name.startsWith(root)) fail('entry lies outside the package root')
    }
  }
  if (manifestEntry.data.length > MAX_MANIFEST_BYTES) fail('package.json is too large')
  let manifest
  try { manifest = JSON.parse(utf8(manifestEntry.data, 'package.json').replace(/^\uFEFF/, '')) } catch { fail('invalid package.json JSON or encoding') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('package.json must be an object')
  if (!validName(manifest.name)) fail('invalid package name')
  if (!validVersion(manifest.version)) fail('invalid package version')
  const regularFiles = new Set([...entries].filter(([, entry]) => !entry.directory).map(([name]) => name))
  function fileExists(declaration, { pattern = false, legacy = false } = {}) {
    const normalized = safePath(declaration, { pattern, allowEmpty: legacy })
    const target = root + normalized
    if (pattern && normalized.includes('*')) {
      // Literal scanning avoids regex backtracking on hostile repeated '*' targets.
      const parts = target.split('*')
      const matches = name => {
        if (!name.startsWith(parts[0])) return false
        let position = parts[0].length
        for (let i = 1; i < parts.length - 1; i++) {
          const next = name.indexOf(parts[i], position)
          if (next < 0) return false
          position = next + parts[i].length
        }
        const last = parts[parts.length - 1]
        return name.endsWith(last) && name.length - last.length >= position
      }
      if ([...regularFiles].some(matches)) return
    } else if (regularFiles.has(target)) return
    const directoryTarget = target.replace(/\/$/, '')
    const indexPrefix = directoryTarget ? directoryTarget + '/' : ''
    if (legacy && [target + '.js', target + '.json', target + '.node', indexPrefix + 'index.js', indexPrefix + 'index.json', indexPrefix + 'index.node'].some(name => regularFiles.has(name))) return
    fail('declared patch or entry file does not exist')
  }
  const patch = manifest.dsh?.bundle?.patch
  const patches = typeof patch === 'string' ? [patch] : patch
  if (!Array.isArray(patches) || !patches.length || patches.some(value => typeof value !== 'string' || !value)) fail('missing or invalid dsh.bundle.patch')
  for (const declaration of patches) fileExists(declaration)
  for (const key of ['main', 'module']) {
    if (own(manifest, key)) {
      if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`invalid ${key} entry`)
      fileExists(manifest[key], { legacy: key === 'main' })
    }
  }
  function exportsEntries(value, depth = 0) {
    if (depth > 32) fail('package exports nesting is too deep')
    if (value === null) return
    if (typeof value === 'string') {
      if (!value.startsWith('./')) fail('package export target must be relative')
      fileExists(value, { pattern: true })
    } else if (Array.isArray(value)) {
      for (const entry of value) exportsEntries(entry, depth + 1)
    } else if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) exportsEntries(entry, depth + 1)
    } else fail('invalid package exports')
  }
  if (own(manifest, 'exports')) exportsEntries(manifest.exports)
  return manifest
}

/**
 * Inspect a gzip-compressed npm/GitHub tar archive, without extraction or code execution.
 * Only structural validity, package identity and declared files are checked. Dependency
 * installation policy, compatibility and script approval belong to the calling workflow.
 * `sha256` and `bytes` describe the original compressed bytes, not the decoded tar.
 */
export function inspectPluginArchive(buffer, { maxCompressedBytes, maxUnpackedBytes } = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new TypeError('archive must be a Buffer or Uint8Array')
  const compressedLimit = limit(maxCompressedBytes, DEFAULT_COMPRESSED_BYTES, 'maxCompressedBytes')
  const unpackedLimit = limit(maxUnpackedBytes, DEFAULT_UNPACKED_BYTES, 'maxUnpackedBytes')
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (bytes.length > compressedLimit) fail('compressed size limit exceeded')
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) fail('expected a gzip archive')
  let tar
  try { tar = gunzipSync(bytes, { maxOutputLength: unpackedLimit }) } catch { fail('invalid gzip or unpacked size limit exceeded') }
  if (tar.length > unpackedLimit) fail('unpacked size limit exceeded')
  const entries = parseTar(tar, unpackedLimit)
  const manifest = inspectManifest(entries)
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}

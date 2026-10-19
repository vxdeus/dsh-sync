/** Cold-session decoding only: no live Session publication and no persistence writes. */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'

const CATALOG_PACKAGE = '@deepseek-ai/dsh-session-format-catalog'
export const MAX_SESSION_BYTES = 128 * 1024 * 1024
const MAX_ZSTD_FRAMES = 100_000
const ZSTD_MAGIC = 0xfd2fb528
let catalogPromise

function validCatalog(value) {
  return value && Number.isSafeInteger(value.currentVersion) && value.currentVersion >= 0
    && typeof value.createRestore === 'function'
}

/** Resolve the running application's codec, never a copied or downloaded implementation. */
export function loadSessionCatalog() {
  if (catalogPromise) return catalogPromise
  catalogPromise = (async () => {
    try {
      const loaded = await import(CATALOG_PACKAGE)
      if (validCatalog(loaded.sessionFormatCatalog)) return loaded.sessionFormatCatalog
    } catch { /* Profile plugins need not resolve installation-owned packages directly. */ }

    // Electron's own fs/module resolver understands app.asar. Plain Node deliberately
    // fails closed if the application archive is not accessible to its module loader.
    const anchors = new Set()
    const addResources = resources => {
      if (typeof resources !== 'string' || !path.isAbsolute(resources)) return
      anchors.add(path.join(resources, 'app.asar', 'dsh', 'package.json'))
      anchors.add(path.join(resources, 'app', 'dsh', 'package.json'))
      anchors.add(path.join(resources, 'dsh', 'package.json'))
    }
    addResources(process.resourcesPath)
    addResources(path.join(path.dirname(process.execPath), 'resources'))
    if (process.argv[1] && path.isAbsolute(process.argv[1])) {
      let directory = path.dirname(process.argv[1])
      // Supports an unpacked CLI/main entry without searching unrelated home trees.
      for (let depth = 0; depth < 6; depth += 1) {
        anchors.add(path.join(directory, 'package.json'))
        anchors.add(path.join(directory, 'dsh', 'package.json'))
        const parent = path.dirname(directory)
        if (parent === directory) break
        directory = parent
      }
    }
    for (const anchor of anchors) {
      if (!existsSync(anchor)) continue
      try {
        const entry = createRequire(anchor).resolve(CATALOG_PACKAGE)
        const loaded = await import(pathToFileURL(entry).href)
        if (validCatalog(loaded.sessionFormatCatalog)) return loaded.sessionFormatCatalog
      } catch { /* Try the next existing application anchor; do not alter resolution. */ }
    }
    throw new Error('The running DSH session format catalog is unavailable; online session import is disabled.')
  })().catch(error => {
    catalogPromise = undefined
    throw error
  })
  return catalogPromise
}

/** Locate exactly one complete ordinary Zstd frame; never accept a recoverable torn tail. */
function frameEnd(bytes, start) {
  let offset = start
  const requireBytes = count => {
    if (bytes.length - offset < count) throw new Error('Truncated Zstandard session frame.')
  }
  requireBytes(5)
  if (bytes.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('Invalid Zstandard session frame magic.')
  offset += 4
  const descriptor = bytes[offset++]
  if (descriptor & 0x18) throw new Error('Reserved Zstandard session frame header bits.')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = Boolean(descriptor & 0x20)
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  requireBytes(headerBytes)
  offset += headerBytes
  for (;;) {
    requireBytes(3)
    const block = bytes.readUIntLE(offset, 3)
    offset += 3
    const blockType = (block >>> 1) & 3
    if (blockType === 3) throw new Error('Reserved Zstandard session block type.')
    const payloadBytes = blockType === 1 ? 1 : block >>> 3
    requireBytes(payloadBytes)
    offset += payloadBytes
    if (block & 1) break
  }
  if (descriptor & 4) {
    requireBytes(4)
    offset += 4
  }
  return offset
}

async function decompressSession(bytes, maxBytes) {
  if (typeof zlib.zstdDecompress !== 'function') {
    throw new Error('This runtime cannot decode Zstandard sessions; online session import is disabled.')
  }
  const decompress = promisify(zlib.zstdDecompress)
  const chunks = []
  let total = 0
  let offset = 0
  while (offset < bytes.length) {
    if (chunks.length >= MAX_ZSTD_FRAMES) throw new Error('Session exceeds the Zstandard frame limit.')
    const end = frameEnd(bytes, offset)
    // Node's one-shot AND streaming decoders stop at the first concatenated frame.
    // Frame-by-frame decoding is required to avoid silently dropping all events.
    const chunk = await decompress(bytes.subarray(offset, end), { maxOutputLength: Math.max(1, maxBytes - total) })
    if (chunk.length === 0 || chunk.at(-1) !== 10) throw new Error('Session Zstandard frame does not end on a complete JSONL record.')
    if (chunks.length === 0 && chunk.indexOf(10) !== chunk.length - 1) {
      throw new Error('Session Zstandard header frame must contain exactly one header record.')
    }
    total += chunk.length
    if (total > maxBytes) throw new Error('Session exceeds the decompressed byte limit.')
    chunks.push(chunk)
    offset = end
  }
  return Buffer.concat(chunks, total)
}

function parseLine(line, number) {
  if (line.trim().length === 0) throw new Error(`Empty session JSONL record at line ${number}.`)
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`Invalid session JSON at line ${number}.`)
  }
}

/**
 * Decode a complete portable artifact through the installed native format catalog.
 * Compatible historical generations follow native migration rules; missing child
 * evidence, unknown vocabulary and future versions retain the native refusal.
 * maxBytes is a hard cap on encoded, decoded and path-remapped data (default 128 MiB).
 */
export async function decodeSession(bytes, { compressed = false, codec, catalog, maxBytes = MAX_SESSION_BYTES } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Session bytes must be a Buffer or Uint8Array.')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SESSION_BYTES) {
    throw new TypeError('Session byte limit must be a positive safe integer no larger than MAX_SESSION_BYTES.')
  }
  if (bytes.byteLength === 0) throw new Error('Empty session artifact.')
  if (bytes.byteLength > maxBytes) throw new Error('Session exceeds the encoded byte limit.')
  // Own the input: asynchronous decompression must not observe caller mutations.
  let buffer = Buffer.from(bytes)
  if (compressed) buffer = await decompressSession(buffer, maxBytes)
  if (buffer.length === 0 || buffer.at(-1) !== 10) throw new Error('Truncated session JSONL: the final record has no newline.')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    throw new Error('Session artifact is not valid UTF-8.')
  }
  if (codec !== undefined) {
    if (typeof codec?.fromPortable !== 'function') throw new TypeError('Session path codec must provide fromPortable(text).')
    text = codec.fromPortable(text)
    if (typeof text !== 'string') throw new TypeError('Session path codec must return text.')
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Session exceeds the path-remapped byte limit.')
  if (!text.endsWith('\n')) throw new Error('Truncated session JSONL after path mapping.')
  const lines = text.split('\n')
  lines.pop()
  const physicalHeader = parseLine(lines[0] ?? '', 1)
  if (!physicalHeader || Array.isArray(physicalHeader) || physicalHeader.type !== 'session') {
    throw new Error('Session artifact must start with one session header.')
  }
  const nativeCatalog = catalog ?? await loadSessionCatalog()
  if (!validCatalog(nativeCatalog)) throw new TypeError('Invalid DSH session format catalog.')
  const restore = nativeCatalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' })
  for (let index = 1; index < lines.length; index += 1) {
    const record = parseLine(lines[index], index + 1)
    if (record?.type === 'session') throw new Error(`Embedded session header at line ${index + 1}.`)
    restore.decodeRow(record)
  }
  const artifact = restore.finish()
  if (!artifact?.header || typeof artifact.header.id !== 'string' || artifact.header.version !== nativeCatalog.currentVersion
      || !Array.isArray(artifact.events) || !Number.isSafeInteger(artifact.inheritedEventCount)
      || artifact.inheritedEventCount < 0 || artifact.inheritedEventCount > artifact.events.length) {
    throw new Error('Native session decoder returned an invalid artifact.')
  }
  return { header: artifact.header, events: artifact.events, inheritedEventCount: artifact.inheritedEventCount }
}

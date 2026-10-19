import test from 'node:test'
import assert from 'node:assert/strict'
import * as zlib from 'node:zlib'
import { decodeSession, loadSessionCatalog, MAX_SESSION_BYTES } from '../lib/live-session.js'
import { createCodec } from '../lib/pathcodec.js'

const header = { type: 'session', version: 4, id: 'synthetic-live-import', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const message = { type: 'user/message', seq: 0, time: 2, data: { text: 'synthetic-only' } }
const bytesFor = (head = header, events = [message]) => Buffer.from([head, ...events].map(value => JSON.stringify(value)).join('\n') + '\n')

function fakeCatalog({ oldVersionError = false } = {}) {
  return {
    currentVersion: 4,
    createRestore(physical, options) {
      assert.deepEqual(options, { recovery: 'strict', validation: 'current' })
      if (physical.version > 4) throw new Error('Native future format refusal')
      if (physical.version < 3) throw new Error('Native unsupported old format')
      if (physical.version === 3 && oldVersionError) throw new Error('Native migration needs historical child evidence')
      const { type, ...logicalHeader } = physical
      const events = []
      return {
        decodeRow(row) {
          if (!row || !['user/message', 'session/end-seed'].includes(row.type)) throw new Error('Native unknown event refusal')
          if (row.seq !== events.length) throw new Error('Native non-contiguous events')
          events.push(row)
        },
        finish() {
          let inheritedEventCount = 0
          for (const event of events) if (event.type === 'session/end-seed' && event.data.inherited === true) inheritedEventCount = event.seq
          return { header: { ...logicalHeader, version: 4 }, events, inheritedEventCount }
        },
      }
    },
  }
}

const catalog = fakeCatalog()

test('plain JSONL uses native strict restoration without publishing or rewriting metadata', async () => {
  const result = await decodeSession(bytesFor(), { catalog })
  const { type, ...logicalHeader } = header
  assert.deepEqual(result, { header: logicalHeader, events: [message], inheritedEventCount: 0 })
})

test('header-only empty histories remain valid and seeded cuts come from the native codec', async () => {
  assert.equal((await decodeSession(bytesFor(header, []), { catalog })).events.length, 0)
  const marker = { type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }
  const result = await decodeSession(bytesFor({ ...header, isSeeded: true }, [message, marker]), { catalog })
  assert.equal(result.inheritedEventCount, 1)
  assert.equal(result.events.length, 2)
})

test('native compatibility migration is allowed and missing historical evidence is not bypassed', async () => {
  assert.equal((await decodeSession(bytesFor({ ...header, version: 3 }), { catalog })).header.version, 4)
  await assert.rejects(decodeSession(bytesFor({ ...header, version: 3 }), { catalog: fakeCatalog({ oldVersionError: true }) }), /historical child evidence/)
  await assert.rejects(decodeSession(bytesFor({ ...header, version: 5 }), { catalog }), /future format/)
  await assert.rejects(decodeSession(bytesFor({ ...header, version: 1 }), { catalog }), /unsupported old format/)
})

test('unknown event vocabulary and non-contiguous rows keep native refusals', async () => {
  await assert.rejects(decodeSession(bytesFor(header, [{ ...message, type: 'unknown/event' }]), { catalog }), /unknown event/)
  await assert.rejects(decodeSession(bytesFor(header, [{ ...message, seq: 1 }]), { catalog }), /non-contiguous/)
})

test('empty, torn, embedded headers, malformed JSON and blank committed rows reject', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from(''), bytesFor().subarray(0, -1), Buffer.from('{}\n'), Buffer.from('{\n'), Buffer.from('\n')]) {
    await assert.rejects(decodeSession(bytes, { catalog }))
  }
  await assert.rejects(decodeSession(bytesFor(header, [header]), { catalog }), /Embedded session header/)
  await assert.rejects(decodeSession(Buffer.concat([bytesFor(), Buffer.from('\n')]), { catalog }), /Empty session JSONL/)
  await assert.rejects(decodeSession(Buffer.concat([bytesFor(header, []), Buffer.from('{"type":\n')]), { catalog }), /Invalid session JSON/)
})

test('UTF-8 validation is fatal rather than replacing corrupted text', async () => {
  const corrupted = Buffer.concat([bytesFor(header, []), Buffer.from('{"type":"user/message","seq":0,"data":"'), Buffer.from([0xc0]), Buffer.from('"}\n')])
  await assert.rejects(decodeSession(corrupted, { catalog }), /valid UTF-8/)
})

test('portable path decoding runs after artifact decoding and before native parsing', async () => {
  const source = createCodec(String.raw`C:\Users\synthetic-source`)
  const target = createCodec(String.raw`C:\Users\synthetic-target`)
  const portable = Buffer.from(source.toPortable(bytesFor({ ...header, cwd: String.raw`C:\Users\synthetic-source\project` }).toString()))
  const result = await decodeSession(portable, { catalog, codec: target })
  assert.equal(result.header.cwd, String.raw`C:\Users\synthetic-target\project`)
})

test('encoded and path-remapped byte limits reject without touching persistence', async () => {
  await assert.rejects(decodeSession(bytesFor(), { catalog, maxBytes: 2 }), /encoded byte limit/)
  await assert.rejects(decodeSession(bytesFor(), { catalog, maxBytes: MAX_SESSION_BYTES + 1 }), /byte limit/)
  await assert.rejects(decodeSession(bytesFor(), { catalog, codec: { fromPortable: text => text + ' '.repeat(1000) + '\n' }, maxBytes: 500 }), /path-remapped byte limit/)
  await assert.rejects(decodeSession(bytesFor(), { catalog, codec: {} }), /fromPortable/)
  await assert.rejects(decodeSession(bytesFor(), { catalog, codec: { fromPortable: () => null } }), /return text/)
})

const hasZstd = typeof zlib.zstdCompressSync === 'function'
const compress = value => zlib.zstdCompressSync(value, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
const compressedFor = (head = header, events = [message]) => Buffer.concat([
  compress(bytesFor(head, [])),
  ...(events.length ? [compress(Buffer.from(events.map(value => JSON.stringify(value)).join('\n') + '\n'))] : []),
])

test('concatenated Zstd header and event frames all decode, not just the first frame', { skip: !hasZstd }, async () => {
  const second = { ...message, seq: 1, time: 3 }
  const encoded = Buffer.concat([compressedFor(), compress(Buffer.from(JSON.stringify(second) + '\n'))])
  const result = await decodeSession(encoded, { compressed: true, catalog })
  assert.deepEqual(result.events, [message, second])
})

test('Zstd portability mapping runs on decompressed JSONL', { skip: !hasZstd }, async () => {
  const source = createCodec(String.raw`C:\Users\synthetic-source`)
  const target = createCodec(String.raw`C:\Users\synthetic-target`)
  const portableHeader = JSON.parse(source.toPortable(JSON.stringify({ ...header, cwd: String.raw`C:\Users\synthetic-source\project` })))
  const result = await decodeSession(compressedFor(portableHeader), { compressed: true, catalog, codec: target })
  assert.equal(result.header.cwd, String.raw`C:\Users\synthetic-target\project`)
  assert.equal(result.events.length, 1)
})

test('torn later Zstd frames, checksum corruption and trailing garbage never silently disappear', { skip: !hasZstd }, async () => {
  const encoded = compressedFor()
  for (const cut of [1, 2, 4, 7]) await assert.rejects(decodeSession(encoded.subarray(0, -cut), { compressed: true, catalog }))
  await assert.rejects(decodeSession(Buffer.concat([encoded, Buffer.from([1, 2, 3])]), { compressed: true, catalog }), /Truncated/)
  await assert.rejects(decodeSession(Buffer.concat([encoded, Buffer.from('garbage!')]), { compressed: true, catalog }), /frame magic/)
  const damaged = Buffer.from(encoded)
  damaged[damaged.length - 1] ^= 1
  await assert.rejects(decodeSession(damaged, { compressed: true, catalog }))
})

test('Zstd must have an independent header frame and complete event record boundaries', { skip: !hasZstd }, async () => {
  await assert.rejects(decodeSession(compress(bytesFor()), { compressed: true, catalog }), /exactly one header/)
  const brokenBoundary = Buffer.concat([compress(bytesFor(header, [])), compress(Buffer.from(JSON.stringify(message)))])
  await assert.rejects(decodeSession(brokenBoundary, { compressed: true, catalog }), /complete JSONL record/)
})

test('Zstd decoded output is bounded across frames', { skip: !hasZstd }, async () => {
  const large = { ...message, data: { text: 'x'.repeat(4096) } }
  const encoded = compressedFor(header, [large])
  assert.ok(encoded.length < 1000)
  await assert.rejects(decodeSession(encoded, { compressed: true, catalog, maxBytes: 1000 }))
})

// Opt-in: run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.
// The catalog imports pure codecs only; all artifacts below are synthetic memory buffers.
test('installed native catalog decodes synthetic v4 plain/Zstd and rejects invalid native events', { skip: process.env.DSH_SYNC_NATIVE_CATALOG_TEST !== '1' }, async () => {
  const native = await loadSessionCatalog()
  assert.equal(native.currentVersion, 4)
  const nativeHeader = { ...header, version: native.currentVersion }
  const title = { type: 'session/title', seq: 0, time: 2, data: { title: 'synthetic-only', messageSeqs: [], source: { kind: 'user' } } }
  const plain = await decodeSession(bytesFor(nativeHeader, [title]), { catalog: native })
  assert.equal(plain.events.length, 1)
  assert.equal(plain.header.id, header.id)
  assert.equal(plain.inheritedEventCount, 0)
  if (hasZstd) assert.deepEqual(await decodeSession(compressedFor(nativeHeader, [title]), { compressed: true, catalog: native }), plain)
  const seed = { type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }
  const seeded = await decodeSession(bytesFor({ ...nativeHeader, isSeeded: true }, [title, seed]), { catalog: native })
  assert.equal(seeded.inheritedEventCount, 1)
  await assert.rejects(decodeSession(bytesFor(nativeHeader, [{ ...title, type: 'unknown/event' }]), { catalog: native }))
  await assert.rejects(decodeSession(bytesFor({ ...nativeHeader, version: native.currentVersion + 1 }, []), { catalog: native }))
})

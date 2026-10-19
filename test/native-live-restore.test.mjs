/**
 * Opt-in isolated integration: packaged Electron, ELECTRON_RUN_AS_NODE=1 and
 * DSH_SYNC_NATIVE_CATALOG_TEST=1. No connection to the active DSH Host or network.
 * Every artifact belongs to a freshly allocated temporary DSH_HOME.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { applyLiveRestore } from '../lib/live-restore.js'
import { loadSessionCatalog } from '../lib/live-session.js'
import { createCodec } from '../lib/pathcodec.js'
import { hash } from '../lib/restore-safety.js'

async function nativeModule(name) {
  const resources = typeof process.resourcesPath === 'string'
    ? process.resourcesPath : path.join(path.dirname(process.execPath), 'resources')
  const anchors = [path.join(resources, 'app.asar', 'dsh', 'package.json'), path.join(resources, 'app', 'dsh', 'package.json')]
  for (const anchor of anchors) {
    if (!fs.existsSync(anchor)) continue
    return import(pathToFileURL(createRequire(anchor).resolve(name)).href)
  }
  throw new Error('Run this isolated test with the packaged Electron executable.')
}

const enabled = process.env.DSH_SYNC_NATIVE_CATALOG_TEST === '1'
test('native online restore uses an isolated real session store and JSONL backend', { skip: !enabled, concurrency: false }, async t => {
  const [cordis, sessionModule, persistenceModule, catalog] = await Promise.all([
    nativeModule('@deepseek-ai/cordis'),
    nativeModule('@deepseek-ai/dsh-session'),
    nativeModule('@deepseek-ai/dsh-session-persistence-jsonl'),
    loadSessionCatalog(),
  ])
  const tempParent = await fsp.realpath(os.tmpdir())
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(tempParent, 'dsh-sync-native-test-')))
  const dshHome = path.join(root, 'isolated-dsh-home')
  const originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const ctx = new cordis.Context()
  let persistence
  try {
    await fsp.mkdir(dshHome, { recursive: true })
    const sessions = new sessionModule.SessionStore(ctx)
    // The packaged backend is a Cordis plugin, not a default-exported Service.
    // Await its nested service registration before using the real persistence seam.
    const backend = ctx.plugin(persistenceModule, { root: path.join(dshHome, 'sessions'), compression: 'none' })
    await backend.await()
    persistence = ctx.sessionPersistence
    assert.ok(persistence, 'the real JSONL plugin must register sessionPersistence')
    assert.equal(persistence.root, path.join(dshHome, 'sessions'))
    const cfg = { profiles: ['desktop'], extras: [], includeAttachments: false }
    const codec = createCodec(os.homedir())
    const runtime = { sessions, persistence, catalog: async () => catalog, busyPaths: () => [] }
    const header = id => ({ version: catalog.currentVersion, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })
    const title = (seq, text = `synthetic-${seq}`) => ({ type: 'session/title', seq, time: seq + 2, data: { title: text, messageSeqs: [], source: { kind: 'user' } } })
    const marker = seq => ({ type: 'session/end-seed', seq, time: seq + 2, data: { inherited: true } })

    async function stageLog(meta, events, inheritedEventCount = 0) {
      const stage = path.join(dshHome, 'sync-restores', randomUUID())
      await fsp.mkdir(path.join(stage, 'files'), { recursive: true })
      const repoPath = `sessions/synthetic-project/${meta.id}/session.v${catalog.currentVersion}.jsonl`
      const bytes = Buffer.from([
        catalog.encodeCurrentHeader(meta, inheritedEventCount),
        ...events.map(event => catalog.encodeCurrentEvent(event)),
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      await fsp.writeFile(path.join(stage, 'files', '0.bin'), bytes, { flag: 'wx' })
      await fsp.writeFile(path.join(stage, 'plan.json'), JSON.stringify({
        schema: 1, mode: 'online', machine: os.hostname(), dshHome,
        files: [{ source: 'files/0.bin', destination: path.join(dshHome, ...repoPath.split('/')), repoPath, size: bytes.length, sha256: hash(bytes), previousHash: null }],
        unmapped: [],
      }), { flag: 'wx' })
      return stage
    }
    async function apply(meta, events, inheritedEventCount = 0) {
      return applyLiveRestore(await stageLog(meta, events, inheritedEventCount), { dshHome, cfg, codec, runtime })
    }
    async function readStored(id) {
      const handle = await persistence.open(id, 'read')
      try {
        return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events }
      } finally { await handle.close() }
    }

    await t.test('new cold Session is created and read back without entering SessionStore', async () => {
      const meta = header('synthetic-new-session')
      const events = [title(0)]
      const result = await apply(meta, events)
      assert.equal(result.ok, true, result.summary)
      assert.equal(result.copied, 1, result.summary)
      assert.deepEqual(await readStored(meta.id), { header: meta, events, inheritedEventCount: 0 })
      assert.equal(sessions.get(meta.id), undefined)
    })

    await t.test('existing cold Session appends only the exact longer prefix and releases ownership', async () => {
      const meta = header('synthetic-new-session')
      const events = [title(0), title(1)]
      const result = await apply(meta, events)
      assert.equal(result.ok, true, result.summary)
      assert.equal(result.copied, 1, result.summary)
      assert.deepEqual((await readStored(meta.id)).events, events)
      const writer = await persistence.open(meta.id, 'write')
      await writer.close()
      assert.equal(sessions.get(meta.id), undefined)
    })

    await t.test('new seeded Session permits an empty create handle before its complete seed append', async () => {
      const meta = { ...header('synthetic-seeded-session'), isSeeded: true }
      const events = [title(0), marker(1), title(2)]
      const probeMeta = { ...meta, id: 'synthetic-unmaterialized-seed-probe' }
      const probe = await persistence.create(probeMeta, { inheritedEventCount: 1 })
      try {
        assert.equal(probe.inheritedEventCount, 1)
        assert.deepEqual((await probe.read()).events, [])
      } finally { await probe.close() }
      assert.equal(await persistence.stat(probeMeta.id), undefined)
      const result = await apply(meta, events, 1)
      assert.equal(result.ok, true, result.summary)
      assert.equal(result.copied, 1, result.summary)
      assert.deepEqual(await readStored(meta.id), { header: meta, events, inheritedEventCount: 1 })
      const appended = [...events, title(3)]
      const second = await apply(meta, appended, 1)
      assert.equal(second.ok, true, second.summary)
      assert.deepEqual((await readStored(meta.id)).events, appended)
    })

    await t.test('idle loaded Sessions, divergent histories and owned writers are not overwritten', async () => {
      const meta = header('synthetic-new-session')
      const original = await readStored(meta.id)
      const prepared = sessions.prepare(meta.id, { seed: structuredClone(original.events), meta: original.header, inheritedEventCount: 0, eventState: 'detached' })
      const detach = sessions.enter(prepared)
      try {
        const loaded = await apply(meta, [...original.events, title(2)])
        assert.equal(loaded.ok, true, loaded.summary)
        assert.equal(loaded.deferred, 1, loaded.summary)
        assert.deepEqual((await readStored(meta.id)).events, original.events)
      } finally { detach() }
      const forked = await apply(meta, [title(0, 'different-prefix')])
      assert.equal(forked.deferred, 1, forked.summary)
      assert.deepEqual((await readStored(meta.id)).events, original.events)
      const owner = await persistence.open(meta.id, 'write')
      try {
        await assert.rejects(persistence.open(meta.id, 'write'), error => error.name === 'SessionAlreadyOwnedError')
        await assert.rejects(persistence.create(meta), error => error.name === 'SessionAlreadyExistsError')
        const held = await apply(meta, [...original.events, title(2)])
        assert.equal(held.ok, true, held.summary)
        assert.equal(held.deferred, 1, held.summary)
      } finally { await owner.close() }
      assert.deepEqual((await readStored(meta.id)).events, original.events)
    })

    await t.test('header-only new Sessions materialize without publishing an Agent', async () => {
      const meta = header('synthetic-empty-session')
      const result = await apply(meta, [])
      assert.equal(result.ok, true, result.summary)
      assert.equal(result.copied, 1, 'empty-session creation must be counted')
      assert.deepEqual(await readStored(meta.id), { header: meta, events: [], inheritedEventCount: 0 })
      assert.equal(sessions.list().length, 0)
    })
  } finally {
    try {
      await persistence?.flush()
      await ctx.fiber.dispose()
    } finally {
      if (originalHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalHome
      // This is the exact freshly allocated test root, not a user-controlled path.
      assert.equal(path.dirname(root), tempParent)
      assert.match(path.basename(root), /^dsh-sync-native-test-/)
      assert.equal(await fsp.realpath(root), root)
      await fsp.rm(root, { recursive: true, force: true })
    }
  }
})

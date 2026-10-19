/** Native OpenSSH portable snapshot store (no shell and no third-party dependencies).
 * runner contract: async ({command,args,batch,batchPath,stdoutPath,stderrPath,timeoutMs,reportProgress,signal})
 * => {code:number, stdout?:string, stderr?:string}. It must execute the batch in order,
 * write get destinations, honor '-' optional commands, and reject transport failures.
 * stdout/stderr may instead be written to the supplied log paths. Do not use pipes.
 * Runners must honor signal and settle only after process teardown (no later writes).
 * Lock acquisition, publication/confirmation, and cleanup omit signal intentionally.
 * Wire format: latest.json and snapshots/<id>.json are identical version-1 manifests.
 * id = SHA256(JSON.stringify({version:1,files})); files are sorted by rel.
 * Limits intentionally apply to untrusted remote manifests as well as local uploads.
 * onProgress counters are phase-local; totals of 0 during scan/connect/publish
 * mean unknown/indeterminate, not a percentage. transferredBytes is cumulative
 * confirmed SFTP payload (including manifests), not SSH protocol overhead.
 * Upload progress counts completed files as subsequent command echoes confirm
 * each mandatory put; a current file's in-flight bytes remain unknown. Only done signals
 * successful verified upload/restore, and observer failures are always isolated.
 */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { throwIfCancelled, cancellationError } from './transfer-control.js'
import { createBatchEchoTracker, transferBatchTimeoutMs } from './sftp-progress.js'

const MAX_FILES = 100000, MAX_BYTES = 100 * 1024 ** 3, MAX_MANIFEST = 32 * 1024 ** 2
const HASH = /^[a-f0-9]{64}$/
const sha = data => createHash('sha256').update(data).digest('hex')
const fail = message => { throw new Error(message) }
const unsafeText = value => /[\x00-\x1f\x7f]/.test(value)
function quote(value) {
  if (typeof value !== 'string' || unsafeText(value)) fail('Unsafe SFTP batch path')
  // OpenSSH batch lexer consumes backslash escapes inside double quotes.
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || unsafeText(rel) || /[\\:*?"<>|]/.test(rel)) fail('Unsafe relative path')
  const parts = rel.split('/')
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || p.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('Unsafe relative path')
  if (parts.some(p => /^\.env(?:\.|$)|\.(pem|key|p12|pfx)$/i.test(p) || ['.ssh', '.gnupg', '.aws', 'id_rsa', 'id_ed25519', '.git-credentials', '.npmrc', '.credentials.yaml', 'dsh-sync.json', 'dsh-sync-auth.json'].includes(p.toLowerCase()))) fail('Credentials are forbidden in snapshots')
  return rel
}
export function validateSftpConfig(sftp) {
  if (!sftp || typeof sftp !== 'object') fail('SFTP configuration required')
  const { host, privateKeyPath, hostKey } = sftp
  const port = sftp.port ?? 22, username = sftp.username ?? 'dshsync', remoteRoot = sftp.remoteRoot ?? '/data/dsh-sync'
  if (typeof host !== 'string' || !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|[a-fA-F0-9:]+)$/.test(host) || host.length > 253) fail('Invalid SFTP host')
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid SFTP port')
  if (typeof username !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)) fail('Invalid SFTP username')
  if (typeof privateKeyPath !== 'string' || unsafeText(privateKeyPath) || !path.isAbsolute(privateKeyPath) || /["\r\n]/.test(privateKeyPath)) fail('privateKeyPath must be an absolute path')
  if (typeof hostKey !== 'string' || unsafeText(hostKey) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/.test(hostKey)) fail('A pinned complete ssh-ed25519 hostKey is required')
  const key = Buffer.from(hostKey.split(' ')[1], 'base64')
  if (key.length !== 51 || key.readUInt32BE(0) !== 11 || key.subarray(4, 15).toString() !== 'ssh-ed25519' || key.readUInt32BE(15) !== 32 || key.toString('base64') !== hostKey.split(' ')[1]) fail('Invalid ssh-ed25519 hostKey')
  if (typeof remoteRoot !== 'string' || !/^\/data\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(remoteRoot) || remoteRoot.split('/').some(p => p.toLowerCase() === '.git')) fail('remoteRoot must be a safe absolute /data/ subdirectory')
  return { host, port, username, privateKeyPath, hostKey: hostKey.split(' ').slice(0, 2).join(' '), remoteRoot }
}
async function noLinks(abs, allowMissing = false) {
  abs = path.resolve(abs)
  const root = path.parse(abs).root
  let cur = root
  for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part)
    try { if ((await fs.lstat(cur)).isSymbolicLink()) fail('Links are forbidden: ' + cur) }
    catch (e) { if (allowMissing && e.code === 'ENOENT') return; throw e }
  }
}
async function readRegular(file, limit = MAX_BYTES) {
  await noLinks(file)
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail('Unsafe or oversized file')
    const data = await handle.readFile()
    if (data.length !== stat.size) fail('File changed while reading')
    return data
  } finally { await handle.close() }
}
function makeManifest(files) {
  const body = { version: 1, files }
  return { ...body, id: sha(JSON.stringify(body)) }
}
function parseManifest(data, signal) {
  throwIfCancelled(signal)
  if (data.length > MAX_MANIFEST) fail('Manifest too large')
  let m
  try { m = JSON.parse(data.toString('utf8')) } catch { fail('Invalid manifest JSON') }
  if (!m || m.version !== 1 || !HASH.test(m.id) || !Array.isArray(m.files) || m.files.length > MAX_FILES) fail('Invalid manifest version/id/count')
  let total = 0, previous = ''
  const paths = new Set(), parents = new Set()
  for (const f of m.files) {
    throwIfCancelled(signal)
    if (!f || typeof f !== 'object' || Object.keys(f).sort().join(',') !== 'rel,sha256,size') fail('Invalid manifest file')
    safeRelative(f.rel)
    if (f.rel <= previous || !HASH.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) fail('Invalid manifest path/hash/size or duplicate path')
    const folded = f.rel.toLowerCase(), segments = folded.split('/')
    if (paths.has(folded) || parents.has(folded)) fail('Manifest path collision')
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/')
      if (paths.has(parent)) fail('Manifest path collision')
      parents.add(parent)
    }
    paths.add(folded)
    previous = f.rel; total += f.size
    if (total > MAX_BYTES) fail('Manifest total size limit exceeded')
  }
  if (!m.files.some(f => f.rel === 'meta.json') || makeManifest(m.files).id !== m.id || Object.keys(m).sort().join(',') !== 'files,id,version') fail('Manifest hash mismatch or missing meta.json')
  return m
}
async function nativeRunner({ command, args, stdoutPath, stderrPath, timeoutMs, reportProgress, reportDownloads, signal }) {
  throwIfCancelled(signal)
  const out = await fs.open(stdoutPath, 'w', 0o600)
  let err
  try {
    err = await fs.open(stderrPath, 'w', 0o600)
    throwIfCancelled(signal)
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', out.fd, err.fd] })
      let timedOut = false, aborted = false, processError, polling
      // Cancellation only settles after close: no process may still write files
      // when the caller removes its staging directory or closes these descriptors.
      const abort = () => { aborted = true; child.kill('SIGKILL') }
      const progressTimer = setInterval(() => {
        if (polling) return
        polling = Promise.resolve().then(() => (reportProgress || reportDownloads)?.()).catch(() => {}).finally(() => { polling = undefined })
      }, 250)
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      child.once('error', e => { processError = e })
      child.once('close', async code => {
        clearTimeout(timer); clearInterval(progressTimer)
        signal?.removeEventListener('abort', abort)
        await polling
        if (aborted) reject(cancellationError())
        else if (processError) reject(processError)
        else if (timedOut) reject(new Error('SFTP timeout after ' + Math.round(timeoutMs / 1000) + 's; remote outcome is unknown; snapshot was not confirmed'))
        else resolve({ code })
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally { await out.close(); await err?.close() }
}
export function createSftpStore(sftp, { cacheDir, runner = nativeRunner, onProgress = () => {}, signal } = {}) {
  const config = validateSftpConfig(sftp)
  if (typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir)) fail('Absolute cacheDir required')
  if (typeof runner !== 'function') fail('runner must be a function')
  const remote = suffix => config.remoteRoot + '/' + suffix
  async function session(fn) {
    throwIfCancelled(signal)
    await noLinks(cacheDir, true); await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 })
    const temp = await fs.mkdtemp(path.join(cacheDir, 'sftp-'))
    const known = path.join(temp, 'known_hosts')
    const alias = '[' + config.host + ']:' + config.port
    let serial = 0
    const started = Date.now()
    const progress = { phase: 'connect', completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0, transferredBytes: 0, connections: 0 }
    let receivedInStage = 0, verifiedInStage = 0
    function emit() {
      const elapsedMs = Date.now() - started
      try {
        const result = onProgress({ ...progress, elapsedMs, speedBytesPerSecond: elapsedMs ? progress.transferredBytes * 1000 / elapsedMs : 0 })
        // Also isolate rejected async observers.
        if (result?.catch) result.catch(() => {})
      } catch {}
    }
    function phase(name, totalBytes = 0, totalFiles = 0) {
      receivedInStage = 0; verifiedInStage = 0
      Object.assign(progress, { phase: name, completedBytes: 0, completedFiles: 0, totalBytes, totalFiles }); emit()
    }
    async function batch(lines, { onDownloads = () => {}, cancellable = true, expectedDownloadBytes = 0 } = {}) {
      const batchSignal = cancellable ? signal : undefined
      throwIfCancelled(batchSignal)
      const n = ++serial, batchPath = path.join(temp, n + '.batch'), stdoutPath = path.join(temp, n + '.out'), stderrPath = path.join(temp, n + '.err')
      const text = lines.join('\n') + '\n'
      await fs.writeFile(batchPath, text, { mode: 0o600 })
      // Native request window: 128 KiB x 64, without pipes or multiplexing.
      const args = ['-b', batchPath, '-B', '131072', '-R', '64', '-P', String(config.port), '-i', config.privateKeyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + quote(known.replace(/\\/g, '/')), '-o', 'GlobalKnownHostsFile=' + quote(known.replace(/\\/g, '/')), '-o', 'HostKeyAlias=' + alias, '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6']
      if (process.platform === 'win32') args.push('-o', 'KexAlgorithms=curve25519-sha256')
      args.push(config.username + '@' + (config.host.includes(':') ? '[' + config.host + ']' : config.host))
      const transfers = [], uploads = new Map()
      for (const [index, line] of lines.entries()) {
        const tokens = line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g)?.map(t => t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t)
        const [op, a, b] = tokens || []
        if (op === 'put') {
          const upload = { local: a, upload: true, size: (await fs.stat(a)).size, confirmed: false }
          transfers.push(upload); uploads.set(index, upload)
        }
        if (op === 'get' || op === '-get') transfers.push({ local: b, upload: false, index })
      }
      let reported = 0, active = true, outputOffset = 0
      function confirmUpload(index) {
        const upload = uploads.get(index)
        if (!active || !upload || upload.confirmed) return
        upload.confirmed = true
        progress.transferredBytes += upload.size
        if (progress.phase === 'upload') completed(upload.size)
        else emit()
      }
      const confirmUploads = () => { for (const index of uploads.keys()) confirmUpload(index) }
      const tracker = createBatchEchoTracker(lines, confirmUpload)
      async function readEchoes() {
        if (!uploads.size || !active) return
        let file
        try {
          file = await fs.open(stdoutPath, 'r')
          // Bounded incremental reads; never reread an ever-growing transcript.
          const buffer = Buffer.alloc(64 * 1024)
          for (let i = 0; i < 4; i++) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, outputOffset)
            if (!bytesRead || !active) break
            outputOffset += bytesRead
            tracker.push(buffer.subarray(0, bytesRead))
          }
        } catch {
          // Telemetry must not alter the batch outcome. A successful exit can
          // supply missing counts even if this OpenSSH version has no echoes.
        } finally { await file?.close().catch(() => {}) }
      }
      async function reportProgress() {
        await readEchoes()
        const downloads = transfers.filter(t => !t.upload)
        const sizes = await Promise.all(downloads.map(t => fs.stat(t.local).then(s => s.size).catch(() => null)))
        if (!active) return
        if (sizes.some(size => size !== null)) {
          // Native ordered batches start readback only after every preceding
          // mandatory put succeeded. Fill buffered/unavailable echo feedback
          // before the caller changes phase from upload to verify.
          const lastStartedGet = downloads.reduce((last, item, i) => sizes[i] !== null ? Math.max(last, item.index) : last, -1)
          for (const index of uploads.keys()) if (index < lastStartedGet) confirmUpload(index)
          onDownloads()
        }
        const bytes = sizes.reduce((a, b) => a + (b ?? 0), 0)
        if (bytes > reported) {
          const delta = bytes - reported
          progress.transferredBytes += delta
          if (progress.phase === 'download') {
            receivedInStage += delta
            progress.completedBytes = Math.min(progress.totalBytes, Math.max(receivedInStage, verifiedInStage))
          }
          reported = bytes; emit()
        }
      }
      const timeoutMs = transferBatchTimeoutMs({
        commands: lines.length,
        bytes: [...uploads.values()].reduce((n, t) => n + t.size, 0) + expectedDownloadBytes,
        dataBatch: cancellable && transfers.length > 0 && ['upload', 'download', 'verify'].includes(progress.phase),
      })
      progress.connections++; emit()
      throwIfCancelled(batchSignal)
      try {
        const result = await runner({ command: 'sftp', args, batch: text, batchPath, stdoutPath, stderrPath, timeoutMs, reportProgress, reportDownloads: reportProgress, signal: batchSignal })
        await reportProgress()
        throwIfCancelled(batchSignal)
        const stderr = result?.stderr ?? await fs.readFile(stderrPath, 'utf8').catch(() => '')
        // Ignored -mkdir diagnostics do not prove that the final mandatory command
        // ran. Only exit 0 confirms batch completion and, for acquisition, ownership.
        // Never accept a failed/killed process based on partial stderr alone.
        if (!result || result.code !== 0) fail('SFTP batch ' + n + ' failed (exit ' + (result?.code ?? 'unknown') + '): ' + (stderr.trim().slice(-1400) || 'no stderr; remote outcome is unknown'))
        // '-' only permits missing files/directories, never authentication or permission failures.
        if (/permission denied|connection closed|connection lost|host key verification failed/i.test(stderr) || (/failure/i.test(stderr) && !lines.some(line => line.startsWith('-mkdir ')))) fail('SFTP error: ' + stderr.slice(-1400))
        // Fill the final put/no-echo runners exactly once, only after exit 0.
        confirmUploads(); emit()
        return stderr
      } catch (error) { throwIfCancelled(batchSignal); throw error }
      finally { try { await reportProgress() } finally { active = false } }
    }
    function manifestRequest(suffix = 'latest.json') {
      const local = path.join(temp, 'manifest-' + randomUUID())
      return { line: '-get ' + quote(remote(suffix)) + ' ' + quote(local), async read(stderr, { cancellable = true } = {}) {
        const readSignal = cancellable ? signal : undefined
        throwIfCancelled(readSignal)
        try { return parseManifest(await readRegular(local, MAX_MANIFEST), readSignal) }
        catch (e) { if (e.code === 'ENOENT' && /no such file|not found/i.test(stderr)) return null; throw e }
      } }
    }
    async function getManifest(suffix) {
      const request = manifestRequest(suffix)
      return request.read(await batch([request.line]))
    }
    function completed(bytes, files = 1) {
      verifiedInStage += bytes
      progress.completedBytes = progress.phase === 'download' ? Math.min(progress.totalBytes, Math.max(receivedInStage, verifiedInStage)) : verifiedInStage
      progress.completedFiles += files; emit()
    }
    let terminal, result
    function done(bytes, files) { terminal = { phase: 'done', completedBytes: bytes, totalBytes: bytes, completedFiles: files, totalFiles: files } }
    try {
      throwIfCancelled(signal)
      await fs.writeFile(known, alias + ' ' + config.hostKey + '\n', { mode: 0o600 })
      emit()
      throwIfCancelled(signal)
      result = await fn({ temp, batch, getManifest, manifestRequest, phase, completed, done })
    }
    finally { await fs.rm(temp, { recursive: true, force: true }) }
    // Only successful verification/publication/restoration AND cleanup may emit done.
    if (terminal) { Object.assign(progress, terminal); emit() }
    return result
  }
  async function verifiedObjects(ctx, manifest, optional = false, prefix = [], beforeVerify = () => {}) {
    const unique = new Map()
    for (const f of manifest.files) {
      throwIfCancelled(signal)
      if (unique.has(f.sha256) && unique.get(f.sha256).size !== f.size) fail('Inconsistent object size')
      unique.set(f.sha256, f)
    }
    const dir = path.join(ctx.temp, 'objects-' + randomUUID()); await fs.mkdir(dir)
    const entries = [...unique.values()].map(f => ({ ...f, local: path.join(dir, f.sha256) }))
    const lines = [...prefix.map(p => p.line), ...entries.map(f => (optional ? '-get ' : 'get ') + quote(remote('objects/' + f.sha256)) + ' ' + quote(f.local))]
    let verificationStarted = false
    const beginVerify = () => { if (!verificationStarted) { verificationStarted = true; beforeVerify() } }
    const expectedDownloadBytes = entries.reduce((n, f) => n + f.size, 0) + prefix.filter(p => p.read).length * MAX_MANIFEST
    const stderr = lines.length ? await ctx.batch(lines, { onDownloads: beginVerify, expectedDownloadBytes }) : ''
    // Validate immutable metadata before allowing any repair or publication.
    for (const request of prefix) {
      throwIfCancelled(signal)
      if (request.read) await request.validate(await request.read(stderr))
    }
    beginVerify()
    const found = new Map()
    for (const f of entries) {
      throwIfCancelled(signal)
      let data
      try { data = await readRegular(f.local, f.size) }
      catch (e) { if (optional && e.code === 'ENOENT' && /no such file|not found/i.test(stderr)) continue; throw e }
      throwIfCancelled(signal)
      if (data.length !== f.size || sha(data) !== f.sha256) fail('Object hash/size mismatch: ' + f.rel)
      found.set(f.sha256, f.local)
      ctx.completed(f.size)
    }
    return found
  }
  return {
    inspect: () => session(ctx => ctx.getManifest()),
    async upload(workDir, { expectedId = null } = {}) {
      throwIfCancelled(signal)
      if (expectedId !== null && !HASH.test(expectedId)) fail('Invalid expectedId')
      await noLinks(workDir)
      return session(async ctx => {
        ctx.phase('scan')
        const files = [], locals = new Map(); let bytes = 0
        async function walk(dir, rel = '') {
          throwIfCancelled(signal)
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            throwIfCancelled(signal)
            if (entry.name.toLowerCase() === '.git') continue
            const name = safeRelative(rel + entry.name), abs = path.join(dir, entry.name)
            const stat = await fs.lstat(abs)
            if (stat.isSymbolicLink()) fail('Links are forbidden')
            if (stat.isDirectory()) await walk(abs, name + '/')
            else if (stat.isFile()) {
              const data = await readRegular(abs); throwIfCancelled(signal); bytes += data.length
              if (bytes > MAX_BYTES || files.length >= MAX_FILES) fail('Snapshot size/count limit exceeded')
              const hash = sha(data), local = path.join(ctx.temp, hash)
              if (!locals.has(hash)) { await fs.writeFile(local, data, { mode: 0o600 }); locals.set(hash, local) }
              files.push({ rel: name, sha256: hash, size: data.length })
              ctx.completed(data.length)
            } else fail('Unsupported file type')
          }
        }
        await walk(path.resolve(workDir)); files.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
        const manifest = parseManifest(Buffer.from(JSON.stringify(makeManifest(files))), signal)
        const parts = config.remoteRoot.split('/').slice(2); let root = '/data'
        const mkdirs = parts.map(part => { root += '/' + part; return '-mkdir ' + quote(root) })
        ctx.phase('connect')
        let locked = false, result
        try {
          // Lock is the final command: success proves ownership. Never unlock a
          // failed/unknown acquisition, including an existing writer's lock.
          throwIfCancelled(signal)
          try { await ctx.batch([...mkdirs, '-mkdir ' + quote(remote('objects')), '-mkdir ' + quote(remote('snapshots')), 'mkdir ' + quote(remote('.lock'))], { cancellable: false }); locked = true }
          catch (e) {
            // Keep the underlying failure visible even to callers that serialize
            // only Error.message. Failure may be transport/auth/path, not a busy lock.
            throw new Error('SFTP lock acquisition failed; lock ownership is unknown; no lock was removed. Cause: ' + String(e?.message || e).slice(-1600), { cause: e })
          }
          throwIfCancelled(signal)
          const current = await ctx.getManifest()
          if ((current?.id ?? null) !== expectedId) fail('Remote latest differs from expectedId; download first before uploading')
          const unique = [...new Map(manifest.files.map(f => [f.sha256, f])).values()]
          const known = new Set(current?.files.map(f => f.sha256) || [])
          const reused = unique.filter(f => known.has(f.sha256))
          let oldSnapshot
          const snapshot = ctx.manifestRequest('snapshots/' + manifest.id + '.json')
          snapshot.validate = value => { oldSnapshot = value; if (value && value.id !== manifest.id) fail('Immutable snapshot mismatch') }
          ctx.phase('verify', reused.reduce((n, f) => n + f.size, 0), reused.length)
          const existing = await verifiedObjects(ctx, { files: reused }, true, [snapshot])
          const missing = unique.filter(f => !existing.has(f.sha256))
          if (missing.length) {
            ctx.phase('upload', missing.reduce((n, f) => n + f.size, 0), missing.length)
            // New hashes are put directly; absent reused hashes are repaired.
            // All readbacks finish before any manifest can be published.
            const puts = missing.map(f => 'put ' + quote(locals.get(f.sha256)) + ' ' + quote(remote('objects/' + f.sha256)))
            await verifiedObjects(ctx, { files: missing }, false, puts.map(line => ({ line })), () => {
              ctx.phase('verify', missing.reduce((n, f) => n + f.size, 0), missing.length)
            })
          }
          // No state change is needed only when BOTH manifests already exist and
          // every unique object has just passed readback verification under lock.
          // Missing immutable metadata or repaired objects still take publication.
          if (current?.id !== manifest.id || !oldSnapshot || missing.length) {
            const local = path.join(ctx.temp, 'publish.json'); await fs.writeFile(local, JSON.stringify(manifest), { mode: 0o600 })
            const pending = remote('latest.' + randomUUID() + '.tmp'), confirmation = ctx.manifestRequest()
            ctx.phase('publish')
            throwIfCancelled(signal)
            // Commit and confirmation form one protected batch. A confirmed
            // publication wins over a cancellation arriving during commit.
            const confirmed = await confirmation.read(await ctx.batch([
              ...(!oldSnapshot ? ['put ' + quote(local) + ' ' + quote(remote('snapshots/' + manifest.id + '.json'))] : []),
              'put ' + quote(local) + ' ' + quote(pending), 'rename ' + quote(pending) + ' ' + quote(remote('latest.json')), confirmation.line,
            ], { cancellable: false }), { cancellable: false })
            if (confirmed?.id !== manifest.id) fail('Published manifest confirmation failed')
          } else throwIfCancelled(signal)
          result = { id: manifest.id, files: manifest.files, bytes, verified: true }
        } finally { if (locked) await ctx.batch(['rmdir ' + quote(remote('.lock'))], { cancellable: false }) }
        ctx.done(bytes, files.length)
        return result
      })
    },
    async download(workDir) {
      throwIfCancelled(signal)
      const target = path.resolve(workDir)
      await noLinks(target, true)
      return session(async ctx => {
        const manifest = await ctx.getManifest()
        if (!manifest) fail('No remote snapshot')
        const unique = [...new Map(manifest.files.map(f => [f.sha256, f])).values()]
        ctx.phase('download', unique.reduce((n, f) => n + f.size, 0), unique.length)
        const objects = await verifiedObjects(ctx, manifest)
        const bytes = manifest.files.reduce((n, f) => n + f.size, 0)
        ctx.phase('restore', bytes, manifest.files.length)
        const parent = path.dirname(target); await noLinks(parent, true); await fs.mkdir(parent, { recursive: true })
        const stage = await fs.mkdtemp(path.join(parent, '.sftp-download-')), backup = target + '.sftp-backup-' + randomUUID()
        let moved = false, installed = false, gitMoved = false
        try {
          for (const f of manifest.files) {
            throwIfCancelled(signal)
            const dest = path.join(stage, ...f.rel.split('/')); await fs.mkdir(path.dirname(dest), { recursive: true })
            await fs.copyFile(objects.get(f.sha256), dest)
            ctx.completed(f.size)
          }
          await noLinks(target, true)
          throwIfCancelled(signal)
          // Once replacement starts, finish install/rollback without cancellation.
          try { await fs.rename(target, backup); moved = true } catch (e) { if (e.code !== 'ENOENT') throw e }
          // Preserve checkout metadata without reading it or putting it in the snapshot.
          if (moved) {
            const git = path.join(backup, '.git')
            try { await noLinks(git); await fs.rename(git, path.join(stage, '.git')); gitMoved = true }
            catch (e) { if (e.code !== 'ENOENT') throw e }
          }
          await fs.rename(stage, target); installed = true
        } catch (e) {
          if (gitMoved && !installed) await fs.rename(path.join(stage, '.git'), path.join(backup, '.git'))
          if (moved && !installed) await fs.rename(backup, target)
          throw e
        } finally {
          if (!installed) await fs.rm(stage, { recursive: true, force: true })
        }
        if (moved) await fs.rm(backup, { recursive: true, force: true })
        ctx.done(bytes, manifest.files.length)
        return { id: manifest.id, files: manifest.files, bytes }
      })
    },
  }
}

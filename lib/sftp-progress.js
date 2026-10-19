import { StringDecoder } from 'node:string_decoder'

// A batch echo is emitted BEFORE the command runs. Only the next expected,
// complete command echo is evidence that its mandatory predecessor completed.
// This is telemetry only: it must never establish lock ownership or publication.
// The native process must still exit 0 and every object must pass readback hashing.
export function createBatchEchoTracker(lines, onCompleted, { windowsPaths = process.platform === 'win32' } = {}) {
  // Windows OpenSSH 9.5p2 normalizes the generated batch's backslashes to '/'
  // before echoing (including the doubled escape in C:\\ paths). Unix stays exact.
  const expected = lines.map(line => new Set(['sftp> ' + line, ...(windowsPaths ? ['sftp> ' + line.replace(/\\/g, '/')] : [])]))
  const decoder = new StringDecoder('utf8')
  let pending = '', next = 0, disabled = false
  const maxLine = 64 * 1024
  return {
    push(chunk) {
      if (disabled) return
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let end
      while ((end = pending.indexOf('\n')) !== -1) {
        const raw = pending.slice(0, end)
        pending = pending.slice(end + 1)
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line.length > maxLine) { disabled = true; pending = ''; return }
        if (!line.startsWith('sftp> ')) continue
        // Do not recover by searching ahead: a missing, duplicated or unexpected
        // echo makes this transcript ambiguous. Successful exit can fill counters.
        if (!expected[next]?.has(line)) { disabled = true; pending = ''; return }
        if (next > 0) onCompleted(next - 1)
        next++
      }
      if (pending.length > maxLine) { disabled = true; pending = '' }
    },
  }
}

// Controls/commit retain a short protected deadline. Data batches include both
// upload AND hash readback; budget for latency per command and total payload.
// This is a conservative hard bound, not an ETA or fabricated progress signal.
// Lack of a file-completion echo is NOT inactivity (a large file may be moving).
export function transferBatchTimeoutMs({ commands, bytes, dataBatch }) {
  if (!dataBatch) return 5 * 60 * 1000
  if (!Number.isSafeInteger(commands) || commands < 0 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid transfer timeout budget')
  return Math.min(12 * 60 * 60 * 1000, Math.max(15 * 60 * 1000,
    2 * 60 * 1000 + commands * 3000 + Math.ceil(bytes / (64 * 1024)) * 1000))
}

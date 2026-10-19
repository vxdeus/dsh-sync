import { isCancellation } from './transfer-control.js'

// A push response can time out or be cancelled after the server has accepted the commit.
// Never repeat a write here; confirm the exact expected commit with a read-only query.
export async function pushAndVerify({ push, readRemote, localOid }) {
  let pushError = null
  try { await push() }
  catch (error) {
    if (!isCancellation(error) && !/timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(String(error?.message || error))) throw error
    pushError = error
  }
  try {
    const remoteOid = await readRemote()
    if (remoteOid === localOid) return { ok: true, pushed: true, verified: true, recoveredFromTimeout: Boolean(pushError) && !isCancellation(pushError), recoveredFromCancellation: isCancellation(pushError), remoteOid }
    return { ok: false, pushed: !pushError, verified: false, confirmationPending: true, remoteOid: remoteOid || null }
  } catch {
    return { ok: false, pushed: !pushError, verified: false, confirmationPending: true, remoteOid: null }
  }
}

// Cancellation is cooperative at local file boundaries and aborts active transport.
// Critical publication/replacement and owned-lock cleanup must finish safely.
export function cancellationError() {
  const error = new Error('传输已取消；已发布的快照不会撤销。')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}
export function isCancellation(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}
export function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError()
}
function waitForBody(pending, signal) {
  // Always attach to pending, even if iterator.next() synchronously aborted.
  let abort
  return new Promise((resolve, reject) => {
    abort = () => reject(cancellationError())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(pending).then(resolve, reject)
    if (signal.aborted) abort()
  }).finally(() => signal.removeEventListener('abort', abort))
}
export function cancellableHttp(http, signal) {
  if (!signal) return http
  return {
    async request(input) {
      throwIfCancelled(signal)
      let response
      try {
        response = await http.request({ ...input, signal, fetchOptions: { ...input.fetchOptions, signal } })
      } catch (error) { throwIfCancelled(signal); throw error }
      // Check both headers and streamed body, not only the initial request.
      throwIfCancelled(signal)
      if (!response.body) return response
      const body = response.body
      return { ...response, body: (async function* () {
        const iterator = body[Symbol.asyncIterator]()
        try {
          for (;;) {
            throwIfCancelled(signal)
            const item = await waitForBody(iterator.next(), signal)
            throwIfCancelled(signal)
            if (item.done) break
            yield item.value
          }
        } catch (error) { throwIfCancelled(signal); throw error }
        finally {
          if (iterator.return) {
            try {
              const closed = iterator.return()
              if (signal.aborted) Promise.resolve(closed).catch(() => {})
              else await closed
            } catch (error) { if (!signal.aborted) throw error }
          }
        }
      })() }
    },
  }
}

import { Agent } from 'undici'

/**
 * Shared dispatcher for all game-file downloads.
 * autoSelectFamily enables happy-eyeballs (IPv4/IPv6 fallback) like Node's global fetch,
 * which the default agent in @xmcl/file-transfer does not do — on machines with broken
 * IPv6 or flaky CDN edges downloads would otherwise time out or produce empty files.
 *
 * Note: no undici RetryAgent here — it conflicts with the range-resume logic in
 * @xmcl/file-transfer ("content-range mismatch" assertions). Retries are done by
 * re-running whole install tasks instead (see withRetries), which is safe because
 * every file is checksum-validated and already-complete files are skipped.
 */
export const downloadAgent = new Agent({
  connect: {
    autoSelectFamily: true,
    timeout: 15_000
  },
  connections: 16,
  headersTimeout: 30_000,
  bodyTimeout: 120_000
})

/** Re-run an idempotent install step until it succeeds, with short backoff. */
export async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw lastError
}

/** Flatten AggregateError trees (thrown by parallel downloads) into a readable message. */
export function describeError(e: unknown): string {
  if (e instanceof AggregateError) {
    const parts = [...new Set(e.errors.map((inner) => describeError(inner)))]
    const shown = parts.slice(0, 3).join('; ')
    return `${parts.length} download error(s): ${shown}${parts.length > 3 ? '; …' : ''}`
  }
  if (e instanceof Error) return e.message || e.name
  return String(e)
}

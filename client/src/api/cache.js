/**
 * Tiny in-memory GET cache for the existing axios client.
 *
 * Why:
 *  - SOC/NOC/Sentinel pages often refetch the same `/api/stats/...` and
 *    `/api/logs/...` URLs on tab switches, range changes, etc. Without a
 *    client-side dedupe layer every render fires another network round-trip
 *    even when an identical request just resolved.
 *  - Adding @tanstack/react-query is the "ideal" answer but it would require
 *    rewiring every page. This module gives 80% of the benefit for ~30 lines.
 *
 * What it provides:
 *  - `cachedGet(url, { ttlMs })` — returns the cached body if it's young enough,
 *    otherwise fires a single shared promise so concurrent callers (e.g. two
 *    components mounting at once) only trigger one network request.
 *  - `invalidate(prefix)` — drop entries whose URL starts with the prefix.
 *  - `clearCache()` — wipe everything (e.g. on logout).
 */
import api from './client'

const cache = new Map() // url -> { ts, data }
const inFlight = new Map() // url -> Promise<data>

/** @param {string} url @param {{ ttlMs?: number, axiosConfig?: object }} [opts] */
export async function cachedGet(url, opts = {}) {
  const ttlMs = opts.ttlMs ?? 30_000
  const now = Date.now()
  const hit = cache.get(url)
  if (hit && now - hit.ts < ttlMs) return hit.data
  const pending = inFlight.get(url)
  if (pending) return pending
  const p = api.get(url, opts.axiosConfig).then(
    (res) => {
      cache.set(url, { ts: Date.now(), data: res.data })
      inFlight.delete(url)
      return res.data
    },
    (err) => {
      inFlight.delete(url)
      throw err
    },
  )
  inFlight.set(url, p)
  return p
}

export function invalidate(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

export function clearCache() {
  cache.clear()
  inFlight.clear()
}

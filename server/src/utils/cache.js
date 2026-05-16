import crypto from 'crypto'
import { getRedis } from '../config/redis.js'

/**
 * Lightweight Redis cache helper for stateless GET endpoints.
 *
 * Why this exists:
 *  - SOC/NOC dashboards poll the same `/api/stats/*` and Reports endpoints every
 *    30s from many tabs. The underlying ES + Mongo work is identical across users
 *    for the same time range, so caching slashes redundant work.
 *  - For 30-day windows the difference is dramatic: one cache hit vs ~17 ES
 *    queries + 3 Mongo countDocuments per request.
 *
 * Behaviour:
 *  - Soft-fail on Redis outages (returns the live response and skips caching) —
 *    the API stays correct even if Redis is down.
 *  - Best-effort SWR: serves a stale value within `staleSeconds` after expiry while
 *    triggering a single background refresh.
 *  - Skips caching when Redis isn't configured — safe in dev without Redis.
 */

function makeKey(namespace, parts) {
  const raw = JSON.stringify(parts)
  const h = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24)
  return `np:cache:${namespace}:${h}`
}

const inFlight = new Map()

/**
 * Wraps an async producer with Redis caching.
 *
 * @param {object} opts
 * @param {string} opts.namespace - Logical bucket (e.g. 'stats:soc').
 * @param {Array}  opts.keyParts - Inputs uniquely identifying the response.
 * @param {number} opts.ttlSeconds - Fresh window.
 * @param {number} [opts.staleSeconds] - Extra grace window where we return the cached value while refreshing in the background.
 * @param {() => Promise<any>} producer - Function that builds the response when there's a miss.
 */
export async function withCache({ namespace, keyParts, ttlSeconds, staleSeconds = 0 }, producer) {
  const redis = getRedis()
  if (!redis) return { value: await producer(), cached: false }

  const key = makeKey(namespace, keyParts)
  let cached = null
  try {
    cached = await redis.get(key)
  } catch {
    cached = null
  }

  if (cached) {
    try {
      const parsed = JSON.parse(cached)
      const ageMs = Date.now() - (parsed.t || 0)
      const freshMs = ttlSeconds * 1000
      const staleMs = (ttlSeconds + staleSeconds) * 1000
      if (ageMs < freshMs) return { value: parsed.v, cached: true, fresh: true }
      if (ageMs < staleMs) {
        // Serve stale, refresh in background (single-flight per key).
        if (!inFlight.has(key)) {
          inFlight.set(
            key,
            Promise.resolve()
              .then(() => producer())
              .then((value) => {
                const payload = JSON.stringify({ v: value, t: Date.now() })
                return redis.set(key, payload, 'EX', ttlSeconds + staleSeconds)
              })
              .catch(() => {})
              .finally(() => inFlight.delete(key)),
          )
        }
        return { value: parsed.v, cached: true, fresh: false }
      }
    } catch {
      /* fall through to recompute on parse error */
    }
  }

  // Single-flight: don't pile up identical computations when 5 tabs poll simultaneously.
  if (inFlight.has(key)) {
    const value = await inFlight.get(key)
    return { value, cached: false }
  }
  const promise = (async () => producer())()
  inFlight.set(key, promise)
  try {
    const value = await promise
    try {
      await redis.set(key, JSON.stringify({ v: value, t: Date.now() }), 'EX', ttlSeconds + staleSeconds)
    } catch {
      /* ignore cache write errors */
    }
    return { value, cached: false }
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Picks a TTL based on the time range. For a 30-day window the data is effectively
 * static (only the last hour shifts), so we cache aggressively.
 */
export function ttlForRange({ range, from, to }) {
  // Custom from/to → cache by window size.
  if (from && to) {
    const ms = new Date(to).getTime() - new Date(from).getTime()
    if (Number.isFinite(ms) && ms > 0) {
      if (ms <= 6 * 3600_000) return { ttl: 30, stale: 30 }   // ≤6h
      if (ms <= 24 * 3600_000) return { ttl: 60, stale: 60 }  // ≤1d
      if (ms <= 7 * 86400_000) return { ttl: 120, stale: 120 } // ≤7d
      return { ttl: 300, stale: 600 } // longer windows: 5min fresh, 10min stale-while-refresh
    }
  }
  // Preset: now-15m / now-1h / etc.
  switch (String(range || '').toLowerCase()) {
    case '15m':
    case '1h':
      return { ttl: 30, stale: 30 }
    case '6h':
    case '12h':
      return { ttl: 60, stale: 60 }
    case '24h':
      return { ttl: 90, stale: 120 }
    case '3d':
    case '7d':
      return { ttl: 180, stale: 240 }
    case '30d':
      return { ttl: 300, stale: 600 }
    default:
      return { ttl: 60, stale: 60 }
  }
}

import { useEffect, useRef } from 'react'

/**
 * Visibility-aware adaptive polling hook.
 *
 * Why this exists:
 *  - The dashboards (SOC/NOC/Sentinel/Infra) used to fire heavy ES requests every 30–60s
 *    even when the browser tab was hidden, and even when the user had selected a 30-day
 *    window where the data barely changes per tick. The combined effect was
 *    "every page is slow" because the network was always saturated with stale work.
 *
 * Behaviour:
 *  - `loader` runs once immediately when `enabled` is true.
 *  - Re-runs at `intervalMs` while the tab is visible.
 *  - When the tab is hidden, the timer pauses and the next run happens as soon as
 *    the tab becomes visible again (so users get fresh data when they come back).
 *  - The hook never starts overlapping runs — if the previous run is still pending
 *    when the timer fires, the tick is skipped.
 *
 * @param {() => (Promise<void> | void)} loader  Async loader (the latest reference is always called).
 * @param {number} intervalMs   Polling cadence while visible (must be > 0).
 * @param {Array}  deps         Dependency list — when any value changes, the loader is re-invoked
 *                              and the timer is restarted (typical: range, tab).
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true]       When false, the hook does nothing.
 * @param {boolean} [opts.skipImmediate=false] Don't call the loader on mount/dep-change. Useful when a
 *                                             separate effect already drives the initial fetch.
 */
export function useSmartPolling(loader, intervalMs, deps = [], opts = {}) {
  const { enabled = true, skipImmediate = false } = opts
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    if (!enabled || !intervalMs || intervalMs <= 0) return undefined
    let cancelled = false
    let timerId = null
    let inFlight = false

    const runOnce = async () => {
      if (cancelled || inFlight) return
      if (typeof document !== 'undefined' && document.hidden) return
      inFlight = true
      try {
        await loaderRef.current()
      } catch {
        /* the caller surfaces its own errors; we just keep polling */
      } finally {
        inFlight = false
      }
    }

    const schedule = () => {
      if (cancelled) return
      timerId = setTimeout(async () => {
        await runOnce()
        schedule()
      }, intervalMs)
    }

    const onVisibility = () => {
      if (cancelled) return
      if (!document.hidden) {
        if (timerId) clearTimeout(timerId)
        runOnce().then(schedule)
      }
    }

    if (skipImmediate) schedule()
    else runOnce().then(schedule)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, skipImmediate, ...deps])
}

/**
 * Returns a recommended polling interval based on the selected time range.
 *
 * Wide windows (30 days, custom multi-day) are dominated by mostly-static data —
 * polling them every 30s wastes bandwidth and ES capacity for no UX gain. Short
 * windows benefit from quick refresh.
 *
 * `range` shape:
 *   { value: '15m'|'1h'|'6h'|'12h'|'24h'|'3d'|'7d'|'30d' }
 *   { type: 'custom', from: ISO, to: ISO }
 *
 * Returned value is in milliseconds. Values are intentionally generous so the
 * server's Redis cache (`utils/cache.js`) can absorb most polls as cheap hits.
 */
export function pollIntervalForRange(range) {
  if (!range) return 60_000
  if (range.type === 'custom' && range.from && range.to) {
    const ms = new Date(range.to).getTime() - new Date(range.from).getTime()
    if (Number.isFinite(ms)) {
      if (ms <= 6 * 3600_000) return 30_000        // ≤6h → 30s
      if (ms <= 24 * 3600_000) return 60_000       // ≤1d → 1m
      if (ms <= 7 * 86400_000) return 180_000      // ≤7d → 3m
      return 300_000                                // longer → 5m
    }
  }
  switch (String(range.value || '').toLowerCase()) {
    case '15m':
    case '1h':
      return 30_000
    case '6h':
    case '12h':
      return 60_000
    case '24h':
      return 90_000
    case '3d':
      return 180_000
    case '7d':
      return 240_000
    case '30d':
      return 300_000
    default:
      return 60_000
  }
}

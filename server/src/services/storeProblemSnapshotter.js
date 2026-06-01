/**
 * Store Problem Snapshotter
 *
 * Runs on a configurable interval (default 30 min) and writes a batch of
 * StoreProblemHistory documents — one row per active problem per store.
 * Snapshots are used by the "Problem History" dashboard tab for trend analysis.
 *
 * Env vars:
 *   PROBLEM_SNAPSHOT_INTERVAL_MS  — snapshot interval (default 1800000 = 30 min)
 *   PROBLEM_HISTORY_TTL_DAYS      — retention period (default 60 days, enforced by TTL index)
 */
import StoreProblemHistory from '../models/StoreProblemHistory.js'
import { fetchStoreSnapshot, isInfluxStoreConfigured } from './influxStore.js'

const INTERVAL_MS = parseInt(process.env.PROBLEM_SNAPSHOT_INTERVAL_MS || '1800000', 10) // 30 min

let _running = false
let _lastSnapAt = null
let _lastSnapCount = 0

export function getProblemSnapshotStatus() {
  return { lastSnapAt: _lastSnapAt, lastSnapCount: _lastSnapCount, intervalMs: INTERVAL_MS }
}

export async function runProblemSnapshot() {
  if (!isInfluxStoreConfigured()) return { skipped: true, reason: 'influx_not_configured' }
  if (_running) return { skipped: true, reason: 'already_running' }
  _running = true
  try {
    const snapshotAt = new Date()
    const stores = await fetchStoreSnapshot(10, '-1h')

    const docs = []
    for (const s of stores) {
      for (const issue of s.issues ?? []) {
        docs.push({
          snapshotAt,
          storeTag:      s.storeTag,
          hostname:      s.hostname || '',
          serial:        s.serial || '',
          connState:     s.connState || 'unknown',
          gatewayVendor: s.gatewayVendor || '',
          severity:      issue.severity,
          code:          issue.code,
          message:       issue.message || '',
          online:        s.online ?? false,
        })
      }
    }

    if (docs.length) {
      await StoreProblemHistory.insertMany(docs, { ordered: false })
    }

    _lastSnapAt    = snapshotAt.toISOString()
    _lastSnapCount = docs.length
    console.log(`[problemSnapshotter] Snapshot saved: ${docs.length} problems across ${stores.length} stores`)
    return { snapshotAt: _lastSnapAt, problems: docs.length, stores: stores.length }
  } catch (e) {
    console.error('[problemSnapshotter] Error:', e.message)
    return { error: e.message }
  } finally {
    _running = false
  }
}

export function startProblemSnapshotter() {
  if (!isInfluxStoreConfigured()) {
    console.log('[problemSnapshotter] InfluxDB not configured — disabled')
    return
  }
  console.log(`[problemSnapshotter] Starting — snapshot every ${INTERVAL_MS / 60000} min`)
  // First snapshot after 2 minutes (let the server finish warming up)
  setTimeout(async () => {
    await runProblemSnapshot().catch((e) => console.error('[problemSnapshotter]', e.message))
    setInterval(async () => {
      await runProblemSnapshot().catch((e) => console.error('[problemSnapshotter]', e.message))
    }, INTERVAL_MS)
  }, 120_000)
}

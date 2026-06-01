/**
 * Store Problem Tracker
 *
 * Runs every PROBLEM_TRACKER_INTERVAL_MS (default 2 min) and maintains a
 * lifecycle record per (storeTag + code):
 *   - New problem  → create doc with status='active', firstSeenAt=now
 *   - Existing     → update lastSeenAt + latest connState/online
 *   - Resolved     → set status='resolved', resolvedAt=now, durationMs
 *
 * Emits Socket.IO events:
 *   store:problems:changed  — { detected: [...], resolved: [...], activeCount }
 *
 * Env vars:
 *   PROBLEM_TRACKER_INTERVAL_MS   — tracking interval (default 120000 = 2 min)
 *   PROBLEM_HISTORY_TTL_DAYS      — TTL for resolved records (default 60 days)
 */
import StoreProblemHistory from '../models/StoreProblemHistory.js'
import { fetchStoreSnapshot, isInfluxStoreConfigured } from './influxStore.js'

const INTERVAL_MS = parseInt(process.env.PROBLEM_TRACKER_INTERVAL_MS || '120000', 10)

let _running  = false
let _lastRunAt  = null
let _lastStats  = null
let _io = null

export function getProblemSnapshotStatus() {
  return { lastSnapAt: _lastRunAt, lastSnapCount: _lastStats?.active ?? 0, intervalMs: INTERVAL_MS, ..._lastStats }
}

export function injectProblemTrackerIo(io) { _io = io }

export async function runProblemSnapshot() {
  if (!isInfluxStoreConfigured()) return { skipped: true, reason: 'influx_not_configured' }
  if (_running) return { skipped: true, reason: 'already_running' }
  _running = true

  try {
    const now = new Date()
    const stores = await fetchStoreSnapshot(10, '-1h')

    // Build a map of currently-active (storeTag+code) → store/issue
    const currentMap = new Map()
    for (const s of stores) {
      for (const issue of s.issues ?? []) {
        const key = `${s.storeTag}|${issue.code}`
        currentMap.set(key, {
          storeTag:      s.storeTag,
          hostname:      s.hostname || '',
          serial:        s.serial   || '',
          connState:     s.connState || 'unknown',
          gatewayVendor: s.gatewayVendor || '',
          severity:      issue.severity,
          code:          issue.code,
          message:       issue.message || '',
          online:        s.online ?? false,
        })
      }
    }

    // Load all currently-active records from DB
    const activeRecords = await StoreProblemHistory.find({ status: 'active' }).lean()
    const activeMap = new Map(activeRecords.map((r) => [`${r.storeTag}|${r.code}`, r]))

    const detected = []
    const resolved = []
    const bulkOps  = []

    // 1. New problems not yet in DB → insert
    for (const [key, info] of currentMap) {
      if (!activeMap.has(key)) {
        detected.push(info)
        bulkOps.push({
          insertOne: {
            document: {
              ...info,
              status:      'active',
              firstSeenAt: now,
              lastSeenAt:  now,
              resolvedAt:  null,
              durationMs:  null,
            },
          },
        })
      } else {
        // 2. Still active → update lastSeenAt + latest state
        const rec = activeMap.get(key)
        bulkOps.push({
          updateOne: {
            filter: { _id: rec._id },
            update: { $set: { lastSeenAt: now, connState: info.connState, online: info.online, severity: info.severity } },
          },
        })
      }
    }

    // 3. Previously-active problems no longer in InfluxDB → mark resolved
    for (const [key, rec] of activeMap) {
      if (!currentMap.has(key)) {
        const durationMs = now - new Date(rec.firstSeenAt)
        resolved.push({ ...rec, resolvedAt: now.toISOString(), durationMs })
        bulkOps.push({
          updateOne: {
            filter: { _id: rec._id },
            update: { $set: { status: 'resolved', resolvedAt: now, durationMs } },
          },
        })
      }
    }

    if (bulkOps.length) {
      await StoreProblemHistory.bulkWrite(bulkOps, { ordered: false })
    }

    _lastRunAt  = now.toISOString()
    _lastStats  = { active: currentMap.size, detected: detected.length, resolved: resolved.length, stores: stores.length }

    // Emit real-time event so all connected clients can react
    if (_io && (detected.length || resolved.length)) {
      _io.emit('store:problems:changed', {
        detected,
        resolved: resolved.map((r) => ({ storeTag: r.storeTag, code: r.code, hostname: r.hostname, resolvedAt: r.resolvedAt, durationMs: r.durationMs })),
        activeCount: currentMap.size,
        checkedAt:  _lastRunAt,
      })
    }

    if (detected.length || resolved.length) {
      console.log(`[problemTracker] ${detected.length} new · ${resolved.length} resolved · ${currentMap.size} active`)
    }
    return { ..._lastStats, checkedAt: _lastRunAt }
  } catch (e) {
    console.error('[problemTracker] Error:', e.message)
    return { error: e.message }
  } finally {
    _running = false
  }
}

export function startProblemSnapshotter(io) {
  _io = io || null
  if (!isInfluxStoreConfigured()) {
    console.log('[problemTracker] InfluxDB not configured — disabled')
    return
  }
  console.log(`[problemTracker] Starting — tracking every ${INTERVAL_MS / 60000} min`)
  setTimeout(async () => {
    await runProblemSnapshot().catch((e) => console.error('[problemTracker]', e.message))
    setInterval(async () => {
      await runProblemSnapshot().catch((e) => console.error('[problemTracker]', e.message))
    }, INTERVAL_MS)
  }, 90_000) // first run after 90s
}

/**
 * Store Alert Engine — evaluates all enabled alert rules against live InfluxDB data
 * and dispatches notifications via Slack / Google Chat / Email.
 *
 * Called automatically every EVAL_INTERVAL_MS (default 2 minutes) after startup.
 * Also exported so the /evaluate route can call it on demand.
 */
import StoreAlertRule from '../models/StoreAlertRule.js'
import StoreAlertEvent from '../models/StoreAlertEvent.js'
import { dispatchAlertNotifications } from './storeAlertNotify.js'
import { fetchStoreSnapshot, fetchCrashCountsPerStore, isInfluxStoreConfigured, isStoreOfflineForAlert } from './influxStore.js'

const EVAL_INTERVAL_MS = parseInt(process.env.STORE_ALERT_INTERVAL_MS || '120000', 10) // 2 min default

export function deriveGroupsServer(hostname, gatewayVendor, isFortinet) {
  const h = String(hostname || '').trim().toUpperCase()
  const v = String(gatewayVendor || '').trim().toLowerCase()
  const groups = []
  if (h.startsWith('RP'))       groups.push('RP Group')
  else if (h.startsWith('LK')) groups.push('POS System Group')
  if (isFortinet || v.includes('fortinet') || v.includes('fortigate')) groups.push('SD-WAN Group')
  if (groups.length === 0) groups.push('General Group')
  return groups
}

export function evaluateCondition(cond, store) {
  const { metric, operator, threshold, target } = cond
  let value = null
  if (metric === 'offline')   return isStoreOfflineForAlert(store)
  if (metric === 'isp_down')  return store.connState === 'isp_down'
  if (metric === 'hotspot')   return store.isHotspot || store.connState === 'hotspot'
  if (metric === 'dns_fail')    return Object.values(store.dns  || {}).some((d) => d.success === false)
  if (metric === 'http_fail')   return Object.values(store.http || {}).some((h) => h.success === false)
  if (metric === 'crash_count') {
    // _crashCounts is a Map<key,count> attached to store by the eval loop
    // key = "appName||crashType" — filter by appName and/or crashType from condition
    const appName   = (cond.appName   || '').trim().toLowerCase()
    const crashType = (cond.crashType || '').trim().toLowerCase()
    if (store._crashCounts) {
      let total = 0
      for (const [key, cnt] of store._crashCounts.entries()) {
        const [kApp, kType] = key.split('||')
        if (appName   && kApp.toLowerCase()  !== appName)   continue
        if (crashType && kType.toLowerCase() !== crashType) continue
        total += cnt
      }
      value = total
    } else {
      value = store._crashCount ?? 0
    }
  }
  if (metric === 'cpu')           value = store.cpuPct
  if (metric === 'memory')        value = store.memPct
  if (metric === 'download_mbps') value = store.downloadMbps
  if (metric === 'upload_mbps')   value = store.uploadMbps
  if (metric === 'packet_loss') {
    const key = target || '8.8.8.8'
    const p = store.ping?.[key] || Object.values(store.ping || {})[0]
    value = p?.packetLossPct
  }
  if (metric === 'latency') {
    const key = target || '8.8.8.8'
    const p = store.ping?.[key] || Object.values(store.ping || {})[0]
    value = p?.avgMs
  }
  if (value == null || !Number.isFinite(Number(value))) return false
  const v = Number(value)
  const t = Number(threshold)
  if (operator === 'gt'  || operator === undefined) return v > t
  if (operator === 'gte') return v >= t
  if (operator === 'lt')  return v < t
  if (operator === 'lte') return v <= t
  if (operator === 'eq')  return v === t
  return false
}

function isWithinSchedule(schedule) {
  if (!schedule?.enabled) return true
  const now   = new Date()
  const dayOk = (schedule.weekdays || [1,2,3,4,5]).includes(now.getDay())
  const hour  = now.getHours()
  const from  = schedule.fromHour ?? 9
  const to    = schedule.toHour   ?? 18
  const hourOk = from <= to ? (hour >= from && hour < to) : (hour >= from || hour < to)
  return dayOk && hourOk
}

let lastEvalAt = null
let lastEvalStats = null
let _io = null   // Socket.IO instance, injected by startStoreAlertEngine

export function getEvalStatus() {
  return { lastEvalAt, lastEvalStats, intervalMs: EVAL_INTERVAL_MS }
}

export async function runStoreAlertEval() {
  if (!isInfluxStoreConfigured()) return { fired: 0, skipped: 0, results: [], reason: 'influx_not_configured' }

  const rules = await StoreAlertRule.find({ enabled: true }).lean()
  if (!rules.length) return { fired: 0, skipped: 0, results: [] }

  const [stores, crashCounts] = await Promise.all([
    fetchStoreSnapshot(15, '-15m'),
    fetchCrashCountsPerStore('-15m').catch(() => new Map()),
  ])
  // Attach crash counts map to each store so evaluateCondition can filter by app/type
  for (const s of stores) {
    const subMap = crashCounts.get(s.storeTag) || crashCounts.get(s.hostname)
    s._crashCounts = subMap || new Map()
    s._crashCount  = subMap ? [...subMap.values()].reduce((a, b) => a + b, 0) : 0
  }
  const results = []
  let fired = 0, skipped = 0

  for (const rule of rules) {
    try {
      // 1. Find affected stores
      const affected = stores.filter((s) => {
        if (rule.group !== 'all') {
          const grps = deriveGroupsServer(s.hostname, s.gatewayVendor, s.isFortinet)
          if (!grps.includes(rule.group)) return false
        }
        return evaluateCondition(rule.condition, s)
      })

      if (!affected.length) continue

      // 2. Must have at least one notification channel configured
      const channels = (rule.channels || []).filter((ch) =>
        (ch.type === 'slack' || ch.type === 'google_chat') ? Boolean(ch.webhookUrl)
          : ch.type === 'email' ? Boolean(ch.emails?.length) : false,
      )
      if (!channels.length) {
        results.push({ rule: rule.name, skipped: true, reason: 'no notification channels configured', affected: affected.length })
        skipped++
        continue
      }

      // 3. Check trigger schedule
      if (!isWithinSchedule(rule.schedule)) {
        results.push({ rule: rule.name, skipped: true, reason: 'outside schedule', affected: affected.length })
        skipped++
        continue
      }

      // 4. Check cooldown
      const cooldownMs = (rule.cooldownMinutes || 30) * 60 * 1000
      const lastFired  = rule.lastFiredAt ? new Date(rule.lastFiredAt).getTime() : 0
      if (Date.now() - lastFired < cooldownMs) {
        const remainMin = Math.ceil((cooldownMs - (Date.now() - lastFired)) / 60000)
        results.push({ rule: rule.name, skipped: true, reason: `cooldown (${remainMin}m left)`, affected: affected.length })
        skipped++
        continue
      }

      // 5. Fire!
      const dispatch = await dispatchAlertNotifications(rule, affected)
      const anyOk = dispatch.some((d) => d.ok)
      if (!anyOk) {
        const errDetail = dispatch.map((d) => `${d.channel}: ${d.error || d.status || 'failed'}`).join('; ')
        console.error(`[storeAlertEngine] Notification failed for "${rule.name}": ${errDetail}`)
        results.push({ rule: rule.name, fired: false, affected: affected.length, dispatch, error: errDetail || 'all channels failed' })
        continue
      }

      await StoreAlertRule.findByIdAndUpdate(rule._id, { lastFiredAt: new Date() })

      const topStores = affected.slice(0, 10).map((s) => {
        const crashBreakdown = []
        if (s._crashCounts?.size) {
          const appFilter   = (rule.condition?.appName   || '').trim().toLowerCase()
          const typeFilter  = (rule.condition?.crashType || '').trim().toLowerCase()
          for (const [key, cnt] of s._crashCounts.entries()) {
            if (!cnt) continue
            const [app, type] = key.split('||')
            if (appFilter  && app.toLowerCase()  !== appFilter)  continue
            if (typeFilter && type.toLowerCase() !== typeFilter) continue
            crashBreakdown.push({ app: app || null, crashType: type || null, count: cnt })
          }
        }
        return {
          hostname:       s.hostname,
          serial:         s.serial,
          storeTag:       s.storeTag,
          connState:      s.connState,
          gatewayIp:      s.gatewayIp,
          gatewayVendor:  s.gatewayVendor,
          online:         s.online,
          lastSeen:       s.lastSeen,
          triggeredValue: rule.condition?.metric === 'crash_count'
            ? (crashBreakdown.reduce((a, b) => a + b.count, 0) || s._crashCount || 0)
            : undefined,
          crashBreakdown: crashBreakdown.length ? crashBreakdown : undefined,
        }
      })

      // Persist to DB
      const savedEvent = await StoreAlertEvent.create({
        ruleId:        rule._id,
        ruleName:      rule.name,
        severity:      rule.severity,
        group:         rule.group,
        condition:     rule.condition,
        affectedCount: affected.length,
        stores:        topStores,
        hasMore:       affected.length > 10,
        dispatch,
        firedAt:       new Date(),
      })

      const alertEvent = {
        _id:           savedEvent._id,
        ruleId:        rule._id,
        ruleName:      rule.name,
        severity:      rule.severity,
        group:         rule.group,
        condition:     rule.condition,
        affectedCount: affected.length,
        stores:        topStores,
        hasMore:       affected.length > 10,
        firedAt:       savedEvent.firedAt.toISOString(),
        dispatch,
      }

      // Broadcast to all subscribed clients in real-time
      if (_io) _io.to('store-alerts').emit('store:alert', alertEvent)

      results.push({ rule: rule.name, fired: true, affected: affected.length, dispatch })
      fired++
      console.log(`[storeAlertEngine] 🔔 Fired: "${rule.name}" (${rule.severity}) — ${affected.length} stores affected`)
    } catch (e) {
      console.error(`[storeAlertEngine] Error processing rule "${rule.name}":`, e.message)
      results.push({ rule: rule.name, error: e.message })
    }
  }

  const stats = { fired, skipped, total: rules.length, storesChecked: stores.length, evaluatedAt: new Date().toISOString() }
  lastEvalAt    = stats.evaluatedAt
  lastEvalStats = stats
  if (fired > 0) console.log(`[storeAlertEngine] Eval complete: ${fired} fired, ${skipped} skipped, ${stores.length} stores checked`)
  return { ...stats, results }
}

export function startStoreAlertEngine(io) {
  _io = io || null
  if (!isInfluxStoreConfigured()) {
    console.log('[storeAlertEngine] InfluxDB not configured — auto-evaluation disabled')
    return
  }
  // Let clients subscribe to 'store-alerts' room for real-time push notifications
  if (_io) {
    _io.on('connection', (socket) => {
      socket.on('subscribe:store-alerts', () => {
        socket.join('store-alerts')
        socket.emit('store-alerts:subscribed', { ok: true })
      })
      socket.on('unsubscribe:store-alerts', () => socket.leave('store-alerts'))
    })
  }
  console.log(`[storeAlertEngine] Starting — evaluating every ${EVAL_INTERVAL_MS / 1000}s`)

  // Run first evaluation after 30s (let server warm up)
  setTimeout(async () => {
    await runStoreAlertEval().catch((e) => console.error('[storeAlertEngine] eval error:', e.message))
    setInterval(async () => {
      await runStoreAlertEval().catch((e) => console.error('[storeAlertEngine] eval error:', e.message))
    }, EVAL_INTERVAL_MS)
  }, 30_000)
}

import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import StoreAlertRule from '../models/StoreAlertRule.js'
import { dispatchAlertNotifications, testChannel } from '../services/storeAlertNotify.js'
import { fetchStoreSnapshot } from '../services/influxStore.js'

const router = Router()
router.use(authenticate, requireAppPage('storeMonitor'))

/* ── CRUD ─────────────────────────────────────────────── */
router.get('/', async (_req, res, next) => {
  try {
    const rules = await StoreAlertRule.find().sort({ createdAt: -1 }).lean()
    res.json(rules)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const rule = await StoreAlertRule.create({ ...req.body, createdBy: req.user?._id })
    res.status(201).json(rule)
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const rule = await StoreAlertRule.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!rule) return res.status(404).json({ error: 'Not found' })
    res.json(rule)
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await StoreAlertRule.findByIdAndDelete(req.params.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* ── Test notification channel ─────────────────────────── */
router.post('/test-channel', async (req, res, next) => {
  try {
    const result = await testChannel(req.body)
    res.json(result)
  } catch (e) { next(e) }
})

/* ── Manual fire / evaluate all rules ─────────────────── */
router.post('/evaluate', async (req, res, next) => {
  try {
    const rules = await StoreAlertRule.find({ enabled: true }).lean()
    if (!rules.length) return res.json({ fired: 0, results: [] })

    // Always evaluate against the latest real-time snapshot (last 15 minutes)
    const stores = await fetchStoreSnapshot(10, '-15m')
    const results = []

    for (const rule of rules) {
      const affected = stores.filter((s) => {
        if (rule.group !== 'all') {
          const grps = deriveGroupsServer(s.hostname, s.gatewayVendor, s.isFortinet)
          if (!grps.includes(rule.group)) return false
        }
        return evaluateCondition(rule.condition, s)
      })

      if (!affected.length) continue

      // Check trigger schedule: is it within the allowed day/hour window?
      if (rule.schedule?.enabled) {
        const now = new Date()
        const dayOk  = (rule.schedule.weekdays || [1,2,3,4,5]).includes(now.getDay())
        const hour   = now.getHours()
        const from   = rule.schedule.fromHour ?? 9
        const to     = rule.schedule.toHour   ?? 18
        const hourOk = from <= to ? (hour >= from && hour < to) : (hour >= from || hour < to)
        if (!dayOk || !hourOk) {
          results.push({ rule: rule.name, skipped: true, reason: 'outside schedule', affected: affected.length })
          continue
        }
      }

      const cooldownMs = (rule.cooldownMinutes || 30) * 60 * 1000
      const lastFired = rule.lastFiredAt ? new Date(rule.lastFiredAt).getTime() : 0
      if (Date.now() - lastFired < cooldownMs) {
        results.push({ rule: rule.name, skipped: true, reason: 'cooldown', affected: affected.length })
        continue
      }

      const dispatch = await dispatchAlertNotifications(rule, affected)
      await StoreAlertRule.findByIdAndUpdate(rule._id, { lastFiredAt: new Date() })
      results.push({ rule: rule.name, fired: true, affected: affected.length, dispatch })
    }

    res.json({ fired: results.filter((r) => r.fired).length, results })
  } catch (e) { next(e) }
})

function deriveGroupsServer(hostname, gatewayVendor, isFortinet) {
  const h = String(hostname || '').trim().toUpperCase()
  const v = String(gatewayVendor || '').trim().toLowerCase()
  const groups = []
  if (h.startsWith('RP'))  groups.push('RP Group')
  else if (h.startsWith('LK')) groups.push('POS System Group')
  if (isFortinet || v.includes('fortinet') || v.includes('fortigate')) groups.push('SD-WAN Group')
  if (groups.length === 0) groups.push('General Group')
  return groups
}

function evaluateCondition(cond, store) {
  const { metric, operator, threshold, target } = cond
  let value = null
  if (metric === 'offline') return !store.online
  if (metric === 'isp_down') return store.connState === 'isp_down'
  if (metric === 'hotspot') return store.isHotspot || store.connState === 'hotspot'
  if (metric === 'dns_fail') return Object.values(store.dns || {}).some((d) => d.success === false)
  if (metric === 'http_fail') return Object.values(store.http || {}).some((h) => h.success === false)
  if (metric === 'cpu') value = store.cpuPct
  if (metric === 'memory') value = store.memPct
  if (metric === 'download_mbps') value = store.downloadMbps
  if (metric === 'upload_mbps') value = store.uploadMbps
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
  if (operator === 'gt' || operator === undefined) return v > t
  if (operator === 'gte') return v >= t
  if (operator === 'lt') return v < t
  if (operator === 'lte') return v <= t
  if (operator === 'eq') return v === t
  return false
}

export default router

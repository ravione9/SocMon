/**
 * Zabbix Store Alert Engine — evaluates rules against Store Zabbix custom ping sensors.
 *
 * Ping / jitter / packet-loss metrics use ONLY the custom agent items:
 *   custom.ping.ms[*], custom.ping.jitter[*], custom.ping.loss[*]
 * (same as Custom Dashboard & Network Health — NOT icmpping/icmppingsec).
 */
import ZabbixAlertRule from '../models/ZabbixAlertRule.js'
import ZabbixAlertEvent from '../models/ZabbixAlertEvent.js'
import { createZabbixClient } from './zabbix.js'
import { fetchAllMonitoredHosts } from './zabbixHostFetch.js'
import { dispatchZabbixAlertNotifications } from './zabbixAlertNotify.js'
import {
  STORE_PING_KEY_RES,
  DEFAULT_PING_TARGET,
  indexCustomPingItems,
  resolveStorePingMetrics,
  hostInGroup,
  getStaleAfterSec,
} from '../utils/zabbixStorePingSensors.js'
import {
  getInstantAlertStatus,
  startInstantSlaWatcher,
  setZabbixAlertIo,
  runInstantSlaCheck,
} from './zabbixAlertInstant.js'

export { handleZabbixAlertWebhook } from './zabbixAlertInstant.js'

const storeClient = createZabbixClient('STORE_ZABBIX')
const { zabbixRpc, isZabbixConfigured } = storeClient

const EVAL_INTERVAL_MS = parseInt(process.env.ZABBIX_ALERT_INTERVAL_MS || '120000', 10)

let lastEvalAt = null
let lastEvalStats = null
let _io = null

export function getZabbixAlertEvalStatus() {
  const instantMs = parseInt(process.env.ZABBIX_ALERT_INSTANT_MS || '10000', 10)
  return {
    lastEvalAt,
    lastEvalStats,
    intervalMs: EVAL_INTERVAL_MS,
    instantIntervalMs: instantMs,
    instant: getInstantAlertStatus(),
    mode: 'instant_sla_edge + scheduled_backup',
  }
}

function isWithinBusinessHours(bh, now = new Date()) {
  if (!bh?.enabled) return true
  const days = bh.weekdays || [1, 2, 3, 4, 5]
  if (!days.includes(now.getDay())) return false
  const hour = now.getHours()
  const from = bh.fromHour ?? 9
  const to = bh.toHour ?? 18
  if (from <= to) return hour >= from && hour < to
  return hour >= from || hour < to
}

function shouldNotifyForBhPolicy(rule) {
  const bh = rule.businessHours || {}
  if (!bh.enabled || bh.policy === 'always') return true
  const inBh = isWithinBusinessHours(bh)
  if (bh.policy === 'bh_only' || bh.policy === 'suppress_after_hours') return inBh
  if (bh.policy === 'outside_bh') return !inBh
  return true
}

async function fetchItemsChunked(hostids, searchKey) {
  if (!hostids.length) return []
  const out = []
  const chunk = 400
  for (let i = 0; i < hostids.length; i += chunk) {
    const slice = hostids.slice(i, i + chunk)
    const rows = await zabbixRpc('item.get', {
      hostids: slice,
      monitored: true,
      search: { key_: searchKey },
      searchWildcardsEnabled: true,
      output: ['itemid', 'hostid', 'key_', 'lastvalue', 'lastclock', 'units'],
      limit: 5000,
    })
    out.push(...(rows || []))
  }
  return out
}

function pickScalarItem(hostItems) {
  if (!hostItems?.length) return null
  let best = null
  for (const it of hostItems) {
    const v = parseFloat(it.lastvalue)
    if (!Number.isFinite(v) || v < 0) continue
    const clock = Number(it.lastclock) || 0
    if (!best || clock >= (Number(best.lastclock) || 0)) best = { ...it, _v: v }
  }
  return best ? best._v : null
}

function buildHostMetrics(hostid, itemBatches, target, nowSec, staleAfterSec) {
  const hid = String(hostid)
  const ping = resolveStorePingMetrics(itemBatches.pingIndexes, hid, target, nowSec, staleAfterSec)

  const cpuItems = (itemBatches.cpu || []).filter((it) => String(it.hostid) === hid)
  const memItems = (itemBatches.mem || []).filter((it) => String(it.hostid) === hid)
  const agentItems = (itemBatches.agent || []).filter((it) => String(it.hostid) === hid)

  return {
    ...ping,
    cpu: pickScalarItem(cpuItems),
    memory: pickScalarItem(memItems),
    agentPing: pickScalarItem(agentItems),
  }
}

function hostMatchesScope(host, scope, groupMap) {
  const type = scope?.type || 'global'
  if (type === 'global') return true
  if (type === 'group') {
    const groups = groupMap[String(host.hostid)] || []
    return hostInGroup(groups, scope.groupName)
  }
  if (type === 'hosts') {
    const ids = new Set((scope.hostids || []).map(String))
    if (ids.has(String(host.hostid))) return true
    const names = (scope.hostnames || []).map((s) => String(s).toLowerCase())
    const h = String(host.host || '').toLowerCase()
    const n = String(host.name || '').toLowerCase()
    return names.some((x) => h.includes(x) || n.includes(x) || h === x || n === x)
  }
  return true
}

function evaluateCondition(cond, metrics, host) {
  const { metric, operator, threshold, thresholdMax } = cond
  let value = null

  if (metric === 'host_down') {
    const avail = Number(host.available ?? host.active_available)
    if (avail === 2) return true
    // Custom ping loss 100% = unreachable (Store Zabbix sensor)
    if (metrics.packetLoss != null && metrics.packetLoss >= 100) return true
    if (metrics.raw?.packetLoss?.fresh && metrics.raw.packetLoss.value >= 100) return true
    return metrics.agentPing === 0
  }

  if (metric === 'agent_down') return metrics.agentPing === 0

  if (metric === 'cpu') value = metrics.cpu
  if (metric === 'memory') value = metrics.memory
  if (metric === 'latency') {
    value = metrics.latency
    if (value == null) return false
  }
  if (metric === 'jitter') {
    value = metrics.jitter
    if (value == null) return false
  }
  if (metric === 'packet_loss') {
    value = metrics.packetLoss
    if (value == null) return false
  }

  if (value == null || !Number.isFinite(Number(value))) return false
  const v = Number(value)
  const t = Number(threshold)
  const tMax = Number(thresholdMax)
  if (operator === 'between') return v >= t && v <= tMax
  if (operator === 'gt' || !operator) return v > t
  if (operator === 'gte') return v >= t
  if (operator === 'lt') return v < t
  if (operator === 'lte') return v <= t
  if (operator === 'eq') return v === t
  return false
}

function triggeredValueForMetric(cond, metrics) {
  const m = cond.metric
  if (m === 'latency') return metrics.latency
  if (m === 'jitter') return metrics.jitter
  if (m === 'packet_loss') return metrics.packetLoss
  if (m === 'cpu') return metrics.cpu
  if (m === 'memory') return metrics.memory
  return null
}

export async function fetchZabbixAlertDashboard() {
  if (!isZabbixConfigured()) {
    return { configured: false, summary: {}, bySeverity: [] }
  }

  const now = new Date()
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)

  const [problems, todayEvents, failedToday, hostsResult] = await Promise.all([
    zabbixRpc('problem.get', {
      output: ['eventid', 'severity', 'name'],
      recent: true,
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit: 5000,
    }).catch(() => []),
    ZabbixAlertEvent.countDocuments({ firedAt: { $gte: startOfDay } }),
    ZabbixAlertEvent.countDocuments({
      firedAt: { $gte: startOfDay },
      dispatch: { $elemMatch: { ok: false } },
    }),
    fetchAllMonitoredHosts(zabbixRpc, {
      output: ['hostid', 'available', 'active_available'],
    }).catch(() => ({ rows: [] })),
  ])

  const probList = problems || []
  const sevCounts = { disaster: 0, critical: 0, high: 0, warning: 0, info: 0 }
  for (const p of probList) {
    const s = Number(p.severity)
    if (s >= 5) sevCounts.disaster++
    else if (s >= 4) sevCounts.critical++
    else if (s >= 3) sevCounts.high++
    else if (s >= 2) sevCounts.warning++
    else sevCounts.info++
  }

  const hostRows = hostsResult.rows || []
  let offline = 0
  for (const h of hostRows) {
    const a = Number(h.available ?? h.active_available)
    if (a === 2) offline++
  }

  const resolvedToday = await ZabbixAlertEvent.countDocuments({
    firedAt: { $gte: startOfDay },
    eventStatus: 'resolved',
  })

  return {
    configured: true,
    sensors: {
      latency: 'custom.ping.ms[8.8.8.8]',
      jitter: 'custom.ping.jitter[8.8.8.8]',
      packetLoss: 'custom.ping.loss[8.8.8.8]',
    },
    summary: {
      activeAlerts: probList.length,
      criticalAlerts: sevCounts.critical + sevCounts.disaster,
      disasterAlerts: sevCounts.disaster,
      alertsToday: todayEvents,
      resolvedToday,
      failedNotifications: failedToday,
      offlineStores: offline,
      offlineDevices: offline,
      totalHosts: hostRows.length,
    },
    bySeverity: [
      { label: 'Disaster', count: sevCounts.disaster, color: '#7f1d1d' },
      { label: 'Critical', count: sevCounts.critical, color: '#ef4444' },
      { label: 'High', count: sevCounts.high, color: '#f97316' },
      { label: 'Warning', count: sevCounts.warning, color: '#eab308' },
      { label: 'Info', count: sevCounts.info, color: '#64748b' },
    ],
    queriedAt: new Date().toISOString(),
  }
}

export async function runZabbixAlertEval({ forceNotify = false } = {}) {
  /** Scheduled backup uses the same edge-trigger + per-host cooldown as instant SLA. */
  return runInstantSlaCheck({ includeAllHosts: true, forceNotify })
}

export function startZabbixAlertEngine(io) {
  _io = io || null
  setZabbixAlertIo(io)

  const url = process.env.STORE_ZABBIX_URL || ''
  const hasToken = Boolean(process.env.STORE_ZABBIX_API_TOKEN?.trim() || process.env.STORE_ZABBIX_TOKEN?.trim())
  console.log(`[zabbixAlertEngine] init url=${url ? 'set' : 'missing'} token=${hasToken ? 'set' : 'missing'} configured=${isZabbixConfigured()}`)

  if (!isZabbixConfigured()) {
    console.log('[zabbixAlertEngine] Store Zabbix not configured — auto-evaluation disabled')
    return
  }

  void zabbixRpc('apiinfo.version', {})
    .then((ver) => console.log(`[zabbixAlertEngine] Store Zabbix API OK (version ${ver})`))
    .catch((e) => console.error(`[zabbixAlertEngine] Store Zabbix API unreachable: ${e.message}`))

  if (_io) {
    _io.on('connection', (socket) => {
      socket.on('subscribe:zabbix-alerts', () => {
        socket.join('zabbix-alerts')
        socket.emit('zabbix-alerts:subscribed', { ok: true })
      })
      socket.on('unsubscribe:zabbix-alerts', () => socket.leave('zabbix-alerts'))
    })
  }
  startInstantSlaWatcher()
  console.log(`[zabbixAlertEngine] Scheduled backup eval every ${EVAL_INTERVAL_MS / 1000}s`)
  setTimeout(async () => {
    await runZabbixAlertEval().catch((e) => console.error('[zabbixAlertEngine]', e.message))
    setInterval(async () => {
      await runZabbixAlertEval().catch((e) => console.error('[zabbixAlertEngine]', e.message))
    }, EVAL_INTERVAL_MS)
  }, 45_000)
}

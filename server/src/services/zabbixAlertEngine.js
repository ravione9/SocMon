/**
 * Zabbix Store Alert Engine — evaluates rules against Store Zabbix custom ping sensors.
 *
 * Ping / jitter / packet-loss metrics use ONLY the custom agent items:
 *   custom.ping.ms[*], custom.ping.jitter[*], custom.ping.loss[*]
 * (same as Custom Dashboard & Network Health — NOT icmpping/icmppingsec).
 */
import ZabbixAlertEvent from '../models/ZabbixAlertEvent.js'
import { createZabbixClient } from './zabbix.js'
import { fetchAllMonitoredHosts } from './zabbixHostFetch.js'
import {
  getInstantAlertStatus,
  startInstantSlaWatcher,
  setZabbixAlertIo,
  runInstantSlaCheck,
} from './zabbixAlertInstant.js'
import { describeBusinessHoursStatus } from '../utils/zabbixAlertBusinessHours.js'

export { describeBusinessHoursStatus }

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

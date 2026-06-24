/**
 * Instant SLA alerting — edge-triggered breach detection + Zabbix problem/webhook hooks.
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

const storeClient = createZabbixClient('STORE_ZABBIX')
const { zabbixRpc, isZabbixConfigured } = storeClient

/** Per rule+host: was the SLA condition breaching on last check? */
const breachState = new Map()
/** Per rule+host: last instant notification time (ms). */
const hostNotifyAt = new Map()
/** Seen Zabbix problem event ids (webhook / problem poll dedupe). */
const seenProblemIds = new Set()
let maxProblemEventId = 0

let lastInstantAt = null
let lastInstantStats = null
let _io = null

export function setZabbixAlertIo(io) {
  _io = io
}

export function getInstantAlertStatus() {
  return { lastInstantAt, lastInstantStats, breachTracked: breachState.size }
}

function stateKey(ruleId, hostid) {
  return `${ruleId}:${hostid}`
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
  for (let i = 0; i < hostids.length; i += 400) {
    const slice = hostids.slice(i, i + 400)
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
  return {
    ...ping,
    cpu: pickScalarItem((itemBatches.cpu || []).filter((it) => String(it.hostid) === hid)),
    memory: pickScalarItem((itemBatches.mem || []).filter((it) => String(it.hostid) === hid)),
    agentPing: pickScalarItem((itemBatches.agent || []).filter((it) => String(it.hostid) === hid)),
  }
}

function hostMatchesScope(host, scope, groupMap) {
  const type = scope?.type || 'global'
  if (type === 'global') return true
  if (type === 'group') {
    return hostInGroup(groupMap[String(host.hostid)] || [], scope.groupName)
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
    if (metrics.packetLoss != null && metrics.packetLoss >= 100) return true
    if (metrics.raw?.packetLoss?.fresh && metrics.raw.packetLoss.value >= 100) return true
    return metrics.agentPing === 0
  }
  if (metric === 'agent_down') return metrics.agentPing === 0
  if (metric === 'cpu') value = metrics.cpu
  if (metric === 'memory') value = metrics.memory
  if (metric === 'latency') { value = metrics.latency; if (value == null) return false }
  if (metric === 'jitter') { value = metrics.jitter; if (value == null) return false }
  if (metric === 'packet_loss') { value = metrics.packetLoss; if (value == null) return false }
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

function hostCooldownMs(rule) {
  const ruleMin = Number(rule.cooldownMinutes)
  const envMin = parseInt(process.env.ZABBIX_ALERT_HOST_COOLDOWN_MIN || '15', 10)
  const min = Number.isFinite(ruleMin) && ruleMin > 0 ? ruleMin : envMin
  return min * 60 * 1000
}

function isNewSlaBreach(ruleId, hostid, breaching, { seedOnly = false } = {}) {
  const key = stateKey(ruleId, hostid)
  if (seedOnly) {
    /** Baseline as healthy so hosts already breaching get notified on the first real poll. */
    breachState.set(key, false)
    return false
  }
  const wasBreaching = breachState.get(key) === true
  breachState.set(key, breaching)
  return breaching && !wasBreaching
}

function hostCooldownOk(rule, hostid) {
  const key = stateKey(rule._id, hostid)
  const last = hostNotifyAt.get(key) || 0
  return Date.now() - last >= hostCooldownMs(rule)
}

function markHostNotified(rule, hostid) {
  hostNotifyAt.set(stateKey(rule._id, hostid), Date.now())
}

async function fireRuleForHosts(rule, affected, { source = 'instant' } = {}) {
  if (!affected.length) return null
  const dispatch = await dispatchZabbixAlertNotifications(rule, affected)
  const event = await ZabbixAlertEvent.create({
    ruleId: rule._id,
    ruleName: rule.name,
    severity: rule.severity,
    condition: rule.condition,
    affectedCount: affected.length,
    hosts: affected.slice(0, 50),
    hasMore: affected.length > 50,
    dispatch,
    eventStatus: 'problem',
    source,
  })
  await ZabbixAlertRule.findByIdAndUpdate(rule._id, { lastFiredAt: new Date() })
  for (const h of affected) markHostNotified(rule, h.hostid)
  if (_io) {
    _io.to('zabbix-alerts').emit('zabbix:alert', {
      id: event._id,
      ruleName: rule.name,
      severity: rule.severity,
      affectedCount: affected.length,
      firedAt: event.firedAt,
      instant: true,
    })
  }
  return { event, dispatch }
}

function collectScopedHosts(rules, hostRows, groupMap) {
  const out = []
  const seen = new Set()
  for (const h of hostRows) {
    const id = String(h.hostid)
    if (seen.has(id)) continue
    if (rules.some((r) => hostMatchesScope(h, r.scope, groupMap))) {
      seen.add(id)
      out.push(h)
    }
  }
  return out
}

async function buildItemBatchesForHosts(hostids) {
  const [msItems, jitterItems, lossItems, cpuItems, memItems, agentItems] = await Promise.all([
    fetchItemsChunked(hostids, 'custom.ping.ms'),
    fetchItemsChunked(hostids, 'custom.ping.jitter'),
    fetchItemsChunked(hostids, 'custom.ping.loss'),
    fetchItemsChunked(hostids, 'system.cpu.util'),
    fetchItemsChunked(hostids, 'vm.memory.util'),
    fetchItemsChunked(hostids, 'agent.ping'),
  ])
  return {
    pingIndexes: {
      latency: indexCustomPingItems(msItems, STORE_PING_KEY_RES.latency),
      jitter: indexCustomPingItems(jitterItems, STORE_PING_KEY_RES.jitter),
      packetLoss: indexCustomPingItems(lossItems, STORE_PING_KEY_RES.packetLoss),
    },
    cpu: cpuItems,
    mem: memItems,
    agent: agentItems,
  }
}

/**
 * Instant SLA loop — polls scoped hosts every N seconds, fires Slack on NEW breach only.
 */
export async function runInstantSlaCheck({ seedState = false, includeAllHosts = false, forceNotify = false } = {}) {
  if (!isZabbixConfigured()) {
    return { fired: 0, skipped: 0, reason: 'zabbix_not_configured' }
  }

  const rules = await ZabbixAlertRule.find({ enabled: true }).lean()
  if (!rules.length) return { fired: 0, skipped: 0, results: [] }

  const nowSec = Math.floor(Date.now() / 1000)
  const staleAfterSec = getStaleAfterSec()

  const { rows: hostRows } = await fetchAllMonitoredHosts(zabbixRpc, {
    output: ['hostid', 'host', 'name', 'available', 'active_available'],
    selectHostGroups: ['groupid', 'name'],
  })

  const groupMap = {}
  for (const h of hostRows) {
    groupMap[String(h.hostid)] = (h.hostgroups || h.groups || []).map((g) => g.name)
  }

  const scopedHosts = includeAllHosts ? hostRows : collectScopedHosts(rules, hostRows, groupMap)
  const hostids = scopedHosts.map((h) => String(h.hostid))
  if (!hostids.length) return { fired: 0, skipped: 0, results: [] }

  const itemBatches = await buildItemBatchesForHosts(hostids)
  const results = []
  let fired = 0
  let skipped = 0
  let breachingHosts = 0
  let edgeBlocked = 0
  let cooldownBlocked = 0
  let noMetricData = 0

  for (const rule of rules) {
    if (!shouldNotifyForBhPolicy(rule)) {
      skipped++
      results.push({ ruleId: rule._id, ruleName: rule.name, skipped: true, reason: 'business_hours' })
      continue
    }
    const pingTarget = String(rule.condition?.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
    const affected = []
    const ruleDiag = { breaching: 0, edgeBlocked: 0, cooldownBlocked: 0, noData: 0 }

    for (const h of scopedHosts) {
      if (!hostMatchesScope(h, rule.scope, groupMap)) continue
      const metrics = buildHostMetrics(h.hostid, itemBatches, pingTarget, nowSec, staleAfterSec)
      const breaching = evaluateCondition(rule.condition, metrics, h)
      if (['latency', 'jitter', 'packet_loss'].includes(rule.condition?.metric)) {
        const val = rule.condition.metric === 'latency' ? metrics.latency
          : rule.condition.metric === 'jitter' ? metrics.jitter : metrics.packetLoss
        if (val == null) {
          noMetricData++
          ruleDiag.noData++
        }
      }
      if (!breaching) {
        if (!seedState) isNewSlaBreach(String(rule._id), String(h.hostid), false)
        continue
      }
      breachingHosts++
      ruleDiag.breaching++
      const isNew = forceNotify || isNewSlaBreach(String(rule._id), String(h.hostid), breaching, { seedOnly: seedState })
      if (!isNew) {
        edgeBlocked++
        ruleDiag.edgeBlocked++
        continue
      }
      if (!hostCooldownOk(rule, h.hostid)) {
        skipped++
        cooldownBlocked++
        ruleDiag.cooldownBlocked++
        continue
      }
      if (forceNotify) {
        breachState.set(stateKey(String(rule._id), String(h.hostid)), true)
      }
      affected.push({
        hostid: String(h.hostid),
        hostname: h.host,
        name: h.name,
        triggeredValue: triggeredValueForMetric(rule.condition, metrics),
        latency: metrics.latency,
        jitter: metrics.jitter,
        packetLoss: metrics.packetLoss,
        cpu: metrics.cpu,
        memory: metrics.memory,
        sensorKeys: metrics.itemKeys,
        pingTarget,
      })
    }

    if (!affected.length) {
      if (ruleDiag.breaching > 0 || ruleDiag.noData > 0) {
        results.push({ ruleId: rule._id, ruleName: rule.name, fired: false, diag: ruleDiag })
      }
      continue
    }
    try {
      const res = await fireRuleForHosts(rule, affected, { source: forceNotify ? 'scheduled' : 'instant_sla' })
      fired++
      results.push({ ruleId: rule._id, ruleName: rule.name, fired: true, affected: affected.length, dispatch: res?.dispatch })
    } catch (e) {
      results.push({ ruleId: rule._id, ruleName: rule.name, error: e.message })
    }
  }

  const stats = {
    fired,
    skipped,
    mode: forceNotify ? 'force' : 'instant_sla',
    hostsChecked: scopedHosts.length,
    breachingHosts,
    edgeBlocked,
    cooldownBlocked,
    noMetricData,
    evaluatedAt: new Date().toISOString(),
    staleAfterSec,
  }
  lastInstantAt = stats.evaluatedAt
  lastInstantStats = stats
  return { ...stats, results }
}

function isPingRelatedProblem(name) {
  const n = String(name || '').toLowerCase()
  return /ping|latency|jitter|packet\s*loss|custom\.ping|unreachable|host down|agent/.test(n)
}

/** Poll Zabbix for brand-new problems (trigger-fired) and notify matching rules immediately. */
export async function pollZabbixNewProblems() {
  if (!isZabbixConfigured()) return { fired: 0 }

  const problems = await zabbixRpc('problem.get', {
    output: ['eventid', 'name', 'severity', 'clock', 'objectid'],
    selectHosts: ['hostid', 'host', 'name'],
    recent: true,
    sortfield: ['eventid'],
    sortorder: 'DESC',
    limit: 100,
  }).catch(() => [])

  const rules = await ZabbixAlertRule.find({ enabled: true }).lean()
  if (!rules.length || !problems?.length) return { fired: 0 }

  let fired = 0
  for (const p of problems) {
    const eid = Number(p.eventid)
    if (!Number.isFinite(eid) || eid <= maxProblemEventId) continue
    if (seenProblemIds.has(eid)) continue
    seenProblemIds.add(eid)
    if (eid > maxProblemEventId) maxProblemEventId = eid
    while (seenProblemIds.size > 5000) {
      const first = seenProblemIds.values().next().value
      seenProblemIds.delete(first)
    }

    if (!isPingRelatedProblem(p.name)) continue
    const hosts = p.hosts || []
    if (!hosts.length) continue

    const nowSec = Math.floor(Date.now() / 1000)
    const staleAfterSec = getStaleAfterSec()
    const hostids = hosts.map((h) => String(h.hostid))

    const { rows: hostRows } = await fetchAllMonitoredHosts(zabbixRpc, {
      hostids,
      output: ['hostid', 'host', 'name', 'available', 'active_available'],
      selectHostGroups: ['groupid', 'name'],
    })
    const fullHosts = hostRows || hosts
    const groupMap = {}
    for (const h of fullHosts) {
      groupMap[String(h.hostid)] = (h.hostgroups || h.groups || []).map((g) => g.name)
    }

    const itemBatches = await buildItemBatchesForHosts(hostids)

    for (const rule of rules) {
      if (!shouldNotifyForBhPolicy(rule)) continue
      const pingTarget = String(rule.condition?.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
      const affected = []
      for (const h of fullHosts) {
        if (!hostMatchesScope(h, rule.scope, groupMap)) continue
        const metrics = buildHostMetrics(h.hostid, itemBatches, pingTarget, nowSec, staleAfterSec)
        if (!evaluateCondition(rule.condition, metrics, h)) continue
        if (!hostCooldownOk(rule, h.hostid)) continue
        affected.push({
          hostid: String(h.hostid),
          hostname: h.host,
          name: h.name,
          trigger: p.name,
          triggeredValue: triggeredValueForMetric(rule.condition, metrics),
          latency: metrics.latency,
          jitter: metrics.jitter,
          packetLoss: metrics.packetLoss,
          sensorKeys: metrics.itemKeys,
          pingTarget,
        })
      }
      if (!affected.length) continue
      await fireRuleForHosts(rule, affected, { source: 'zabbix_problem' })
      fired++
    }
  }
  return { fired }
}

/** Zabbix media-type webhook → instant Slack (configure in Zabbix action). */
export async function handleZabbixAlertWebhook(body, { eventId } = {}) {
  if (!isZabbixConfigured()) {
    return { ok: false, error: 'Store Zabbix not configured' }
  }
  const eid = Number(eventId || body?.event_id || body?.eventid || body?.EVENT?.ID)
  if (Number.isFinite(eid) && eid > 0) {
    if (seenProblemIds.has(eid)) return { ok: true, deduped: true }
    seenProblemIds.add(eid)
  }

  const hostname = String(
    body?.host_name || body?.hostname || body?.HOST?.NAME || body?.host || body?.HOSTNAME || '',
  ).trim()
  if (!hostname) return { ok: false, error: 'hostname missing in webhook payload' }

  const hosts = await zabbixRpc('host.get', {
    filter: { host: [hostname] },
    output: ['hostid', 'host', 'name', 'available', 'active_available'],
    selectHostGroups: ['name'],
    limit: 1,
  }).catch(() => [])
  const host = hosts?.[0]
  if (!host) {
    return { ok: false, error: `host not found: ${hostname}` }
  }

  const rules = await ZabbixAlertRule.find({ enabled: true }).lean()
  const groupMap = { [String(host.hostid)]: (host.hostgroups || []).map((g) => g.name) }
  const nowSec = Math.floor(Date.now() / 1000)
  const itemBatches = await buildItemBatchesForHosts([String(host.hostid)])

  let fired = 0
  for (const rule of rules) {
    if (!shouldNotifyForBhPolicy(rule)) continue
    if (!hostMatchesScope(host, rule.scope, groupMap)) continue
    if (!hostCooldownOk(rule, host.hostid)) continue
    const pingTarget = String(rule.condition?.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
    const metrics = buildHostMetrics(host.hostid, itemBatches, pingTarget, nowSec, getStaleAfterSec())
    if (!evaluateCondition(rule.condition, metrics, host)) continue

    await fireRuleForHosts(rule, [{
      hostid: String(host.hostid),
      hostname: host.host,
      name: host.name,
      trigger: String(body?.trigger_name || body?.TRIGGER?.NAME || body?.alert_message || 'Zabbix webhook'),
      triggeredValue: triggeredValueForMetric(rule.condition, metrics),
      latency: metrics.latency,
      jitter: metrics.jitter,
      packetLoss: metrics.packetLoss,
      sensorKeys: metrics.itemKeys,
      pingTarget,
    }], { source: 'zabbix_webhook' })
    fired++
  }
  return { ok: true, fired, hostname }
}

async function initProblemWatermark() {
  try {
    const rows = await zabbixRpc('problem.get', {
      output: ['eventid'],
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit: 1,
    })
    const eid = Number(rows?.[0]?.eventid)
    if (Number.isFinite(eid) && eid > 0) {
      maxProblemEventId = eid
      console.log(`[zabbixAlertInstant] Problem watermark eventid=${maxProblemEventId}`)
    }
  } catch (e) {
    console.warn('[zabbixAlertInstant] Problem watermark init failed:', e.message)
  }
}

export function startInstantSlaWatcher() {
  const instantMs = parseInt(process.env.ZABBIX_ALERT_INSTANT_MS || '10000', 10)
  const problemMs = parseInt(process.env.ZABBIX_ALERT_PROBLEM_MS || '10000', 10)

  if (!isZabbixConfigured()) return

  console.log(`[zabbixAlertInstant] SLA edge-check every ${instantMs / 1000}s · problem poll every ${problemMs / 1000}s`)

  void initProblemWatermark()

  setTimeout(async () => {
    await runInstantSlaCheck({ seedState: true }).catch((e) => console.error('[zabbixAlertInstant] seed', e.message))
  }, 20_000)

  setInterval(async () => {
    await runInstantSlaCheck().catch((e) => console.error('[zabbixAlertInstant] sla', e.message))
  }, instantMs)

  setInterval(async () => {
    await pollZabbixNewProblems().catch((e) => console.error('[zabbixAlertInstant] problems', e.message))
  }, problemMs)
}

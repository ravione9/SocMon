import { DEFAULT_PING_TARGET } from './zabbixStorePingSensors.js'

export const CONDITION_METRICS = [
  'host_down', 'agent_down', 'interface_down',
  'cpu', 'memory', 'disk',
  'latency', 'jitter', 'packet_loss',
  'bandwidth', 'zabbix_problem',
]

export const CONDITION_OPERATORS = ['gt', 'lt', 'eq', 'gte', 'lte', 'between']

export function blankCondition(overrides = {}) {
  return {
    metric: 'latency',
    operator: 'gt',
    threshold: 150,
    thresholdMax: 250,
    target: DEFAULT_PING_TARGET,
    triggerPattern: '',
    ...overrides,
  }
}

/** Normalize legacy single `condition` or new `conditions[]`. */
export function getRuleConditions(rule) {
  const list = rule?.conditions?.length ? rule.conditions : null
  if (list?.length) return list
  if (rule?.condition?.metric) return [rule.condition]
  return [blankCondition()]
}

export function primaryPingTarget(rule) {
  for (const c of getRuleConditions(rule)) {
    if (['latency', 'jitter', 'packet_loss'].includes(c.metric)) {
      return String(c.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
    }
  }
  return DEFAULT_PING_TARGET
}

export function uniquePingTargets(rule) {
  const targets = new Set()
  for (const c of getRuleConditions(rule)) {
    if (['latency', 'jitter', 'packet_loss'].includes(c.metric)) {
      targets.add(String(c.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET)
    }
  }
  return targets.size ? [...targets] : [DEFAULT_PING_TARGET]
}

export function evaluateSingleCondition(cond, metrics, host) {
  const { metric, operator, threshold, thresholdMax } = cond || {}
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

export function metricValueFromMetrics(cond, metrics) {
  const m = cond?.metric
  if (m === 'latency') return metrics.latency
  if (m === 'jitter') return metrics.jitter
  if (m === 'packet_loss') return metrics.packetLoss
  if (m === 'cpu') return metrics.cpu
  if (m === 'memory') return metrics.memory
  return null
}

export function triggeredValuesForRule(rule, metricsByTarget, buildMetrics) {
  const out = {}
  for (const cond of getRuleConditions(rule)) {
    const target = String(cond.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
    const metrics = metricsByTarget.get(target) || buildMetrics(target)
    if (!metricsByTarget.has(target)) metricsByTarget.set(target, metrics)
    const val = metricValueFromMetrics(cond, metrics)
    if (val != null) out[cond.metric] = val
  }
  return out
}

/**
 * Evaluate all conditions for one host.
 * @param {Function} buildMetrics — (pingTarget) => metrics object
 */
export function evaluateRuleConditions(rule, host, buildMetrics) {
  const conditions = getRuleConditions(rule)
  const logic = rule?.logic || 'and'
  const cache = new Map()

  const getMetrics = (cond) => {
    const target = String(cond.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
    if (!cache.has(target)) cache.set(target, buildMetrics(target))
    return cache.get(target)
  }

  const results = conditions.map((cond) => evaluateSingleCondition(cond, getMetrics(cond), host))
  if (logic === 'or') return results.some(Boolean)
  return results.every(Boolean)
}

export function ruleMissingPingMetricData(rule, buildMetrics) {
  for (const cond of getRuleConditions(rule)) {
    if (!['latency', 'jitter', 'packet_loss'].includes(cond.metric)) continue
    const target = String(cond.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET
    const metrics = buildMetrics(target)
    if (metricValueFromMetrics(cond, metrics) == null) return true
  }
  return false
}

export function normalizeRulePayload(body) {
  const payload = { ...body }
  let conditions = Array.isArray(payload.conditions) ? payload.conditions.filter((c) => c?.metric) : []
  if (!conditions.length && payload.condition?.metric) {
    conditions = [payload.condition]
  }
  if (!conditions.length) {
    conditions = [blankCondition()]
  }
  payload.conditions = conditions.map((c) => ({
    ...blankCondition(),
    ...c,
    target: String(c.target || DEFAULT_PING_TARGET).trim() || DEFAULT_PING_TARGET,
  }))
  payload.condition = payload.conditions[0]
  payload.logic = payload.logic === 'or' ? 'or' : 'and'
  return payload
}

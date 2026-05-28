/**
 * Prebuilt + custom SolarWinds / Orion reports (SWQL-backed).
 */

import { orionSwisQuery, withOrionReportTimeout } from './solarwinds.js'
import { fetchActiveAlerts, fetchEvents } from './solarwindsNodeSnapshot.js'
import {
  discoverIfaceCPFields,
  inBusinessHours,
  parseBusinessHours,
  toOrionDT,
} from './solarwindsCustomProps.js'

const NODE_STATUS = {
  0: 'Unknown', 1: 'Up', 2: 'Down', 3: 'Warning',
  9: 'Unmanaged', 12: 'Unknown', 14: 'Unknown',
}
const ALERT_SEVERITY = {
  0: 'Information', 1: 'Warning', 2: 'High', 3: 'Critical',
}

function nodeStatusLabel(s) {
  return NODE_STATUS[Number(s)] || `Status ${s}`
}
function alertSeverityLabel(s) {
  return ALERT_SEVERITY[Number(s)] || String(s)
}
function swqlEscape(s) {
  return String(s || '').replace(/'/g, "''")
}
function clampInt(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

export const SW_REPORT_DEFS = [
  {
    id: 'executive_summary',
    title: 'Executive summary',
    description: 'Network health snapshot — current node/alert state plus optional period metrics (availability, events, alerts triggered).',
    category: 'Executive',
    icon: '▤',
    usesTimeRange: true,
    usesBusinessHours: true,
  },
  {
    id: 'node_inventory',
    title: 'Node inventory',
    description: 'Full managed node list with status, response time, CPU, and memory.',
    category: 'Nodes',
    icon: '▦',
    usesLimit: true,
    defaultLimit: 500,
  },
  {
    id: 'nodes_impaired',
    title: 'Down & warning nodes',
    description: 'Nodes currently in Down or Warning state — priority remediation list.',
    category: 'Nodes',
    icon: '⚠',
    usesLimit: true,
    defaultLimit: 500,
  },
  {
    id: 'down_interfaces',
    title: 'Down interfaces',
    description: 'Interfaces in Down state with carrier, carrier description, and optional time window + business hours.',
    category: 'Nodes',
    icon: '⬇',
    usesLimit: true,
    defaultLimit: 500,
    usesTimeRange: true,
    usesBusinessHours: true,
    usesCarrierFilter: true,
  },
  {
    id: 'active_alerts',
    title: 'Active alerts',
    description: 'All currently active alert objects with severity, object, and trigger time.',
    category: 'Alerts',
    icon: '🔔',
    usesLimit: true,
    defaultLimit: 300,
  },
  {
    id: 'critical_high_alerts',
    title: 'Critical & high alerts',
    description: 'Active Critical and High severity alerts only.',
    category: 'Alerts',
    icon: '🚨',
    usesLimit: true,
    defaultLimit: 300,
  },
  {
    id: 'recent_events',
    title: 'Recent events',
    description: 'Orion events within the selected time window (node, type, message).',
    category: 'Events',
    icon: '◉',
    usesHours: true,
    defaultHours: 24,
    usesLimit: true,
    defaultLimit: 500,
  },
  {
    id: 'unacknowledged_events',
    title: 'Unacknowledged events',
    description: 'Events not yet acknowledged — useful for NOC handoff and SLA tracking.',
    category: 'Events',
    icon: '✉',
    usesHours: true,
    defaultHours: 48,
    usesLimit: true,
    defaultLimit: 500,
  },
  {
    id: 'capacity_stress',
    title: 'Capacity stress (CPU / memory)',
    description: 'Nodes with CPU or memory utilization above the threshold.',
    category: 'Capacity',
    icon: '📈',
    usesThreshold: true,
    defaultThreshold: 80,
    usesLimit: true,
    defaultLimit: 200,
  },
  {
    id: 'custom',
    title: 'Custom report',
    description: 'Pick a data source, columns, and filters to build your own exportable report.',
    category: 'Custom',
    icon: '◇',
    custom: true,
  },
]

export const CUSTOM_REPORT_SOURCES = {
  nodes: {
    label: 'Nodes',
    columns: [
      { key: 'name', label: 'Node' },
      { key: 'ip', label: 'IP address' },
      { key: 'status', label: 'Status' },
      { key: 'responseTime', label: 'Response (ms)' },
      { key: 'packetLoss', label: 'Packet loss %' },
      { key: 'cpu', label: 'CPU %' },
      { key: 'memory', label: 'Memory %' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'machineType', label: 'Type' },
      { key: 'location', label: 'Location' },
      { key: 'dns', label: 'DNS' },
    ],
    defaultColumns: ['name', 'ip', 'status', 'responseTime', 'cpu', 'memory'],
  },
  alerts: {
    label: 'Alerts',
    columns: [
      { key: 'name', label: 'Alert name' },
      { key: 'severity', label: 'Severity' },
      { key: 'objectName', label: 'Object' },
      { key: 'objectType', label: 'Type' },
      { key: 'count', label: 'Trigger count' },
      { key: 'lastTriggered', label: 'Last triggered' },
      { key: 'description', label: 'Description' },
    ],
    defaultColumns: ['severity', 'name', 'objectName', 'lastTriggered', 'count'],
  },
  events: {
    label: 'Events',
    columns: [
      { key: 'time', label: 'Time' },
      { key: 'node', label: 'Node' },
      { key: 'carrier', label: 'Carrier' },
      { key: 'carrierDescription', label: 'Link description' },
      { key: 'typeLabel', label: 'Event type' },
      { key: 'message', label: 'Message' },
      { key: 'acknowledged', label: 'Acknowledged' },
    ],
    defaultColumns: ['time', 'node', 'carrier', 'carrierDescription', 'typeLabel', 'message', 'acknowledged'],
  },
}

export function getReportCatalog() {
  return SW_REPORT_DEFS.map(({ custom, ...rest }) => rest)
}

function col(keys, labels) {
  return keys.map((key, i) => ({ key, label: labels[i] }))
}

function reportFilterSummary(params) {
  const filters = {}
  const carrier = String(params.carrier || '').trim()
  const carrierDescription = String(params.carrierDescription || params.carrierDesc || '').trim()
  if (carrier && carrier.toLowerCase() !== 'all') filters.carrier = carrier
  if (carrierDescription && carrierDescription.toLowerCase() !== 'all') {
    filters.carrierDescription = carrierDescription
  }
  return Object.keys(filters).length ? { filters } : {}
}

function applyCarrierFilters(rows, params) {
  const carrier = String(params.carrier || '').trim()
  const carrierDescription = String(params.carrierDescription || params.carrierDesc || '').trim()
  let out = rows || []
  if (carrier && carrier.toLowerCase() !== 'all') {
    out = out.filter((r) => String(r.carrier || '').trim() === carrier)
  }
  if (carrierDescription && carrierDescription.toLowerCase() !== 'all') {
    const q = carrierDescription.toLowerCase()
    out = out.filter((r) => String(r.carrierDescription || '').toLowerCase().includes(q))
  }
  return out
}

function buildIfaceCpWhere(params, carrierField, descField) {
  const parts = []
  const carrier = String(params.carrier || '').trim()
  const carrierDescription = String(params.carrierDescription || params.carrierDesc || '').trim()
  if (carrier && carrier.toLowerCase() !== 'all' && carrierField) {
    parts.push(`icp.${carrierField} = '${swqlEscape(carrier)}'`)
  }
  if (carrierDescription && carrierDescription.toLowerCase() !== 'all' && descField) {
    parts.push(`icp.${descField} LIKE '%${swqlEscape(carrierDescription)}%'`)
  }
  return parts
}

function reportTimeSummary(params, bh) {
  const summary = {}
  if (params.from && params.to) {
    summary.timeRange = { from: params.from, to: params.to }
  }
  if (bh?.enabled) {
    summary.businessHours = {
      enabled: true,
      start: params.bhStart || '09:00',
      end: params.bhEnd || '18:00',
      days: [...bh.days].sort(),
    }
  }
  return summary
}

function reportPayload(def, { summary = null, columns, rows }) {
  return {
    reportId: def.id,
    title: def.title,
    description: def.description,
    category: def.category,
    generatedAt: new Date().toISOString(),
    summary,
    columns,
    rows,
    rowCount: rows.length,
  }
}

async function fetchOverviewSummary() {
  const [nodeData, alertData] = await Promise.all([
    orionSwisQuery('SELECT Status, COUNT(NodeID) AS NodeCount FROM Orion.Nodes GROUP BY Status'),
    orionSwisQuery(
      `SELECT ac.Severity, COUNT(ao.AlertID) AS AlertCount
       FROM Orion.AlertObjects ao
       INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID
       GROUP BY ac.Severity`,
    ),
  ])

  const nodes = { total: 0, up: 0, down: 0, warning: 0, other: 0 }
  for (const r of nodeData?.results || []) {
    const n = Number(r.NodeCount ?? 0)
    nodes.total += n
    const code = Number(r.Status)
    if (code === 1) nodes.up += n
    else if (code === 2) nodes.down += n
    else if (code === 3) nodes.warning += n
    else nodes.other += n
  }

  const alerts = { total: 0, Critical: 0, High: 0, Warning: 0, Information: 0, other: 0 }
  for (const r of alertData?.results || []) {
    const n = Number(r.AlertCount ?? 0)
    alerts.total += n
    const label = alertSeverityLabel(r.Severity)
    if (label in alerts) alerts[label] += n
    else alerts.other += n
  }

  const availPct = nodes.total ? Math.round((nodes.up / nodes.total) * 1000) / 10 : null
  return { nodes, alerts, availabilityPct: availPct }
}

async function avgAvailabilityInWindow(fromIso, toIso, bh) {
  const from = toOrionDT(fromIso)
  const to = toOrionDT(toIso)
  if (!from || !to) return null

  if (!bh?.enabled) {
    try {
      const data = await orionSwisQuery(
        `SELECT AVG(Availability) AS Avail FROM Orion.ResponseTime
         WHERE DateTime >= '${from}' AND DateTime <= '${to}'`,
      )
      const v = Number(data?.results?.[0]?.Avail)
      return Number.isFinite(v) ? Math.round(v * 10) / 10 : null
    } catch {
      return null
    }
  }

  try {
    const data = await orionSwisQuery(
      `SELECT TOP 3000 DateTime, Availability FROM Orion.ResponseTime
       WHERE DateTime >= '${from}' AND DateTime <= '${to}'
       ORDER BY DateTime DESC`,
    )
    let samples = data?.results || []
    samples = samples.filter((r) => {
      const t = new Date(r.DateTime)
      return !Number.isNaN(t.getTime()) && inBusinessHours(t, bh)
    })
    if (!samples.length) return null
    const sum = samples.reduce((s, r) => s + Number(r.Availability || 0), 0)
    return Math.round((sum / samples.length) * 10) / 10
  } catch {
    return null
  }
}

async function nodeEventStatsInWindow(fromIso, toIso, bh) {
  const from = toOrionDT(fromIso)
  const to = toOrionDT(toIso)
  if (!from || !to) return { downEventCount: 0, distinctDownNodes: 0, warningEventCount: 0 }

  const baseWhere = `EventTime >= '${from}' AND EventTime <= '${to}' AND NetObjectType = 'N'`

  if (!bh?.enabled) {
    try {
      const [downData, warnData, nodeData] = await Promise.all([
        orionSwisQuery(`SELECT COUNT(EventID) AS C FROM Orion.Events WHERE ${baseWhere} AND EventType = 1`),
        orionSwisQuery(`SELECT COUNT(EventID) AS C FROM Orion.Events WHERE ${baseWhere} AND Message LIKE '%warning%'`),
        orionSwisQuery(`SELECT TOP 500 NetworkNode FROM Orion.Events WHERE ${baseWhere} AND EventType = 1 GROUP BY NetworkNode`),
      ])
      const downEventCount = Number(downData?.results?.[0]?.C ?? 0)
      const warningEventCount = Number(warnData?.results?.[0]?.C ?? 0)
      const distinctDownNodes = (nodeData?.results || []).length
      return { downEventCount, distinctDownNodes, warningEventCount }
    } catch {
      return { downEventCount: 0, distinctDownNodes: 0, warningEventCount: 0 }
    }
  }

  try {
    const data = await orionSwisQuery(
      `SELECT TOP 2500 EventTime, EventType, NetworkNode, Message FROM Orion.Events
       WHERE ${baseWhere} ORDER BY EventTime DESC`,
    )
    let events = data?.results || []
    events = events.filter((e) => {
      const t = new Date(e.EventTime)
      return !Number.isNaN(t.getTime()) && inBusinessHours(t, bh)
    })
    const downEvents = events.filter((e) =>
      Number(e.EventType) === 1 || /\bdown\b/i.test(String(e.Message || '')),
    )
    const warningEvents = events.filter((e) => /warning/i.test(String(e.Message || '')))
    return {
      downEventCount: downEvents.length,
      distinctDownNodes: new Set(downEvents.map((e) => e.NetworkNode).filter((id) => id != null)).size,
      warningEventCount: warningEvents.length,
    }
  } catch {
    return { downEventCount: 0, distinctDownNodes: 0, warningEventCount: 0 }
  }
}

async function alertCountsInWindow(fromIso, toIso, bh) {
  const empty = { total: 0, Critical: 0, High: 0, Warning: 0, Information: 0, other: 0 }
  const from = toOrionDT(fromIso)
  const to = toOrionDT(toIso)
  if (!from || !to) return empty

  if (!bh?.enabled) {
    try {
      const data = await orionSwisQuery(
        `SELECT ac.Severity, COUNT(ao.AlertObjectID) AS AlertCount
         FROM Orion.AlertObjects ao
         INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID
         WHERE ao.LastTriggeredDateTime >= '${from}' AND ao.LastTriggeredDateTime <= '${to}'
         GROUP BY ac.Severity`,
      )
      const counts = { ...empty }
      for (const r of data?.results || []) {
        const n = Number(r.AlertCount ?? 0)
        counts.total += n
        const label = alertSeverityLabel(r.Severity)
        if (label in counts) counts[label] += n
        else counts.other += n
      }
      return counts
    } catch {
      /* fall through to alert list filter */
    }
  }

  const alerts = await fetchActiveAlerts(600)
  return alertsTriggeredInWindow(alerts, fromIso, toIso, bh)
}

async function fetchEventsForReport({ limit = 200, hours = 24, unackedOnly = false } = {}) {
  const top = clampInt(limit, 10, 500, 200)
  const hrs = clampInt(hours, 1, 168, 24)
  const from = new Date(Date.now() - hrs * 3600 * 1000).toISOString()
  const to = new Date().toISOString()
  return fetchEvents(top, { from, to, unackedOnly })
}

function alertsTriggeredInWindow(alerts, fromIso, toIso, bh) {
  const fromMs = new Date(fromIso).getTime()
  const toMs = new Date(toIso).getTime()
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { total: 0, Critical: 0, High: 0, Warning: 0, Information: 0, other: 0 }
  }
  const counts = { total: 0, Critical: 0, High: 0, Warning: 0, Information: 0, other: 0 }
  for (const a of alerts) {
    if (!a.lastTriggered) continue
    const t = new Date(a.lastTriggered)
    if (Number.isNaN(t.getTime()) || t.getTime() < fromMs || t.getTime() > toMs) continue
    if (bh?.enabled && !inBusinessHours(t, bh)) continue
    counts.total++
    const label = a.severity
    if (label in counts) counts[label]++
    else counts.other++
  }
  return counts
}

async function fetchExecutiveSummary(params = {}) {
  const snapshot = await fetchOverviewSummary()
  const bh = parseBusinessHours(params)
  const hasWindow = Boolean(params.from && params.to)
  if (!hasWindow) return { ...snapshot, period: null }

  const [periodAvail, eventStats, periodAlerts] = await Promise.all([
    avgAvailabilityInWindow(params.from, params.to, bh),
    nodeEventStatsInWindow(params.from, params.to, bh),
    alertCountsInWindow(params.from, params.to, bh),
  ])

  return {
    ...snapshot,
    period: {
      avgAvailabilityPct: periodAvail,
      ...eventStats,
      alerts: periodAlerts,
    },
  }
}

async function fetchNodeRows({ where = '', limit = 500 } = {}) {
  let swql = `SELECT TOP ${limit} NodeID, Caption, IPAddress, Status, StatusDescription,
    ResponseTime, PercentLoss, CPULoad, PercentMemoryUsed,
    Vendor, MachineType, DNS, Location
    FROM Orion.Nodes`
  if (where) swql += ` WHERE ${where}`
  swql += ' ORDER BY Status, Caption'
  const data = await orionSwisQuery(swql)
  return (data?.results || []).map((n) => ({
    name: n.Caption,
    ip: n.IPAddress || '',
    status: nodeStatusLabel(n.Status),
    statusCode: Number(n.Status),
    responseTime: n.ResponseTime != null ? Number(n.ResponseTime) : null,
    packetLoss: n.PercentLoss != null ? Number(n.PercentLoss) : null,
    cpu: n.CPULoad != null ? Number(n.CPULoad) : null,
    memory: n.PercentMemoryUsed != null ? Number(n.PercentMemoryUsed) : null,
    vendor: n.Vendor || '',
    machineType: n.MachineType || '',
    location: n.Location || '',
    dns: n.DNS || '',
  }))
}

function isInterfaceDownMessage(message) {
  const msg = String(message || '').toLowerCase()
  return msg.includes('down') || msg.includes('changed to down') || msg.includes('is down')
}

function mapDownInterfaceRow(r, downTime = null) {
  return {
    node: r.NodeName,
    ip: r.IPAddress || '',
    interface: r.InterfaceName,
    carrier: r.CarrierName || '',
    carrierDescription: r.CarrierDescription || '',
    status: nodeStatusLabel(r.Status),
    downTime: downTime ? new Date(downTime).toISOString() : '',
    inBps: r.InBps != null ? Number(r.InBps) : null,
    outBps: r.OutBps != null ? Number(r.OutBps) : null,
    utilization: r.PercentUtil != null ? Number(r.PercentUtil) : null,
  }
}

async function ifaceCpSelects() {
  const ifaceFields = await discoverIfaceCPFields()
  const carrierField = ifaceFields.includes('CarrierName') ? 'CarrierName' : null
  const descField = ifaceFields.includes('Comments') ? 'Comments' : null
  const carrierSel = carrierField ? 'icp.CarrierName' : "''"
  const descSel = descField ? 'icp.Comments' : "''"
  return { carrierSel, descSel, carrierField, descField }
}

async function fetchDownInterfacesInWindow({ fromIso, toIso, bh, limit, carrierSel, descSel, params = {} }) {
  const from = toOrionDT(fromIso)
  const to = toOrionDT(toIso)
  if (!from || !to) return []

  const swql = `SELECT TOP ${Math.min(limit * 2, 800)} e.EventTime, e.Message,
    n.Caption AS NodeName, n.IPAddress,
    i.Caption AS InterfaceName, i.Status, i.InBps, i.OutBps, i.PercentUtil,
    ${carrierSel} AS CarrierName, ${descSel} AS CarrierDescription,
    i.InterfaceID
    FROM Orion.Events e
    INNER JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID
    LEFT JOIN Orion.NPM.Interfaces i ON e.NetObjectID = i.InterfaceID
    LEFT JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID
    WHERE e.EventTime >= '${from}' AND e.EventTime <= '${to}'
    AND e.NetObjectType = 'I'
    AND (e.Message LIKE '%down%' OR e.Message LIKE '%Down%')
    ORDER BY e.EventTime DESC`

  const data = await orionSwisQuery(swql)
  let events = data?.results || []
  events = events.filter((e) => isInterfaceDownMessage(e.Message))

  if (bh?.enabled) {
    events = events.filter((e) => {
      const t = new Date(e.EventTime)
      return !Number.isNaN(t.getTime()) && inBusinessHours(t, bh)
    })
  }

  const seen = new Map()
  for (const e of events) {
    const id = e.InterfaceID
    if (id == null) continue
    if (!seen.has(id)) seen.set(id, e)
  }

  return applyCarrierFilters(
    [...seen.values()].slice(0, limit).map((r) => mapDownInterfaceRow(r, r.EventTime)),
    params,
  )
}

async function fetchDownInterfaces(params = {}) {
  const limit = clampInt(params.limit, 10, 1000, 500)
  const fromIso = params.from || null
  const toIso = params.to || null
  const bh = parseBusinessHours(params)
  const { carrierSel, descSel, carrierField, descField } = await ifaceCpSelects()

  if (fromIso && toIso) {
    return fetchDownInterfacesInWindow({ fromIso, toIso, bh, limit, carrierSel, descSel, params })
  }

  const cpWhere = buildIfaceCpWhere(params, carrierField, descField)
  const swql = `SELECT TOP ${limit} i.Caption AS InterfaceName, i.Status,
    n.Caption AS NodeName, n.IPAddress, i.InBps, i.OutBps, i.PercentUtil,
    ${carrierSel} AS CarrierName, ${descSel} AS CarrierDescription
    FROM Orion.NPM.Interfaces i
    INNER JOIN Orion.Nodes n ON i.NodeID = n.NodeID
    LEFT JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID
    WHERE i.Status = 2${cpWhere.length ? ` AND ${cpWhere.join(' AND ')}` : ''}
    ORDER BY n.Caption, i.Caption`
  const data = await orionSwisQuery(swql)
  return applyCarrierFilters((data?.results || []).map((r) => mapDownInterfaceRow(r)), params)
}

function filterEventsByHours(events, hours) {
  const cutoff = Date.now() - hours * 3600 * 1000
  return events.filter((e) => {
    if (!e.time) return false
    return new Date(e.time).getTime() >= cutoff
  })
}

function pickColumns(rows, columnKeys, columnDefs) {
  const defMap = new Map(columnDefs.map((c) => [c.key, c.label]))
  const columns = columnKeys.map((key) => ({ key, label: defMap.get(key) || key }))
  const picked = rows.map((row) => {
    const out = {}
    for (const key of columnKeys) {
      let val = row[key]
      if (key === 'acknowledged') val = val ? 'Yes' : 'No'
      if (key === 'lastTriggered' || key === 'time') {
        val = val ? new Date(val).toISOString() : ''
      }
      out[key] = val ?? ''
    }
    return out
  })
  return { columns, rows: picked }
}

async function runCustomReport(params = {}) {
  const source = String(params.source || 'nodes').toLowerCase()
  const srcDef = CUSTOM_REPORT_SOURCES[source]
  if (!srcDef) {
    const err = new Error(`Invalid custom report source: ${source}`)
    err.status = 400
    throw err
  }

  const limit = clampInt(params.limit, 10, 1000, 500)
  const search = String(params.search || '').trim().toLowerCase()
  const columnKeys = String(params.columns || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const keys = columnKeys.length ? columnKeys : srcDef.defaultColumns

  let rows = []
  if (source === 'nodes') {
    const conditions = []
    const status = String(params.status || '').toLowerCase()
    if (status === 'down') conditions.push('Status = 2')
    else if (status === 'warning') conditions.push('Status = 3')
    else if (status === 'up') conditions.push('Status = 1')
    if (search) {
      const q = swqlEscape(search)
      conditions.push(`(Caption LIKE '%${q}%' OR IPAddress LIKE '%${q}%')`)
    }
    rows = await fetchNodeRows({ where: conditions.join(' AND '), limit })
  } else if (source === 'alerts') {
    rows = await fetchActiveAlerts(limit)
    const sev = String(params.severity || '').toLowerCase()
    if (sev && sev !== 'all') {
      rows = rows.filter((r) => String(r.severity).toLowerCase() === sev)
    }
    if (search) {
      rows = rows.filter((r) =>
        [r.name, r.objectName, r.message, r.description].some((v) =>
          String(v ?? '').toLowerCase().includes(search),
        ),
      )
    }
  } else if (source === 'events') {
    const hours = clampInt(params.hours, 1, 168, 24)
    rows = await fetchEventsForReport({
      limit,
      hours,
      unackedOnly: params.ack === 'unacked',
    })
    if (params.ack === 'acked') rows = rows.filter((r) => r.acknowledged)
    if (search) {
      rows = rows.filter((r) =>
        [r.message, r.node, r.typeLabel].some((v) =>
          String(v ?? '').toLowerCase().includes(search),
        ),
      )
    }
  }

  const { columns, rows: picked } = pickColumns(rows, keys, srcDef.columns)
  return reportPayload(
    SW_REPORT_DEFS.find((d) => d.id === 'custom'),
    { columns, rows: picked, summary: { source, filters: { search: search || null, limit } } },
  )
}

export async function runSolarWindsReport(reportId, params = {}) {
  const id = String(reportId || '').trim()
  const def = SW_REPORT_DEFS.find((d) => d.id === id)
  if (!def) {
    const err = new Error(`Unknown report: ${id}`)
    err.status = 404
    throw err
  }
  if (def.custom) return runCustomReport(params)

  const limit = clampInt(params.limit, 10, 1000, def.defaultLimit || 500)
  const hours = clampInt(params.hours, 1, 168, def.defaultHours || 24)
  const threshold = clampInt(params.threshold, 1, 100, def.defaultThreshold || 80)

  switch (id) {
    case 'executive_summary': {
      const bh = parseBusinessHours(params)
      const summary = await fetchExecutiveSummary(params)
      const timeSummary = reportTimeSummary(params, bh)
      const hasWindow = Boolean(params.from && params.to)
      const columns = col(['metric', 'value'], ['Metric', 'Value'])

      const rows = [
        { metric: 'Total nodes (current)', value: summary.nodes.total },
        { metric: 'Nodes up (current)', value: summary.nodes.up },
        { metric: 'Nodes down (current)', value: summary.nodes.down },
        { metric: 'Nodes warning (current)', value: summary.nodes.warning },
        { metric: 'Availability % (current)', value: summary.availabilityPct ?? '—' },
        { metric: 'Active alerts (current)', value: summary.alerts.total },
        { metric: 'Critical alerts (current)', value: summary.alerts.Critical },
        { metric: 'High alerts (current)', value: summary.alerts.High },
        { metric: 'Warning alerts (current)', value: summary.alerts.Warning },
        { metric: 'Information alerts (current)', value: summary.alerts.Information },
      ]

      if (hasWindow && summary.period) {
        rows.push(
          { metric: '— Period —', value: '—' },
          { metric: 'Avg availability % (period)', value: summary.period.avgAvailabilityPct ?? '—' },
          { metric: 'Node down events (period)', value: summary.period.downEventCount },
          { metric: 'Nodes with down event (period)', value: summary.period.distinctDownNodes },
          { metric: 'Warning events (period)', value: summary.period.warningEventCount },
          { metric: 'Alerts triggered (period)', value: summary.period.alerts.total },
          { metric: 'Critical triggered (period)', value: summary.period.alerts.Critical },
          { metric: 'High triggered (period)', value: summary.period.alerts.High },
          { metric: 'Warning triggered (period)', value: summary.period.alerts.Warning },
          { metric: 'Information triggered (period)', value: summary.period.alerts.Information },
        )
      }

      return reportPayload(def, {
        summary: { ...summary, ...timeSummary, hasPeriod: hasWindow },
        columns,
        rows,
      })
    }

    case 'node_inventory': {
      const rows = await fetchNodeRows({ limit })
      return reportPayload(def, {
        columns: col(
          ['name', 'ip', 'status', 'responseTime', 'packetLoss', 'cpu', 'memory', 'vendor', 'machineType'],
          ['Node', 'IP', 'Status', 'Response (ms)', 'Loss %', 'CPU %', 'Memory %', 'Vendor', 'Type'],
        ),
        rows,
      })
    }

    case 'nodes_impaired': {
      const rows = await fetchNodeRows({ where: 'Status = 2 OR Status = 3', limit })
      return reportPayload(def, {
        summary: { impairedCount: rows.length },
        columns: col(
          ['name', 'ip', 'status', 'responseTime', 'packetLoss', 'cpu', 'memory', 'location'],
          ['Node', 'IP', 'Status', 'Response (ms)', 'Loss %', 'CPU %', 'Memory %', 'Location'],
        ),
        rows,
      })
    }

    case 'down_interfaces': {
      const bh = parseBusinessHours(params)
      const rows = await fetchDownInterfaces({ ...params, limit })
      const timeSummary = reportTimeSummary(params, bh)
      const filterSummary = reportFilterSummary(params)
      const hasWindow = Boolean(params.from && params.to)
      return reportPayload(def, {
        summary: {
          downInterfaceCount: rows.length,
          mode: hasWindow ? 'down_events_in_window' : 'currently_down',
          ...timeSummary,
          ...filterSummary,
        },
        columns: col(
          ['node', 'ip', 'interface', 'carrier', 'carrierDescription', 'status', 'downTime', 'inBps', 'outBps', 'utilization'],
          ['Node', 'IP', 'Interface', 'Carrier', 'Carrier description', 'Status', 'Down time', 'In bps', 'Out bps', 'Util %'],
        ),
        rows: rows.map((r) => ({
          ...r,
          downTime: r.downTime ? new Date(r.downTime).toLocaleString() : '—',
        })),
      })
    }

    case 'active_alerts': {
      const rows = await fetchActiveAlerts(limit)
      return reportPayload(def, {
        summary: { alertCount: rows.length },
        columns: col(
          ['severity', 'name', 'objectName', 'objectType', 'count', 'lastTriggered'],
          ['Severity', 'Alert', 'Object', 'Type', 'Count', 'Last triggered'],
        ),
        rows: rows.map((r) => ({
          ...r,
          lastTriggered: r.lastTriggered ? new Date(r.lastTriggered).toISOString() : '',
        })),
      })
    }

    case 'critical_high_alerts': {
      const rows = (await fetchActiveAlerts(limit)).filter((r) =>
        r.severity === 'Critical' || r.severity === 'High',
      )
      return reportPayload(def, {
        summary: { alertCount: rows.length },
        columns: col(
          ['severity', 'name', 'objectName', 'objectType', 'count', 'lastTriggered'],
          ['Severity', 'Alert', 'Object', 'Type', 'Count', 'Last triggered'],
        ),
        rows: rows.map((r) => ({
          ...r,
          lastTriggered: r.lastTriggered ? new Date(r.lastTriggered).toISOString() : '',
        })),
      })
    }

    case 'recent_events': {
      const rows = await fetchEventsForReport({ limit, hours })
      return reportPayload(def, {
        summary: { eventCount: rows.length, hours },
        columns: col(
          ['time', 'node', 'carrier', 'carrierDescription', 'typeLabel', 'message', 'acknowledged'],
          ['Time', 'Node', 'Carrier', 'Link description', 'Type', 'Message', 'Acknowledged'],
        ),
        rows: rows.map((r) => ({
          time: r.time ? new Date(r.time).toISOString() : '',
          node: r.node || '',
          carrier: r.carrier || '',
          carrierDescription: r.carrierDescription || '',
          typeLabel: r.typeLabel || '',
          message: r.message || '',
          acknowledged: r.acknowledged ? 'Yes' : 'No',
        })),
      })
    }

    case 'unacknowledged_events': {
      const rows = await fetchEventsForReport({ limit, hours, unackedOnly: true })
      return reportPayload(def, {
        summary: { eventCount: rows.length, hours },
        columns: col(
          ['time', 'node', 'carrier', 'carrierDescription', 'typeLabel', 'message'],
          ['Time', 'Node', 'Carrier', 'Link description', 'Type', 'Message'],
        ),
        rows: rows.map((r) => ({
          time: r.time ? new Date(r.time).toISOString() : '',
          node: r.node || '',
          carrier: r.carrier || '',
          carrierDescription: r.carrierDescription || '',
          typeLabel: r.typeLabel || '',
          message: r.message || '',
        })),
      })
    }

    case 'capacity_stress': {
      const swql = `SELECT TOP ${limit} NodeID, Caption, IPAddress, Status,
        ResponseTime, CPULoad, PercentMemoryUsed, Vendor
        FROM Orion.Nodes
        WHERE CPULoad >= ${threshold} OR PercentMemoryUsed >= ${threshold}
        ORDER BY CPULoad DESC, PercentMemoryUsed DESC`
      const data = await orionSwisQuery(swql)
      const rows = (data?.results || []).map((n) => ({
        name: n.Caption,
        ip: n.IPAddress || '',
        status: nodeStatusLabel(n.Status),
        cpu: n.CPULoad != null ? Number(n.CPULoad) : null,
        memory: n.PercentMemoryUsed != null ? Number(n.PercentMemoryUsed) : null,
        responseTime: n.ResponseTime != null ? Number(n.ResponseTime) : null,
        vendor: n.Vendor || '',
      }))
      return reportPayload(def, {
        summary: { stressedNodeCount: rows.length, thresholdPct: threshold },
        columns: col(
          ['name', 'ip', 'status', 'cpu', 'memory', 'responseTime', 'vendor'],
          ['Node', 'IP', 'Status', 'CPU %', 'Memory %', 'Response (ms)', 'Vendor'],
        ),
        rows,
      })
    }

    default: {
      const err = new Error(`Report not implemented: ${id}`)
      err.status = 501
      throw err
    }
  }
}

export async function runSolarWindsReportSafe(reportId, params = {}) {
  return withOrionReportTimeout(runSolarWindsReport(reportId, params), `report ${reportId}`)
}

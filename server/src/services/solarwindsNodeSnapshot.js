/**
 * Shared node snapshot + alert detail helpers for SolarWinds routes.
 */

import { orionSwisQuery, withOrionTimeout } from './solarwinds.js'

const NODE_STATUS = {
  0: 'Unknown', 1: 'Up', 2: 'Down', 3: 'Warning',
  9: 'Unmanaged', 12: 'Unknown', 14: 'Unknown',
}
const NODE_STATUS_COLOR = {
  1: 'up', 2: 'down', 3: 'warning', 0: 'unknown',
  9: 'unmanaged', 12: 'unknown', 14: 'unknown',
}
const ALERT_SEVERITY = {
  0: 'Information', 1: 'Warning', 2: 'High', 3: 'Critical',
}

function nodeStatusLabel(s) {
  return NODE_STATUS[Number(s)] || `Status ${s}`
}
function nodeStatusColor(s) {
  return NODE_STATUS_COLOR[Number(s)] || 'unknown'
}
function alertSeverityLabel(s) {
  return ALERT_SEVERITY[Number(s)] || String(s)
}

function swqlEscape(s) {
  return String(s || '').replace(/'/g, "''")
}

function mapNodeRow(n) {
  return {
    id: n.NodeID,
    name: n.Caption,
    ip: n.IPAddress,
    status: nodeStatusLabel(n.Status),
    statusColor: nodeStatusColor(n.Status),
    statusCode: Number(n.Status),
    statusDescription: n.StatusDescription || null,
    responseTime: n.ResponseTime != null ? Number(n.ResponseTime) : null,
    packetLoss: n.PercentLoss != null ? Number(n.PercentLoss) : null,
    cpu: n.CPULoad != null ? Number(n.CPULoad) : null,
    memory: n.PercentMemoryUsed != null ? Number(n.PercentMemoryUsed) : null,
    vendor: n.Vendor || null,
    machineType: n.MachineType || null,
    dns: n.DNS || null,
    location: n.Location || null,
    contact: n.Contact || null,
    description: n.Description || null,
  }
}

export function parseNodeIdFromEntityUri(uri) {
  if (!uri) return null
  const m = String(uri).match(/(?:NodeID[=:/]|Orion\.Nodes\/)(\d+)/i)
  return m ? Number(m[1]) : null
}

export function parseObjectTypeFromEntityUri(uri) {
  if (!uri) return null
  const s = String(uri)
  if (/Orion\.Nodes/i.test(s)) return 'Node'
  if (/NPM\.Interfaces/i.test(s)) return 'Interface'
  if (/NPM\./i.test(s)) return 'NPM'
  if (/IPAM\./i.test(s)) return 'IPAM'
  return null
}

/** SWQL column sets — try richest first; fall back when Orion rejects unknown properties. */
const ALERT_SELECT_VARIANTS = [
  `ao.AlertObjectID, ao.AlertID, ao.EntityCaption, ao.RelatedNodeCaption,
    ao.EntityUri, ao.TriggeredCount, ao.LastTriggeredDateTime, ao.FirstTriggeredDateTime,
    ac.Name, ac.Severity, ac.Description`,
  `ao.AlertID, ao.EntityCaption, ao.RelatedNodeCaption,
    ao.EntityUri, ao.TriggeredCount, ac.Name, ac.Severity`,
]

async function queryAlertObjects({ top = 200, where = '', orderBy = 'ac.Severity DESC' } = {}) {
  const whereClause = where ? ` WHERE ${where}` : ''
  let lastErr = null
  for (const cols of ALERT_SELECT_VARIANTS) {
    const swql = `SELECT TOP ${top} ${cols}
      FROM Orion.AlertObjects ao
      INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID${whereClause}
      ORDER BY ${orderBy}`
    try {
      return await orionSwisQuery(swql)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Unable to query Orion.AlertObjects')
}

async function queryAlertDetailRow(alertId, objectHint = '') {
  const id = Number(alertId)
  const object = swqlEscape(String(objectHint || '').trim())
  const orderVariants = ['ao.LastTriggeredDateTime DESC', 'ac.Severity DESC']
  const whereVariants = object
    ? [`ao.AlertID = ${id} AND (ao.EntityCaption='${object}' OR ao.RelatedNodeCaption='${object}')`, `ao.AlertID = ${id}`]
    : [`ao.AlertID = ${id}`]

  let lastErr = null
  for (const where of whereVariants) {
    for (const orderBy of orderVariants) {
      try {
        const data = await queryAlertObjects({ top: 1, where, orderBy })
        if (data?.results?.[0]) return data.results[0]
      } catch (e) {
        lastErr = e
      }
    }
  }
  if (lastErr) throw lastErr
  return null
}

export async function findNodeIdByCaption(caption) {
  const cap = swqlEscape(String(caption || '').trim())
  if (!cap) return null
  const data = await orionSwisQuery(`SELECT TOP 1 NodeID FROM Orion.Nodes WHERE Caption='${cap}'`)
  const id = data?.results?.[0]?.NodeID
  return id != null ? Number(id) : null
}

export async function fetchNodeSnapshot(nodeId) {
  const nodeSwql = `SELECT NodeID, Caption, IPAddress, Status, StatusDescription,
    ResponseTime, PercentLoss, CPULoad, PercentMemoryUsed,
    Vendor, MachineType, DNS, Location, Contact, Description
    FROM Orion.Nodes WHERE NodeID=${nodeId}`

  const nodeData = await withOrionTimeout(orionSwisQuery(nodeSwql), 'node')
  const raw = nodeData?.results?.[0]
  if (!raw) {
    return { found: false, node: null, interfaces: [], alerts: [], events: [] }
  }

  const node = mapNodeRow(raw)
  const cap = swqlEscape(node.name)

  const ifSwql = `SELECT TOP 100 InterfaceID, Caption, Status, InBps, OutBps, PercentUtil
    FROM Orion.NPM.Interfaces WHERE NodeID=${nodeId} ORDER BY Caption`
  const eventsSwql = `SELECT TOP 50 e.EventID, e.EventTime, e.EventType, e.Message, e.Acknowledged
    FROM Orion.Events e INNER JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID
    WHERE n.NodeID=${nodeId} ORDER BY e.EventTime DESC`
  const alertsSwqlWhere = `ao.RelatedNodeCaption='${cap}' OR ao.EntityCaption='${cap}'`
  const [ifData, eventsData, alertsData] = await Promise.all([
    withOrionTimeout(orionSwisQuery(ifSwql), 'interfaces').catch(() => ({ results: [] })),
    withOrionTimeout(orionSwisQuery(eventsSwql), 'events'),
    withOrionTimeout(queryAlertObjects({ top: 50, where: alertsSwqlWhere }), 'alerts').catch(() => ({ results: [] })),
  ])

  const interfaces = (ifData?.results || []).map((i) => ({
    id: i.InterfaceID,
    name: i.Caption,
    status: nodeStatusLabel(i.Status),
    statusColor: nodeStatusColor(i.Status),
    inBps: i.InBps != null ? Number(i.InBps) : null,
    outBps: i.OutBps != null ? Number(i.OutBps) : null,
    utilization: i.PercentUtil != null ? Number(i.PercentUtil) : null,
  }))

  const events = (eventsData?.results || []).map((e) => ({
    id: e.EventID,
    time: e.EventTime,
    type: e.EventType || null,
    message: e.Message || '',
    acknowledged: Boolean(e.Acknowledged),
  }))

  const alerts = (alertsData?.results || []).map((a, idx) => mapAlertRow(a, idx))

  return { found: true, node, interfaces, alerts, events }
}

function mapAlertRow(a, idx = 0) {
  return {
    id: `${a.AlertID}-${a.AlertObjectID ?? idx}`,
    alertObjectId: a.AlertObjectID ?? null,
    alertId: a.AlertID,
    name: a.Name,
    severity: alertSeverityLabel(a.Severity),
    severityCode: Number(a.Severity),
    description: a.Description || null,
    message: a.EntityCaption || null,
    objectName: a.RelatedNodeCaption || a.EntityCaption || null,
    entityUri: a.EntityUri || null,
    objectType: parseObjectTypeFromEntityUri(a.EntityUri),
    count: a.TriggeredCount != null ? Number(a.TriggeredCount) : 1,
    lastTriggered: a.LastTriggeredDateTime || null,
    firstTriggered: a.FirstTriggeredDateTime || null,
  }
}

/**
 * Load one alert object + optional node snapshot (when the alert relates to a node).
 */
export async function fetchAlertDetail(alertId, objectHint = '') {
  const id = Number(alertId)
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('Invalid alertId')
    err.status = 400
    throw err
  }

  const raw = await withOrionTimeout(queryAlertDetailRow(id, objectHint), 'alert detail')
  if (!raw) {
    return { found: false, alert: null, node: null, interfaces: [], alerts: [], events: [] }
  }

  const alert = mapAlertRow(raw, 0)

  let nodeId = parseNodeIdFromEntityUri(raw.EntityUri)
  const nodeCaption = raw.RelatedNodeCaption || (parseObjectTypeFromEntityUri(raw.EntityUri) === 'Node' ? raw.EntityCaption : null)
  if (!nodeId && nodeCaption) {
    nodeId = await findNodeIdByCaption(nodeCaption)
  }

  if (!nodeId) {
    return { found: true, alert, node: null, interfaces: [], alerts: [], events: [] }
  }

  const snap = await fetchNodeSnapshot(nodeId)
  return { found: true, alert, ...snap }
}

/** Active alerts list for /api/solarwinds/alerts */
export async function fetchActiveAlerts(limit = 200) {
  const data = await queryAlertObjects({ top: limit })
  return (data?.results || []).map((a, i) => mapAlertRow(a, i))
}

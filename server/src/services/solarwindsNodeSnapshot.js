/**
 * Shared node snapshot + alert detail helpers for SolarWinds routes.
 */

import { orionSwisQuery, withOrionTimeout } from './solarwinds.js'
import {
  discoverNodeCPFields,
  discoverIfaceCPFields,
  fetchInterfacesBulk,
  cpFieldLabel,
  toOrionDT,
} from './solarwindsCustomProps.js'

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

/**
 * SWQL query variants — richest first; fall back when Orion rejects unknown properties.
 * Note: Orion.AlertObjects has LastTriggeredDateTime but not FirstTriggeredDateTime;
 * join AlertActive for the current active instance TriggeredDateTime.
 */
const ALERT_QUERY_VARIANTS = [
  {
    cols: `ao.AlertObjectID, ao.AlertID, ao.EntityCaption, ao.RelatedNodeCaption,
      ao.EntityUri, ao.TriggeredCount, ao.LastTriggeredDateTime,
      aa.TriggeredDateTime,
      ac.Name, ac.Severity, ac.Description`,
    from: `FROM Orion.AlertObjects ao
      INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID
      LEFT JOIN Orion.AlertActive aa ON aa.AlertObjectID = ao.AlertObjectID`,
  },
  {
    cols: `ao.AlertObjectID, ao.AlertID, ao.EntityCaption, ao.RelatedNodeCaption,
      ao.EntityUri, ao.TriggeredCount, ao.LastTriggeredDateTime,
      ac.Name, ac.Severity, ac.Description`,
    from: `FROM Orion.AlertObjects ao
      INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID`,
  },
  {
    cols: `ao.AlertID, ao.EntityCaption, ao.RelatedNodeCaption,
      ao.EntityUri, ao.TriggeredCount, ac.Name, ac.Severity`,
    from: `FROM Orion.AlertObjects ao
      INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID`,
  },
]

async function queryAlertObjects({ top = 200, where = '', orderBy = 'ao.LastTriggeredDateTime DESC' } = {}) {
  const whereClause = where ? ` WHERE ${where}` : ''
  let lastErr = null
  for (const { cols, from } of ALERT_QUERY_VARIANTS) {
    const swql = `SELECT TOP ${top} ${cols}
      ${from}${whereClause}
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
  const orderVariants = ['aa.TriggeredDateTime DESC', 'ao.LastTriggeredDateTime DESC', 'ac.Severity DESC']
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

function mapCpEntries(fields, row, entity = 'node') {
  const source = row || {}
  return (fields || [])
    .map((field) => {
      const value = source[field]
      if (value == null || String(value).trim() === '') return null
      return { field, label: cpFieldLabel(field, entity), value: String(value).trim() }
    })
    .filter(Boolean)
}

export async function fetchNodeSnapshot(nodeId) {
  const nodeSwql = `SELECT NodeID, Caption, IPAddress, Status, StatusDescription,
    ResponseTime, PercentLoss, CPULoad, PercentMemoryUsed,
    Vendor, MachineType, DNS, Location, Contact, Description
    FROM Orion.Nodes WHERE NodeID=${nodeId}`

  const nodeData = await withOrionTimeout(orionSwisQuery(nodeSwql), 'node')
  const raw = nodeData?.results?.[0]
  if (!raw) {
    return {
      found: false, node: null, interfaces: [], alerts: [], events: [],
      nodeCustomProperties: [], nodeFieldMeta: [], ifaceFieldMeta: [],
    }
  }

  const node = mapNodeRow(raw)
  const cap = swqlEscape(node.name)

  const [nodeFields, ifaceFields] = await Promise.all([
    discoverNodeCPFields(),
    discoverIfaceCPFields(),
  ])
  const nodeFieldMeta = (nodeFields || []).map((field) => ({
    field,
    label: cpFieldLabel(field, 'node'),
  }))
  const ifaceFieldMeta = (ifaceFields || []).map((field) => ({
    field,
    label: cpFieldLabel(field, 'iface'),
  }))

  const nodeCpSwql = nodeFields.length
    ? `SELECT ${nodeFields.join(', ')} FROM Orion.NodesCustomProperties WHERE NodeID=${nodeId}`
    : null

  const eventsSwql = `SELECT TOP 50 e.EventID, e.EventTime, e.EventType, e.Message, e.Acknowledged
    FROM Orion.Events e INNER JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID
    WHERE n.NodeID=${nodeId} ORDER BY e.EventTime DESC`
  const alertsSwqlWhere = `ao.RelatedNodeCaption='${cap}' OR ao.EntityCaption='${cap}'`

  const [nodeCpData, ifaceBulk, eventsData, alertsData] = await Promise.all([
    nodeCpSwql
      ? withOrionTimeout(orionSwisQuery(nodeCpSwql), 'node CP').catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
    withOrionTimeout(fetchInterfacesBulk([nodeId], ifaceFields), 'interfaces'),
    withOrionTimeout(orionSwisQuery(eventsSwql), 'events'),
    withOrionTimeout(queryAlertObjects({ top: 50, where: alertsSwqlWhere }), 'alerts').catch(() => ({ results: [] })),
  ])

  const nodeCpRow = nodeCpData?.results?.[0] || null
  const nodeCustomProperties = mapCpEntries(nodeFields, nodeCpRow, 'node')

  const interfaces = (ifaceBulk?.ifaceMap?.get(nodeId) || []).map((iface) => ({
    id: iface.id,
    name: iface.name,
    status: iface.status,
    statusColor: iface.statusColor || nodeStatusColor(iface.statusCode),
    inBps: iface.inBps,
    outBps: iface.outBps,
    utilization: iface.utilization,
    customProperties: mapCpEntries(ifaceFields, iface.cp || {}, 'iface'),
  }))

  const events = await enrichEventsWithCarriers(
    (eventsData?.results || []).map((e) => mapEventRow({
      ...e,
      NetworkNode: nodeId,
      NodeCaption: node.name,
    })),
  )

  const alerts = (alertsData?.results || []).map((a, idx) => mapAlertRow(a, idx))

  return {
    found: true,
    node,
    interfaces,
    alerts,
    events,
    nodeCustomProperties,
    nodeFieldMeta,
    ifaceFieldMeta,
  }
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
    lastTriggered: a.TriggeredDateTime || a.LastTriggeredDateTime || null,
    firstTriggered: a.TriggeredDateTime || a.LastTriggeredDateTime || null,
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
  return { found: true, alert, node: null, interfaces: [], alerts: [], events: [] }
}

/** Active alerts list for /api/solarwinds/alerts */
export async function fetchActiveAlerts(limit = 200) {
  const data = await queryAlertObjects({ top: limit })
  return (data?.results || []).map((a, i) => mapAlertRow(a, i))
}

const EVENT_QUERY_VARIANTS = [
  {
    cols: `e.EventID, e.EventTime, e.NetworkNode, n.Caption AS NodeCaption,
      e.EventType, et.Name AS EventTypeName, e.Message, e.Acknowledged,
      e.NetObjectType, e.NetObjectID,
      i.Caption AS InterfaceName,
      icp.CarrierName, icp.Comments AS CarrierDescription`,
    from: `FROM Orion.Events e
      LEFT JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID
      LEFT JOIN Orion.EventTypes et ON e.EventType = et.EventType
      LEFT JOIN Orion.NPM.Interfaces i ON e.NetObjectType = 'I' AND e.NetObjectID = i.InterfaceID
      LEFT JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID`,
    alias: true,
  },
  {
    cols: `e.EventID, e.EventTime, e.NetworkNode, n.Caption AS NodeCaption,
      e.EventType, et.Name AS EventTypeName, e.Message, e.Acknowledged`,
    from: `FROM Orion.Events e
      LEFT JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID
      LEFT JOIN Orion.EventTypes et ON e.EventType = et.EventType`,
    alias: true,
  },
  {
    cols: `e.EventID, e.EventTime, e.NetworkNode, n.Caption AS NodeCaption,
      e.EventType, e.Message, e.Acknowledged`,
    from: `FROM Orion.Events e
      LEFT JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID`,
    alias: true,
  },
  {
    cols: `EventID, EventTime, NetworkNode, EventType, Message, Acknowledged`,
    from: `FROM Orion.Events`,
    alias: false,
  },
]

function wanLinkIndex(message) {
  const m = String(message || '').match(/\bWAN\s*(\d+)\b/i)
  return m ? Number(m[1]) : null
}

function pickIfaceForEvent(ifaces, message, interfaceName) {
  if (!ifaces?.length) return null
  if (interfaceName) {
    const byName = ifaces.find((i) => i.name && String(i.name).toLowerCase() === String(interfaceName).toLowerCase())
    if (byName) return byName
  }
  const wan = wanLinkIndex(message)
  if (wan != null && wan >= 1 && wan <= ifaces.length) return ifaces[wan - 1]
  if (wan === 1) return ifaces[0] || null
  if (wan === 2) return ifaces[1] || null
  return null
}

function mapEventRow(e) {
  const nodeId = e.NetworkNode != null ? Number(e.NetworkNode) : null
  const carrier = e.CarrierName != null ? String(e.CarrierName).trim() : ''
  const carrierDescription = e.CarrierDescription != null ? String(e.CarrierDescription).trim() : ''
  return {
    id: e.EventID,
    time: e.EventTime,
    nodeId,
    node: e.NodeCaption || (nodeId != null ? `Node ${nodeId}` : null),
    type: e.EventType != null ? Number(e.EventType) : null,
    typeLabel: e.EventTypeName || (e.EventType != null ? `Type ${e.EventType}` : null),
    message: e.Message || '',
    acknowledged: Boolean(e.Acknowledged),
    netObjectType: e.NetObjectType || null,
    interfaceName: e.InterfaceName || null,
    carrier: carrier || null,
    carrierDescription: carrierDescription || null,
  }
}

async function enrichEventsWithCarriers(events) {
  const needNodes = new Set()
  for (const e of events) {
    if ((!e.carrier && !e.carrierDescription) && e.nodeId != null) {
      needNodes.add(e.nodeId)
    }
  }
  if (!needNodes.size) return events

  const ifaceFields = await discoverIfaceCPFields()
  const { ifaceMap } = await fetchInterfacesBulk([...needNodes], ifaceFields)

  return events.map((e) => {
    if (e.carrier || e.carrierDescription) return e
    const ifaces = ifaceMap.get(e.nodeId) || []
    const iface = pickIfaceForEvent(ifaces, e.message, e.interfaceName)
    if (!iface) return e
    const cpCarrier = iface.cp?.CarrierName != null ? String(iface.cp.CarrierName).trim() : ''
    const cpDesc = iface.cp?.Comments != null ? String(iface.cp.Comments).trim() : ''
    return {
      ...e,
      interfaceName: e.interfaceName || iface.name || null,
      carrier: cpCarrier || null,
      carrierDescription: cpDesc || null,
    }
  })
}

function buildEventWhere(opts = {}, useAlias = true) {
  const parts = []
  const p = useAlias ? 'e.' : ''
  if (opts.from && opts.to) {
    const from = toOrionDT(opts.from)
    const to = toOrionDT(opts.to)
    if (from && to) {
      parts.push(`${p}EventTime >= '${from}' AND ${p}EventTime <= '${to}'`)
    }
  }
  if (opts.unackedOnly) parts.push(`${p}Acknowledged = false`)
  return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
}

async function queryEvents(limit = 200, opts = {}) {
  let lastErr = null
  for (const { cols, from, alias } of EVENT_QUERY_VARIANTS) {
    const where = buildEventWhere(opts, alias)
    const swql = `SELECT TOP ${limit} ${cols}
      ${from}
      ${where}
      ORDER BY ${alias ? 'e.EventTime' : 'EventTime'} DESC`
    try {
      return await orionSwisQuery(swql)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Unable to query Orion.Events')
}

/** Recent events for /api/solarwinds/events and reports */
export async function fetchEvents(limit = 200, opts = {}) {
  const top = Math.min(Math.max(Number(limit) || 100, 10), 500)
  const data = await queryEvents(top, opts)
  const rows = (data?.results || []).map(mapEventRow)
  return enrichEventsWithCarriers(rows)
}

import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAppPage } from '../middleware/requireAppPage.js'
import {
  parseOrionWebUrl,
  isOrionConfigured,
  resolveOrionSwisBase,
  orionSwisQuery,
  orionSwisProbe,
  withOrionTimeout,
} from '../services/solarwinds.js'
import {
  discoverNodeCPFields,
  discoverIfaceCPFields,
  getNodeCPValues,
  getIfaceCPValues,
  getCustomPropertyPresets,
  queryByCustomProperties,
} from '../services/solarwindsCustomProps.js'
import {
  assertInterfaceOnNode,
  getInterfaceTrafficHistory,
  TRAFFIC_RANGE_SEC,
} from '../services/solarwindsInterfaceTraffic.js'
import {
  fetchAlertDetail,
  fetchActiveAlerts,
  fetchNodeSnapshot,
} from '../services/solarwindsNodeSnapshot.js'

const router = Router()

// All routes require Netpulse auth + solarwinds page access
router.use(authenticate, requireAppPage('solarwinds'))

// Orion node status codes → friendly labels
const NODE_STATUS = {
  0: 'Unknown', 1: 'Up', 2: 'Down', 3: 'Warning',
  9: 'Unmanaged', 12: 'Unknown', 14: 'Unknown',
}
const NODE_STATUS_COLOR = {
  1: 'up', 2: 'down', 3: 'warning', 0: 'unknown',
  9: 'unmanaged', 12: 'unknown', 14: 'unknown',
}

// Orion alert severity codes
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

/**
 * Return HTTP 200 with a structured "unreachable" payload so the UI can render
 * an empty/offline state without treating the response as a crash.
 * Only unconfigured (missing credentials) gets a non-200 status.
 */
function swisErr(res, e, emptyPayload = {}) {
  if (e.code === 'ORION_NOT_CONFIGURED') {
    return res.status(503).json({ error: e.message, configured: false })
  }
  const isTimeout = e.code === 'ORION_TIMEOUT' || /timeout/i.test(e.message)
  const is405 = e.status === 405 || /405/.test(e.message)
  let tip = null
  if (isTimeout) {
    tip = 'Orion did not respond in time. Check firewall and that the Netpulse server can reach port 17774.'
  } else if (is405) {
    tip = 'SWIS rejected the HTTP method. Set ORION_SWIS_URL=https://HOST:17774/SolarWinds/InformationService/v3/Json and ORION_TLS_INSECURE=true, then GET /api/solarwinds/diagnostic.'
  } else if (e.status === 302 || /redirect/i.test(e.message)) {
    tip = 'Orion redirected to login — check ORION_USERNAME / ORION_PASSWORD and Manage Accounts in Orion.'
  }
  return res.json({
    reachable: false,
    configured: true,
    error: e.message,
    ...(e.code ? { code: e.code } : {}),
    ...(e.status ? { swisStatus: e.status } : {}),
    ...(tip ? { tip } : {}),
    ...emptyPayload,
  })
}

router.get('/config', (req, res) => {
  const web = parseOrionWebUrl()
  res.json({
    configured: isOrionConfigured(),
    orionUrl: web.origin,
    swisUrl: resolveOrionSwisBase(),
    host: web.hostname,
    port: web.port,
    scheme: web.scheme,
  })
})

/** Test which SWIS URL/method works — use when dashboard shows SWIS HTTP 405. */
router.get('/diagnostic', async (req, res) => {
  if (!isOrionConfigured()) {
    return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  }
  try {
    const probe = await withOrionTimeout(orionSwisProbe(), 'SWIS probe')
    res.json({
      configured: true,
      orionWebUrl: parseOrionWebUrl().origin,
      swisUrlDefault: resolveOrionSwisBase(),
      ...probe,
      tips: [
        'SWIS usually listens on https://<host>:17774 (not the web UI port 8787).',
        'If probe finds a working base/method, set ORION_SWIS_URL to that base in server/.env.',
        'For self-signed HTTPS: ORION_TLS_INSECURE=true',
        'Account must exist under Orion → Settings → Manage Accounts with API rights.',
      ],
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/overview', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const [nodeData, alertData] = await Promise.all([
      withOrionTimeout(orionSwisQuery('SELECT Status, COUNT(NodeID) AS NodeCount FROM Orion.Nodes GROUP BY Status'), 'nodes'),
      withOrionTimeout(
        orionSwisQuery(
          'SELECT ac.Severity, COUNT(ao.AlertID) AS AlertCount FROM Orion.AlertObjects ao INNER JOIN Orion.AlertConfigurations ac ON ao.AlertID = ac.AlertID GROUP BY ac.Severity',
        ),
        'alerts',
      ),
    ])

    const nodesByStatus = {}
    let totalNodes = 0
    for (const r of nodeData?.results || []) {
      const label = nodeStatusColor(r.Status)
      const n = Number(r.NodeCount ?? r.Count ?? 0)
      nodesByStatus[label] = (nodesByStatus[label] || 0) + n
      totalNodes += n
    }

    const alertsBySev = {}
    let totalAlerts = 0
    for (const r of alertData?.results || []) {
      const label = alertSeverityLabel(r.Severity)
      const n = Number(r.AlertCount ?? r.Count ?? 0)
      alertsBySev[label] = (alertsBySev[label] || 0) + n
      totalAlerts += n
    }

    res.json({
      reachable: true,
      configured: true,
      nodes: { total: totalNodes, ...nodesByStatus },
      alerts: { total: totalAlerts, ...alertsBySev },
    })
  } catch (e) {
    swisErr(res, e, { nodes: { total: 0 }, alerts: { total: 0 } })
  }
})

router.get('/nodes', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const q = req.query.q ? String(req.query.q).trim() : ''
    const statusFilter = req.query.status ? String(req.query.status).trim() : ''

    let swql = `SELECT NodeID, Caption, IPAddress, Status, StatusDescription,
      ResponseTime, PercentLoss, CPULoad, PercentMemoryUsed,
      Vendor, MachineType
      FROM Orion.Nodes`
    const conditions = []
    if (q) conditions.push(`(Caption LIKE '%${q.replace(/'/g, '')}%' OR IPAddress LIKE '%${q.replace(/'/g, '')}%')`)
    if (statusFilter === 'down') conditions.push('Status = 2')
    else if (statusFilter === 'warning') conditions.push('Status = 3')
    else if (statusFilter === 'up') conditions.push('Status = 1')
    if (conditions.length) swql += ` WHERE ${conditions.join(' AND ')}`
    swql += ' ORDER BY Status, Caption'
    swql = swql.replace(/^SELECT /i, 'SELECT TOP 500 ')

    const data = await withOrionTimeout(orionSwisQuery(swql), 'nodes')
    const rows = (data?.results || []).map(mapNodeRow)
    res.json({ reachable: true, configured: true, nodes: rows, total: rows.length })
  } catch (e) {
    swisErr(res, e, { nodes: [], total: 0 })
  }
})

/** Per-node snapshot — device info, interfaces, alerts, recent events (Zabbix-style drill-down). */
router.get('/nodes/:nodeId/snapshot', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  const nodeId = Number(req.params.nodeId)
  if (!Number.isFinite(nodeId) || nodeId <= 0) {
    return res.status(400).json({ error: 'Invalid node ID', configured: true })
  }

  try {
    const snap = await fetchNodeSnapshot(nodeId)
    res.json({
      reachable: true,
      configured: true,
      found: snap.found,
      node: snap.node,
      interfaces: snap.interfaces,
      alerts: snap.alerts,
      events: snap.events,
    })
  } catch (e) {
    swisErr(res, e, { found: false, node: null, interfaces: [], alerts: [], events: [] })
  }
})

/** Interface bandwidth history (Orion.NPM.InterfaceTraffic) — Zabbix-style time series. */
router.get('/nodes/:nodeId/interfaces/:interfaceId/traffic', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  const nodeId = Number(req.params.nodeId)
  const interfaceId = Number(req.params.interfaceId)
  if (!Number.isFinite(nodeId) || nodeId <= 0 || !Number.isFinite(interfaceId) || interfaceId <= 0) {
    return res.status(400).json({ error: 'Invalid node or interface ID', configured: true })
  }

  const hasCustom = Boolean(req.query.from && req.query.to)
  const range = String(req.query.range || '12h').toLowerCase()
  if (!hasCustom && req.query.range && !TRAFFIC_RANGE_SEC[range]) {
    return res.status(400).json({ error: `range must be one of: ${Object.keys(TRAFFIC_RANGE_SEC).join(', ')}`, configured: true })
  }
  if (hasCustom) {
    const fromMs = new Date(req.query.from).getTime()
    const toMs = new Date(req.query.to).getTime()
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return res.status(400).json({ error: 'from and to must be valid ISO datetimes with from < to', configured: true })
    }
    const maxSpan = 30 * 86400 * 1000
    if (toMs - fromMs > maxSpan) {
      return res.status(400).json({ error: 'Custom range cannot exceed 30 days', configured: true })
    }
  }

  try {
    const iface = await assertInterfaceOnNode(nodeId, interfaceId)
    const history = await getInterfaceTrafficHistory(interfaceId, {
      range: hasCustom ? undefined : range,
      from: req.query.from,
      to: req.query.to,
      maxPoints: req.query.maxPoints,
    })
    res.json({
      reachable: true,
      configured: true,
      nodeId,
      interface: iface,
      range: req.query.from ? null : range,
      ...history,
    })
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502
    res.status(status).json({ error: e.message || 'Failed to load interface traffic', configured: true })
  }
})

router.get('/alerts', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const rows = await withOrionTimeout(fetchActiveAlerts(200), 'alerts')
    res.json({ reachable: true, configured: true, alerts: rows, total: rows.length })
  } catch (e) {
    swisErr(res, e, { alerts: [], total: 0 })
  }
})

/** Alert drill-down — full alert fields + node snapshot when the object is a node. */
router.get('/alerts/detail', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  const alertId = req.query.alertId
  const object = req.query.object || req.query.entityCaption || req.query.objectName || ''
  if (!alertId) return res.status(400).json({ error: 'alertId query parameter required', configured: true })
  try {
    const detail = await withOrionTimeout(fetchAlertDetail(alertId, object), 'alert detail')
    if (!detail.found) {
      return res.json({ reachable: true, configured: true, found: false, alert: null, node: null, interfaces: [], alerts: [], events: [] })
    }
    res.json({
      reachable: true,
      configured: true,
      found: true,
      alert: detail.alert,
      node: detail.node,
      interfaces: detail.interfaces,
      alerts: detail.alerts,
      events: detail.events,
    })
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502
    res.status(status).json({ error: e.message || 'Failed to load alert detail', configured: true })
  }
})

/** Radio preset values: Link, Organization, Carrier, etc. */
router.get('/custom-properties/presets', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const data = await withOrionTimeout(getCustomPropertyPresets(), 'CP presets')
    res.json({ reachable: true, configured: true, ...data })
  } catch (e) {
    swisErr(res, e, { presets: {}, nodeFields: [], ifaceFields: [] })
  }
})

/** Discover node + interface custom property column names. */
router.get('/custom-properties/schema', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const force = req.query.refresh === '1'
    const [nodeFields, ifaceFields] = await Promise.all([
      withOrionTimeout(discoverNodeCPFields(force), 'node CP fields'),
      withOrionTimeout(discoverIfaceCPFields(force), 'iface CP fields'),
    ])
    res.json({ reachable: true, configured: true, nodeFields, ifaceFields })
  } catch (e) {
    swisErr(res, e, { nodeFields: [], ifaceFields: [] })
  }
})

/** Distinct values for a node or interface custom property. */
router.get('/custom-properties/values', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  const field = String(req.query.field || '').trim()
  const entity = req.query.entity === 'iface' ? 'iface' : 'node'
  if (!field) return res.status(400).json({ error: 'field query parameter required', configured: true })
  try {
    const values = await withOrionTimeout(
      entity === 'iface' ? getIfaceCPValues(field) : getNodeCPValues(field),
      'CP values',
    )
    res.json({ reachable: true, configured: true, field, entity, values })
  } catch (e) {
    swisErr(res, e, { field, entity, values: [] })
  }
})

/** Filter nodes by node CPs + interface CPs + optional time windows. */
router.get('/custom-properties/nodes', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const result = await withOrionTimeout(
      queryByCustomProperties({
        nodeProp1: req.query.nodeProp1,
        nodeVal1: req.query.nodeVal1,
        nodeProp2: req.query.nodeProp2,
        nodeVal2: req.query.nodeVal2,
        nodeProp3: req.query.nodeProp3,
        nodeVal3: req.query.nodeVal3,
        ifaceProp1: req.query.ifaceProp1,
        ifaceVal1: req.query.ifaceVal1,
        ifaceProp2: req.query.ifaceProp2,
        ifaceVal2: req.query.ifaceVal2,
        status: req.query.status,
        bandwidth: req.query.bandwidth,
        match: req.query.match === 'contains' ? 'contains' : 'equals',
        from: req.query.from,
        to: req.query.to,
        excludeFrom: req.query.excludeFrom,
        excludeTo: req.query.excludeTo,
        bhEnabled: req.query.bhEnabled,
        bhStart: req.query.bhStart,
        bhEnd: req.query.bhEnd,
        bhDays: req.query.bhDays,
        bhTzOffsetMin: req.query.bhTzOffsetMin,
      }),
      'custom-properties query',
    )
    const nodes = result.nodes.map((n) => ({
      ...n,
      status: nodeStatusLabel(n.statusCode),
      statusColor: nodeStatusColor(n.statusCode),
    }))
    res.json({
      reachable: true,
      configured: true,
      nodeFields: result.nodeFields,
      ifaceFields: result.ifaceFields,
      timeWindow: result.timeWindow,
      businessHours: result.businessHours,
      nodes,
      total: nodes.length,
    })
  } catch (e) {
    swisErr(res, e, { nodes: [], total: 0, nodeFields: [], ifaceFields: [] })
  }
})

router.get('/events', async (req, res) => {
  if (!isOrionConfigured()) return res.status(503).json({ error: 'Set ORION_USERNAME and ORION_PASSWORD in server .env', configured: false })
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 10), 500)
    const swql = `SELECT TOP ${limit} EventID, EventTime, NetworkNode, EventType, Message, Acknowledged
      FROM Orion.Events
      ORDER BY EventTime DESC`

    const data = await withOrionTimeout(orionSwisQuery(swql), 'events')
    const rows = (data?.results || []).map((e) => ({
      id: e.EventID,
      time: e.EventTime,
      node: e.NetworkNode || null,
      type: e.EventType || null,
      message: e.Message || '',
      acknowledged: Boolean(e.Acknowledged),
    }))
    res.json({ reachable: true, configured: true, events: rows, total: rows.length })
  } catch (e) {
    swisErr(res, e, { events: [], total: 0 })
  }
})

export default router

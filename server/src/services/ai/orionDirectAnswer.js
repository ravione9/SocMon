import {
  isOrionConfigured,
  orionSwisQuery,
  withOrionTimeout,
  parseOrionWebUrl,
} from '../solarwinds.js'
import {
  fetchActiveAlerts,
  fetchNodeSnapshot,
  findNodeIdByCaption,
} from '../solarwindsNodeSnapshot.js'
import { extractIpv4 } from './zabbixDirectAnswer.js'

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

const ORION_KEYWORDS = /\b(orion|orian|solarwinds|solar\s*winds|npm|swis|orion\s*npm)\b/i

function nodeStatusLabel(s) {
  return NODE_STATUS[Number(s)] || `Status ${s}`
}
function nodeStatusColor(s) {
  return NODE_STATUS_COLOR[Number(s)] || 'unknown'
}
function alertSeverityLabel(s) {
  return ALERT_SEVERITY[Number(s)] || String(s)
}

function mapOrionNode(n) {
  return {
    id: n.NodeID,
    name: n.Caption,
    ip: n.IPAddress,
    status: nodeStatusLabel(n.Status),
    statusColor: nodeStatusColor(n.Status),
    statusCode: Number(n.Status),
    responseTime: n.ResponseTime != null ? Number(n.ResponseTime) : null,
    packetLoss: n.PercentLoss != null ? Number(n.PercentLoss) : null,
    cpu: n.CPULoad != null ? Number(n.CPULoad) : null,
    memory: n.PercentMemoryUsed != null ? Number(n.PercentMemoryUsed) : null,
    vendor: n.Vendor || null,
    machineType: n.MachineType || null,
  }
}

export function isOrionQuestion(question) {
  return ORION_KEYWORDS.test(String(question || ''))
}

function detectNodeStatusFilter(question) {
  const q = String(question || '').toLowerCase()
  if (/\b(down|offline|unreachable)\b/.test(q)) return 'down'
  if (/\b(warning|degraded)\b/.test(q)) return 'warning'
  if (/\b(up|online|healthy)\b/.test(q) && !/\b(down|offline)\b/.test(q)) return 'up'
  return ''
}

function extractNodeSearch(question) {
  const ip = extractIpv4(question)
  if (ip) return ip
  const quoted = String(question || '').match(/\b(?:node|host|caption|orion)\s+["']([^"']{2,})["']/i)
  if (quoted?.[1]) return quoted[1].trim()
  const bare = String(question || '').match(/\bfor\s+([A-Za-z0-9][A-Za-z0-9._-]{2,})\b/i)
  if (bare?.[1] && !/^(the|all|any|each|every)$/i.test(bare[1])) return bare[1].trim()
  return ''
}

async function fetchOrionOverview() {
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

  const alertsBySeverity = {}
  let totalAlerts = 0
  for (const r of alertData?.results || []) {
    const label = alertSeverityLabel(r.Severity)
    const n = Number(r.AlertCount ?? r.Count ?? 0)
    alertsBySeverity[label] = (alertsBySeverity[label] || 0) + n
    totalAlerts += n
  }

  return {
    nodes: { total: totalNodes, ...nodesByStatus },
    alerts: { total: totalAlerts, ...alertsBySeverity },
  }
}

async function fetchOrionNodes({ q = '', statusFilter = '', limit = 50 } = {}) {
  let swql = `SELECT TOP ${Math.min(Math.max(limit, 1), 500)} NodeID, Caption, IPAddress, Status, StatusDescription,
    ResponseTime, PercentLoss, CPULoad, PercentMemoryUsed,
    Vendor, MachineType
    FROM Orion.Nodes`
  const conditions = []
  const search = String(q || '').trim().replace(/'/g, '')
  if (search) {
    conditions.push(`(Caption LIKE '%${search}%' OR IPAddress LIKE '%${search}%')`)
  }
  if (statusFilter === 'down') conditions.push('Status = 2')
  else if (statusFilter === 'warning') conditions.push('Status = 3')
  else if (statusFilter === 'up') conditions.push('Status = 1')
  if (conditions.length) swql += ` WHERE ${conditions.join(' AND ')}`
  swql += ' ORDER BY Status, Caption'

  const data = await withOrionTimeout(orionSwisQuery(swql), 'nodes')
  const nodes = (data?.results || []).map(mapOrionNode)
  return { nodes, total: nodes.length }
}

/**
 * Live SolarWinds Orion context for MCP / agent portal.
 * @param {string} [userMessage]
 */
export async function buildSolarWindsContext(userMessage = '') {
  const fetchedAt = new Date().toISOString()
  if (!isOrionConfigured()) {
    return {
      module: 'orian',
      freshness: 'live',
      fetchedAt,
      configured: false,
      error: 'ORION_USERNAME and ORION_PASSWORD not configured',
    }
  }

  const nodeFilter = extractNodeSearch(userMessage)
  const statusFilter = detectNodeStatusFilter(userMessage)
  const wantsDetail = Boolean(nodeFilter)
    || /\b(snapshot|interfaces|interface|traffic|detail|events)\b/i.test(userMessage)

  try {
    const [summary, nodesData, alerts] = await Promise.all([
      fetchOrionOverview(),
      fetchOrionNodes({
        q: nodeFilter,
        statusFilter,
        limit: nodeFilter ? 25 : 50,
      }),
      fetchActiveAlerts(40),
    ])

    let nodeDetail = null
    if (wantsDetail) {
      let nodeId = nodesData.nodes?.[0]?.id ?? null
      if (!nodeId && nodeFilter && !extractIpv4(nodeFilter)) {
        nodeId = await findNodeIdByCaption(nodeFilter)
      }
      if (nodeId) {
        const snap = await fetchNodeSnapshot(nodeId).catch(() => null)
        if (snap?.found) {
          nodeDetail = {
            node: snap.node,
            interfaces: (snap.interfaces || []).slice(0, 30),
            alerts: (snap.alerts || []).slice(0, 12),
            events: (snap.events || []).slice(0, 15),
          }
        }
      }
    }

    return {
      module: 'orian',
      freshness: 'live',
      fetchedAt,
      configured: true,
      reachable: true,
      source: 'SolarWinds Orion SWIS API',
      orionUrl: parseOrionWebUrl().origin,
      nodeFilter: nodeFilter || null,
      statusFilter: statusFilter || null,
      summary,
      nodes: nodesData.nodes,
      nodeCount: nodesData.total,
      activeAlerts: alerts.slice(0, 25),
      activeAlertCount: alerts.length,
      nodeDetail,
      note: nodeFilter
        ? `Orion nodes filtered by "${nodeFilter}". nodeDetail includes interfaces (inBps/outBps) when a single node matched.`
        : 'Orion NPM live snapshot. nodes[] has cpu, memory, responseTime, packetLoss from SWIS. Use node/host name in question for drill-down.',
    }
  } catch (err) {
    return {
      module: 'orian',
      freshness: 'live',
      fetchedAt,
      configured: true,
      reachable: false,
      error: err?.message || String(err),
      errorCode: err?.code || null,
      nodeFilter: nodeFilter || null,
      summary: { nodes: { total: 0 }, alerts: { total: 0 } },
      nodes: [],
      activeAlerts: [],
    }
  }
}

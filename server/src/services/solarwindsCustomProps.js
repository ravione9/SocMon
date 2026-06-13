/**
 * Orion node & interface custom properties — discovery and filtered queries.
 *
 * Node CP columns on this server: DUAL_LINKS, ORGANIZATION, Department, City, State, AssetTag, Comments
 * Interface CP columns on this server: CarrierName, Comments
 */

import { orionSwisQuery, withOrionTimeout } from './solarwinds.js'

// Default candidates — known-good columns for THIS Orion. Extend via env var.
const NODE_CP_DEFAULTS = [
  'DUAL_LINKS', 'LINK_STATUS', 'LKST_BU', 'ORGANIZATION', 'Department',
  'CITY', 'City', 'STATE', 'State', 'AssetTag', 'Comments',
  'Country', 'Region', 'Site', 'Zone', 'BranchCode', 'Category', 'Tier',
  'Customer', 'Owner', 'Type', 'SubType',
]

const IFACE_CP_DEFAULTS = [
  'CarrierName', 'Comments', 'Circuit', 'ISP', 'Provider', 'Link', 'Speed',
  'VLAN', 'Type', 'Carrier', 'Bandwidth',
]

// Runtime caches
let cachedNodeFields = null
let cachedIfaceFields = null
let cachedNodeAt = 0
let cachedIfaceAt = 0
/** @type {Map<string, string>} Orion Metadata.Property Description per column */
let cachedNodeFieldLabels = new Map()
let cachedIfaceFieldLabels = new Map()
const CACHE_MS = 60 * 60 * 1000

function humanizeFieldName(field) {
  return String(field || '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim()
}

function cpFieldLabel(field, entity = 'node') {
  const meta = entity === 'iface' ? cachedIfaceFieldLabels : cachedNodeFieldLabels
  const desc = meta.get(field)
  if (desc != null && String(desc).trim()) return String(desc).trim()
  return humanizeFieldName(field)
}

function isValidCol(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

function candidateList(envKey, defaults) {
  const env = (process.env[envKey] || '').split(',').map((s) => s.trim()).filter(Boolean)
  return env.length ? env : defaults
}

/**
 * Discover which CP columns exist on this Orion.
 * Tries SWIS metadata first (single round-trip). Falls back to parallel column probes when
 * metadata isn't accessible — much faster than the old sequential per-column SELECT loop
 * which would take ~30+ round trips on first load.
 */
async function probeFields(entity, candidates) {
  const tableName = entity === 'Nodes'
    ? 'Orion.NodesCustomProperties'
    : 'Orion.NPM.InterfacesCustomProperties'

  const idCol = entity === 'Nodes' ? 'NodeID' : 'InterfaceID'
  const labelMap = entity === 'Nodes' ? cachedNodeFieldLabels : cachedIfaceFieldLabels

  try {
    const data = await orionSwisQuery(
      `SELECT Name, Description FROM Metadata.Property WHERE EntityName = '${tableName}'`,
    )
    const rows = data?.results || []
    if (rows.length) {
      labelMap.clear()
      const known = new Set()
      for (const r of rows) {
        const name = String(r.Name || '').trim()
        if (!name || name === idCol || !isValidCol(name)) continue
        known.add(name)
        const desc = r.Description != null ? String(r.Description).trim() : ''
        if (desc) labelMap.set(name, desc)
      }
      if (known.size) {
        return [...known].sort()
      }
    }
  } catch { /* metadata table not exposed — fall through to probing */ }

  const valid = candidates.filter(isValidCol)
  const settled = await Promise.allSettled(
    valid.map((col) =>
      orionSwisQuery(`SELECT TOP 1 ${idCol}, ${col} FROM ${tableName}`).then(() => col),
    ),
  )
  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
}

export async function discoverNodeCPFields(force = false) {
  if (cachedNodeFields && !force && Date.now() - cachedNodeAt < CACHE_MS) return cachedNodeFields
  const fields = await probeFields('Nodes', candidateList('ORION_NODE_CUSTOM_PROPERTIES', NODE_CP_DEFAULTS))
  cachedNodeFields = fields
  cachedNodeAt = Date.now()
  return fields
}

export async function discoverIfaceCPFields(force = false) {
  if (cachedIfaceFields && !force && Date.now() - cachedIfaceAt < CACHE_MS) return cachedIfaceFields
  const fields = await probeFields('Interfaces', candidateList('ORION_IFACE_CUSTOM_PROPERTIES', IFACE_CP_DEFAULTS))
  cachedIfaceFields = fields
  cachedIfaceAt = Date.now()
  return fields
}

export async function getNodeCPValues(field, limit = 300) {
  if (!isValidCol(field)) return []
  const top = Math.min(Math.max(limit, 10), 500)
  const data = await orionSwisQuery(
    `SELECT DISTINCT TOP ${top} ${field} FROM Orion.NodesCustomProperties WHERE ${field} IS NOT NULL ORDER BY ${field}`,
  )
  return (data?.results || []).map((r) => r[field]).filter((v) => v != null && String(v).trim() !== '')
}

export async function getIfaceCPValues(field, limit = 300) {
  if (!isValidCol(field)) return []
  const top = Math.min(Math.max(limit, 10), 500)
  const data = await orionSwisQuery(
    `SELECT DISTINCT TOP ${top} ${field} FROM Orion.NPM.InterfacesCustomProperties WHERE ${field} IS NOT NULL ORDER BY ${field}`,
  )
  return (data?.results || []).map((r) => r[field]).filter((v) => v != null && String(v).trim() !== '')
}

function buildCondition(prefix, field, value, mode) {
  if (!field || !isValidCol(field) || value == null || String(value).trim() === '') return null
  const v = String(value).trim().replace(/'/g, "''")
  if (mode === 'contains') return `${prefix}.${field} LIKE '%${v}%'`
  return `${prefix}.${field} = '${v}'`
}

/** Node matches when any NPM interface has the given carrier CP value. */
function buildAnyIfaceCarrierCondition(field, value, mode = 'equals') {
  if (field !== 'CarrierName' || !isValidCol(field) || value == null || String(value).trim() === '') return null
  const v = String(value).trim().replace(/'/g, "''")
  if (mode === 'contains') {
    return `n.NodeID IN (
      SELECT DISTINCT i.NodeID FROM Orion.NPM.Interfaces i
      INNER JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID
      WHERE icp.${field} LIKE '%${v}%'
    )`
  }
  return `n.NodeID IN (
    SELECT DISTINCT i.NodeID FROM Orion.NPM.Interfaces i
    INNER JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID
    WHERE icp.${field} = '${v}'
  )`
}

function ifaceCarrierValue(iface) {
  return String(iface?.cp?.CarrierName ?? '').trim()
}

function ifaceMatchesCarrier(iface, value, mode = 'equals') {
  if (!value) return true
  const carrier = ifaceCarrierValue(iface)
  const v = String(value).trim()
  if (mode === 'contains') return carrier.toLowerCase().includes(v.toLowerCase())
  return carrier === v
}

function nodeHasMatchingCarrier(ifaces, value, mode = 'equals') {
  if (!value) return true
  if (!ifaces?.length) return false
  return ifaces.some((iface) => ifaceMatchesCarrier(iface, value, mode))
}

/** Store WAN links: interfaces with CarrierName, or common BB/wan captions. */
function isStoreWanInterface(iface) {
  if (ifaceCarrierValue(iface)) return true
  const name = String(iface?.name || '').trim().toLowerCase()
  return /^(bb\d+|wan\d*)$/.test(name) || name === 'wan'
}

/**
 * One table row per link. Carrier filter → only matching links; otherwise each tagged WAN link.
 */
function interfacesForLinkRows(ifaces, carrierFilterVal, matchMode = 'equals') {
  if (!ifaces?.length) return []
  if (carrierFilterVal) {
    return ifaces.filter((i) => ifaceMatchesCarrier(i, carrierFilterVal, matchMode))
  }
  const tagged = ifaces.filter(isStoreWanInterface)
  if (tagged.length) return tagged
  return ifaces.slice(0, 2)
}

function toOrionDT(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.0000000`
}

/** Parse "HH:MM" → minutes from midnight. */
function parseHm(str) {
  const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

function inBusinessHours(date, bh) {
  if (!bh?.enabled) return true
  const tzOffsetMin = Number.isFinite(Number(bh.tzOffsetMin)) ? Number(bh.tzOffsetMin) : 0
  const local = new Date(date.getTime() + tzOffsetMin * 60_000)
  const day = local.getUTCDay()
  if (!bh.days.has(day)) return false
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (bh.startMin <= bh.endMin) return mins >= bh.startMin && mins < bh.endMin
  return mins >= bh.startMin || mins < bh.endMin
}

function parseBusinessHours(opts) {
  if (!opts?.bhEnabled || String(opts.bhEnabled) === 'false' || String(opts.bhEnabled) === '0') return null
  const startMin = parseHm(opts.bhStart) ?? 9 * 60
  const endMin = parseHm(opts.bhEnd) ?? 18 * 60
  const daysRaw = String(opts.bhDays || '1,2,3,4,5').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  return {
    enabled: true,
    startMin,
    endMin,
    days: new Set(daysRaw.length ? daysRaw : [1, 2, 3, 4, 5]),
    tzOffsetMin: Number(opts.bhTzOffsetMin) || 0,
  }
}

async function nodeIdsInEventWindow(fromIso, toIso, bh = null) {
  const from = toOrionDT(fromIso)
  const to = toOrionDT(toIso)
  if (!from || !to) return null
  const data = await orionSwisQuery(
    `SELECT DISTINCT e.NetworkNode AS NodeID, e.EventTime FROM Orion.Events e
     INNER JOIN Orion.Nodes n ON e.NetworkNode = n.NodeID
     WHERE e.EventTime >= '${from}' AND e.EventTime <= '${to}'`,
  )
  const rows = data?.results || []
  if (!bh?.enabled) {
    return new Set(rows.map((r) => Number(r.NodeID)).filter(Number.isFinite))
  }
  const set = new Set()
  for (const r of rows) {
    const t = new Date(r.EventTime)
    if (Number.isNaN(t.getTime())) continue
    if (inBusinessHours(t, bh)) set.add(Number(r.NodeID))
  }
  return set
}

/**
 * Query nodes filtered by node CPs and/or interface CPs, plus optional time windows.
 *
 * @param {object} opts
 *  nodeProp1, nodeVal1, nodeProp2, nodeVal2  — node CP filters
 *  ifaceProp1, ifaceVal1, ifaceProp2, ifaceVal2 — interface CP filters
 *  match ('equals'|'contains'), from, to, excludeFrom, excludeTo
 */
function buildCpFieldMeta(fields, entity = 'node') {
  return (fields || []).map((field) => ({
    field,
    label: cpFieldLabel(field, entity),
  }))
}

/** Preset radio dimensions → field names and distinct values (one round-trip for the UI). */
export async function getCustomPropertyPresets(force = false) {
  const [nodeFields, ifaceFields, linkVals, carrierVals] = await Promise.all([
    discoverNodeCPFields(force),
    discoverIfaceCPFields(force),
    getNodeCPValues('DUAL_LINKS').catch(() => []),
    getIfaceCPValues('CarrierName').catch(() => []),
  ])
  return {
    nodeFields,
    ifaceFields,
    nodeFieldMeta: buildCpFieldMeta(nodeFields, 'node'),
    ifaceFieldMeta: buildCpFieldMeta(ifaceFields, 'iface'),
    presets: {
      link: {
        field: 'DUAL_LINKS',
        label: cpFieldLabel('DUAL_LINKS', 'node'),
        values: linkVals,
      },
      carrier: {
        field: 'CarrierName',
        label: cpFieldLabel('CarrierName', 'iface'),
        entity: 'iface',
        values: carrierVals,
      },
      uptime: {
        label: 'Node status (ICMP)',
        values: [
          { id: 'up', label: 'Up' },
          { id: 'down', label: 'Down' },
          { id: 'warning', label: 'Warning' },
        ],
      },
      bandwidth: {
        label: 'Bandwidth',
        values: [
          { id: 'high', label: 'High (>50% util)' },
          { id: 'medium', label: 'Medium (10–50%)' },
          { id: 'low', label: 'Low (<10%)' },
        ],
      },
    },
  }
}

const STATUS_CODE = { up: 1, down: 2, warning: 3 }

/** When no include-time range is set, sample link availability over this window. */
const DEFAULT_UPTIME_LOOKBACK_MS = 24 * 3600 * 1000

const IFACE_STATUS_LABEL = {
  0: 'Unknown', 1: 'Up', 2: 'Down', 3: 'Warning',
  9: 'Unmanaged', 11: 'Unknown', 12: 'Unknown', 14: 'Unknown',
}
const IFACE_STATUS_COLOR = {
  1: 'up', 2: 'down', 3: 'warning', 0: 'unknown',
  9: 'unmanaged', 11: 'unknown', 12: 'unknown', 14: 'unknown',
}

function ifaceStatusLabel(code) {
  return IFACE_STATUS_LABEL[Number(code)] || `Status ${code}`
}
function ifaceStatusColor(code) {
  return IFACE_STATUS_COLOR[Number(code)] || 'unknown'
}

function resolveAvailabilityWindow(opts) {
  if (opts.from && opts.to) {
    return { from: opts.from, to: opts.to, defaulted: false }
  }
  const to = new Date()
  const from = new Date(to.getTime() - DEFAULT_UPTIME_LOOKBACK_MS)
  return { from: from.toISOString(), to: to.toISOString(), defaulted: true }
}

/** Average availability % per interface from Orion.NPM.InterfaceAvailability. */
async function interfaceAvailabilityMap(ifaceIds, fromIso, toIso, bh = null) {
  const map = new Map()
  const ids = [...new Set((ifaceIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  if (!ids.length) return map

  const from = toOrionDT(fromIso)
  const to = toOrionDT(toIso)
  if (!from || !to) return map

  const CHUNK = 80

  if (!bh?.enabled) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK).join(',')
      try {
        const data = await orionSwisQuery(
          `SELECT InterfaceID, AVG(Availability) AS Avail
           FROM Orion.NPM.InterfaceAvailability
           WHERE InterfaceID IN (${chunk}) AND DateTime >= '${from}' AND DateTime <= '${to}'
           GROUP BY InterfaceID`,
        )
        for (const r of data?.results || []) {
          const v = Number(r.Avail)
          if (Number.isFinite(v)) map.set(Number(r.InterfaceID), Math.max(0, Math.min(100, v)))
        }
      } catch { /* NPM availability history not licensed or table empty */ }
    }
    return map
  }

  const acc = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).join(',')
    try {
      const data = await orionSwisQuery(
        `SELECT InterfaceID, DateTime, Availability
         FROM Orion.NPM.InterfaceAvailability
         WHERE InterfaceID IN (${chunk}) AND DateTime >= '${from}' AND DateTime <= '${to}'`,
      )
      for (const r of data?.results || []) {
        const t = new Date(r.DateTime)
        if (Number.isNaN(t.getTime()) || !inBusinessHours(t, bh)) continue
        const id = Number(r.InterfaceID)
        const v = Number(r.Availability)
        if (!Number.isFinite(id) || !Number.isFinite(v)) continue
        if (!acc.has(id)) acc.set(id, { sum: 0, n: 0 })
        const a = acc.get(id)
        a.sum += v
        a.n++
      }
    } catch { /* ignore */ }
  }
  for (const [id, a] of acc) {
    if (a.n) map.set(id, Math.max(0, Math.min(100, a.sum / a.n)))
  }
  return map
}

function enrichIfaceAvailability(ifaces, ifaceAvailMap) {
  return (ifaces || []).map((iface) => {
    const avail = ifaceAvailMap.get(iface.id)
    return {
      ...iface,
      availabilityPct: avail != null ? avail : null,
      availabilitySampled: avail != null,
    }
  })
}

/** Flatten nodes into one result row per WAN link. */
function expandNodesToLinkRows(nodeRows, ifaceMap, ifaceAvailMap, carrierFilterVal, matchMode) {
  const out = []
  for (const base of nodeRows) {
    const rawIfaces = ifaceMap.get(base.nodeId) || []
    if (carrierFilterVal && !nodeHasMatchingCarrier(rawIfaces, carrierFilterVal, matchMode)) continue
    const ifaces = enrichIfaceAvailability(
      interfacesForLinkRows(rawIfaces, carrierFilterVal, matchMode),
      ifaceAvailMap,
    )
    for (const iface of ifaces) {
      const uptimePct = iface.availabilitySampled && Number.isFinite(iface.availabilityPct)
        ? Math.round(iface.availabilityPct * 10) / 10
        : null
      out.push({
        ...base,
        rowKey: `${base.nodeId}-${iface.id}`,
        link: iface,
        uptimePct,
        uptimeSampled: iface.availabilitySampled,
        bandwidthPct: Number.isFinite(iface.utilization) ? iface.utilization : null,
        bandwidthPeakPct: Number.isFinite(iface.utilization) ? iface.utilization : null,
        linkStatus: iface.status,
        linkStatusCode: iface.statusCode,
        linkStatusColor: iface.statusColor,
        interface1: iface,
        interface2: null,
      })
    }
  }
  return out
}

export async function queryByCustomProperties(opts = {}) {
  const nodeFields = await discoverNodeCPFields()
  const ifaceFields = await discoverIfaceCPFields()
  const bh = parseBusinessHours(opts)

  const nodeCpCols = nodeFields.length
    ? nodeFields.map((f) => `ncp.${f}`).join(', ')
    : 'ncp.NodeID'

  const nodeConds = [
    buildCondition('ncp', opts.nodeProp1, opts.nodeVal1, opts.match),
    buildCondition('ncp', opts.nodeProp2, opts.nodeVal2, opts.match),
    buildCondition('ncp', opts.nodeProp3, opts.nodeVal3, opts.match),
  ].filter(Boolean)

  const matchMode = opts.match === 'contains' ? 'contains' : 'equals'
  const carrierFilterVal = opts.ifaceProp1 === 'CarrierName' && opts.ifaceVal1
    ? String(opts.ifaceVal1).trim()
    : null
  const carrierCond = carrierFilterVal
    ? buildAnyIfaceCarrierCondition('CarrierName', carrierFilterVal, matchMode)
    : null
  const genericIfaceProp1 = carrierCond ? null : opts.ifaceProp1
  const genericIfaceVal1 = carrierCond ? null : opts.ifaceVal1

  const allConds = [...nodeConds]

  if (opts.status && opts.status !== 'all' && STATUS_CODE[opts.status] != null) {
    allConds.push(`n.Status = ${STATUS_CODE[opts.status]}`)
  }

  if (carrierCond) {
    allConds.push(carrierCond)
  }

  const genericIfaceConds = [
    buildCondition('icp', genericIfaceProp1, genericIfaceVal1, opts.match),
    buildCondition('icp', opts.ifaceProp2, opts.ifaceVal2, opts.match),
  ].filter(Boolean)

  if (genericIfaceConds.length) {
    const ifaceWhere = genericIfaceConds.join(' AND ')
    allConds.push(`n.NodeID IN (SELECT DISTINCT i.NodeID FROM Orion.NPM.Interfaces i
      INNER JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID
      WHERE ${ifaceWhere})`)
  }

  if (opts.bandwidth === 'high') {
    allConds.push('n.NodeID IN (SELECT DISTINCT i.NodeID FROM Orion.NPM.Interfaces i WHERE i.PercentUtil > 50)')
  } else if (opts.bandwidth === 'medium') {
    allConds.push('n.NodeID IN (SELECT DISTINCT i.NodeID FROM Orion.NPM.Interfaces i WHERE i.PercentUtil >= 10 AND i.PercentUtil <= 50)')
  } else if (opts.bandwidth === 'low') {
    allConds.push('n.NodeID IN (SELECT DISTINCT i.NodeID FROM Orion.NPM.Interfaces i WHERE i.PercentUtil < 10 AND i.PercentUtil >= 0)')
  }

  const whereClause = allConds.length ? `WHERE ${allConds.join(' AND ')}` : ''

  const swql = `SELECT TOP 500 n.NodeID, n.Caption, n.IPAddress, n.Status, n.StatusDescription,
    n.ResponseTime, n.PercentLoss, n.CPULoad, n.PercentMemoryUsed, n.Vendor, n.MachineType,
    ${nodeCpCols}
    FROM Orion.Nodes n
    INNER JOIN Orion.NodesCustomProperties ncp ON n.NodeID = ncp.NodeID
    ${whereClause}
    ORDER BY n.Caption`

  const data = await withOrionTimeout(orionSwisQuery(swql), 'custom-prop query')
  let rows = data?.results || []

  // Apply time window filtering in JS (event joins are too slow in SWQL)
  if ((opts.from && opts.to) || (opts.excludeFrom && opts.excludeTo)) {
    const [includeSet, excludeSet] = await Promise.all([
      opts.from && opts.to ? nodeIdsInEventWindow(opts.from, opts.to, bh) : Promise.resolve(null),
      opts.excludeFrom && opts.excludeTo ? nodeIdsInEventWindow(opts.excludeFrom, opts.excludeTo, bh) : Promise.resolve(null),
    ])
    rows = rows.filter((r) => {
      const id = Number(r.NodeID)
      if (includeSet && !includeSet.has(id)) return false
      if (excludeSet && excludeSet.has(id)) return false
      return true
    })
  }

  const uptimeWindow = resolveAvailabilityWindow(opts)

  // Fetch top-2 interfaces (with CPs) + aggregate stats in a single bulk pass.
  const nodeIds = rows.map((r) => Number(r.NodeID))
  const { ifaceMap, statsMap } = await fetchInterfacesBulk(nodeIds, ifaceFields)
  const ifaceStats = statsMap

  const ifaceIdsForAvail = []
  for (const nid of nodeIds) {
    const list = ifaceMap.get(nid) || []
    for (const iface of interfacesForLinkRows(list, carrierFilterVal, matchMode)) {
      ifaceIdsForAvail.push(iface.id)
    }
  }
  const ifaceAvailMap = await interfaceAvailabilityMap(
    ifaceIdsForAvail,
    uptimeWindow.from,
    uptimeWindow.to,
    bh,
  )

  const nodeRows = rows.map((r) => {
    const nodeCp = {}
    for (const f of nodeFields) nodeCp[f] = r[f] ?? null
    const stats = ifaceStats.get(Number(r.NodeID)) || null
    const statusCode = Number(r.Status)
    return {
      nodeId: r.NodeID,
      id: r.NodeID,
      name: r.Caption,
      ip: r.IPAddress,
      statusCode,
      status: null,
      statusDescription: r.StatusDescription || null,
      responseTime: r.ResponseTime != null ? Number(r.ResponseTime) : null,
      packetLoss: r.PercentLoss != null ? Number(r.PercentLoss) : null,
      cpu: r.CPULoad != null ? Number(r.CPULoad) : null,
      memory: r.PercentMemoryUsed != null ? Number(r.PercentMemoryUsed) : null,
      vendor: r.Vendor || null,
      machineType: r.MachineType || null,
      uptimePct: null,
      uptimeSampled: false,
      bandwidthPct: stats?.avgUtil ?? null,
      bandwidthPeakPct: stats?.peakUtil ?? null,
      nodeCp,
    }
  })

  const nodes = expandNodesToLinkRows(nodeRows, ifaceMap, ifaceAvailMap, carrierFilterVal, matchMode)

  return {
    nodeFields,
    ifaceFields,
    nodeFieldMeta: buildCpFieldMeta(nodeFields, 'node'),
    ifaceFieldMeta: buildCpFieldMeta(ifaceFields, 'iface'),
    timeWindow: opts.from && opts.to ? { from: opts.from, to: opts.to } : null,
    uptimeWindow,
    businessHours: bh ? { enabled: true, startMin: bh.startMin, endMin: bh.endMin, days: [...bh.days].sort() } : null,
    nodes,
  }
}

/**
 * Walks all interfaces for the supplied node IDs once and produces:
 *   - ifaceMap: NodeID → up to 2 interface objects (with CPs) for the table
 *   - statsMap: NodeID → { avgUtil, peakUtil } across every interface
 *
 * Returning both from a single pass avoids a separate aggregation round-trip.
 */
async function fetchInterfacesBulk(nodeIds, ifaceFields) {
  const ifaceMap = new Map()
  const acc = new Map()
  if (!nodeIds.length) return { ifaceMap, statsMap: new Map() }

  const CHUNK = 100
  const ifaceCpCols = ifaceFields.length
    ? ifaceFields.map((f) => `icp.${f}`).join(', ')
    : 'icp.InterfaceID'

  const accumulate = (nid, row) => {
    if (!ifaceMap.has(nid)) ifaceMap.set(nid, [])
    const list = ifaceMap.get(nid)
    const ifaceCp = {}
    for (const f of ifaceFields) ifaceCp[f] = row[f] ?? null
    const statusCode = Number(row.Status)
    list.push({
      id: row.InterfaceID,
      name: row.Caption,
      statusCode,
      status: ifaceStatusLabel(statusCode),
      statusColor: ifaceStatusColor(statusCode),
      inBps: row.InBps != null ? Number(row.InBps) : null,
      outBps: row.OutBps != null ? Number(row.OutBps) : null,
      utilization: row.PercentUtil != null ? Number(row.PercentUtil) : null,
      cp: ifaceCp,
      availabilityPct: null,
      availabilitySampled: false,
    })
    const util = row.PercentUtil != null ? Number(row.PercentUtil) : null
    if (Number.isFinite(util) && util >= 0) {
      if (!acc.has(nid)) acc.set(nid, { sum: 0, n: 0, peak: 0 })
      const a = acc.get(nid)
      a.sum += util
      a.n++
      if (util > a.peak) a.peak = util
    }
  }

  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const ids = nodeIds.slice(i, i + CHUNK).join(',')
    try {
      const q = `SELECT i.InterfaceID, i.NodeID, i.Caption, i.Status, i.InBps, i.OutBps,
        i.PercentUtil, ${ifaceCpCols}
        FROM Orion.NPM.Interfaces i
        LEFT JOIN Orion.NPM.InterfacesCustomProperties icp ON i.InterfaceID = icp.InterfaceID
        WHERE i.NodeID IN (${ids}) ORDER BY i.NodeID, i.InterfaceID`
      const d = await orionSwisQuery(q)
      for (const row of d?.results || []) accumulate(Number(row.NodeID), row)
    } catch { /* iface CP join unavailable — fallback below */ }
  }

  // Fallback for nodes that produced no rows (e.g. no CP join present)
  const missing = nodeIds.filter((id) => !ifaceMap.has(id))
  if (missing.length) {
    const CHUNK2 = 150
    for (let i = 0; i < missing.length; i += CHUNK2) {
      const ids = missing.slice(i, i + CHUNK2).join(',')
      try {
        const q = `SELECT TOP 500 InterfaceID, NodeID, Caption, Status, InBps, OutBps, PercentUtil
          FROM Orion.NPM.Interfaces WHERE NodeID IN (${ids}) ORDER BY NodeID, InterfaceID`
        const d = await orionSwisQuery(q)
        for (const row of d?.results || []) accumulate(Number(row.NodeID), row)
      } catch { /* ignore */ }
    }
  }

  const statsMap = new Map()
  for (const [nid, a] of acc) {
    statsMap.set(nid, {
      avgUtil: a.n ? a.sum / a.n : null,
      peakUtil: a.n ? a.peak : null,
    })
  }
  return { ifaceMap, statsMap }
}

/** Load node custom property row (chunked + per-field fallback). */
export async function fetchNodeCpRow(nodeId, nodeFields) {
  const fields = (nodeFields || []).filter(isValidCol)
  if (!fields.length || !Number.isFinite(Number(nodeId))) return null
  const row = {}
  const CHUNK = 12
  for (let i = 0; i < fields.length; i += CHUNK) {
    const chunk = fields.slice(i, i + CHUNK)
    try {
      const data = await orionSwisQuery(
        `SELECT ${chunk.join(', ')} FROM Orion.NodesCustomProperties WHERE NodeID=${Number(nodeId)}`,
      )
      Object.assign(row, data?.results?.[0] || {})
    } catch {
      await Promise.allSettled(chunk.map(async (field) => {
        try {
          const data = await orionSwisQuery(
            `SELECT TOP 1 ${field} FROM Orion.NodesCustomProperties WHERE NodeID=${Number(nodeId)}`,
          )
          const val = data?.results?.[0]?.[field]
          if (val != null && String(val).trim() !== '') row[field] = val
        } catch { /* column absent on this Orion */ }
      }))
    }
  }
  return Object.keys(row).length ? row : null
}

export { toOrionDT, parseBusinessHours, inBusinessHours, fetchInterfacesBulk, cpFieldLabel, buildCpFieldMeta, fetchNodeCpRow }

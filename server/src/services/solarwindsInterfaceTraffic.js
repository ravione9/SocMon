/**
 * Orion NPM interface traffic history (Orion.NPM.InterfaceTraffic).
 */

import { orionSwisQuery, withOrionTimeout } from './solarwinds.js'

export const TRAFFIC_RANGE_SEC = {
  '15m': 15 * 60,
  '1h': 3600,
  '6h': 6 * 3600,
  '12h': 12 * 3600,
  '24h': 86400,
  '7d': 7 * 86400,
}

function toOrionDT(d) {
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}.0000000`
}

function downsample(rows, maxPoints) {
  if (!rows?.length || rows.length <= maxPoints) return rows || []
  const step = Math.ceil(rows.length / maxPoints)
  return rows.filter((_, i) => i % step === 0)
}

/**
 * @param {number} interfaceId
 * @param {{ from?: string|Date, to?: string|Date, range?: string, maxPoints?: number }} opts
 */
export async function getInterfaceTrafficHistory(interfaceId, opts = {}) {
  const ifaceId = Number(interfaceId)
  if (!Number.isFinite(ifaceId) || ifaceId <= 0) {
    throw Object.assign(new Error('Invalid interface ID'), { status: 400 })
  }

  const to = opts.to ? new Date(opts.to) : new Date()
  let from = opts.from ? new Date(opts.from) : null
  if (!from || Number.isNaN(from.getTime())) {
    if (!opts.range) {
      throw Object.assign(new Error('Provide range or from/to'), { status: 400 })
    }
    const key = String(opts.range || '12h').toLowerCase()
    const sec = TRAFFIC_RANGE_SEC[key] ?? TRAFFIC_RANGE_SEC['12h']
    from = new Date(to.getTime() - sec * 1000)
  }
  if (from.getTime() >= to.getTime()) {
    throw Object.assign(new Error('from must be before to'), { status: 400 })
  }

  const fromStr = toOrionDT(from)
  const toStr = toOrionDT(to)
  if (!fromStr || !toStr) {
    throw Object.assign(new Error('Invalid time range'), { status: 400 })
  }

  const maxPoints = Math.min(Math.max(Number(opts.maxPoints) || 500, 50), 2000)
  const swql = `SELECT DateTime, InAveragebps, OutAveragebps
    FROM Orion.NPM.InterfaceTraffic
    WHERE InterfaceID=${ifaceId}
      AND DateTime >= '${fromStr}' AND DateTime <= '${toStr}'
    ORDER BY DateTime`

  const data = await withOrionTimeout(orionSwisQuery(swql), 'interface traffic')
  const raw = data?.results || []
  const rows = downsample(raw, maxPoints)

  const inPoints = []
  const outPoints = []
  for (const r of rows) {
    const t = r.DateTime
    const clock = Math.floor(new Date(t).getTime() / 1000)
    if (!Number.isFinite(clock)) continue
    if (r.InAveragebps != null && Number.isFinite(Number(r.InAveragebps))) {
      inPoints.push({ clock, value: Number(r.InAveragebps) })
    }
    if (r.OutAveragebps != null && Number.isFinite(Number(r.OutAveragebps))) {
      outPoints.push({ clock, value: Number(r.OutAveragebps) })
    }
  }

  return {
    interfaceId: ifaceId,
    from: from.toISOString(),
    to: to.toISOString(),
    pointCount: inPoints.length,
    series: [
      { key: 'in', name: 'Inbound', units: 'bps', color: '#3b82f6', points: inPoints },
      { key: 'out', name: 'Outbound', units: 'bps', color: '#22c55e', points: outPoints },
    ],
  }
}

/** Ensure interface belongs to node before returning history. */
export async function assertInterfaceOnNode(nodeId, interfaceId) {
  const nid = Number(nodeId)
  const iid = Number(interfaceId)
  const data = await withOrionTimeout(
    orionSwisQuery(`SELECT InterfaceID, Caption FROM Orion.NPM.Interfaces WHERE InterfaceID=${iid} AND NodeID=${nid}`),
    'interface lookup',
  )
  const row = data?.results?.[0]
  if (!row) {
    throw Object.assign(new Error('Interface not found on this node'), { status: 404 })
  }
  return { id: row.InterfaceID, name: row.Caption }
}

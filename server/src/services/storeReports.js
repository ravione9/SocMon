/**
 * Excel report generation for Store Network Monitor using ExcelJS.
 */
import ExcelJS from 'exceljs'

/* ─── theme ─── */
const COLORS = {
  headerBg: '1E2535', headerFg: 'FFFFFF',
  green: '22C55E', red: 'EF4444', amber: 'EAB308',
  blue: '3B82F6', purple: '8B5CF6', cyan: '06B6D4',
  rowAlt: 'F8FAFC', rowAlt2: '1A2235',
  border: 'CBD5E1',
  critical: 'EF4444', high: 'F97316', warning: 'EAB308', ok: '22C55E',
}

function colColor(val, low, mid) {
  if (val == null || !Number.isFinite(Number(val))) return null
  const v = Number(val)
  if (v >= mid) return COLORS.red
  if (v >= low) return COLORS.amber
  return COLORS.green
}

function mkHeaderRow(ws, cols, headerBg = COLORS.headerBg) {
  const row = ws.addRow(cols.map((c) => c.header))
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.headerFg }, size: 10 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerBg } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false }
    cell.border = { bottom: { style: 'thin', color: { argb: COLORS.border } } }
  })
  row.height = 22
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 16 })
}

function mkCell(cell, value, opts = {}) {
  cell.value = value
  if (opts.color)  cell.font = { ...cell.font, color: { argb: opts.color }, bold: opts.bold }
  if (opts.bold)   cell.font = { ...(cell.font || {}), bold: true }
  if (opts.mono)   cell.font = { ...(cell.font || {}), name: 'Courier New', size: 9 }
  if (opts.align)  cell.alignment = { horizontal: opts.align }
  if (opts.bg)     cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } }
  if (opts.border) cell.border = { bottom: { style: 'thin', color: { argb: COLORS.border } } }
}

function addSummaryHeader(wb, reportTitle, range, generatedAt) {
  const ws = wb.addWorksheet('Summary')
  ws.getColumn(1).width = 25
  ws.getColumn(2).width = 40
  ws.addRow([])
  const titleRow = ws.addRow([reportTitle])
  titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: COLORS.blue } }
  ws.addRow([])
  ws.addRow(['Generated at', new Date(generatedAt).toLocaleString()])
  ws.addRow(['Range',        range])
  ws.addRow(['Tool',         'Netpulse Store Network Monitor'])
  ws.addRow([])
  return ws
}

function deriveGroups(hostname, vendor, isFortinet) {
  const h = String(hostname || '').toUpperCase()
  const v = String(vendor || '').toLowerCase()
  const groups = []
  if (h.startsWith('RP'))  groups.push('RP Group')
  else if (h.startsWith('LK')) groups.push('POS System Group')
  if (isFortinet || v.includes('fortinet') || v.includes('fortigate')) groups.push('SD-WAN Group')
  if (groups.length === 0) groups.push('General Group')
  return groups
}
function deriveGroup(hostname, vendor, isFortinet) { return deriveGroups(hostname, vendor, isFortinet)[0] }

function primaryPing(s) {
  return s?.ping?.['8.8.8.8'] || s?.ping?.['google.com'] || Object.values(s?.ping || {})[0]
}

/* ══════════ STORE INVENTORY REPORT ══════════ */
export async function buildStoreInventoryReport(stores, range) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'
  wb.created = new Date()
  addSummaryHeader(wb, 'Store Inventory Report', range, new Date().toISOString())

  const ws = wb.addWorksheet('All Stores')
  const cols = [
    { header: 'Hostname',      width: 20 }, { header: 'Serial',      width: 14 },
    { header: 'Group',         width: 18 }, { header: 'Status',      width: 10 },
    { header: 'Connectivity',  width: 16 }, { header: 'Interface',   width: 14 },
    { header: 'SSID',          width: 20 }, { header: 'Gateway IP',  width: 14 },
    { header: 'Vendor',        width: 14 }, { header: 'Ping (ms)',   width: 10 },
    { header: 'Loss %',        width: 10 }, { header: 'CPU %',       width: 10 },
    { header: 'RAM %',         width: 10 }, { header: 'DL Mbps',     width: 11 },
    { header: 'UL Mbps',       width: 11 }, { header: 'Issues',      width: 10 },
    { header: 'Severity',      width: 11 }, { header: 'Last Seen',   width: 22 },
  ]
  mkHeaderRow(ws, cols)

  for (const s of stores) {
    const group = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    const ping  = primaryPing(s)
    const row   = ws.addRow([
      s.hostname, s.serial, group,
      s.online ? 'ONLINE' : 'OFFLINE',
      s.connState, s.activeInterface || '',
      s.activeSsid && s.activeSsid !== 'n/a' ? s.activeSsid : '',
      s.gatewayIp || '', s.gatewayVendor || '',
      ping?.avgMs ?? '', ping?.packetLossPct ?? '',
      s.cpuPct ?? '', s.memPct ?? '',
      s.downloadMbps ?? '', s.uploadMbps ?? '',
      s.issueCount || 0, s.severity || 'ok',
      s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '',
    ])
    // color status cell
    const statusCell = row.getCell(4)
    statusCell.font  = { bold: true, color: { argb: s.online ? COLORS.green : COLORS.red } }
    // color severity
    const sevCell  = row.getCell(17)
    const sevColor = { critical: COLORS.critical, high: COLORS.high, warning: COLORS.warning, ok: COLORS.ok }
    sevCell.font   = { bold: true, color: { argb: sevColor[s.severity] || COLORS.ok } }
    // color numeric cells
    if (ping?.avgMs != null)          row.getCell(10).font = { color: { argb: colColor(ping.avgMs, 100, 200) || COLORS.green } }
    if (ping?.packetLossPct != null)  row.getCell(11).font = { color: { argb: colColor(ping.packetLossPct, 1, 10) || COLORS.green } }
    if (s.cpuPct != null)             row.getCell(12).font = { color: { argb: colColor(s.cpuPct, 70, 90) || COLORS.green } }
    if (s.memPct != null)             row.getCell(13).font = { color: { argb: colColor(s.memPct, 70, 90) || COLORS.green } }
    row.eachCell((cell) => { cell.alignment = { vertical: 'middle' } })
    row.height = 18
  }
  ws.autoFilter = { from: 'A1', to: `R${stores.length + 1}` }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return wb
}

/* ══════════ UPTIME REPORT ══════════ */
export async function buildUptimeReport(stores, range) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'; wb.created = new Date()
  addSummaryHeader(wb, 'Uptime Report', range, new Date().toISOString())

  // Group summary sheet
  const wg = wb.addWorksheet('Group Summary')
  mkHeaderRow(wg, [
    { header: 'Group', width: 20 }, { header: 'Total Stores', width: 14 },
    { header: 'Online', width: 10 }, { header: 'Offline', width: 10 },
    { header: 'Uptime %', width: 12 }, { header: 'Avg Ping (ms)', width: 14 },
    { header: 'Issue Stores', width: 14 },
  ])
  const groupMap = {}
  for (const s of stores) {
    const g = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    if (!groupMap[g]) groupMap[g] = { total: 0, online: 0, issues: 0, pingSum: 0, pingC: 0 }
    groupMap[g].total++
    if (s.online) groupMap[g].online++
    if ((s.issueCount || 0) > 0) groupMap[g].issues++
    const p = primaryPing(s)
    if (p?.avgMs != null) { groupMap[g].pingSum += p.avgMs; groupMap[g].pingC++ }
  }
  for (const [name, g] of Object.entries(groupMap)) {
    const uptime = g.total ? ((g.online / g.total) * 100).toFixed(1) : '0.0'
    const row = wg.addRow([name, g.total, g.online, g.total - g.online, `${uptime}%`, g.pingC ? (g.pingSum / g.pingC).toFixed(0) : '—', g.issues])
    row.getCell(5).font = { bold: true, color: { argb: Number(uptime) >= 95 ? COLORS.green : Number(uptime) >= 80 ? COLORS.amber : COLORS.red } }
  }

  // Per-store uptime sheet
  const ws = wb.addWorksheet('Per Store')
  mkHeaderRow(ws, [
    { header: 'Hostname', width: 20 }, { header: 'Serial', width: 14 },
    { header: 'Group', width: 18 }, { header: 'Status', width: 10 },
    { header: 'Online', width: 8 }, { header: 'Connectivity', width: 16 },
    { header: 'Ping Avg (ms)', width: 14 }, { header: 'Packet Loss %', width: 14 },
    { header: 'CPU %', width: 10 }, { header: 'RAM %', width: 10 },
    { header: 'Last Seen', width: 22 }, { header: 'Issues', width: 8 },
  ])
  for (const s of stores) {
    const group = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    const ping  = primaryPing(s)
    const row = ws.addRow([
      s.hostname, s.serial, group,
      s.online ? 'ONLINE' : 'OFFLINE', s.online ? '✓' : '✗',
      s.connState, ping?.avgMs ?? '', ping?.packetLossPct ?? '',
      s.cpuPct ?? '', s.memPct ?? '',
      s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '', s.issueCount || 0,
    ])
    row.getCell(4).font = { bold: true, color: { argb: s.online ? COLORS.green : COLORS.red } }
    row.getCell(5).font = { bold: true, color: { argb: s.online ? COLORS.green : COLORS.red } }
    row.height = 18
  }
  ws.autoFilter = { from: 'A1', to: `L${stores.length + 1}` }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return wb
}

/* ══════════ ISSUES REPORT ══════════ */
export async function buildIssuesReport(stores, range) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'; wb.created = new Date()
  addSummaryHeader(wb, 'Issues Report', range, new Date().toISOString())
  const now = new Date().toISOString()

  // Summary counts
  const wsSum = wb.addWorksheet('Issue Summary')
  mkHeaderRow(wsSum, [
    { header: 'Issue Code', width: 22 }, { header: 'Severity', width: 12 },
    { header: 'Count', width: 10 }, { header: 'Description', width: 40 },
  ])
  const codeCounts = {}
  for (const s of stores) {
    for (const iss of (s.issues || [])) {
      const key = `${iss.severity}|${iss.code}`
      if (!codeCounts[key]) codeCounts[key] = { code: iss.code, severity: iss.severity, message: iss.message, count: 0 }
      codeCounts[key].count++
    }
  }
  const sevOrder = { critical: 0, high: 1, warning: 2 }
  const sorted = Object.values(codeCounts).sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9) || b.count - a.count)
  for (const ic of sorted) {
    const row = wsSum.addRow([ic.code, ic.severity.toUpperCase(), ic.count, ic.message])
    const sevColor = { critical: COLORS.critical, high: COLORS.high, warning: COLORS.warning }
    row.getCell(2).font = { bold: true, color: { argb: sevColor[ic.severity] || COLORS.ok } }
    row.getCell(3).font = { bold: true }
  }

  // Detailed issues per store
  const ws = wb.addWorksheet('All Issues')
  mkHeaderRow(ws, [
    { header: 'Severity',    width: 12 }, { header: 'Hostname',     width: 20 },
    { header: 'Serial',      width: 14 }, { header: 'Group',        width: 18 },
    { header: 'Issue Code',  width: 18 }, { header: 'Description',  width: 44 },
    { header: 'Connectivity',width: 16 }, { header: 'Interface',    width: 14 },
    { header: 'Gateway IP',  width: 14 }, { header: 'Vendor',       width: 14 },
    { header: 'Ping Avg',    width: 12 }, { header: 'Packet Loss',  width: 12 },
    { header: 'Last Seen',   width: 22 }, { header: 'Report Time',  width: 22 },
  ])
  const sevColor = { critical: COLORS.critical, high: COLORS.high, warning: COLORS.warning }
  for (const s of stores) {
    if (!s.issues?.length) continue
    const group = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    const ping  = primaryPing(s)
    for (const iss of s.issues) {
      const row = ws.addRow([
        iss.severity.toUpperCase(), s.hostname, s.serial, group,
        iss.code, iss.message,
        s.connState, s.activeInterface || '',
        s.gatewayIp || '', s.gatewayVendor || '',
        ping?.avgMs != null ? `${ping.avgMs} ms` : '—',
        ping?.packetLossPct != null ? `${ping.packetLossPct}%` : '—',
        s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '—',
        new Date(now).toLocaleString(),
      ])
      row.getCell(1).font = { bold: true, color: { argb: sevColor[iss.severity] || COLORS.ok } }
      row.height = 18
    }
  }
  ws.autoFilter = { from: 'A1', to: `N${ws.lastRow?.number || 2}` }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return wb
}

/* ══════════ CONNECTIVITY REPORT ══════════ */
export async function buildConnectivityReport(stores, range) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'; wb.created = new Date()
  addSummaryHeader(wb, 'Connectivity Report', range, new Date().toISOString())

  const connMap = {}
  for (const s of stores) {
    connMap[s.connState] = (connMap[s.connState] || 0) + 1
  }
  const wsBreak = wb.addWorksheet('Breakdown')
  mkHeaderRow(wsBreak, [
    { header: 'Connectivity State', width: 22 }, { header: 'Count', width: 10 },
    { header: 'Percentage', width: 14 },
  ])
  const connColors = { lan_healthy:'22C55E', wifi_healthy:'06B6D4', hotspot:'F97316', isp_down:'EF4444', no_connectivity:'DC2626', unknown:'64748B' }
  for (const [state, count] of Object.entries(connMap)) {
    const row = wsBreak.addRow([state, count, `${((count / stores.length) * 100).toFixed(1)}%`])
    row.getCell(1).font = { color: { argb: connColors[state] || '64748B' }, bold: true }
  }

  const ws = wb.addWorksheet('Per Store')
  mkHeaderRow(ws, [
    { header: 'Hostname', width: 20 }, { header: 'Serial', width: 14 },
    { header: 'Group', width: 18 }, { header: 'Status', width: 10 },
    { header: 'Connectivity', width: 16 }, { header: 'Interface', width: 14 },
    { header: 'SSID', width: 20 }, { header: 'Gateway IP', width: 14 },
    { header: 'Vendor', width: 14 }, { header: 'Is Hotspot', width: 12 },
    { header: 'Is Fortinet', width: 12 }, { header: 'Last Seen', width: 22 },
  ])
  for (const s of stores) {
    const group = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    const row = ws.addRow([
      s.hostname, s.serial, group,
      s.online ? 'ONLINE' : 'OFFLINE',
      s.connState, s.activeInterface || '',
      s.activeSsid && s.activeSsid !== 'n/a' ? s.activeSsid : '',
      s.gatewayIp || '', s.gatewayVendor || '',
      s.isHotspot ? 'YES' : 'No',
      s.isFortinet ? 'YES' : 'No',
      s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '',
    ])
    row.getCell(4).font = { bold: true, color: { argb: s.online ? COLORS.green : COLORS.red } }
    row.getCell(10).font = { color: { argb: s.isHotspot ? COLORS.amber : COLORS.ok } }
    row.getCell(11).font = { color: { argb: s.isFortinet ? COLORS.purple : '64748B' } }
    row.height = 18
  }
  ws.autoFilter = { from: 'A1', to: `L${stores.length + 1}` }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return wb
}

/* ══════════ SPEEDTEST REPORT ══════════ */
export async function buildSpeedtestReport(stores, range) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'; wb.created = new Date()
  addSummaryHeader(wb, 'Speedtest Report', range, new Date().toISOString())

  const wsSum = wb.addWorksheet('Group Summary')
  const grpSpeed = {}
  for (const s of stores) {
    const g = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    if (!grpSpeed[g]) grpSpeed[g] = { dlSum: 0, dlC: 0, ulSum: 0, ulC: 0 }
    if (s.downloadMbps != null && s.downloadMbps > 0) { grpSpeed[g].dlSum += s.downloadMbps; grpSpeed[g].dlC++ }
    if (s.uploadMbps   != null && s.uploadMbps   > 0) { grpSpeed[g].ulSum += s.uploadMbps;   grpSpeed[g].ulC++ }
  }
  mkHeaderRow(wsSum, [
    { header: 'Group', width: 20 }, { header: 'Avg Download (Mbps)', width: 20 },
    { header: 'Avg Upload (Mbps)', width: 20 }, { header: 'Stores with Data', width: 18 },
  ])
  for (const [name, g] of Object.entries(grpSpeed)) {
    wsSum.addRow([name, g.dlC ? (g.dlSum / g.dlC).toFixed(1) : '—', g.ulC ? (g.ulSum / g.ulC).toFixed(1) : '—', g.dlC])
  }

  const ws = wb.addWorksheet('Per Store')
  mkHeaderRow(ws, [
    { header: 'Hostname', width: 20 }, { header: 'Serial', width: 14 },
    { header: 'Group', width: 18 }, { header: 'Status', width: 10 },
    { header: 'Download (Mbps)', width: 16 }, { header: 'Upload (Mbps)', width: 14 },
    { header: 'Connectivity', width: 16 }, { header: 'Last Seen', width: 22 },
  ])
  const byDl = [...stores].sort((a, b) => (b.downloadMbps || 0) - (a.downloadMbps || 0))
  for (const s of byDl) {
    const group = s.systemGroup || deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet)
    const row = ws.addRow([
      s.hostname, s.serial, group,
      s.online ? 'ONLINE' : 'OFFLINE',
      s.downloadMbps != null ? s.downloadMbps : '—',
      s.uploadMbps   != null ? s.uploadMbps   : '—',
      s.connState,
      s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '',
    ])
    if (s.downloadMbps != null) row.getCell(5).font = { color: { argb: s.downloadMbps < 5 ? COLORS.red : s.downloadMbps < 20 ? COLORS.amber : COLORS.blue } }
    if (s.uploadMbps   != null) row.getCell(6).font = { color: { argb: s.uploadMbps   < 2 ? COLORS.red : s.uploadMbps   < 10 ? COLORS.amber : COLORS.purple } }
    row.height = 18
  }
  ws.autoFilter = { from: 'A1', to: `H${stores.length + 1}` }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return wb
}

/* ══════════ FULL REPORT (all sheets in one workbook) ══════════ */
export async function buildFullReport(stores, range) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'; wb.created = new Date()
  addSummaryHeader(wb, 'Store Network Monitor — Full Report', range, new Date().toISOString())

  // All stores
  const invWb = await buildStoreInventoryReport(stores, range)
  for (const srcWs of invWb.worksheets) {
    if (srcWs.name === 'Summary') continue
    const dstWs = wb.addWorksheet(`Inventory - ${srcWs.name}`)
    srcWs.eachRow((row) => { dstWs.addRow(row.values) })
  }
  // Issues
  const issWb = await buildIssuesReport(stores, range)
  for (const srcWs of issWb.worksheets) {
    if (srcWs.name === 'Summary') continue
    const dstWs = wb.addWorksheet(`Issues - ${srcWs.name}`)
    srcWs.eachRow((row) => { dstWs.addRow(row.values) })
  }
  return wb
}

const IST_OFFSET_MIN = 330

function makeBhChecker(bh, tzMinutes) {
  if (!bh || !Array.isArray(bh.weekdays) || !bh.weekdays.length) return null
  const weekdays = new Set(bh.weekdays.map(Number))
  const startH = Number(bh.startHour)
  const endH = Number(bh.endHour)
  const tzOff = Number(tzMinutes ?? bh.tzOffsetMinutes ?? IST_OFFSET_MIN) * 60_000
  return (tsMs) => {
    const local = new Date(tsMs + tzOff)
    const day = local.getUTCDay()
    if (!weekdays.has(day)) return false
    const hour = local.getUTCHours()
    if (startH <= endH) return hour >= startH && hour < endH
    return hour >= startH || hour < endH
  }
}

/** YYYY-MM-DD in the requested timezone (default IST). */
function dayLabelInTz(tsMs, tzMinutes = IST_OFFSET_MIN) {
  return new Date(tsMs + tzMinutes * 60_000).toISOString().slice(0, 10)
}

/** Inclusive list of YYYY-MM-DD calendar days in the requested timezone. */
function buildDayLabels(fromMs, toMs, tzMinutes = IST_OFFSET_MIN) {
  const startLabel = dayLabelInTz(fromMs, tzMinutes)
  const endLabel = dayLabelInTz(toMs,   tzMinutes)
  const out = []
  let cur = new Date(`${startLabel}T00:00:00.000Z`).getTime()
  const end = new Date(`${endLabel}T00:00:00.000Z`).getTime()
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10))
    cur += 86_400_000
  }
  return out
}

/** "10 Jun 2026" style label in the requested timezone. */
function fmtTzDateTime(iso, tzMinutes = IST_OFFSET_MIN) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const local = new Date(t + tzMinutes * 60_000)
  const date = local.toISOString().slice(0, 10)
  const time = local.toISOString().slice(11, 16)
  const tzLabel = tzMinutes === IST_OFFSET_MIN ? 'IST' : `UTC${tzMinutes >= 0 ? '+' : '-'}${Math.floor(Math.abs(tzMinutes) / 60)}:${String(Math.abs(tzMinutes) % 60).padStart(2, '0')}`
  return `${date} ${time} ${tzLabel}`
}

/**
 * Daily disconnection workbook for one logical group.
 * Input events are flap-coalesced offline sessions (one per outage chain
 * per store, with a `disconnectTs` Unix-second timestamp).
 *
 * Sheets:
 *   1. Summary             — group metadata + roll-up totals (matches dashboard)
 *   2. Daily Summary       — Date | Unique Stores Disconnected | Total Events | Avg/Day
 *   3. Store-wise Daily    — every store in the group with per-day disconnect counts
 */
export async function buildGroupStoreDailyDisconnectionReport({
  groupName,
  fromIso,
  toIso,
  source,
  events = [],
  businessHours = null,
  groupStoreCount = null,
  groupStoreTags = [],
  tzOffsetMinutes = IST_OFFSET_MIN,
}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'
  wb.created = new Date()
  const tzMinutes = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : IST_OFFSET_MIN
  const rangeLabel = `${fmtTzDateTime(fromIso, tzMinutes)} → ${fmtTzDateTime(toIso, tzMinutes)}`
  addSummaryHeader(
    wb,
    `${groupName} — Store-wise Daily Disconnections`,
    rangeLabel,
    new Date().toISOString(),
  )

  const fromMs = new Date(fromIso).getTime()
  const toMs = new Date(toIso).getTime()
  const dayLabels = buildDayLabels(fromMs, toMs, tzMinutes)
  const daySet = new Set(dayLabels)
  const isBh = makeBhChecker(businessHours, tzMinutes)
  const seedStoreTags = Array.isArray(groupStoreTags)
    ? [...new Set(groupStoreTags.map((t) => String(t || '').trim()).filter(Boolean))]
    : []

  // Per-day rollups (event-count + unique-store-count) — the latter aligns with
  // the dashboard's "Disconnects" column on the Net Health tab.
  const dayEventTotals  = new Map(dayLabels.map((d) => [d, 0]))
  const dayUniqueStores = new Map(dayLabels.map((d) => [d, new Set()]))

  const byStore = new Map()
  for (const tag of seedStoreTags) {
    byStore.set(tag, {
      storeTag: tag,
      hostname: '',
      counts: new Map(dayLabels.map((d) => [d, 0])),
    })
  }

  for (const ev of events || []) {
    const tsMs = Number(ev?.disconnectTs || 0) * 1000
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue
    if (isBh && !isBh(tsMs)) continue

    const dayLabel = dayLabelInTz(tsMs, tzMinutes)
    if (!daySet.has(dayLabel)) continue

    const storeTag = String(ev?.storeTag || '').trim()
    if (!storeTag) continue

    if (!byStore.has(storeTag)) {
      byStore.set(storeTag, {
        storeTag,
        hostname: String(ev?.hostname || ''),
        counts: new Map(dayLabels.map((d) => [d, 0])),
      })
    }
    const row = byStore.get(storeTag)
    row.counts.set(dayLabel, (row.counts.get(dayLabel) || 0) + 1)
    if (!row.hostname && ev?.hostname) row.hostname = String(ev.hostname)

    dayEventTotals.set(dayLabel, (dayEventTotals.get(dayLabel) || 0) + 1)
    dayUniqueStores.get(dayLabel).add(storeTag)
  }

  const daysCount = Math.max(1, dayLabels.length)
  const storeRows = [...byStore.values()]
  storeRows.sort((a, b) => {
    const aTotal = [...a.counts.values()].reduce((sum, v) => sum + v, 0)
    const bTotal = [...b.counts.values()].reduce((sum, v) => sum + v, 0)
    return bTotal - aTotal || a.storeTag.localeCompare(b.storeTag)
  })

  const totalEvents = [...dayEventTotals.values()].reduce((sum, v) => sum + v, 0)
  const avgEventsPerDay = totalEvents / daysCount
  const totalUniqueStoreDays = [...dayUniqueStores.values()].reduce((sum, s) => sum + s.size, 0)
  const avgUniqueStoresPerDay = totalUniqueStoreDays / daysCount
  const impactedRows = storeRows.filter(
    (s) => [...s.counts.values()].some((v) => v > 0),
  )
  const impactedStoreCount = impactedRows.length

  // ── Summary sheet ───────────────────────────────────────────────────────
  const wsSummary = wb.getWorksheet('Summary')
  wsSummary.addRow(['Group', groupName])
  wsSummary.addRow(['Source', source || `StoreProblemHistory (code='offline', MongoDB)`])
  wsSummary.addRow(['Date range', rangeLabel])
  wsSummary.addRow(['Time zone', tzMinutes === IST_OFFSET_MIN ? 'IST (UTC+5:30)' : `UTC${tzMinutes >= 0 ? '+' : '-'}${Math.floor(Math.abs(tzMinutes) / 60)}:${String(Math.abs(tzMinutes) % 60).padStart(2, '0')}`])
  wsSummary.addRow(['Days in range', dayLabels.length])
  wsSummary.addRow(['Stores in group', Number(groupStoreCount ?? storeRows.length)])
  wsSummary.addRow(['Stores with at least 1 disconnect', impactedStoreCount])
  wsSummary.addRow(['Total disconnect events', totalEvents])
  wsSummary.addRow(['Avg events / day', Number(avgEventsPerDay.toFixed(2))])
  wsSummary.addRow(['Avg unique stores impacted / day', Number(avgUniqueStoresPerDay.toFixed(2))])
  wsSummary.addRow([
    'Business hours',
    businessHours
      ? `${String(businessHours.startHour).padStart(2, '0')}:00-${String(businessHours.endHour).padStart(2, '0')}:00 ${tzMinutes === IST_OFFSET_MIN ? 'IST' : ''} · weekdays ${businessHours.weekdays.join(',')}`
      : 'Disabled (24x7)',
  ])

  // ── Daily Summary sheet (matches dashboard "Disconnects" column) ────────
  const wsDaily = wb.addWorksheet('Daily Summary')
  mkHeaderRow(wsDaily, [
    { header: 'Date', width: 14 },
    { header: 'Unique Stores Disconnected', width: 26 },
    { header: 'Total Events', width: 14 },
    { header: 'Avg Events / Day', width: 16 },
  ], COLORS.blue)
  for (const d of dayLabels) {
    wsDaily.addRow([
      d,
      dayUniqueStores.get(d)?.size || 0,
      dayEventTotals.get(d) || 0,
      Number(avgEventsPerDay.toFixed(2)),
    ])
  }
  // Total row
  const totalRow = wsDaily.addRow([
    'Total',
    totalUniqueStoreDays,
    totalEvents,
    Number(avgEventsPerDay.toFixed(2)),
  ])
  totalRow.eachCell((cell) => {
    cell.font = { bold: true }
    cell.border = { top: { style: 'thin', color: { argb: COLORS.border } } }
  })

  // ── Store-wise Daily sheet ─────────────────────────────────────────────
  const wsStore = wb.addWorksheet('Store-wise Daily')
  const storeCols = [
    { header: 'Store Tag', width: 18 },
    { header: 'Hostname', width: 24 },
    ...dayLabels.map((d) => ({ header: d, width: 12 })),
    { header: 'Total', width: 10 },
    { header: 'Avg/Day', width: 10 },
  ]
  mkHeaderRow(wsStore, storeCols, COLORS.purple)

  // List every store in the group with its base offline-event count per day.
  // Impacted rows are sorted to the top; non-impacted stores follow with zeroes.
  for (const s of storeRows) {
    const perDay = dayLabels.map((d) => s.counts.get(d) || 0)
    const total = perDay.reduce((sum, v) => sum + v, 0)
    const avg = total / daysCount
    const row = wsStore.addRow([
      s.storeTag,
      s.hostname || '',
      ...perDay,
      total,
      Number(avg.toFixed(2)),
    ])
    if (total > 0) {
      const totalCell = row.getCell(2 + dayLabels.length + 1)
      totalCell.font = { bold: true, color: { argb: COLORS.red } }
    }
  }

  if (!storeRows.length) {
    wsStore.addRow([
      'No stores in group',
      '',
      ...dayLabels.map(() => 0),
      0,
      0,
    ])
  }

  wsDaily.views = [{ state: 'frozen', ySplit: 1 }]
  wsStore.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }]
  wsStore.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: storeCols.length },
  }
  return wb
}

function fmtDurationMin(mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return '—'
  const m = Number(mins)
  if (m < 1) return '< 1 m'
  if (m < 60) return `${Math.round(m)} m`
  if (m < 1440) return `${(m / 60).toFixed(1)} h`
  return `${(m / 1440).toFixed(1)} d`
}

const ROP_GROUP_LABELS = {
  rp: 'All ROP',
  rp_sdwan: 'ROP + SD-WAN',
  rp_no_sdwan: 'ROP without SD-WAN',
  manual_sdwan: 'Manual ROP + SD-WAN',
  pos: 'POS Systems (LK)',
  sdwan: 'SD-WAN Stores',
}

/**
 * ROP Dashboard — store-wise disconnect / reconnect event export.
 * Sheets: Summary | All Events | Per Store Summary
 */
export async function buildRopDisconnectEventsReport({
  groupKey,
  groupLabel,
  fromIso,
  toIso,
  source,
  businessHours,
  bhApplied,
  storeCount,
  events = [],
  storeSummary = [],
  tzOffsetMinutes = IST_OFFSET_MIN,
}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'
  wb.created = new Date()
  const tzMinutes = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : IST_OFFSET_MIN
  const label = groupLabel || ROP_GROUP_LABELS[groupKey] || groupKey || 'ROP Group'
  const rangeLabel = `${fmtTzDateTime(fromIso, tzMinutes)} → ${fmtTzDateTime(toIso, tzMinutes)}`
  const bh = businessHours || null
  const bhLabel = bh
    ? `${String(bh.startHour).padStart(2, '0')}:00–${String(bh.endHour).padStart(2, '0')}:00 · weekdays ${(bh.weekdays || []).join(',')}`
    : '24×7'

  addSummaryHeader(wb, `${label} — Disconnect & Connect Events`, rangeLabel, new Date().toISOString())
  const wsSummary = wb.getWorksheet('Summary')
  wsSummary.addRow(['Group', label])
  wsSummary.addRow(['Group key', groupKey || ''])
  wsSummary.addRow(['Source', source || `StoreProblemHistory (code='offline', MongoDB)`])
  wsSummary.addRow(['Stores in group', storeCount ?? 0])
  wsSummary.addRow(['Stores with events', storeSummary.length])
  wsSummary.addRow(['Total disconnect events', events.length])
  wsSummary.addRow(['Business hours', bhLabel])
  wsSummary.addRow(['BH filter applied', bhApplied ? 'Yes' : 'No'])

  const wsEvents = wb.addWorksheet('All Events')
  mkHeaderRow(wsEvents, [
    { header: '#', width: 6 },
    { header: 'Store Tag', width: 20 },
    { header: 'Hostname', width: 26 },
    { header: 'Disconnected At', width: 22 },
    { header: 'Connected At', width: 22 },
    { header: 'Total Duration', width: 14 },
    { header: 'BH Duration', width: 14 },
    { header: 'Status', width: 14 },
  ], COLORS.blue)

  events.forEach((ev, idx) => {
    const row = wsEvents.addRow([
      idx + 1,
      ev.storeTag || '',
      ev.hostname || '',
      fmtTzDateTime(ev.disconnectAt, tzMinutes),
      ev.stillOffline ? 'Still offline' : fmtTzDateTime(ev.backUpAt, tzMinutes),
      fmtDurationMin(ev.durationMin),
      fmtDurationMin(ev.bhDurationMin),
      ev.stillOffline ? 'OFFLINE' : 'Reconnected',
    ])
    if (ev.stillOffline) {
      mkCell(row.getCell(8), 'OFFLINE', { color: COLORS.red, bold: true })
    } else {
      mkCell(row.getCell(8), 'Reconnected', { color: COLORS.green })
    }
  })
  if (!events.length) {
    wsEvents.addRow(['', 'No disconnect events in this range / BH window', '', '', '', '', '', ''])
  }
  wsEvents.views = [{ state: 'frozen', ySplit: 1 }]
  wsEvents.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } }

  const wsStores = wb.addWorksheet('Per Store Summary')
  mkHeaderRow(wsStores, [
    { header: 'Store Tag', width: 20 },
    { header: 'Hostname', width: 26 },
    { header: 'Disconnect Events', width: 18 },
    { header: 'Total BH Downtime', width: 16 },
    { header: 'Total Duration', width: 16 },
    { header: 'Still Offline', width: 14 },
  ], COLORS.purple)

  for (const s of storeSummary) {
    const row = wsStores.addRow([
      s.storeTag,
      s.hostname || '',
      s.eventCount,
      fmtDurationMin(s.totalBhDownMin),
      fmtDurationMin(s.totalDurationMin),
      s.stillOffline ? 'Yes' : 'No',
    ])
    if (s.stillOffline) mkCell(row.getCell(6), 'Yes', { color: COLORS.red, bold: true })
  }
  if (!storeSummary.length) {
    wsStores.addRow(['No stores with disconnect events in this range', '', 0, '', '', ''])
  }
  wsStores.views = [{ state: 'frozen', ySplit: 1 }]
  wsStores.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } }

  return wb
}

/** Single-store disconnect export (ROP hostname popup). */
export async function buildRopSingleStoreDisconnectReport(data, tzOffsetMinutes = IST_OFFSET_MIN) {
  const events = data?.events || []
  const storeTag = data?.storeTag || ''
  const hostname = data?.hostname || events[0]?.hostname || ''
  const storeSummary = [{
    storeTag,
    hostname,
    eventCount: events.length,
    totalBhDownMin: events.reduce((s, e) => s + (e.bhDurationMin || 0), 0),
    totalDurationMin: events.reduce((s, e) => s + (e.durationMin || 0), 0),
    stillOffline: events.some((e) => e.stillOffline),
  }]
  return buildRopDisconnectEventsReport({
    groupKey: storeTag,
    groupLabel: hostname ? `${hostname} (${storeTag})` : storeTag,
    fromIso: data?.rangeFromIso,
    toIso: data?.rangeToIso,
    source: data?.source,
    businessHours: data?.businessHours,
    bhApplied: data?.bhApplied,
    storeCount: 1,
    events,
    storeSummary,
    tzOffsetMinutes,
  })
}

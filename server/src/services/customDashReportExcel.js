/**
 * Excel export for Custom Dashboard fleet-health and latency-episode reports.
 */
import ExcelJS from 'exceljs'

const COLORS = {
  headerBg: '1E2535',
  headerFg: 'FFFFFF',
  blue: '3B82F6',
  purple: '8B5CF6',
  border: 'CBD5E1',
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

function bhLabel(bh) {
  if (!bh?.enabled) return '24/7'
  return `${String(bh.start).padStart(2, '0')}:00–${String(bh.end).padStart(2, '0')}:00 IST`
}

function formatEpisodesArrow(episodes) {
  if (!episodes?.length) return 'no breach (sustained high ping)'
  return episodes.map((e) => `${e.start}→${e.end} ${e.peakMs}ms@${e.peakAt}`).join(' · ')
}

function formatEpisodesDash(episodes) {
  if (!episodes?.length) return ''
  return episodes.map((e) => `${e.start}–${e.end} ${e.peakMs}@${e.peakAt}`).join(' · ')
}

function addReportMeta(ws, report, title) {
  ws.getColumn(1).width = 22
  ws.getColumn(2).width = 48
  ws.addRow([])
  const titleRow = ws.addRow([title])
  titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: COLORS.blue } }
  ws.addRow([])
  ws.addRow(['Generated at', new Date().toLocaleString()])
  ws.addRow(['Hosts', (report.hosts || []).length])
  ws.addRow(['Days', (report.perDay || []).length])
  ws.addRow(['Business hours', bhLabel(report.bh)])
  ws.addRow(['Latency threshold', `${report.latencyThresholdMs} ms`])
  ws.addRow(['Gap tolerance', `${Math.round((report.gapToleranceSec || 0) / 60)} min`])
  ws.addRow([])
}

function addSummaryMatrix(ws, report) {
  ws.addRow(['Summary matrix'])
  ws.lastRow.getCell(1).font = { bold: true, size: 11 }
  mkHeaderRow(ws, [
    { header: 'Day', width: 14 },
    { header: 'Rebooted', width: 12 },
    { header: 'Total reboots', width: 14 },
    { header: `Lat>${report.latencyThresholdMs}`, width: 12 },
    { header: 'Net-issue no-reboot', width: 18 },
    { header: 'Highest avg', width: 28 },
    { header: 'Largest spike', width: 28 },
  ], COLORS.purple)
  for (const d of report.perDay || []) {
    const s = d.summary || {}
    const ha = s.highestAvg ? `${s.highestAvg.avgMs} (${s.highestAvg.hostname})` : '—'
    const ls = s.largestSpike ? `${s.largestSpike.maxMs} (${s.largestSpike.hostname})` : '—'
    ws.addRow([
      d.dayLabel,
      s.rebootedHosts || 0,
      s.totalReboots || 0,
      s.latencyHighCount || 0,
      s.networkIssueNoReboot || 0,
      ha,
      ls,
    ])
  }
  ws.addRow([])
}

export async function buildFleetHealthExcelReport(report) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'
  wb.created = new Date()

  const hostsCount = (report.hosts || []).length
  const wsSummary = wb.addWorksheet('Summary')
  addReportMeta(wsSummary, report, `Day-Wise Fleet Health (${hostsCount} hosts)`)
  addSummaryMatrix(wsSummary, report)

  const wsReboots = wb.addWorksheet('Reboots')
  mkHeaderRow(wsReboots, [
    { header: 'Day', width: 14 },
    { header: 'Hostname', width: 26 },
    { header: 'Resets', width: 10 },
    { header: 'Exact boot time(s) IST', width: 36 },
    { header: 'SD-WAN', width: 10 },
    { header: 'Link', width: 10 },
  ])
  for (const d of report.perDay || []) {
    for (const r of d.reboots || []) {
      const times = r.bootTimesIst?.length
        ? r.bootTimesIst.join(', ')
        : (r.rebootOutsideBh ? 'only outside BH window' : 'no event logged')
      wsReboots.addRow([d.dayLabel, r.hostname, r.rebootCount, times, r.sdwan ? 'Yes' : 'No', r.link])
    }
  }
  if (wsReboots.rowCount <= 1) wsReboots.addRow(['', 'No reboots in BH window', '', '', '', ''])
  wsReboots.views = [{ state: 'frozen', ySplit: 1 }]

  const wsLatency = wb.addWorksheet(`Latency >${report.latencyThresholdMs}`)
  mkHeaderRow(wsLatency, [
    { header: 'Day', width: 14 },
    { header: 'Hostname', width: 26 },
    { header: 'Avg ms', width: 10 },
    { header: 'Max ms', width: 10 },
    { header: 'Episodes (start→end peakMs@time)', width: 52 },
    { header: 'SD-WAN', width: 10 },
    { header: 'Link', width: 10 },
  ])
  for (const d of report.perDay || []) {
    for (const r of d.latencyHighTop || []) {
      wsLatency.addRow([
        d.dayLabel,
        r.hostname,
        r.avgMs ?? '—',
        r.maxMs ?? '—',
        formatEpisodesArrow(r.episodes),
        r.sdwan ? 'Yes' : 'No',
        r.link,
      ])
    }
  }
  if (wsLatency.rowCount <= 1) wsLatency.addRow(['', 'No latency breaches in BH window', '', '', '', '', ''])
  wsLatency.views = [{ state: 'frozen', ySplit: 1 }]

  const wsNet = wb.addWorksheet('Network no reboot')
  mkHeaderRow(wsNet, [
    { header: 'Day', width: 14 },
    { header: 'Hostname', width: 26 },
    { header: 'Avg ms', width: 10 },
    { header: 'Max ms', width: 10 },
    { header: 'Episodes (start→end peakMs@time)', width: 52 },
    { header: 'SD-WAN', width: 10 },
    { header: 'Link', width: 10 },
  ])
  for (const d of report.perDay || []) {
    for (const r of d.networkNoRebootTop || []) {
      wsNet.addRow([
        d.dayLabel,
        r.hostname,
        r.avgMs ?? '—',
        r.maxMs ?? '—',
        formatEpisodesArrow(r.episodes),
        r.sdwan ? 'Yes' : 'No',
        r.link,
      ])
    }
  }
  if (wsNet.rowCount <= 1) wsNet.addRow(['', 'No qualifying hosts', '', '', '', '', ''])
  wsNet.views = [{ state: 'frozen', ySplit: 1 }]

  return wb
}

export async function buildLatencyEpisodesExcelReport(report) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Netpulse'
  wb.created = new Date()

  const wsSummary = wb.addWorksheet('Summary')
  addReportMeta(
    wsSummary,
    report,
    `High-Latency >${report.latencyThresholdMs} ms Breach Timestamps (${bhLabel(report.bh)})`,
  )
  wsSummary.addRow(['Format', 'Each row = one host-day. Episodes: start–end peakMs@peakTime'])
  wsSummary.addRow([])

  const ws = wb.addWorksheet('Episodes')
  mkHeaderRow(ws, [
    { header: 'Day', width: 14 },
    { header: 'Hostname', width: 26 },
    { header: 'Win avg', width: 10 },
    { header: 'Win max@IST', width: 18 },
    { header: '#breaches', width: 12 },
    { header: 'Episodes: start–end peak@time', width: 56 },
  ], COLORS.blue)

  for (const d of report.perDay || []) {
    const list = (d.hosts || []).filter((r) => (r.episodes || []).length)
      .sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0))
    for (const r of list) {
      const winMax = r.maxMs != null && r.peakAt != null
        ? `${r.maxMs}@${r.episodes?.[0]?.peakAt || '—'}`
        : (r.maxMs ?? '—')
      ws.addRow([
        d.dayLabel,
        r.hostname,
        r.avgMs ?? '—',
        winMax,
        r.breaches,
        formatEpisodesDash(r.episodes),
      ])
    }
  }
  if (ws.rowCount <= 1) ws.addRow(['', 'No latency breaches in range', '', '', '', ''])
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } }

  return wb
}

export async function buildCustomDashReportExcel(report, reportKind = 'fleetHealth') {
  if (String(reportKind) === 'latencyEpisodes') {
    return buildLatencyEpisodesExcelReport(report)
  }
  return buildFleetHealthExcelReport(report)
}

/**
 * SolarWinds Reports tab — prebuilt Orion reports + custom report builder.
 * Pattern follows AdReportsPanel + CustomPropertiesTab export flow.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
} from 'chart.js'
import api from '../../api/client'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const REPORT_RANGE_SEC = { '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '7d': 604800 }
const REPORT_TIMEOUT_MS = 120_000
const BH_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const STATUS_COLOR = { Up: '#22d3a0', Down: '#f5534f', Warning: '#f5a623', Other: '#555a72', Unknown: '#8b90aa' }
const SEV_COLOR = { Critical: '#f5534f', High: '#f97316', Warning: '#f5a623', Information: '#22d3ee' }
const PALETTE = ['#3b82f6', '#22c55e', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#64748b']

function countByField(rows, key, fallback = 'Unknown') {
  const map = new Map()
  for (const row of rows || []) {
    const label = String(row?.[key] ?? '').trim() || fallback
    map.set(label, (map.get(label) || 0) + 1)
  }
  return map
}

function topEntries(map, n = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

function doughnutFromMap(map, colorFn) {
  const entries = [...map.entries()].filter(([, v]) => v > 0)
  if (!entries.length) return null
  return {
    labels: entries.map(([k]) => k),
    datasets: [{
      data: entries.map(([, v]) => v),
      backgroundColor: entries.map(([k], i) => colorFn(k, i)),
      borderWidth: 0,
    }],
  }
}

function barFromTop(map, n = 8) {
  const entries = topEntries(map, n).filter(([, v]) => v > 0)
  if (!entries.length) return null
  return {
    labels: entries.map(([k]) => k),
    datasets: [{
      data: entries.map(([, v]) => v),
      backgroundColor: entries.map((_, i) => PALETTE[i % PALETTE.length]),
      borderWidth: 0,
      borderRadius: 4,
    }],
  }
}

function buildReportCharts(payload) {
  if (!payload?.rows?.length) return []
  const { reportId, rows, summary } = payload
  const charts = []

  if (reportId === 'executive_summary' && summary?.nodes && summary?.alerts) {
    const nodeData = doughnutFromMap(new Map([
      ['Up', summary.nodes.up || 0],
      ['Warning', summary.nodes.warning || 0],
      ['Down', summary.nodes.down || 0],
      ['Other', summary.nodes.other || 0],
    ]), (k) => STATUS_COLOR[k] || STATUS_COLOR.Other)
    if (nodeData) charts.push({ type: 'doughnut', title: 'Node status', data: nodeData })

    const alertData = doughnutFromMap(new Map([
      ['Critical', summary.alerts.Critical || 0],
      ['High', summary.alerts.High || 0],
      ['Warning', summary.alerts.Warning || 0],
      ['Information', summary.alerts.Information || 0],
    ]), (k) => SEV_COLOR[k] || STATUS_COLOR.Other)
    if (alertData) charts.push({ type: 'doughnut', title: 'Alert severity', data: alertData })
    return charts
  }

  if (reportId === 'node_inventory' || reportId === 'nodes_impaired') {
    const data = doughnutFromMap(countByField(rows, 'status'), (k) => STATUS_COLOR[k] || STATUS_COLOR.Other)
    if (data) charts.push({ type: 'doughnut', title: 'Status distribution', data })
  }

  if (reportId === 'down_interfaces') {
    const carrierData = barFromTop(countByField(rows, 'carrier', 'No carrier'))
    if (carrierData) charts.push({ type: 'bar', title: 'Down interfaces by carrier', data: carrierData })
    const ifaceData = barFromTop(countByField(rows, 'interface'))
    if (ifaceData) charts.push({ type: 'bar', title: 'Down interfaces by name', data: ifaceData })
  }

  if (reportId === 'active_alerts' || reportId === 'critical_high_alerts') {
    const sevData = doughnutFromMap(countByField(rows, 'severity'), (k) => SEV_COLOR[k] || STATUS_COLOR.Other)
    if (sevData) charts.push({ type: 'doughnut', title: 'Severity breakdown', data: sevData })
    const objData = barFromTop(countByField(rows, 'objectType', 'Unknown'))
    if (objData) charts.push({ type: 'bar', title: 'Alerts by object type', data: objData })
  }

  if (reportId === 'recent_events' || reportId === 'unacknowledged_events') {
    const typeData = barFromTop(countByField(rows, 'typeLabel'))
    if (typeData) charts.push({ type: 'bar', title: 'Events by type', data: typeData })
    if (reportId === 'recent_events') {
      const ackMap = new Map([
        ['Acknowledged', rows.filter((r) => String(r.acknowledged).toLowerCase() === 'yes').length],
        ['Unacknowledged', rows.filter((r) => String(r.acknowledged).toLowerCase() !== 'yes').length],
      ])
      const ackData = doughnutFromMap(ackMap, (k) => (k === 'Acknowledged' ? STATUS_COLOR.Up : STATUS_COLOR.Down))
      if (ackData) charts.push({ type: 'doughnut', title: 'Acknowledgement', data: ackData })
    }
  }

  if (reportId === 'capacity_stress') {
    let cpuOnly = 0
    let memOnly = 0
    let both = 0
    for (const r of rows) {
      const cpu = Number(r.cpu)
      const mem = Number(r.memory)
      const hiCpu = Number.isFinite(cpu) && cpu >= (summary?.thresholdPct ?? 80)
      const hiMem = Number.isFinite(mem) && mem >= (summary?.thresholdPct ?? 80)
      if (hiCpu && hiMem) both++
      else if (hiCpu) cpuOnly++
      else if (hiMem) memOnly++
    }
    const stressData = doughnutFromMap(new Map([
      ['High CPU only', cpuOnly],
      ['High memory only', memOnly],
      ['Both', both],
    ]), (_, i) => PALETTE[i])
    if (stressData) charts.push({ type: 'doughnut', title: 'Stress type', data: stressData })
    const vendorData = barFromTop(countByField(rows, 'vendor', 'Unknown'))
    if (vendorData) charts.push({ type: 'bar', title: 'Stressed nodes by vendor', data: vendorData })
  }

  if (reportId === 'custom') {
    if (rows[0]?.status != null) {
      const data = doughnutFromMap(countByField(rows, 'status'), (k) => STATUS_COLOR[k] || STATUS_COLOR.Other)
      if (data) charts.push({ type: 'doughnut', title: 'Status distribution', data })
    } else if (rows[0]?.severity != null) {
      const data = doughnutFromMap(countByField(rows, 'severity'), (k) => SEV_COLOR[k] || STATUS_COLOR.Other)
      if (data) charts.push({ type: 'doughnut', title: 'Severity breakdown', data })
    } else if (rows[0]?.typeLabel != null) {
      const data = barFromTop(countByField(rows, 'typeLabel'))
      if (data) charts.push({ type: 'bar', title: 'Events by type', data })
    }
  }

  return charts
}

function ReportCharts({ payload }) {
  const charts = useMemo(() => buildReportCharts(payload), [payload])
  const doughnutOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
    cutout: '60%',
  }), [])
  const barOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0 } },
      y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
    },
  }), [])

  if (!charts.length) return null

  return (
    <div className="sw-widget sw-report-charts" style={{ marginBottom: 14 }}>
      <div className="sw-widget-hd">
        <span className="sw-widget-title">Visual summary</span>
      </div>
      <div className="sw-widget-body">
        <div className="sw-report-charts-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          {charts.map((c) => (
            <div key={c.title} className="sw-report-chart-cell" style={{ minHeight: 200 }}>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 8, textAlign: 'center', letterSpacing: '.05em' }}>
                {c.title.toUpperCase()}
              </div>
              <div style={{ height: 180 }}>
                {c.type === 'doughnut'
                  ? <Doughnut data={c.data} options={doughnutOpts} />
                  : <Bar data={c.data} options={barOpts} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function toLocalInput(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDate(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch { return ts }
}

function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename, columns, rows) {
  const keys = columns.map((c) => c.key)
  const labels = columns.map((c) => c.label)
  const lines = [
    labels.map(csvCell).join(','),
    ...rows.map((row) => keys.map((k) => csvCell(row[k])).join(',')),
  ]
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportPdf() {
  document.body.classList.add('sw-report-printing')
  setTimeout(() => {
    window.print()
    document.body.classList.remove('sw-report-printing')
  }, 350)
}

function SummaryKpis({ summary }) {
  if (!summary) return null
  const items = []
  if (summary.nodes) {
    items.push(
      { label: 'Total nodes', value: summary.nodes.total },
      { label: 'Up', value: summary.nodes.up, color: '#22d3a0' },
      { label: 'Down', value: summary.nodes.down, color: '#f5534f' },
      { label: 'Warning', value: summary.nodes.warning, color: '#f5a623' },
    )
    if (summary.availabilityPct != null) {
      items.push({ label: 'Availability', value: `${summary.availabilityPct}%` })
    }
  }
  if (summary.alerts) {
    items.push(
      { label: 'Active alerts', value: summary.alerts.total },
      { label: 'Critical', value: summary.alerts.Critical, color: '#f5534f' },
      { label: 'High', value: summary.alerts.High, color: '#f97316' },
    )
  }
  if (summary.impairedCount != null) items.push({ label: 'Impaired nodes', value: summary.impairedCount })
  if (summary.downInterfaceCount != null) items.push({ label: 'Down interfaces', value: summary.downInterfaceCount })
  if (summary.alertCount != null) items.push({ label: 'Alerts in report', value: summary.alertCount })
  if (summary.eventCount != null) items.push({ label: 'Events in report', value: summary.eventCount })
  if (summary.stressedNodeCount != null) {
    items.push({ label: 'Stressed nodes', value: summary.stressedNodeCount })
    if (summary.thresholdPct != null) items.push({ label: 'Threshold', value: `${summary.thresholdPct}%` })
  }
  if (summary.timeRange?.from && summary.timeRange?.to) {
    items.push({ label: 'From', value: fmtDate(summary.timeRange.from) })
    items.push({ label: 'To', value: fmtDate(summary.timeRange.to) })
  }
  if (summary.businessHours?.enabled) {
    const days = (summary.businessHours.days || []).map((d) => BH_DAY_LABELS[d] || d).join(', ')
    items.push({
      label: 'Business hours',
      value: `${summary.businessHours.start}–${summary.businessHours.end}${days ? ` (${days})` : ''}`,
    })
  }
  if (summary.period?.avgAvailabilityPct != null) {
    items.push({ label: 'Period availability', value: `${summary.period.avgAvailabilityPct}%` })
  }
  if (summary.period?.downEventCount != null) {
    items.push({ label: 'Down events (period)', value: summary.period.downEventCount })
  }
  if (summary.period?.alerts?.total != null) {
    items.push({ label: 'Alerts triggered (period)', value: summary.period.alerts.total })
  }
  if (summary.hasPeriod) {
    items.push({ label: 'Report mode', value: 'Current + period metrics' })
  }
  if (summary.filters?.carrier) {
    items.push({ label: 'Carrier filter', value: summary.filters.carrier })
  }
  if (summary.filters?.carrierDescription) {
    items.push({ label: 'Description filter', value: summary.filters.carrierDescription })
  }
  if (summary.mode === 'down_events_in_window') {
    items.push({ label: 'Scope', value: 'Down events in window' })
  } else if (summary.mode === 'currently_down') {
    items.push({ label: 'Scope', value: 'Currently down' })
  }
  if (!items.length) return null

  return (
    <div className="sw-kpi-grid" style={{ marginBottom: 14 }}>
      {items.map((k) => (
        <div key={k.label} className="sw-kpi">
          <div className="sw-kpi-label">{k.label}</div>
          <div className="sw-kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

function ReportCarrierFilters({
  carrier, carrierDescription, onCarrierChange, onCarrierDescriptionChange,
  carrierOptions, descriptionOptions, loading,
}) {
  return (
    <div className="sw-filter-section sw-no-print" style={{ marginBottom: 14, width: '100%' }}>
      <div className="sw-filter-section-hd">Carrier filters</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 10, lineHeight: 1.45 }}>
        Filter down interfaces by interface custom properties — carrier name and carrier description (Comments).
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12 }}>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Carrier</span>
          <select className="sw-select" value={carrier} onChange={(e) => onCarrierChange(e.target.value)} disabled={loading} style={{ minWidth: 160 }}>
            <option value="all">All carriers</option>
            {carrierOptions.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Carrier description</span>
          <select className="sw-select" value={carrierDescription} onChange={(e) => onCarrierDescriptionChange(e.target.value)} disabled={loading} style={{ minWidth: 200 }}>
            <option value="all">All descriptions</option>
            {descriptionOptions.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
        {loading && (
          <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="sw-spinner" /> Loading options…
          </span>
        )}
      </div>
    </div>
  )
}

function ReportTimeFilters({
  fromLocal, toLocal, onFromChange, onToChange, onApplyRange, onClearRange,
  bhEnabled, bhStart, bhEnd, bhDays, onBhEnabled, onBhStart, onBhEnd, onToggleBhDay,
  hint,
}) {
  return (
    <div className="sw-filter-section sw-no-print" style={{ marginBottom: 14, width: '100%' }}>
      <div className="sw-filter-section-hd">Time duration (optional)</div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 8, lineHeight: 1.45 }}>{hint}</div>
      )}
      <div className="sw-radio-group" style={{ marginBottom: 8 }}>
        {Object.keys(REPORT_RANGE_SEC).map((r) => (
          <button key={r} type="button" className="sw-btn" style={{ fontSize: 11 }} onClick={() => onApplyRange(r)}>{r}</button>
        ))}
        {(fromLocal || toLocal) && (
          <button type="button" className="sw-btn" style={{ fontSize: 11 }} onClick={onClearRange}>Clear range</button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="datetime-local" className="sw-search" style={{ maxWidth: 200 }} value={fromLocal} onChange={(e) => onFromChange(e.target.value)} />
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>→</span>
        <input type="datetime-local" className="sw-search" style={{ maxWidth: 200 }} value={toLocal} onChange={(e) => onToChange(e.target.value)} />
      </div>

      <div style={{ paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
          <input type="checkbox" checked={bhEnabled} onChange={(e) => onBhEnabled(e.target.checked)} />
          <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Business hours only</span>
          <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>(local time, applies when time range is set)</span>
        </label>
        {bhEnabled && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <input type="time" className="sw-search" style={{ maxWidth: 110, fontSize: 11 }} value={bhStart} onChange={(e) => onBhStart(e.target.value)} />
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>to</span>
              <input type="time" className="sw-search" style={{ maxWidth: 110, fontSize: 11 }} value={bhEnd} onChange={(e) => onBhEnd(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {BH_DAY_LABELS.map((label, day) => (
                <button
                  key={label}
                  type="button"
                  className={`sw-bh-day${bhDays.includes(day) ? ' on' : ''}`}
                  onClick={() => onToggleBhDay(day)}
                >{label}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CustomReportBuilder({ sources, onRun, loading }) {
  const sourceKeys = Object.keys(sources || {})
  const [source, setSource] = useState(sourceKeys[0] || 'nodes')
  const srcDef = sources?.[source]
  const [selectedCols, setSelectedCols] = useState(() =>
    new Set(srcDef?.defaultColumns || []),
  )
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [severity, setSeverity] = useState('all')
  const [ack, setAck] = useState('all')
  const [hours, setHours] = useState(24)
  const [limit, setLimit] = useState(500)

  useEffect(() => {
    const def = sources?.[source]
    setSelectedCols(new Set(def?.defaultColumns || []))
  }, [source, sources])

  const toggleCol = (key) => {
    setSelectedCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const runCustom = () => {
    const columns = [...selectedCols]
    if (!columns.length) return
    onRun('custom', {
      source,
      columns: columns.join(','),
      search: search.trim() || undefined,
      status: status !== 'all' ? status : undefined,
      severity: severity !== 'all' ? severity : undefined,
      ack: ack !== 'all' ? ack : undefined,
      hours,
      limit,
    })
  }

  return (
    <div className="sw-filter-section sw-no-print" style={{ marginBottom: 14 }}>
      <div className="sw-filter-section-hd">Custom report builder</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <label style={{ fontSize: 12 }}>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Data source</span>
          <select className="sw-select" value={source} onChange={(e) => setSource(e.target.value)}>
            {sourceKeys.map((k) => (
              <option key={k} value={k}>{sources[k].label}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Search</span>
          <input className="sw-search" type="search" placeholder="Filter results…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 180 }} />
        </label>
        <label style={{ fontSize: 12 }}>
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Row limit</span>
          <input className="sw-input" type="number" min={10} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 500)} style={{ width: 90 }} />
        </label>
        {source === 'nodes' && (
          <label style={{ fontSize: 12 }}>
            <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Status</span>
            <select className="sw-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
              <option value="warning">Warning</option>
            </select>
          </label>
        )}
        {source === 'alerts' && (
          <label style={{ fontSize: 12 }}>
            <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Severity</span>
            <select className="sw-select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="all">All</option>
              <option value="Critical">Critical</option>
              <option value="High">High</option>
              <option value="Warning">Warning</option>
              <option value="Information">Information</option>
            </select>
          </label>
        )}
        {source === 'events' && (
          <>
            <label style={{ fontSize: 12 }}>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Hours</span>
              <input className="sw-input" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value) || 24)} style={{ width: 80 }} />
            </label>
            <label style={{ fontSize: 12 }}>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Acknowledged</span>
              <select className="sw-select" value={ack} onChange={(e) => setAck(e.target.value)}>
                <option value="all">All</option>
                <option value="unacked">Unacknowledged</option>
                <option value="acked">Acknowledged</option>
              </select>
            </label>
          </>
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 }}>Columns</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(srcDef?.columns || []).map((c) => {
            const on = selectedCols.has(c.key)
            return (
              <label key={c.key} className={`sw-radio-opt${on ? ' active' : ''}`} style={{ padding: '6px 12px' }}>
                <input type="checkbox" checked={on} onChange={() => toggleCol(c.key)} />
                {c.label}
              </label>
            )
          })}
        </div>
      </div>
      <button type="button" className="sw-btn sw-btn-primary" onClick={runCustom} disabled={loading || selectedCols.size === 0}>
        {loading ? <span className="sw-spinner" /> : '▶'} Generate custom report
      </button>
    </div>
  )
}

export default function SolarWindsReportsTab({ loading: parentBusy, onReachability }) {
  const [catalog, setCatalog] = useState(null)
  const [customSources, setCustomSources] = useState(null)
  const [selectedId, setSelectedId] = useState('executive_summary')
  const [hours, setHours] = useState(24)
  const [limit, setLimit] = useState(500)
  const [threshold, setThreshold] = useState(80)
  const [fromLocal, setFromLocal] = useState('')
  const [toLocal, setToLocal] = useState('')
  const [bhEnabled, setBhEnabled] = useState(false)
  const [bhStart, setBhStart] = useState('09:00')
  const [bhEnd, setBhEnd] = useState('18:00')
  const [bhDays, setBhDays] = useState([1, 2, 3, 4, 5])
  const [carrierFilter, setCarrierFilter] = useState('all')
  const [carrierDescFilter, setCarrierDescFilter] = useState('all')
  const [carrierOptions, setCarrierOptions] = useState([])
  const [carrierDescOptions, setCarrierDescOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [payload, setPayload] = useState(null)

  const defMap = useMemo(() => new Map((catalog || []).map((d) => [d.id, d])), [catalog])
  const selectedDef = defMap.get(selectedId) || catalog?.[0]

  useEffect(() => {
    api.get('/api/solarwinds/reports/catalog')
      .then(({ data }) => {
        setCatalog(data.reports || [])
        setCustomSources(data.customSources || {})
        setCarrierOptions(data.carrierFilters?.carriers || [])
        setCarrierDescOptions(data.carrierFilters?.descriptions || [])
        if (data.reports?.length && !data.reports.some((r) => r.id === selectedId)) {
          setSelectedId(data.reports[0].id)
        }
      })
      .catch(() => setCatalog([]))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const runReport = useCallback(async (reportId, extraParams = {}) => {
    setLoading(true)
    setError(null)
    setPayload(null)
    try {
      const def = defMap.get(reportId) || {}
      const params = { ...extraParams }
      if (def.usesHours) params.hours = extraParams.hours ?? hours
      if (def.usesLimit) params.limit = extraParams.limit ?? limit
      if (def.usesThreshold) params.threshold = extraParams.threshold ?? threshold
      if (def.usesTimeRange && fromLocal && toLocal) {
        params.from = new Date(fromLocal).toISOString()
        params.to = new Date(toLocal).toISOString()
      }
      if (def.usesBusinessHours && bhEnabled) {
        params.bhEnabled = '1'
        params.bhStart = bhStart
        params.bhEnd = bhEnd
        params.bhDays = bhDays.join(',')
        params.bhTzOffsetMin = -new Date().getTimezoneOffset()
      }
      if (def.usesCarrierFilter) {
        if (carrierFilter !== 'all') params.carrier = carrierFilter
        if (carrierDescFilter !== 'all') params.carrierDescription = carrierDescFilter
      }

      const { data } = await api.get(`/api/solarwinds/reports/${reportId}`, { params, timeout: REPORT_TIMEOUT_MS })
      onReachability?.(data)
      if (data.error && data.reachable === false) {
        setError(data.error)
        return
      }
      setPayload(data)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Report failed')
    } finally {
      setLoading(false)
    }
  }, [defMap, hours, limit, threshold, fromLocal, toLocal, bhEnabled, bhStart, bhEnd, bhDays, carrierFilter, carrierDescFilter, onReachability])

  const applyReportRange = useCallback((rangeKey) => {
    const sec = REPORT_RANGE_SEC[rangeKey]
    if (!sec) return
    const to = Date.now()
    const from = to - sec * 1000
    setFromLocal(toLocalInput(from))
    setToLocal(toLocalInput(to))
  }, [])

  const toggleBhDay = useCallback((day) => {
    setBhDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()))
  }, [])

  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of catalog || []) {
      const cat = r.category || 'Other'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(r)
    }
    return [...map.entries()]
  }, [catalog])

  const exportCsv = () => {
    if (!payload?.rows?.length || !payload?.columns?.length) return
    const safeName = (payload.title || 'report').replace(/[^\w\-]+/g, '_')
    downloadCsv(`orion-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`, payload.columns, payload.rows)
  }

  const busy = loading || parentBusy

  return (
    <div className="sw-fade sw-report-print-root">
      <div className="sw-cp-print-header" style={{ display: 'none' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{payload?.title || selectedDef?.title || 'SolarWinds Report'}</h2>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#555' }}>
          Generated {fmtDate(payload?.generatedAt || new Date().toISOString())}
          {payload?.rowCount != null ? ` · ${payload.rowCount} rows` : ''}
          {payload?.summary?.timeRange?.from ? ` · ${fmtDate(payload.summary.timeRange.from)} – ${fmtDate(payload.summary.timeRange.to)}` : ''}
          {payload?.summary?.businessHours?.enabled ? ` · Business hours ${payload.summary.businessHours.start}–${payload.summary.businessHours.end}` : ''}
        </p>
      </div>

      <p className="sw-no-print" style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Prebuilt Orion reports for NOC handoffs, executive reviews, and exports. Pick a template or build a custom report with your own columns and filters.
      </p>

      {grouped.map(([category, reports]) => (
        <div key={category} className="sw-no-print" style={{ marginBottom: 16 }}>
          <div className="sw-modal-section-title">{category}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
            {reports.map((d) => {
              const active = d.id === selectedId
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(d.id)
                    if (d.custom) setPayload(null)
                  }}
                  className="sw-filter-section"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderColor: active ? 'var(--accent)' : undefined,
                    background: active ? 'rgba(79,126,245,.08)' : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 14 }}>{d.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{d.title}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>{d.description}</p>
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {selectedDef?.custom && customSources && (
        <CustomReportBuilder sources={customSources} onRun={runReport} loading={busy} />
      )}

      {!selectedDef?.custom && selectedDef && (
        <>
          {(selectedDef.usesTimeRange || selectedDef.usesBusinessHours) && (
            <ReportTimeFilters
              fromLocal={fromLocal}
              toLocal={toLocal}
              onFromChange={setFromLocal}
              onToChange={setToLocal}
              onApplyRange={applyReportRange}
              onClearRange={() => { setFromLocal(''); setToLocal('') }}
              bhEnabled={bhEnabled}
              bhStart={bhStart}
              bhEnd={bhEnd}
              bhDays={bhDays}
              onBhEnabled={setBhEnabled}
              onBhStart={setBhStart}
              onBhEnd={setBhEnd}
              onToggleBhDay={toggleBhDay}
              hint={selectedDef.id === 'down_interfaces'
                ? 'Without a time range, the report lists all currently down interfaces. With a range, it lists interfaces that went down during that window (business hours filter optional).'
                : selectedDef.id === 'executive_summary'
                  ? 'Without a time range, shows current node and alert snapshot. With a range, adds period metrics — avg availability, down events, and alerts triggered (business hours optional).'
                  : 'Limit results to events or activity within the selected window.'}
            />
          )}
          {selectedDef.usesCarrierFilter && (
            <ReportCarrierFilters
              carrier={carrierFilter}
              carrierDescription={carrierDescFilter}
              onCarrierChange={setCarrierFilter}
              onCarrierDescriptionChange={setCarrierDescFilter}
              carrierOptions={carrierOptions}
              descriptionOptions={carrierDescOptions}
              loading={!catalog}
            />
          )}
        <div className="sw-toolbar sw-no-print" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {selectedDef.usesHours && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10 }}>Hours</span>
              <input className="sw-input" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value) || 24)} style={{ width: 72 }} />
            </label>
          )}
          {selectedDef.usesLimit && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10 }}>Limit</span>
              <input className="sw-input" type="number" min={10} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 500)} style={{ width: 80 }} />
            </label>
          )}
          {selectedDef.usesThreshold && (
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10 }}>Threshold %</span>
              <input className="sw-input" type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value) || 80)} style={{ width: 72 }} />
            </label>
          )}
          <button type="button" className="sw-btn sw-btn-primary" onClick={() => runReport(selectedId)} disabled={busy}>
            {busy ? <span className="sw-spinner" /> : '▶'} Generate
          </button>
          <button type="button" className="sw-btn" onClick={exportCsv} disabled={!payload?.rows?.length}>Export CSV</button>
          <button type="button" className="sw-btn" onClick={exportPdf} disabled={!payload?.rows?.length}>Export PDF</button>
        </div>
        </>
      )}

      {selectedDef?.custom && payload?.rows?.length > 0 && (
        <div className="sw-toolbar sw-no-print" style={{ marginBottom: 14 }}>
          <button type="button" className="sw-btn" onClick={exportCsv}>Export CSV</button>
          <button type="button" className="sw-btn" onClick={exportPdf}>Export PDF</button>
        </div>
      )}

      {error && !busy && (
        <div className="sw-empty sw-no-print" style={{ color: 'var(--red)', marginBottom: 14 }}>{error}</div>
      )}

      {!payload && !busy && !error && selectedDef && !selectedDef.custom && (
        <div className="sw-empty sw-no-print" style={{ marginBottom: 14 }}>
          Choose filters if needed, then click Generate to load this report from Orion.
        </div>
      )}

      {busy && !payload && (
        <div className="sw-empty sw-no-print"><span className="sw-spinner" /> Generating report from Orion…</div>
      )}

      {payload && (
        <div className="sw-report-print-area">
          <SummaryKpis summary={payload.summary} />
          <ReportCharts payload={payload} />
          <div className="sw-widget">
            <div className="sw-widget-hd">
              <span className="sw-widget-title">{payload.title}</span>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
                {payload.rowCount ?? payload.rows?.length ?? 0} rows · {fmtDate(payload.generatedAt)}
              </span>
            </div>
            <div className="sw-table-wrap">
              {!payload.rows?.length ? (
                <div className="sw-empty">No data for this report</div>
              ) : (
                <table className="sw-table">
                  <thead>
                    <tr>
                      {(payload.columns || []).map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payload.rows.map((row, i) => (
                      <tr key={i}>
                        {(payload.columns || []).map((c) => (
                          <td key={c.key} className="sw-report-td" title={String(row[c.key] ?? '')}>
                            {row[c.key] ?? '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

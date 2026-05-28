import { useCallback, useEffect, useMemo, useState } from 'react'
import { Doughnut, Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
} from 'chart.js'
import api from '../../api/client'
import { useSmartPolling } from '../../hooks/useSmartPolling.js'
import { useUrlTab } from '../../hooks/useUrlTab.js'
import { useThemeStore } from '../../store/themeStore.js'
import { getThemeCssColors } from '../../utils/themeCssColors.js'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler)

/* ─── helpers ─────────────────────────────────────────────────────────── */
function relAge(ts) {
  if (!ts) return '—'
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (!Number.isFinite(d) || d < 0) return '—'
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`
  return `${Math.floor(d / 86400)}d ${Math.floor((d % 86400) / 3600)}h`
}
function fmtDate(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch { return ts }
}
function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(1)}%`
}
function fmtBps(bps) {
  if (bps == null || !Number.isFinite(bps)) return '—'
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`
  return `${bps.toFixed(0)} bps`
}

/* ─── constants ─────────────────────────────────────────────────────────── */
const STATUS_COLOR = { up: '#22d3a0', down: '#f5534f', warning: '#f5a623', unknown: '#555a72', unmanaged: '#8b90aa' }
const SEV_COLOR = { Critical: '#f5534f', High: '#f97316', Warning: '#f5a623', Information: '#22d3ee' }

const TRAFFIC_RANGES = ['15m', '1h', '6h', '12h', '24h', '7d']
const TRAFFIC_RANGE_SEC = {
  '15m': 15 * 60, '1h': 3600, '6h': 6 * 3600, '12h': 12 * 3600, '24h': 86400, '7d': 7 * 86400,
}
const TRAFFIC_COLORS = { in: '#3b82f6', out: '#22c55e' }
const BH_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DEFAULT_BH_DAYS = [1, 2, 3, 4, 5]

function toLocalDatetimeInput(date) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseTimeHm(str) {
  const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/** Keep points whose timestamp falls on selected weekdays and between start/end (local time). */
function filterTrafficByBusinessHours(payload, { enabled, startHm, endHm, weekdays }) {
  if (!enabled || !payload?.series?.length) return payload
  const startMin = parseTimeHm(startHm)
  const endMin = parseTimeHm(endHm)
  const days = new Set((weekdays || []).map(Number))
  if (startMin == null || endMin == null || !days.size) return payload

  const inWindow = (clock) => {
    const d = new Date(clock * 1000)
    if (!days.has(d.getDay())) return false
    const mins = d.getHours() * 60 + d.getMinutes()
    if (startMin <= endMin) return mins >= startMin && mins < endMin
    return mins >= startMin || mins < endMin
  }

  const series = payload.series.map((s) => ({
    ...s,
    points: (s.points || []).filter((p) => inWindow(Number(p.clock))),
  }))
  const pointCount = series.reduce((n, s) => n + (s.points?.length || 0), 0)
  return { ...payload, series, pointCount, businessHoursFiltered: true }
}

function buildTrafficChart(payload) {
  const series = (payload?.series || []).filter((s) => (s.points || []).length > 0)
  if (!series.length) return null
  const clockSet = new Set()
  for (const s of series) {
    for (const p of s.points || []) {
      const c = Number(p.clock)
      if (Number.isFinite(c)) clockSet.add(c)
    }
  }
  let clocks = [...clockSet].sort((a, b) => a - b)
  if (clocks.length > 400) {
    const step = Math.ceil(clocks.length / 400)
    clocks = clocks.filter((_, i) => i % step === 0)
  }
  const labels = clocks.map((c) =>
    new Date(c * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  )
  const datasets = series.map((s) => {
    const hex = s.color || TRAFFIC_COLORS[s.key] || '#3b82f6'
    const by = Object.fromEntries(
      (s.points || []).map((p) => [Number(p.clock), Number(p.value)]).filter(([c, v]) => Number.isFinite(c) && Number.isFinite(v)),
    )
    return {
      label: `${s.name} (${s.units || 'bps'})`,
      data: clocks.map((t) => by[t] ?? null),
      borderColor: hex,
      backgroundColor: `${hex}18`,
      tension: 0.35,
      spanGaps: true,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 2,
      fill: true,
    }
  })
  return { labels, datasets }
}

const TABS = [
  { id: 'overview', label: 'Dashboard', icon: '▤' },
  { id: 'nodes',    label: 'Nodes',     icon: '▦' },
  { id: 'snapshot', label: 'Device Snapshot', icon: '▣' },
  { id: 'custom',   label: 'Custom Properties', icon: '◇' },
  { id: 'alerts',   label: 'Alerts',    icon: '⚠' },
  { id: 'events',   label: 'Events',    icon: '◉' },
]

const CP_RANGE_SEC = { '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '7d': 604800 }

function toLocalInput(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ─── inline CSS ─────────────────────────────────────────────────────────── */
const CSS = `
.sw-page { display:flex; flex-direction:column; gap:0; min-height:0; }
.sw-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap;
  gap:10px; padding:14px 0 10px; border-bottom:1px solid var(--border); margin-bottom:14px; }
.sw-header-title { display:flex; align-items:center; gap:10px; }
.sw-header-title h1 { margin:0; font-size:17px; font-weight:700; color:var(--text); }
.sw-header-sub { margin:0; font-size:11px; font-family:var(--mono); color:var(--text3); margin-top:3px; }
.sw-dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.sw-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:14px; }
.sw-tab { display:inline-flex; align-items:center; gap:7px; padding:7px 14px; border-radius:8px;
  border:1px solid transparent; background:transparent; color:var(--text2); font-size:12px;
  font-weight:600; cursor:pointer; transition:all .12s; font-family:var(--sans); }
.sw-tab:hover { background:var(--bg3); color:var(--text); }
.sw-tab.active { background:var(--bg3); border-color:var(--border2); color:var(--accent); }
.sw-tab-badge { background:var(--accent); color:var(--on-accent); font-size:10px; font-weight:700;
  border-radius:999px; min-width:18px; height:18px; display:inline-flex; align-items:center;
  justify-content:center; padding:0 5px; }
.sw-widget { background:var(--bg2); border:1px solid var(--border); border-radius:12px;
  overflow:hidden; margin-bottom:14px; }
.sw-widget-hd { display:flex; align-items:center; gap:8px; padding:11px 14px 10px;
  border-bottom:1px solid var(--border); background:var(--bg3); }
.sw-widget-title { font-size:11px; font-family:var(--mono); font-weight:700; letter-spacing:.06em;
  text-transform:uppercase; color:var(--text2); flex:1; }
.sw-widget-body { padding:14px; }
.sw-kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; }
.sw-kpi { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
.sw-kpi-label { font-size:10px; font-family:var(--mono); color:var(--text3); text-transform:uppercase;
  letter-spacing:.06em; margin-bottom:6px; }
.sw-kpi-value { font-size:22px; font-weight:700; color:var(--text); line-height:1; margin-bottom:4px; }
.sw-kpi-sub { font-size:10px; font-family:var(--mono); color:var(--text3); }
button.sw-kpi { width:100%; text-align:left; font-family:inherit; color:inherit; padding:12px 14px; }
.sw-kpi-clickable { cursor:pointer; transition:border-color .12s, background .12s, transform .08s; }
.sw-kpi-clickable:hover { border-color:var(--border2); background:var(--bg3); }
.sw-kpi-clickable:active { transform:scale(.99); }
.sw-kpi-clickable.active { border-color:var(--accent); background:rgba(79,126,245,.08); }
.sw-legend-row-click { cursor:pointer; border-radius:6px; padding:4px 6px; margin:0 -6px; transition:background .12s; }
.sw-legend-row-click:hover { background:var(--bg3); }
.sw-table-wrap { overflow-x:auto; }
.sw-table { width:100%; border-collapse:collapse; font-size:12px; }
.sw-table th { font-size:10px; font-family:var(--mono); font-weight:700; letter-spacing:.06em;
  text-transform:uppercase; color:var(--text3); padding:8px 12px; text-align:left;
  border-bottom:1px solid var(--border); background:var(--bg3); white-space:nowrap; }
.sw-table td { padding:8px 12px; border-bottom:1px solid var(--border); color:var(--text); vertical-align:middle; }
.sw-table tr:last-child td { border-bottom:none; }
.sw-table tr:hover td { background:var(--bg3); }
.sw-pill { display:inline-flex; align-items:center; padding:2px 8px; border-radius:999px; font-size:10px;
  font-family:var(--mono); font-weight:700; white-space:nowrap; }
.sw-pill-up    { background:rgba(34,211,160,.12); color:#22d3a0; border:1px solid rgba(34,211,160,.28); }
.sw-pill-down  { background:rgba(245,83,79,.12); color:#f5534f; border:1px solid rgba(245,83,79,.28); }
.sw-pill-warning { background:rgba(245,166,35,.12); color:#f5a623; border:1px solid rgba(245,166,35,.28); }
.sw-pill-unknown { background:rgba(85,90,114,.12); color:#8b90aa; border:1px solid rgba(85,90,114,.28); }
.sw-pill-critical { background:rgba(245,83,79,.12); color:#f5534f; border:1px solid rgba(245,83,79,.28); }
.sw-pill-high    { background:rgba(249,115,22,.12); color:#f97316; border:1px solid rgba(249,115,22,.28); }
.sw-pill-information { background:rgba(34,211,238,.1); color:#22d3ee; border:1px solid rgba(34,211,238,.28); }
.sw-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:12px; }
.sw-search { padding:7px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg3);
  color:var(--text); font-size:12px; font-family:var(--sans); outline:none; min-width:180px; flex:1; max-width:280px; }
.sw-select { padding:6px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg3);
  color:var(--text); font-size:11px; font-family:var(--sans); outline:none; cursor:pointer; }
.sw-btn { padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg4);
  color:var(--text2); font-size:11px; font-weight:600; cursor:pointer; font-family:var(--sans); }
.sw-btn:hover { background:var(--bg3); color:var(--text); }
.sw-btn-primary { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
.sw-btn-primary:hover { opacity:.88; }
.sw-empty { text-align:center; padding:40px 20px; color:var(--text3); font-size:12px;
  font-family:var(--mono); }
.sw-err { padding:12px 14px; border-radius:10px; font-size:12px; font-family:var(--mono);
  color:var(--text2); line-height:1.5; border:1px solid rgba(245,83,79,.35);
  background:rgba(245,83,79,.08); margin-bottom:12px; }
.sw-spinner { display:inline-block; width:14px; height:14px; border:2px solid var(--border);
  border-top-color:var(--accent); border-radius:50%; animation:spin .6s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
.sw-fade { animation:fadeIn .18s ease; }
.sw-row-click { cursor:pointer; }
.sw-row-click:hover td { background:var(--bg3); }
.sw-row-active td { background:rgba(79,126,245,.12) !important; }
.sw-traffic-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
.sw-traffic-range { display:flex; gap:4px; flex-wrap:wrap; }
.sw-traffic-filters { display:flex; flex-direction:column; gap:10px; margin-bottom:12px; padding:10px 12px;
  border-radius:8px; border:1px solid var(--border); background:var(--bg2); }
.sw-traffic-filter-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sw-traffic-filter-label { font-size:10px; font-family:var(--mono); font-weight:700; letter-spacing:.05em;
  text-transform:uppercase; color:var(--text3); min-width:72px; }
.sw-bh-day { padding:4px 8px; border-radius:6px; font-size:10px; font-family:var(--mono); font-weight:600;
  border:1px solid var(--border); background:transparent; color:var(--text3); cursor:pointer; }
.sw-bh-day.on { border-color:var(--accent); background:rgba(79,126,245,.15); color:var(--accent); }
.sw-modal-backdrop { position:fixed; inset:0; z-index:200; background:rgba(0,0,0,.55); backdrop-filter:blur(4px);
  display:flex; align-items:center; justify-content:center; padding:16px; }
.sw-modal { width:min(920px,100%); max-height:min(90vh,900px); display:flex; flex-direction:column;
  background:var(--bg2); border:1px solid var(--border); border-radius:14px; box-shadow:0 24px 80px rgba(0,0,0,.45); }
.sw-modal.sw-modal-sm { width:min(560px,100%); max-height:min(80vh,640px); }
.sw-modal-hd { display:flex; align-items:flex-start; gap:12px; padding:16px 18px; border-bottom:1px solid var(--border); }
.sw-modal-body { flex:1; overflow-y:auto; padding:16px 18px 20px; }
.sw-modal-section { margin-bottom:18px; }
.sw-modal-section-title { font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
  color:var(--text3); font-family:var(--mono); margin-bottom:10px; }

/* Print / Export PDF: hide chrome, render report cleanly when window.print() is invoked
   from the Custom Properties tab. body.sw-cp-printing scopes the rules to that flow. */
@media print {
  body.sw-cp-printing .sw-no-print,
  body.sw-cp-printing aside,
  body.sw-cp-printing nav,
  body.sw-cp-printing header,
  body.sw-cp-printing .sw-tabs,
  body.sw-cp-printing .sw-toolbar { display:none !important; }
  body.sw-cp-printing .sw-cp-print-header { display:block !important; margin-bottom:14px; }
  body.sw-cp-printing { background:#fff !important; color:#111 !important; }
  body.sw-cp-printing .sw-table { font-size:11px; }
  body.sw-cp-printing .sw-table th, body.sw-cp-printing .sw-table td { color:#111 !important; border-color:#ccc !important; }
}
.sw-device-list { flex:0 0 250px; max-height:620px; overflow-y:auto; border:1px solid var(--border);
  border-radius:10px; background:var(--bg2); }
.sw-device-list-hd { padding:9px 14px; border-bottom:1px solid var(--border); background:var(--bg3);
  font-size:10px; font-weight:700; color:var(--text3); font-family:var(--mono); letter-spacing:.08em;
  text-transform:uppercase; }
.sw-device-card { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px;
  text-align:left; border:none; border-bottom:1px solid var(--border); border-left:3px solid transparent;
  background:transparent; cursor:pointer; font-size:12px; font-family:var(--mono); transition:background .12s; }
.sw-device-card:hover { background:var(--bg3); }
.sw-device-card.active { background:rgba(79,126,245,.08); border-left-color:var(--accent); }
.sw-snapshot-layout { display:flex; gap:14px; align-items:start; min-height:520px; }
.sw-info-grid { display:flex; gap:20px; flex-wrap:wrap; font-size:12px; font-family:var(--mono); }
.sw-info-field { min-width:120px; }
.sw-info-label { font-size:10px; color:var(--text3); font-weight:700; letter-spacing:.05em;
  text-transform:uppercase; margin-bottom:2px; }
.sw-info-value { color:var(--text); font-weight:600; }
.sw-snapshot-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:12px; border:1px dashed var(--border); border-radius:10px; background:var(--bg2); padding:50px; }
.sw-radio-group { display:flex; flex-wrap:wrap; gap:8px; }
.sw-radio-opt { display:inline-flex; align-items:center; gap:8px; padding:8px 14px; border-radius:8px;
  border:1px solid var(--border); background:var(--bg3); cursor:pointer; font-size:12px; font-family:var(--mono);
  font-weight:600; color:var(--text2); transition:all .12s; user-select:none; }
.sw-radio-opt:hover { border-color:var(--border2); background:var(--bg4); color:var(--text); }
.sw-radio-opt.active { border-color:var(--accent); background:rgba(79,126,245,.12); color:var(--accent); }
.sw-radio-opt input { accent-color:var(--accent); margin:0; cursor:pointer; }
.sw-filter-section { padding:12px 14px; border-radius:10px; border:1px solid var(--border); background:var(--bg2); }
.sw-filter-section-hd { font-size:10px; font-family:var(--mono); font-weight:700; letter-spacing:.07em;
  text-transform:uppercase; color:var(--text3); margin-bottom:10px; }
.sw-not-cfg { padding:28px; text-align:center; color:var(--text2); font-size:13px; line-height:1.7; }
.sw-not-cfg code { color:var(--cyan); background:var(--bg3); padding:2px 6px; border-radius:4px; font-family:var(--mono); font-size:12px; }
`

/* ─── small components ────────────────────────────────────────────────────── */
function Pill({ label, color }) {
  const cls = `sw-pill sw-pill-${(label || 'unknown').toLowerCase().replace(/\s+/g, '-')}`
  const col = color || SEV_COLOR[label] || STATUS_COLOR[label?.toLowerCase()] || '#8b90aa'
  return <span className={cls} style={{ color: col, background: `${col}18`, borderColor: `${col}40` }}>{label}</span>
}

function KpiCard({ label, value, sub, color, onClick, active }) {
  const inner = (
    <>
      <div className="sw-kpi-label">{label}</div>
      <div className="sw-kpi-value" style={color ? { color } : {}}>{value ?? '—'}</div>
      {sub && <div className="sw-kpi-sub">{sub}</div>}
    </>
  )
  if (!onClick) {
    return <div className="sw-kpi">{inner}</div>
  }
  return (
    <button
      type="button"
      className={`sw-kpi sw-kpi-clickable${active ? ' active' : ''}`}
      onClick={onClick}
      title={`Filter by ${label}`}
    >
      {inner}
    </button>
  )
}

function Widget({ title, action, children }) {
  return (
    <div className="sw-widget">
      <div className="sw-widget-hd">
        <span className="sw-widget-title">{title}</span>
        {action}
      </div>
      <div className="sw-widget-body">{children}</div>
    </div>
  )
}

function SortIcon({ col, sortKey, sortDir }) {
  if (sortKey !== col) return <span style={{ opacity: .3, fontSize: 9 }}>↕</span>
  return <span style={{ fontSize: 9, color: 'var(--accent)' }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
}

function useSort(rows, defaultKey, defaultDir = 'asc') {
  const [key, setKey] = useState(defaultKey)
  const [dir, setDir] = useState(defaultDir)
  const toggle = useCallback((k) => {
    setKey(k)
    setDir((d) => k === key ? (d === 'asc' ? 'desc' : 'asc') : 'asc')
  }, [key])
  const sorted = useMemo(() => {
    if (!rows?.length) return rows || []
    return [...rows].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string'
        ? av.localeCompare(bv, undefined, { sensitivity: 'base' })
        : av - bv
      return dir === 'asc' ? cmp : -cmp
    })
  }, [rows, key, dir])
  return { sorted, sortKey: key, sortDir: dir, toggleSort: toggle }
}

/* ─── tabs ────────────────────────────────────────────────────────────────── */
function OverviewTab({ overview, openExternalOrion, nodesStatusFilter, onFilterNodes, onFilterAlerts }) {
  const n = overview?.nodes || {}
  const a = overview?.alerts || {}
  const upPct = n.total ? Math.round((n.up || 0) / n.total * 100) : null

  const donutData = useMemo(() => ({
    labels: ['Up', 'Down', 'Warning', 'Unknown'],
    datasets: [{
      data: [n.up || 0, n.down || 0, n.warning || 0, n.unknown || 0],
      backgroundColor: [STATUS_COLOR.up, STATUS_COLOR.down, STATUS_COLOR.warning, STATUS_COLOR.unknown],
      borderWidth: 0,
    }],
  }), [n])

  return (
    <div className="sw-fade">
      <div className="sw-kpi-grid">
        <KpiCard label="Total Nodes" value={n.total ?? '—'} sub="Monitored by Orion"
          onClick={() => onFilterNodes?.('all')} active={nodesStatusFilter === 'all'} />
        <KpiCard label="Up" value={n.up ?? 0} color={STATUS_COLOR.up}
          sub={upPct != null ? `${upPct}% healthy` : null}
          onClick={() => onFilterNodes?.('up')} active={nodesStatusFilter === 'up'} />
        <KpiCard label="Down" value={n.down ?? 0} color={n.down ? STATUS_COLOR.down : undefined} sub="Unreachable"
          onClick={() => onFilterNodes?.('down')} active={nodesStatusFilter === 'down'} />
        <KpiCard label="Warning" value={n.warning ?? 0} color={n.warning ? STATUS_COLOR.warning : undefined} sub="Degraded"
          onClick={() => onFilterNodes?.('warning')} active={nodesStatusFilter === 'warning'} />
        <KpiCard label="Active Alerts" value={a.total ?? '—'} color={a.total ? STATUS_COLOR.down : undefined} sub="Across all severity"
          onClick={() => onFilterAlerts?.('all')} />
        <KpiCard label="Critical" value={a.Critical ?? 0} color={a.Critical ? SEV_COLOR.Critical : undefined} sub="Critical alerts"
          onClick={() => onFilterAlerts?.('Critical')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,240px)', gap: 14 }}>
        <Widget title="Alert Summary">
          {!a.total ? (
            <div className="sw-empty">No active alerts</div>
          ) : (
            <div className="sw-table-wrap">
              <table className="sw-table">
                <thead><tr>
                  <th>Severity</th><th>Count</th>
                </tr></thead>
                <tbody>
                  {['Critical', 'High', 'Warning', 'Information'].map((s) =>
                    a[s] != null ? (
                      <tr
                        key={s}
                        className="sw-row-click"
                        onClick={() => onFilterAlerts?.(s)}
                        title={`Show ${s} alerts`}
                      >
                        <td><Pill label={s} /></td>
                        <td style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{a[s]}</td>
                      </tr>
                    ) : null
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Widget>

        <Widget title="Node Status">
          {n.total ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0' }}>
              <div style={{ width: 160, height: 160, position: 'relative' }}>
                <Doughnut data={donutData} options={{
                  cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: {
                    label: (ctx) => ` ${ctx.label}: ${ctx.raw}`,
                  }}},
                  animation: false,
                }} />
                {upPct != null && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{upPct}%</div>
                    <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--text3)', textTransform: 'uppercase' }}>Up</div>
                  </div>
                )}
              </div>
            </div>
          ) : <div className="sw-empty">No node data</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {[['Up', 'up'], ['Down', 'down'], ['Warning', 'warning'], ['Unknown', 'unknown']].map(([label, key]) => (
              <button
                key={key}
                type="button"
                className="sw-legend-row-click"
                style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: 11, fontFamily: 'var(--mono)', border: 'none', background: 'transparent', color: 'inherit' }}
                onClick={() => onFilterNodes?.(key)}
                title={`Show ${label} nodes`}
              >
                <span style={{ color: STATUS_COLOR[key] }}>{label}</span>
                <span style={{ color: 'var(--text)', fontWeight: 700 }}>{n[key] ?? 0}</span>
              </button>
            ))}
          </div>
        </Widget>
      </div>

      {openExternalOrion && (
        <div style={{ textAlign: 'right', marginTop: 4 }}>
          <button type="button" className="sw-btn" onClick={openExternalOrion}>Open Orion Web Console ↗</button>
        </div>
      )}
    </div>
  )
}

function NodesTab({ nodes, loading, onRefresh, onNodeClick, statusFilter, onStatusFilterChange }) {
  const [q, setQ] = useState('')
  const statusF = statusFilter ?? 'all'
  const setStatusF = onStatusFilterChange ?? (() => {})

  const filtered = useMemo(() => {
    const ql = q.toLowerCase()
    return (nodes || []).filter((n) => {
      if (ql && !n.name?.toLowerCase().includes(ql) && !n.ip?.toLowerCase().includes(ql)) return false
      if (statusF !== 'all' && n.statusColor !== statusF) return false
      return true
    })
  }, [nodes, q, statusF])

  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'statusCode', 'asc')

  const th = (key, label) => (
    <th onClick={() => toggleSort(key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label} <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
    </th>
  )

  return (
    <div className="sw-fade">
      <div className="sw-toolbar">
        <input className="sw-search" type="search" placeholder="Search hostname, IP…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="sw-select" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="warning">Warning</option>
          <option value="unknown">Unknown</option>
        </select>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', marginLeft: 4 }}>
          {sorted.length} node{sorted.length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="sw-btn" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="sw-spinner" /> : '↻'} Refresh
        </button>
      </div>

      <div className="sw-widget">
        <div className="sw-table-wrap">
          {sorted.length === 0 ? (
            <div className="sw-empty">{loading ? 'Loading…' : 'No nodes found'}</div>
          ) : (
            <table className="sw-table">
              <thead><tr>
                {th('statusCode', 'Status')}
                {th('name', 'Name')}
                {th('ip', 'IP Address')}
                {th('vendor', 'Vendor')}
                {th('responseTime', 'RTT')}
                {th('packetLoss', 'Loss')}
                {th('cpu', 'CPU')}
                {th('memory', 'Memory')}
              </tr></thead>
              <tbody>
                {sorted.map((n) => (
                  <tr
                    key={n.id}
                    className={onNodeClick ? 'sw-row-click' : undefined}
                    onClick={onNodeClick ? () => onNodeClick(n) : undefined}
                    title={onNodeClick ? 'Open device snapshot' : undefined}
                  >
                    <td><Pill label={n.status} /></td>
                    <td style={{ fontWeight: 600, color: 'var(--accent)' }}>{n.name}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{n.ip || '—'}</td>
                    <td style={{ color: 'var(--text3)', fontSize: 11 }}>{n.vendor || n.machineType || '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtMs(n.responseTime)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: n.packetLoss > 0 ? STATUS_COLOR.warning : 'inherit' }}>{fmtPct(n.packetLoss)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtPct(n.cpu)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtPct(n.memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function AlertDetailModal({ detail, onClose }) {
  if (!detail) return null
  const { loading, error, alert } = detail

  return (
    <div className="sw-modal-backdrop" onClick={onClose} role="presentation">
      <div className="sw-modal sw-modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="sw-alert-modal-title">
        <div className="sw-modal-hd">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id="sw-alert-modal-title" style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', fontFamily: 'var(--sans)' }}>
              {loading ? 'Loading alert…' : (alert?.name || 'Alert detail')}
            </div>
            {alert && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <Pill label={alert.severity} />
                {(alert.objectName || alert.message) && (
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                    {alert.objectName || alert.message}
                  </span>
                )}
              </div>
            )}
          </div>
          <button type="button" className="sw-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sw-modal-body">
          {loading && (
            <div className="sw-empty" style={{ padding: 32 }}>
              <span className="sw-spinner" /> Loading from Orion…
            </div>
          )}
          {error && !loading && (
            <div className="sw-empty" style={{ color: 'var(--red)' }}>{error}</div>
          )}
          {!loading && !error && alert && (
            <div className="sw-info-grid">
              {[
                { label: 'Severity', value: alert.severity },
                { label: 'Alert name', value: alert.name },
                { label: 'Object', value: alert.objectName || '—' },
                { label: 'Entity caption', value: alert.message || '—' },
                { label: 'Type', value: alert.objectType || '—' },
                { label: 'Trigger count', value: alert.count ?? '—' },
                { label: 'Last triggered', value: fmtDate(alert.lastTriggered) },
                { label: 'First triggered', value: fmtDate(alert.firstTriggered) },
                { label: 'Alert ID', value: alert.alertId ?? '—' },
                { label: 'Description', value: alert.description || '—', wide: true },
                { label: 'Entity URI', value: alert.entityUri || '—', wide: true, mono: true },
              ].map((f) => (
                <div key={f.label} className="sw-info-field" style={f.wide ? { minWidth: '100%' } : undefined}>
                  <div className="sw-info-label">{f.label}</div>
                  <div
                    className="sw-info-value"
                    style={f.mono ? { fontFamily: 'var(--mono)', fontSize: 11, wordBreak: 'break-all' } : undefined}
                  >
                    {f.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DeviceSnapshotTab({
  nodes,
  nodesLoading,
  selectedNode,
  snapshot,
  snapshotBusy,
  nodeSearch,
  onNodeSearch,
  onPickNode,
  onRefresh,
  onAlertClick,
}) {
  const theme = useThemeStore((s) => s.theme)
  const tc = useMemo(() => getThemeCssColors(), [theme])
  const [selectedIfaceId, setSelectedIfaceId] = useState(null)
  const [trafficRange, setTrafficRange] = useState('12h')
  const [trafficCustomFrom, setTrafficCustomFrom] = useState('')
  const [trafficCustomTo, setTrafficCustomTo] = useState('')
  const [trafficCustomActive, setTrafficCustomActive] = useState(null)
  const [businessHoursOn, setBusinessHoursOn] = useState(false)
  const [bhStart, setBhStart] = useState('09:00')
  const [bhEnd, setBhEnd] = useState('18:00')
  const [bhWeekdays, setBhWeekdays] = useState(DEFAULT_BH_DAYS)
  const [trafficPayload, setTrafficPayload] = useState(null)
  const [trafficBusy, setTrafficBusy] = useState(false)
  const [trafficError, setTrafficError] = useState(null)

  const pickTrafficRange = useCallback((r) => {
    setTrafficRange(r)
    setTrafficCustomActive(null)
  }, [])

  const applyTrafficCustomRange = useCallback(() => {
    if (!trafficCustomFrom || !trafficCustomTo) return
    const from = new Date(trafficCustomFrom)
    const to = new Date(trafficCustomTo)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      setTrafficError('Custom range: “from” must be before “to”.')
      return
    }
    setTrafficCustomActive({ from: from.toISOString(), to: to.toISOString() })
    setTrafficError(null)
  }, [trafficCustomFrom, trafficCustomTo])

  const toggleBhDay = useCallback((day) => {
    setBhWeekdays((prev) => {
      const set = new Set(prev)
      if (set.has(day)) set.delete(day)
      else set.add(day)
      return [...set].sort((a, b) => a - b)
    })
  }, [])

  const chartOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 500 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: tc.text2, font: { size: 11 }, boxWidth: 14, padding: 12, usePointStyle: true },
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed?.y
            return `${ctx.dataset.label}: ${fmtBps(v)}`
          },
        },
      },
    },
    scales: {
      x: { ticks: { color: tc.text3, maxRotation: 45, font: { size: 9 }, maxTicksLimit: 12 }, grid: { color: 'rgba(128,128,160,.05)' } },
      y: {
        ticks: {
          color: tc.text3,
          font: { size: 10 },
          callback: (v) => fmtBps(v),
        },
        grid: { color: 'rgba(128,128,160,.07)' },
        beginAtZero: true,
      },
    },
  }), [tc])

  const filteredTrafficPayload = useMemo(
    () => filterTrafficByBusinessHours(trafficPayload, {
      enabled: businessHoursOn,
      startHm: bhStart,
      endHm: bhEnd,
      weekdays: bhWeekdays,
    }),
    [trafficPayload, businessHoursOn, bhStart, bhEnd, bhWeekdays],
  )
  const trafficChart = useMemo(() => buildTrafficChart(filteredTrafficPayload), [filteredTrafficPayload])
  const displayedPointCount = useMemo(() => {
    if (!filteredTrafficPayload?.series) return 0
    return filteredTrafficPayload.series.reduce((n, s) => n + (s.points?.length || 0), 0)
  }, [filteredTrafficPayload])
  const selectedIface = useMemo(
    () => (snapshot?.interfaces || []).find((i) => i.id === selectedIfaceId),
    [snapshot?.interfaces, selectedIfaceId],
  )

  useEffect(() => {
    const ifaces = snapshot?.interfaces || []
    if (!ifaces.length) {
      setSelectedIfaceId(null)
      return
    }
    if (!ifaces.some((i) => i.id === selectedIfaceId)) {
      setSelectedIfaceId(ifaces[0].id)
    }
  }, [snapshot?.interfaces, selectedIfaceId])

  useEffect(() => {
    if (trafficCustomActive) return
    const sec = TRAFFIC_RANGE_SEC[trafficRange] ?? TRAFFIC_RANGE_SEC['12h']
    const to = new Date()
    const from = new Date(to.getTime() - sec * 1000)
    setTrafficCustomFrom(toLocalDatetimeInput(from))
    setTrafficCustomTo(toLocalDatetimeInput(to))
  }, [trafficRange, trafficCustomActive])

  useEffect(() => {
    if (!selectedNode?.id || !selectedIfaceId) {
      setTrafficPayload(null)
      setTrafficError(null)
      return
    }
    let cancelled = false
    setTrafficBusy(true)
    setTrafficError(null)
    const params = trafficCustomActive
      ? { from: trafficCustomActive.from, to: trafficCustomActive.to }
      : { range: trafficRange }
    api.get(`/api/solarwinds/nodes/${selectedNode.id}/interfaces/${selectedIfaceId}/traffic`, { params })
      .then(({ data }) => {
        if (!cancelled) setTrafficPayload(data)
      })
      .catch((e) => {
        if (!cancelled) {
          setTrafficPayload(null)
          setTrafficError(e.response?.data?.error || e.message || 'Failed to load traffic history')
        }
      })
      .finally(() => { if (!cancelled) setTrafficBusy(false) })
    return () => { cancelled = true }
  }, [selectedNode?.id, selectedIfaceId, trafficRange, trafficCustomActive])

  const filtered = useMemo(() => {
    const ql = nodeSearch.toLowerCase()
    return (nodes || []).filter((n) => {
      if (!ql) return true
      return n.name?.toLowerCase().includes(ql) || n.ip?.toLowerCase().includes(ql)
    })
  }, [nodes, nodeSearch])

  const node = snapshot?.node || selectedNode
  const dotColor = STATUS_COLOR[node?.statusColor] || STATUS_COLOR.unknown

  return (
    <div className="sw-fade">
      <div className="sw-toolbar">
        <input className="sw-search" type="search" placeholder="Search devices…"
          value={nodeSearch} onChange={(e) => onNodeSearch(e.target.value)} />
        {selectedNode && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999,
            background: 'rgba(79,126,245,.08)', border: '1px solid rgba(79,126,245,.25)',
            fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor }} />
            {selectedNode.name}
          </div>
        )}
        <button type="button" className="sw-btn" onClick={onRefresh} disabled={snapshotBusy || !selectedNode}>
          {snapshotBusy ? <span className="sw-spinner" /> : '↻'} Refresh
        </button>
      </div>

      <div className="sw-snapshot-layout">
        <div className="sw-device-list">
          <div className="sw-device-list-hd">
            Devices {filtered.length > 0 ? `(${filtered.length})` : ''}
          </div>
          {nodesLoading && nodes == null && (
            <div className="sw-empty" style={{ padding: 20 }}>Loading devices…</div>
          )}
          {!nodesLoading && filtered.map((n) => {
            const active = selectedNode?.id === n.id
            const col = STATUS_COLOR[n.statusColor] || STATUS_COLOR.unknown
            return (
              <button
                key={n.id}
                type="button"
                className={`sw-device-card${active ? ' active' : ''}`}
                onClick={() => onPickNode(n)}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: col, flexShrink: 0,
                  boxShadow: n.statusColor === 'up' ? `0 0 5px ${col}80` : 'none',
                }} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                    {n.ip || '—'}
                  </div>
                </div>
              </button>
            )
          })}
          {!nodesLoading && filtered.length === 0 && (
            <div className="sw-empty" style={{ padding: 20 }}>No devices found.</div>
          )}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {!selectedNode && (
            <div className="sw-snapshot-empty">
              <span style={{ fontSize: 40, opacity: .2 }}>📊</span>
              <span style={{ fontSize: 14, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Select a device to view its snapshot</span>
              <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', opacity: .5 }}>Or click any node from the Nodes tab</span>
            </div>
          )}

          {selectedNode && snapshotBusy && !snapshot?.node && (
            <div className="sw-snapshot-empty">
              <span className="sw-spinner" />
              <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Loading snapshot…</span>
            </div>
          )}

          {selectedNode && snapshot?.node && (
            <>
              <Widget title="Device Info">
                <div className="sw-info-grid">
                  {[
                    { label: 'Device', value: node.name },
                    { label: 'IP Address', value: node.ip || '—' },
                    { label: 'Status', value: node.status, color: dotColor },
                    { label: 'Vendor', value: node.vendor || '—' },
                    { label: 'Type', value: node.machineType || '—' },
                    { label: 'DNS', value: node.dns || '—' },
                    { label: 'Location', value: node.location || '—' },
                    { label: 'Contact', value: node.contact || '—' },
                    { label: 'Description', value: node.description || node.statusDescription || '—' },
                  ].map((f) => (
                    <div key={f.label} className="sw-info-field">
                      <div className="sw-info-label">{f.label}</div>
                      <div className="sw-info-value" style={f.color ? { color: f.color } : undefined}>{f.value}</div>
                    </div>
                  ))}
                </div>
              </Widget>

              <div className="sw-kpi-grid">
                <KpiCard label="Response Time" value={fmtMs(node.responseTime)} sub="ICMP / poller" />
                <KpiCard label="Packet Loss" value={fmtPct(node.packetLoss)} color={node.packetLoss > 0 ? STATUS_COLOR.warning : undefined} />
                <KpiCard label="CPU Load" value={node.cpu != null && node.cpu >= 0 ? fmtPct(node.cpu) : '—'} />
                <KpiCard label="Memory" value={node.memory != null && node.memory >= 0 ? fmtPct(node.memory) : '—'} />
                <KpiCard label="Active Alerts" value={snapshot.alerts?.length ?? 0} color={(snapshot.alerts?.length ?? 0) > 0 ? STATUS_COLOR.down : undefined} />
                <KpiCard label="Interfaces" value={snapshot.interfaces?.length ?? 0} sub="NPM interfaces" />
              </div>

              <Widget title={`Interfaces (${snapshot.interfaces?.length ?? 0})`}>
                {(snapshot.interfaces || []).length === 0 ? (
                  <div className="sw-empty">No interface data for this node.</div>
                ) : (
                  <>
                    <div className="sw-table-wrap" style={{ marginBottom: 14 }}>
                      <table className="sw-table">
                        <thead><tr>
                          <th>Status</th><th>Interface</th><th>In (live)</th><th>Out (live)</th><th>Util</th>
                        </tr></thead>
                        <tbody>
                          {snapshot.interfaces.map((iface) => (
                            <tr
                              key={iface.id}
                              className={`sw-row-click${selectedIfaceId === iface.id ? ' sw-row-active' : ''}`}
                              onClick={() => setSelectedIfaceId(iface.id)}
                              title="Show bandwidth graph"
                            >
                              <td><Pill label={iface.status} /></td>
                              <td style={{ fontWeight: 600, color: selectedIfaceId === iface.id ? 'var(--accent)' : undefined }}>{iface.name}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtBps(iface.inBps)}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtBps(iface.outBps)}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtPct(iface.utilization)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {selectedIface && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                        <div className="sw-traffic-toolbar">
                          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
                            Bandwidth — {selectedIface.name}
                          </span>
                          <div className="sw-traffic-range">
                            {TRAFFIC_RANGES.map((r) => (
                              <button
                                key={r}
                                type="button"
                                className={`sw-btn${trafficRange === r && !trafficCustomActive ? ' sw-btn-primary' : ''}`}
                                style={{ fontSize: 11, padding: '4px 10px' }}
                                onClick={() => pickTrafficRange(r)}
                              >
                                {r}
                              </button>
                            ))}
                          </div>
                          {trafficBusy && <span className="sw-spinner" />}
                        </div>

                        <div className="sw-traffic-filters">
                          <div className="sw-traffic-filter-row">
                            <span className="sw-traffic-filter-label" style={trafficCustomActive ? { color: 'var(--accent)' } : undefined}>Custom</span>
                            <input
                              type="datetime-local"
                              className="sw-search"
                              style={{ maxWidth: 200, fontSize: 11 }}
                              value={trafficCustomFrom}
                              onChange={(e) => setTrafficCustomFrom(e.target.value)}
                            />
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>→</span>
                            <input
                              type="datetime-local"
                              className="sw-search"
                              style={{ maxWidth: 200, fontSize: 11 }}
                              value={trafficCustomTo}
                              onChange={(e) => setTrafficCustomTo(e.target.value)}
                            />
                            <button
                              type="button"
                              className="sw-btn sw-btn-primary"
                              style={{ fontSize: 11 }}
                              disabled={!trafficCustomFrom || !trafficCustomTo || trafficBusy}
                              onClick={applyTrafficCustomRange}
                            >
                              Apply
                            </button>
                            {trafficCustomActive && (
                              <button
                                type="button"
                                className="sw-btn"
                                style={{ fontSize: 11 }}
                                onClick={() => { setTrafficCustomActive(null); pickTrafficRange(trafficRange) }}
                              >
                                Clear custom
                              </button>
                            )}
                            {trafficCustomActive && (
                              <span className="sw-pill" style={{ fontSize: 10, background: 'rgba(79,126,245,.12)', color: 'var(--accent)' }}>
                                Custom range active
                              </span>
                            )}
                          </div>

                          <div className="sw-traffic-filter-row">
                            <span className="sw-traffic-filter-label" style={businessHoursOn ? { color: 'var(--accent)' } : undefined}>Business hrs</span>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: 'var(--text2)' }}>
                              <input type="checkbox" checked={businessHoursOn} onChange={(e) => setBusinessHoursOn(e.target.checked)} />
                              Show only
                            </label>
                            <input
                              type="time"
                              className="sw-search"
                              style={{ maxWidth: 110, fontSize: 11 }}
                              value={bhStart}
                              onChange={(e) => setBhStart(e.target.value)}
                              disabled={!businessHoursOn}
                            />
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>to</span>
                            <input
                              type="time"
                              className="sw-search"
                              style={{ maxWidth: 110, fontSize: 11 }}
                              value={bhEnd}
                              onChange={(e) => setBhEnd(e.target.value)}
                              disabled={!businessHoursOn}
                            />
                            <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>(local time)</span>
                          </div>
                          <div className="sw-traffic-filter-row" style={{ paddingLeft: 72 }}>
                            {BH_DAY_LABELS.map((label, day) => (
                              <button
                                key={label}
                                type="button"
                                className={`sw-bh-day${bhWeekdays.includes(day) ? ' on' : ''}`}
                                disabled={!businessHoursOn}
                                onClick={() => toggleBhDay(day)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {trafficError && (
                          <div className="sw-empty" style={{ color: 'var(--amber)', marginBottom: 8 }}>{trafficError}</div>
                        )}
                        {!trafficBusy && !trafficError && !trafficChart && (
                          <div className="sw-empty">
                            {businessHoursOn && trafficPayload?.pointCount
                              ? 'No samples in the selected business hours. Widen the time range or adjust hours/days.'
                              : 'No historical traffic in this range.'}
                          </div>
                        )}
                        {trafficChart && (
                          <div style={{ height: 320, position: 'relative' }}>
                            <Line data={trafficChart} options={chartOpts} />
                          </div>
                        )}
                        {trafficPayload?.pointCount != null && !trafficBusy && (
                          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                            {displayedPointCount}
                            {businessHoursOn && displayedPointCount !== trafficPayload.pointCount
                              ? ` of ${trafficPayload.pointCount}`
                              : ''}
                            {' '}samples
                            {businessHoursOn ? ' · business hours filter' : ''}
                            {' · Orion NPM InterfaceTraffic'}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </Widget>

              <Widget title={`Active Alerts (${snapshot.alerts?.length ?? 0})`}>
                {(snapshot.alerts || []).length === 0 ? (
                  <div className="sw-empty">No active alerts on this node.</div>
                ) : (
                  <div className="sw-table-wrap">
                    <table className="sw-table">
                      <thead><tr><th>Severity</th><th>Alert</th><th>Object</th><th>Count</th></tr></thead>
                      <tbody>
                        {snapshot.alerts.map((a) => (
                          <tr
                            key={a.id}
                            className="sw-row-click"
                            onClick={() => onAlertClick?.(a)}
                            title="View alert details"
                          >
                            <td><Pill label={a.severity} /></td>
                            <td style={{ fontWeight: 600 }}>{a.name}</td>
                            <td style={{ fontSize: 11, color: 'var(--text2)' }}>{a.message || a.objectName || '—'}</td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{a.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Widget>

              <Widget title={`Recent Events (${snapshot.events?.length ?? 0})`}>
                {(snapshot.events || []).length === 0 ? (
                  <div className="sw-empty">No recent events for this node.</div>
                ) : (
                  <div className="sw-table-wrap">
                    <table className="sw-table">
                      <thead><tr><th>Time</th><th>Age</th><th>Type</th><th>Message</th></tr></thead>
                      <tbody>
                        {snapshot.events.map((e) => (
                          <tr key={e.id}>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{fmtDate(e.time)}</td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{relAge(e.time)}</td>
                            <td style={{ fontSize: 11, color: 'var(--text3)' }}>{e.type || '—'}</td>
                            <td style={{ color: 'var(--text2)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.message}>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Widget>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SwRadioGroup({ name, value, onChange, options }) {
  const opts = [{ id: 'all', label: 'All' }, ...(options || [])]
  return (
    <div className="sw-radio-group" role="radiogroup" aria-label={name}>
      {opts.map((o) => {
        const id = String(o.id)
        const active = value === id
        return (
          <label key={id} className={`sw-radio-opt${active ? ' active' : ''}`}>
            <input type="radio" name={name} value={id} checked={active} onChange={() => onChange(id)} />
            {o.label ?? id}
          </label>
        )
      })}
    </div>
  )
}

function CustomPropertiesTab({
  presets, presetsLoading,
  results, loading, onSearch, onNodeClick,
  filters, onFiltersChange,
}) {
  const f = filters || {}
  const set = (key, val) => onFiltersChange?.({ ...f, [key]: val })
  const p = presets || {}

  const toggleBhDay = (day) => {
    const current = Array.isArray(f.bhDays) ? f.bhDays : []
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()
    set('bhDays', next)
  }

  // Summary stats for the result set (drives the chart row + KPIs)
  const summary = useMemo(() => {
    const rows = Array.isArray(results) ? results : []
    const status = { up: 0, warning: 0, down: 0, other: 0 }
    let uptimeSum = 0, uptimeCount = 0, uptimeSampled = false
    let bwSum = 0, bwCount = 0
    const bwBins = { low: 0, medium: 0, high: 0, none: 0 }
    for (const n of rows) {
      const c = Number(n.statusCode)
      if (c === 1) status.up++
      else if (c === 3) status.warning++
      else if (c === 2) status.down++
      else status.other++

      if (Number.isFinite(n.uptimePct)) { uptimeSum += n.uptimePct; uptimeCount++; if (n.uptimeSampled) uptimeSampled = true }

      const bw = Number(n.bandwidthPct)
      if (Number.isFinite(bw)) {
        bwSum += bw; bwCount++
        if (bw > 50) bwBins.high++
        else if (bw >= 10) bwBins.medium++
        else bwBins.low++
      } else {
        bwBins.none++
      }
    }
    return {
      total: rows.length,
      status,
      avgUptime: uptimeCount ? uptimeSum / uptimeCount : null,
      uptimeSampled,
      avgBandwidth: bwCount ? bwSum / bwCount : null,
      bwBins,
    }
  }, [results])

  const statusDoughnut = useMemo(() => ({
    labels: ['Up', 'Warning', 'Down', 'Other'],
    datasets: [{
      data: [summary.status.up, summary.status.warning, summary.status.down, summary.status.other],
      backgroundColor: [STATUS_COLOR.up, STATUS_COLOR.warning, STATUS_COLOR.down, STATUS_COLOR.unknown],
      borderWidth: 0,
    }],
  }), [summary])

  const bandwidthDoughnut = useMemo(() => ({
    labels: ['Low (<10%)', 'Medium (10–50%)', 'High (>50%)', 'No data'],
    datasets: [{
      data: [summary.bwBins.low, summary.bwBins.medium, summary.bwBins.high, summary.bwBins.none],
      backgroundColor: [STATUS_COLOR.up, STATUS_COLOR.warning, STATUS_COLOR.down, STATUS_COLOR.unknown],
      borderWidth: 0,
    }],
  }), [summary])

  const doughnutOpts = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
    },
    cutout: '60%',
  }), [])

  const exportPdf = () => {
    const root = document.querySelector('.sw-cp-print-root')
    if (!root) { window.print(); return }
    document.body.classList.add('sw-cp-printing')
    setTimeout(() => {
      window.print()
      document.body.classList.remove('sw-cp-printing')
    }, 50)
  }

  const exportCsv = () => {
    const rows = Array.isArray(results) ? results : []
    if (!rows.length) return
    const header = ['Name', 'IP', 'Status', 'Uptime %', 'Bandwidth %', 'Link', 'Org', 'Dept', 'If1', 'Carrier', 'If2']
    const cell = (v) => {
      if (v == null) return ''
      const s = String(v).replace(/"/g, '""')
      return /[",\n]/.test(s) ? `"${s}"` : s
    }
    const body = rows.map((n) => [
      n.name, n.ip || '', n.status || '',
      Number.isFinite(n.uptimePct) ? n.uptimePct.toFixed(1) : '',
      Number.isFinite(n.bandwidthPct) ? n.bandwidthPct.toFixed(1) : '',
      n.nodeCp?.DUAL_LINKS || '', n.nodeCp?.ORGANIZATION || '', n.nodeCp?.Department || '',
      n.interface1?.name || '', n.interface1?.cp?.CarrierName || '', n.interface2?.name || '',
    ].map(cell).join(','))
    const csv = [header.join(','), ...body].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `solarwinds-nodes-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const applyRange = (kind, rangeKey) => {
    const sec = CP_RANGE_SEC[rangeKey]
    if (!sec) return
    const to = Date.now()
    const from = to - sec * 1000
    if (kind === 'include') {
      onFiltersChange?.({ ...f, fromLocal: toLocalInput(from), toLocal: toLocalInput(to) })
    } else {
      onFiltersChange?.({ ...f, excludeFromLocal: toLocalInput(from), excludeToLocal: toLocalInput(to), excludeEnabled: true })
    }
  }

  const cpRadio = (key, presetKey) => {
    const preset = p[presetKey]
    if (!preset?.values?.length) return null
    const stringOpts = preset.values.map((v) => ({ id: v, label: v }))
    return (
      <div className="sw-filter-section" key={key}>
        <div className="sw-filter-section-hd">{preset.label || presetKey}</div>
        <SwRadioGroup name={`sw-cp-${key}`} value={f[key] || 'all'} onChange={(v) => set(key, v)} options={stringOpts} />
      </div>
    )
  }

  const staticRadio = (key, presetKey) => {
    const preset = p[presetKey]
    if (!preset?.values?.length) return null
    return (
      <div className="sw-filter-section" key={key}>
        <div className="sw-filter-section-hd">{preset.label}</div>
        <SwRadioGroup name={`sw-cp-${key}`} value={f[key] || 'all'} onChange={(v) => set(key, v)} options={preset.values} />
      </div>
    )
  }

  return (
    <div className="sw-fade" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {presetsLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
          <span className="sw-spinner" /> Loading filter options from Orion…
        </div>
      )}

      {!presetsLoading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
          {cpRadio('link', 'link')}
          {cpRadio('carrier', 'carrier')}
          {staticRadio('uptime', 'uptime')}
          {staticRadio('bandwidth', 'bandwidth')}
        </div>
      )}

      <div className="sw-filter-section">
        <div className="sw-filter-section-hd">Time duration (optional)</div>
        <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 8 }}>Include — only nodes with events in range</div>
        <div className="sw-radio-group" style={{ marginBottom: 8 }}>
          {Object.keys(CP_RANGE_SEC).map((r) => (
            <button key={r} type="button" className="sw-btn" style={{ fontSize: 11 }} onClick={() => applyRange('include', r)}>{r}</button>
          ))}
          {(f.fromLocal || f.toLocal) && (
            <button type="button" className="sw-btn" style={{ fontSize: 11 }} onClick={() => { set('fromLocal', ''); set('toLocal', '') }}>Clear include</button>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input type="datetime-local" className="sw-search" style={{ maxWidth: 200 }} value={f.fromLocal || ''} onChange={(e) => set('fromLocal', e.target.value)} />
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>→</span>
          <input type="datetime-local" className="sw-search" style={{ maxWidth: 200 }} value={f.toLocal || ''} onChange={(e) => set('toLocal', e.target.value)} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
          <input type="checkbox" checked={Boolean(f.excludeEnabled)} onChange={(e) => set('excludeEnabled', e.target.checked)} />
          <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Exclude time window</span>
        </label>
        {f.excludeEnabled && (
          <>
            <div className="sw-radio-group" style={{ marginBottom: 8 }}>
              {Object.keys(CP_RANGE_SEC).map((r) => (
                <button key={`ex-${r}`} type="button" className="sw-btn" style={{ fontSize: 11 }} onClick={() => applyRange('exclude', r)}>{r}</button>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input type="datetime-local" className="sw-search" style={{ maxWidth: 200 }} value={f.excludeFromLocal || ''} onChange={(e) => set('excludeFromLocal', e.target.value)} />
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>→</span>
              <input type="datetime-local" className="sw-search" style={{ maxWidth: 200 }} value={f.excludeToLocal || ''} onChange={(e) => set('excludeToLocal', e.target.value)} />
            </div>
          </>
        )}

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" checked={Boolean(f.bhEnabled)} onChange={(e) => set('bhEnabled', e.target.checked)} />
            <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Business hours only</span>
            <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>(applies to include & exclude windows)</span>
          </label>
          {f.bhEnabled && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <input type="time" className="sw-search" style={{ maxWidth: 110, fontSize: 11 }} value={f.bhStart || '09:00'} onChange={(e) => set('bhStart', e.target.value)} />
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>to</span>
                <input type="time" className="sw-search" style={{ maxWidth: 110, fontSize: 11 }} value={f.bhEnd || '18:00'} onChange={(e) => set('bhEnd', e.target.value)} />
                <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>(local)</span>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {BH_DAY_LABELS.map((label, day) => {
                  const active = Array.isArray(f.bhDays) ? f.bhDays.includes(day) : false
                  return (
                    <button
                      key={label}
                      type="button"
                      className={`sw-bh-day${active ? ' on' : ''}`}
                      onClick={() => toggleBhDay(day)}
                    >{label}</button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="sw-btn sw-btn-primary" onClick={onSearch} disabled={loading || presetsLoading}>
          {loading ? <><span className="sw-spinner" /> Applying…</> : 'Apply filters'}
        </button>
        {results != null && !loading && (
          <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700 }}>
            {results.length} node{results.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {results != null && (
        <div className="sw-cp-print-root" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="sw-cp-print-header" style={{ display: 'none' }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>SolarWinds — Custom property report</h2>
            <div style={{ fontSize: 11, color: '#555' }}>
              Generated {new Date().toLocaleString()} · {results.length} node{results.length !== 1 ? 's' : ''}
              {f.bhEnabled ? ` · Business hours ${f.bhStart || '09:00'}–${f.bhEnd || '18:00'}` : ''}
            </div>
          </div>

          {results.length > 0 && (
            <Widget title="Summary">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, alignItems: 'stretch' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 6 }}>STATUS DISTRIBUTION</div>
                  <div style={{ width: '100%', height: 180 }}>
                    <Doughnut data={statusDoughnut} options={doughnutOpts} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 6 }}>BANDWIDTH BUCKETS</div>
                  <div style={{ width: '100%', height: 180 }}>
                    <Doughnut data={bandwidthDoughnut} options={doughnutOpts} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
                  <KpiCard
                    label="Avg uptime"
                    value={summary.avgUptime != null ? fmtPct(summary.avgUptime) : '—'}
                    sub={summary.uptimeSampled ? 'sampled from Orion.ResponseTime' : 'derived from current status'}
                  />
                  <KpiCard
                    label="Avg bandwidth"
                    value={summary.avgBandwidth != null ? fmtPct(summary.avgBandwidth) : '—'}
                    sub="mean PercentUtil across interfaces"
                  />
                </div>
              </div>
            </Widget>
          )}

          <Widget title={`Results (${results.length})`}>
            <div className="sw-cp-actions sw-no-print" style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <button type="button" className="sw-btn" onClick={exportPdf} disabled={!results.length}>Export PDF</button>
              <button type="button" className="sw-btn" onClick={exportCsv} disabled={!results.length}>Export CSV</button>
            </div>
            <div className="sw-table-wrap">
              {results.length === 0 ? (
                <div className="sw-empty">No nodes matched. Try &quot;All&quot; on one dimension or clear time filters.</div>
              ) : (
                <table className="sw-table">
                  <thead><tr>
                    <th>Status</th><th>Name</th><th>IP</th>
                    <th>Uptime</th><th>Bandwidth</th>
                    <th>Link</th><th>Org</th><th>Dept</th>
                    <th>If1</th><th>Carrier</th><th>If2</th>
                  </tr></thead>
                  <tbody>
                    {results.map((n) => (
                      <tr key={n.id} className={onNodeClick ? 'sw-row-click' : undefined}
                        onClick={onNodeClick ? () => onNodeClick(n) : undefined}
                        title={onNodeClick ? 'Open device snapshot' : undefined}>
                        <td><Pill label={n.status} /></td>
                        <td style={{ fontWeight: 600, color: 'var(--accent)' }}>{n.name}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{n.ip || '—'}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: Number.isFinite(n.uptimePct) && n.uptimePct < 95 ? 'var(--amber)' : undefined }} title={n.uptimeSampled ? 'Average availability over selected window' : 'Derived from current node status (no time window)'}>
                          {fmtPct(n.uptimePct)}
                          {n.uptimeSampled && <span style={{ fontSize: 9, marginLeft: 4, color: 'var(--text3)' }}>•</span>}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: Number.isFinite(n.bandwidthPct) && n.bandwidthPct > 50 ? 'var(--amber)' : undefined }} title={Number.isFinite(n.bandwidthPeakPct) ? `Peak ${n.bandwidthPeakPct.toFixed(1)}%` : undefined}>
                          {fmtPct(n.bandwidthPct)}
                        </td>
                        <td style={{ fontSize: 11 }}>{n.nodeCp?.DUAL_LINKS ?? '—'}</td>
                        <td style={{ fontSize: 11 }}>{n.nodeCp?.ORGANIZATION ?? '—'}</td>
                        <td style={{ fontSize: 11 }}>{n.nodeCp?.Department ?? '—'}</td>
                        <td style={{ fontSize: 11 }}>{n.interface1?.name || '—'}</td>
                        <td style={{ fontSize: 11, color: 'var(--text3)' }}>{n.interface1?.cp?.CarrierName ?? '—'}</td>
                        <td style={{ fontSize: 11 }}>{n.interface2?.name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Widget>
        </div>
      )}
    </div>
  )
}

function AlertsTab({ alerts, loading, onRefresh, severityFilter, onSeverityFilterChange, onAlertClick }) {
  const sevF = severityFilter ?? 'all'
  const setSevF = onSeverityFilterChange ?? (() => {})
  const filtered = useMemo(() => {
    return (alerts || []).filter((a) => sevF === 'all' || a.severity === sevF)
  }, [alerts, sevF])

  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'severityCode', 'desc')

  const th = (key, label) => (
    <th onClick={() => toggleSort(key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label} <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
    </th>
  )

  return (
    <div className="sw-fade">
      <div className="sw-toolbar">
        <select className="sw-select" value={sevF} onChange={(e) => setSevF(e.target.value)}>
          <option value="all">All severities</option>
          <option value="Critical">Critical</option>
          <option value="High">High</option>
          <option value="Warning">Warning</option>
          <option value="Information">Information</option>
        </select>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', marginLeft: 4 }}>
          {sorted.length} alert{sorted.length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="sw-btn" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="sw-spinner" /> : '↻'} Refresh
        </button>
      </div>

      <div className="sw-widget">
        <div className="sw-table-wrap">
          {sorted.length === 0 ? (
            <div className="sw-empty">{loading ? 'Loading…' : 'No active alerts'}</div>
          ) : (
            <table className="sw-table">
              <thead><tr>
                {th('severityCode', 'Severity')}
                {th('name', 'Alert Name')}
                {th('objectName', 'Object')}
                {th('objectType', 'Type')}
                {th('count', 'Count')}
                {th('lastTriggered', 'Triggered')}
                <th>Age</th>
              </tr></thead>
              <tbody>
                {sorted.map((a) => (
                  <tr
                    key={a.id}
                    className="sw-row-click"
                    onClick={() => onAlertClick?.(a)}
                    title="View alert and node details"
                  >
                    <td><Pill label={a.severity} /></td>
                    <td style={{ fontWeight: 600, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>{a.objectName || '—'}</td>
                    <td style={{ color: 'var(--text3)', fontSize: 11 }}>{a.objectType || '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{a.count}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>{fmtDate(a.lastTriggered)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>{relAge(a.lastTriggered)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function EventsTab({ events, loading, onRefresh }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    if (!q) return events || []
    const ql = q.toLowerCase()
    return (events || []).filter((e) =>
      e.message?.toLowerCase().includes(ql) || e.node?.toLowerCase().includes(ql)
    )
  }, [events, q])

  return (
    <div className="sw-fade">
      <div className="sw-toolbar">
        <input className="sw-search" type="search" placeholder="Filter by node or message…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', marginLeft: 4 }}>
          {filtered.length} event{filtered.length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="sw-btn" onClick={onRefresh} disabled={loading}>
          {loading ? <span className="sw-spinner" /> : '↻'} Refresh
        </button>
      </div>

      <div className="sw-widget">
        <div className="sw-table-wrap">
          {filtered.length === 0 ? (
            <div className="sw-empty">{loading ? 'Loading…' : 'No events'}</div>
          ) : (
            <table className="sw-table">
              <thead><tr>
                <th>Time</th>
                <th>Age</th>
                <th>Node</th>
                <th>Type</th>
                <th>Message</th>
                <th>Ack</th>
              </tr></thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={e.id ?? i}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{fmtDate(e.time)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{relAge(e.time)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>{e.node || '—'}</td>
                    <td style={{ color: 'var(--text3)', fontSize: 11 }}>{e.type || '—'}</td>
                    <td style={{ color: 'var(--text2)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.message}>{e.message}</td>
                    <td style={{ textAlign: 'center' }}>
                      {e.acknowledged
                        ? <span style={{ color: '#22d3a0', fontSize: 12 }}>✓</span>
                        : <span style={{ color: 'var(--border2)', fontSize: 12 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── main page ────────────────────────────────────────────────────────────── */
export default function SolarWindsPage() {
  const [tab, setTab]           = useUrlTab('overview', TABS)
  const [config, setConfig]     = useState(null)
  const [overview, setOverview] = useState(null)
  const [nodes, setNodes]       = useState(null)
  const [alerts, setAlerts]     = useState(null)
  const [events, setEvents]     = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [nodeSearch, setNodeSearch] = useState('')
  const [nodesStatusFilter, setNodesStatusFilter] = useState('all')
  const [alertsSeverityFilter, setAlertsSeverityFilter] = useState('all')
  const [cpPresets, setCpPresets] = useState(null)
  const [cpPresetsLoaded, setCpPresetsLoaded] = useState(false)
  const [cpResults, setCpResults] = useState(null)
  const [cpFilters, setCpFilters] = useState({
    link: 'all', carrier: 'all',
    uptime: 'all', bandwidth: 'all',
    fromLocal: '', toLocal: '', excludeEnabled: false,
    excludeFromLocal: '', excludeToLocal: '',
    bhEnabled: false, bhStart: '09:00', bhEnd: '18:00', bhDays: [1, 2, 3, 4, 5],
  })
  const [loading, setLoading]   = useState(false)
  const [tabBusy, setTabBusy]   = useState(false)
  const [error, setError]       = useState(null)
  const [reachable, setReachable] = useState(null)   // null=unknown, true/false from API
  const [reachTip, setReachTip]   = useState(null)
  const [alertDetail, setAlertDetail] = useState(null)

  const configured = config?.configured

  function applyReachability(data) {
    if (data == null) return
    if (typeof data.reachable === 'boolean') setReachable(data.reachable)
    if (data.tip)   setReachTip(data.tip)
    if (data.error && data.reachable === false) setError(data.error)
  }

  const loadConfig = useCallback(async () => {
    const { data } = await api.get('/api/solarwinds/config')
    setConfig(data)
    return data
  }, [])

  const loadOverview = useCallback(async () => {
    const { data } = await api.get('/api/solarwinds/overview')
    applyReachability(data)
    setOverview(data)
  }, [])

  const loadNodes = useCallback(async () => {
    const { data } = await api.get('/api/solarwinds/nodes')
    applyReachability(data)
    setNodes(data.nodes)
  }, [])

  const loadAlerts = useCallback(async () => {
    const { data } = await api.get('/api/solarwinds/alerts')
    applyReachability(data)
    setAlerts(data.alerts)
  }, [])

  const loadEvents = useCallback(async () => {
    const { data } = await api.get('/api/solarwinds/events?limit=200')
    applyReachability(data)
    setEvents(data.events)
  }, [])

  const loadCpPresets = useCallback(async () => {
    const { data } = await api.get('/api/solarwinds/custom-properties/presets')
    applyReachability(data)
    setCpPresets(data.presets || {})
    setCpPresetsLoaded(true)
    return data.presets
  }, [])

  const buildCpSearchParams = useCallback((f, presetMap) => {
    const p = presetMap || cpPresets || {}
    const params = {}
    if (f.link && f.link !== 'all' && p.link?.field) {
      params.nodeProp1 = p.link.field
      params.nodeVal1 = f.link
    }
    if (f.carrier && f.carrier !== 'all' && p.carrier?.field) {
      params.ifaceProp1 = p.carrier.field
      params.ifaceVal1 = f.carrier
    }
    if (f.uptime && f.uptime !== 'all') params.status = f.uptime
    if (f.bandwidth && f.bandwidth !== 'all') params.bandwidth = f.bandwidth
    if (f.fromLocal && f.toLocal) {
      params.from = new Date(f.fromLocal).toISOString()
      params.to = new Date(f.toLocal).toISOString()
    }
    if (f.excludeEnabled && f.excludeFromLocal && f.excludeToLocal) {
      params.excludeFrom = new Date(f.excludeFromLocal).toISOString()
      params.excludeTo = new Date(f.excludeToLocal).toISOString()
    }
    if (f.bhEnabled) {
      params.bhEnabled = '1'
      if (f.bhStart) params.bhStart = f.bhStart
      if (f.bhEnd) params.bhEnd = f.bhEnd
      if (Array.isArray(f.bhDays) && f.bhDays.length) params.bhDays = f.bhDays.join(',')
      params.bhTzOffsetMin = -new Date().getTimezoneOffset()
    }
    return params
  }, [cpPresets])

  const searchCustomProperties = useCallback(async (filtersOverride) => {
    const f = filtersOverride || cpFilters
    setTabBusy(true)
    setError(null)
    try {
      const params = buildCpSearchParams(f)
      const { data } = await api.get('/api/solarwinds/custom-properties/nodes', { params })
      applyReachability(data)
      setCpResults(data.nodes || [])
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Custom property search failed')
      setCpResults([])
    } finally {
      setTabBusy(false)
    }
  }, [cpFilters, buildCpSearchParams])

  const loadSnapshot = useCallback(async (nodeId) => {
    const { data } = await api.get(`/api/solarwinds/nodes/${nodeId}/snapshot`)
    applyReachability(data)
    if (data.found === false) {
      setError('Node not found in Orion')
      setSnapshot(null)
      return
    }
    setSnapshot(data)
    if (data.node) setSelectedNode(data.node)
  }, [])

  const openAlertDetail = useCallback(async (alert) => {
    setAlertDetail({ loading: true, error: null, alert })
    try {
      const { data } = await api.get('/api/solarwinds/alerts/detail', {
        params: {
          alertId: alert.alertId,
          object: alert.message || alert.objectName || '',
        },
      })
      setAlertDetail({
        loading: false,
        error: data.found === false ? 'Alert not found in Orion' : null,
        alert: data.alert || alert,
      })
    } catch (e) {
      setAlertDetail({
        loading: false,
        error: e.response?.data?.error || e.message || 'Failed to load alert detail',
        alert,
      })
    }
  }, [])

  const closeAlertDetail = useCallback(() => setAlertDetail(null), [])

  const runTab = useCallback(async (t) => {
    setTabBusy(true)
    setError(null)
    try {
      if (t === 'overview') await loadOverview()
      if (t === 'nodes')    await loadNodes()
      if (t === 'alerts')   await loadAlerts()
      if (t === 'events')   await loadEvents()
      if (t === 'snapshot') {
        if (nodes === null) await loadNodes()
        if (selectedNode?.id) await loadSnapshot(selectedNode.id)
      }
      if (t === 'custom' && !cpPresetsLoaded) {
        await loadCpPresets()
        await searchCustomProperties(cpFilters)
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load data')
    } finally {
      setTabBusy(false)
    }
  }, [loadOverview, loadNodes, loadAlerts, loadEvents, loadSnapshot, loadCpPresets, searchCustomProperties, nodes, selectedNode, cpPresetsLoaded, cpFilters])

  const goToSnapshot = useCallback(async (node) => {
    setTab('snapshot')
    setSelectedNode(node)
    setSnapshot(null)
    setTabBusy(true)
    setError(null)
    try {
      if (nodes === null) await loadNodes()
      await loadSnapshot(node.id)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load device snapshot')
    } finally {
      setTabBusy(false)
    }
  }, [loadNodes, loadSnapshot, nodes])

  const goToNodesFilter = useCallback(async (status) => {
    setNodesStatusFilter(status)
    setTab('nodes')
    setError(null)
    if (nodes === null) {
      setTabBusy(true)
      try {
        await loadNodes()
      } catch (e) {
        setError(e.response?.data?.error || e.message || 'Failed to load nodes')
      } finally {
        setTabBusy(false)
      }
    }
  }, [nodes, loadNodes])

  const goToAlertsFilter = useCallback(async (severity) => {
    setAlertsSeverityFilter(severity)
    setTab('alerts')
    setError(null)
    if (alerts === null) {
      setTabBusy(true)
      try {
        await loadAlerts()
      } catch (e) {
        setError(e.response?.data?.error || e.message || 'Failed to load alerts')
      } finally {
        setTabBusy(false)
      }
    }
  }, [alerts, loadAlerts])

  const pickSnapshotNode = useCallback(async (node) => {
    setSelectedNode(node)
    setSnapshot(null)
    setTabBusy(true)
    setError(null)
    try {
      await loadSnapshot(node.id)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load device snapshot')
    } finally {
      setTabBusy(false)
    }
  }, [loadSnapshot])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const cfg = await loadConfig()
      if (!cfg.configured) return
      await runTab(tab)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [loadConfig, runTab, tab])

  // Initial load: config + overview
  useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load tab data when Orion becomes configured or user switches tabs.
  // (Do not track "previous tab" — if the user switches before config loads,
  // a prev-tab guard would skip the fetch forever.)
  useEffect(() => {
    if (!configured) return
    const loaded = {
      overview: overview != null,
      nodes: nodes !== null,
      alerts: alerts !== null,
      events: events !== null,
      snapshot: nodes !== null && (!selectedNode || snapshot != null),
      custom: cpPresetsLoaded,
    }
    if (!loaded[tab]) runTab(tab)
  }, [tab, configured, overview, nodes, alerts, events, snapshot, selectedNode, cpPresetsLoaded, runTab])

  const selectTab = useCallback((id) => {
    setTab(id)
    if (configured) {
      const loaded = {
        overview: overview != null,
        nodes: nodes !== null,
        alerts: alerts !== null,
        events: events !== null,
        snapshot: nodes !== null && (!selectedNode || snapshot != null),
        custom: cpPresetsLoaded,
      }
      if (!loaded[id]) runTab(id)
    }
  }, [configured, overview, nodes, alerts, events, snapshot, selectedNode, cpPresetsLoaded, runTab])

  // Auto-refresh every 60s for overview / alerts when tab is visible
  useSmartPolling(
    useCallback(() => {
      if (!configured) return
      if (tab === 'overview') loadOverview().catch(() => {})
      if (tab === 'alerts')   loadAlerts().catch(() => {})
    }, [configured, tab, loadOverview, loadAlerts]),
    60_000,
    [configured, tab],
    { skipImmediate: true },
  )

  const openExternalOrion = useCallback(() => {
    if (!config?.orionUrl) return
    window.open(config.orionUrl, '_blank', 'noopener,noreferrer')
  }, [config])

  const totalAlerts = alerts?.length ?? overview?.alerts?.total ?? null

  return (
    <div className="sw-page">
      <style>{CSS}</style>

      {/* ── Header ── */}
      <div className="sw-header">
        <div className="sw-header-title">
          <span className="sw-dot" style={{ background: configured ? '#22d3a0' : config ? '#f5534f' : '#555a72' }} />
          <div>
            <h1>SolarWinds Orion</h1>
            <p className="sw-header-sub">
              {!config ? 'Connecting…'
                : !configured ? 'Not configured — set ORION_USERNAME + ORION_PASSWORD in server .env'
                : `${config.orionUrl} · NPM / NTA / SAM`}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {loading && <span className="sw-spinner" />}
          <button type="button" className="sw-btn" onClick={openExternalOrion} disabled={!config?.orionUrl}>
            Open Orion ↗
          </button>
          <button type="button" className="sw-btn sw-btn-primary" onClick={refresh} disabled={loading || tabBusy}>
            {loading || tabBusy ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && reachable !== false && <div className="sw-err">{error}</div>}

      {/* ── Orion unreachable banner ── */}
      {reachable === false && (
        <div style={{
          padding: '14px 18px', borderRadius: 12, marginBottom: 12,
          border: '1px solid rgba(245,166,35,.45)', background: 'rgba(245,166,35,.07)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>⚠</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--amber, #f5a623)' }}>
              Orion server unreachable
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
            {error && <div style={{ marginBottom: 6, color: 'var(--red, #f5534f)' }}>{error}</div>}
            Data comes from the <strong style={{ color: 'var(--text)' }}>SWIS API</strong> (usually port <strong>17774</strong>, not the web UI port {config?.port ?? '8787'}).
            Restart the API after changing <code style={{ color: 'var(--cyan)' }}>server/.env</code>.
          </div>
          {reachTip && (
            <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
              {reachTip}
            </div>
          )}
          <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', lineHeight: 1.7 }}>
            <div>Fix steps:</div>
            <div>1. Open <code style={{ color: 'var(--cyan)', background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>/api/solarwinds/diagnostic</code> while logged in — it shows which URL/method works.</div>
            <div>2. Set <code style={{ color: 'var(--cyan)', background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>ORION_SWIS_URL=https://{config?.host ?? '192.168.10.100'}:17774/SolarWinds/InformationService/v3/Json</code></div>
            <div>3. Self-signed HTTPS: <code style={{ color: 'var(--cyan)', background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>ORION_TLS_INSECURE=true</code></div>
            <div>4. User must exist in Orion → Manage Accounts (same as web login).</div>
          </div>
        </div>
      )}

      {/* ── Not configured ── */}
      {config && !configured && (
        <div className="sw-widget"><div className="sw-not-cfg">
          <p>SolarWinds Orion integration is not configured.</p>
          <p>Add the following to <code>server/.env</code> and restart the API:</p>
          <p>
            <code>ORION_WEB_URL=http://192.168.10.100:8787</code><br />
            <code>ORION_USERNAME=your_orion_username</code><br />
            <code>ORION_PASSWORD=your_orion_password</code>
          </p>
        </div></div>
      )}

      {/* ── Tabs ── */}
      {configured && (
        <>
          <div className="sw-tabs">
            {TABS.map((t) => {
              const badge = t.id === 'alerts'
                ? (totalAlerts || null)
                : t.id === 'nodes'
                  ? (overview?.nodes?.total || null)
                  : null
              return (
                <button key={t.id} type="button"
                  className={`sw-tab${tab === t.id ? ' active' : ''}`}
                  onClick={() => selectTab(t.id)}
                >
                  <span style={{ fontSize: 13, opacity: .9 }}>{t.icon}</span>
                  {t.label}
                  {badge != null && badge !== 0 && (
                    <span className="sw-tab-badge">{badge}</span>
                  )}
                </button>
              )
            })}
          </div>

          {tabBusy && tab !== 'overview' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
              <span className="sw-spinner" /> Loading {tab}…
            </div>
          )}

          {tab === 'overview' && (
            <OverviewTab
              overview={overview}
              openExternalOrion={openExternalOrion}
              nodesStatusFilter={nodesStatusFilter}
              onFilterNodes={goToNodesFilter}
              onFilterAlerts={goToAlertsFilter}
            />
          )}
          {tab === 'nodes' && (
            <NodesTab
              nodes={nodes}
              loading={tabBusy}
              onRefresh={() => runTab('nodes')}
              onNodeClick={goToSnapshot}
              statusFilter={nodesStatusFilter}
              onStatusFilterChange={setNodesStatusFilter}
            />
          )}
          {tab === 'custom' && (
            <CustomPropertiesTab
              presets={cpPresets}
              presetsLoading={!cpPresetsLoaded && tabBusy}
              results={cpResults}
              loading={tabBusy}
              filters={cpFilters}
              onFiltersChange={setCpFilters}
              onSearch={() => searchCustomProperties()}
              onNodeClick={goToSnapshot}
            />
          )}
          {tab === 'snapshot' && (
            <DeviceSnapshotTab
              nodes={nodes}
              nodesLoading={tabBusy && nodes == null}
              selectedNode={selectedNode}
              snapshot={snapshot}
              snapshotBusy={tabBusy}
              nodeSearch={nodeSearch}
              onNodeSearch={setNodeSearch}
              onPickNode={pickSnapshotNode}
              onRefresh={() => selectedNode && pickSnapshotNode(selectedNode)}
              onAlertClick={openAlertDetail}
            />
          )}
          {tab === 'alerts' && (
            <AlertsTab
              alerts={alerts}
              loading={tabBusy}
              onRefresh={() => runTab('alerts')}
              severityFilter={alertsSeverityFilter}
              onSeverityFilterChange={setAlertsSeverityFilter}
              onAlertClick={openAlertDetail}
            />
          )}
          {tab === 'events' && (
            <EventsTab events={events} loading={tabBusy} onRefresh={() => runTab('events')} />
          )}
        </>
      )}

      <AlertDetailModal
        detail={alertDetail}
        onClose={closeAlertDetail}
      />
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'
import api from '../../api/client'
import { useSmartPolling } from '../../hooks/useSmartPolling.js'
import { useUrlTab } from '../../hooks/useUrlTab.js'
import { useThemeStore } from '../../store/themeStore.js'
import { getThemeCssColors } from '../../utils/themeCssColors.js'
import { useAuthStore } from '../../store/authStore.js'
import { resolvedApiBase } from '../../utils/backendOrigin.js'

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip)

/* ─── constants ──────────────────────────────────── */
const TABS = [
  { id: 'noc',       label: 'NOC Overview', icon: '🖥' },
  { id: 'stores',    label: 'Stores',       icon: '🏪' },
  { id: 'problems',  label: 'Problems',     icon: '⚠' },
  { id: 'netHealth', label: 'Net Health',   icon: '📶' },
  { id: 'detail',    label: 'Store Detail', icon: '🔍' },
  { id: 'reports',   label: 'Reports',      icon: '📊' },
  { id: 'alerts',    label: 'Alert Rules',  icon: '🔔' },
]

const REPORT_TYPES = [
  { key: 'inventory',    label: 'Store Inventory',      icon: '🏪', desc: 'Full store list with connectivity, ping, CPU, RAM and speedtest data for all stores.' },
  { key: 'uptime',       label: 'Uptime Report',        icon: '⏱', desc: 'Online/offline status per store and group. Highlights stores that went offline during the period.' },
  { key: 'issues',       label: 'Issues Report',        icon: '⚠',  desc: 'All active issues with severity, issue code, affected store and last-seen time.' },
  { key: 'connectivity', label: 'Connectivity Report',  icon: '🌐', desc: 'Connectivity state breakdown (LAN/Wi-Fi/ISP Down/Hotspot) per store and as summary.' },
  { key: 'speedtest',    label: 'Speedtest Report',     icon: '⚡', desc: 'Download & upload speeds sorted by performance. Group averages included.' },
]

const TIME_RANGES = [
  { key: '-1h',  label: '1 Hour' },
  { key: '-3h',  label: '3 Hours' },
  { key: '-6h',  label: '6 Hours' },
  { key: '-12h', label: '12 Hours' },
  { key: '-24h', label: '24 Hours' },
  { key: '-2d',  label: '2 Days' },
  { key: '-7d',  label: '7 Days' },
]
const HISTORY_SECS = { '-1h': 3600, '-3h': 10800, '-6h': 21600, '-12h': 43200, '-24h': 86400, '-2d': 172800, '-7d': 604800 }

const CONN_COLORS = {
  lan_healthy: '#22c55e', wifi_healthy: '#06b6d4', hotspot: '#f97316',
  isp_down: '#ef4444', no_connectivity: '#dc2626', unknown: '#475569',
}
const CONN_LABELS = {
  lan_healthy: 'LAN Healthy', wifi_healthy: 'Wi-Fi Healthy', hotspot: 'Hotspot',
  isp_down: 'ISP Down', no_connectivity: 'No Connectivity', unknown: 'Unknown',
}
const SEV_COLORS   = { critical: '#ef4444', high: '#f97316', warning: '#eab308', ok: '#22c55e' }
const GROUP_DEFS   = [
  { id: 'SD-WAN Group',    color: '#8b5cf6', icon: '🛡' },
  { id: 'RP Group',        color: '#06b6d4', icon: '📡' },
  { id: 'POS System Group',color: '#22c55e', icon: '🛒' },
  { id: 'General Group',   color: '#64748b', icon: '🏢' },
]
const GROUP_MAP = Object.fromEntries(GROUP_DEFS.map((g) => [g.id, g]))

const METRIC_OPTS = [
  { value: 'offline',       label: 'Device Offline' },
  { value: 'isp_down',      label: 'ISP Down' },
  { value: 'hotspot',       label: 'Hotspot Detected' },
  { value: 'packet_loss',   label: 'Packet Loss (%)' },
  { value: 'latency',       label: 'Latency (ms)' },
  { value: 'cpu',           label: 'CPU Usage (%)' },
  { value: 'memory',        label: 'Memory Usage (%)' },
  { value: 'download_mbps', label: 'Download Speed (Mbps)' },
  { value: 'upload_mbps',   label: 'Upload Speed (Mbps)' },
  { value: 'dns_fail',      label: 'DNS Failure' },
  { value: 'http_fail',     label: 'HTTP Failure' },
]
const BOOLEAN_METRICS = new Set(['offline', 'isp_down', 'hotspot', 'dns_fail', 'http_fail'])

/* ─── helpers ────────────────────────────────────── */
function deriveGroup(hostname, vendor, isFortinet) {
  const h = String(hostname || '').toUpperCase()
  const v = String(vendor || '').toLowerCase()
  if (isFortinet || v.includes('fortinet')) return 'SD-WAN Group'
  if (h.startsWith('RP')) return 'RP Group'
  if (h.startsWith('LK')) return 'POS System Group'
  return 'General Group'
}

function relAge(iso) {
  if (!iso) return '—'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(d) || d < 0) return '—'
  if (d < 60) return `${d}s`; if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`
  return `${Math.floor(d / 86400)}d`
}
const fmtMs   = (v) => v == null || !Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`
const fmtPct  = (v) => v == null || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(1)}%`
const fmtMbps = (v) => v == null || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(1)} Mbps`
const pct     = (n, d) => (!d ? 0 : Math.round((n / d) * 1000) / 10)
const primaryPing = (s) => s?.ping?.['8.8.8.8'] || s?.ping?.['google.com'] || Object.values(s?.ping || {})[0]

function chartOpts(tc, extras = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: tc.text2, boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: tc.text3, font: { size: 10 }, maxTicksLimit: 8 }, grid: { color: tc.border } },
      y: { ticks: { color: tc.text3, font: { size: 10 } }, grid: { color: tc.border } },
    },
    ...extras,
  }
}

const PAL = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899']

function buildTimeChart(series, tc, yLabel = '', maxPts = 350) {
  const active = (series || []).filter((s) => (s.points || []).length > 0)
  if (!active.length) return null
  const clockSet = new Set()
  for (const s of active) for (const p of s.points) { const c = Number(p.clock); if (Number.isFinite(c)) clockSet.add(c) }
  let clocks = [...clockSet].sort((a, b) => a - b)
  if (clocks.length > maxPts) { const step = Math.ceil(clocks.length / maxPts); clocks = clocks.filter((_, i) => i % step === 0) }
  const labels = clocks.map((c) => new Date(c * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  const datasets = active.slice(0, 8).map((s, i) => {
    const hex = PAL[i % PAL.length]
    const by = Object.fromEntries((s.points || []).map((p) => [Number(p.clock), Number(p.value)]).filter(([c, v]) => Number.isFinite(c) && Number.isFinite(v)))
    return { label: s.name, data: clocks.map((t) => by[t] ?? null), borderColor: hex, backgroundColor: `${hex}22`, tension: 0.3, spanGaps: true, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, fill: true }
  })
  return { data: { labels, datasets }, yLabel }
}

function applyBusinessHours(series, bh) {
  if (!bh?.enabled) return series
  const { startHour, endHour, weekdays } = bh
  const days = new Set((weekdays || []).map(Number))
  return (series || []).map((s) => ({
    ...s,
    points: (s.points || []).filter((p) => {
      const d = new Date(Number(p.clock) * 1000)
      if (!days.has(d.getDay())) return false
      const h = d.getHours()
      if (startHour <= endHour) return h >= startHour && h < endHour
      return h >= startHour || h < endHour
    }),
  }))
}

const BH_DAYS = [
  { val: 0, label: 'Sun' }, { val: 1, label: 'Mon' }, { val: 2, label: 'Tue' },
  { val: 3, label: 'Wed' }, { val: 4, label: 'Thu' }, { val: 5, label: 'Fri' }, { val: 6, label: 'Sat' },
]

/* ─── CSS ─────────────────────────────────────────── */
const CSS = `
/* ── design tokens ── */
:root {
  --sm-r: 8px; --sm-r-lg: 12px;
  --sm-border: var(--border);
  --sm-shadow: 0 1px 3px rgba(0,0,0,.18), 0 4px 16px rgba(0,0,0,.12);
}

/* ── page shell ── */
.sm { display:flex; flex-direction:column; min-height:0; font-size:12.5px; color:var(--text); line-height:1.5; }

/* ── page header ── */
.sm-hd { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;
  padding:10px 0 9px; border-bottom:1px solid var(--border); margin-bottom:10px; }
.sm-title { margin:0; font-size:16px; font-weight:700; display:flex; align-items:center; gap:8px; letter-spacing:-.01em; }
.sm-sub { font-size:11px; font-family:var(--mono); color:var(--text3); margin:2px 0 0; letter-spacing:.01em; }
.sm-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
.sm-live { font-size:9px; font-weight:800; padding:2px 6px; border-radius:999px;
  background:rgba(34,197,94,.15); color:#22c55e; border:1px solid rgba(34,197,94,.25); letter-spacing:.08em; text-transform:uppercase; }

/* ── tabs ── */
.sm-tabs { display:flex; gap:2px; flex-wrap:wrap; margin-bottom:10px;
  background:var(--bg2); border:1px solid var(--border); border-radius:var(--sm-r-lg); padding:3px; }
.sm-tab { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:7px; border:none;
  background:transparent; color:var(--text3); font-size:11.5px; font-weight:600; cursor:pointer;
  transition:all .12s; font-family:var(--sans); white-space:nowrap; }
.sm-tab:hover { background:var(--bg3); color:var(--text2); }
.sm-tab.active { background:var(--accent); color:#fff; box-shadow:0 1px 6px rgba(79,126,245,.4); }
.sm-badge-count { background:rgba(255,255,255,.22); color:#fff; font-size:9px; font-weight:800;
  border-radius:999px; min-width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center; padding:0 3px; }
.sm-badge-count-red { background:#ef4444; color:#fff; font-size:9px; font-weight:800;
  border-radius:999px; min-width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center; padding:0 3px; }

/* ── cards / widgets ── */
.sm-tr { background:var(--bg2); border:1px solid var(--border); border-radius:var(--sm-r-lg); overflow:hidden; }
.sm-tr-hd { display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:8px 13px 7px; border-bottom:1px solid var(--border); background:var(--bg3); }
.sm-tr-title { font-size:10px; font-family:var(--mono); font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--text2); }
.sm-tr-body { padding:12px 14px; }

/* ── grids ── */
.sm-g2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:10px; }
.sm-g3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:9px; }
.sm-g4 { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:9px; }
.sm-section-mb { margin-bottom:12px; }

/* ── KPI cards ── */
.sm-kpi { background:var(--bg2); border:1px solid var(--border); border-radius:var(--sm-r);
  padding:11px 13px; display:flex; flex-direction:column; gap:3px; }
.sm-kpi-label { font-size:9.5px; font-family:var(--mono); color:var(--text3); text-transform:uppercase; letter-spacing:.07em; }
.sm-kpi-val { font-size:22px; font-weight:700; line-height:1.1; letter-spacing:-.01em; }
.sm-kpi-sub { font-size:10px; font-family:var(--mono); color:var(--text3); margin-top:1px; }

/* ── tables ── */
.sm-tbl-wrap { overflow:auto; border-radius:var(--sm-r); border:1px solid var(--border); }
.sm-tbl { width:100%; border-collapse:collapse; font-size:12px; }
.sm-tbl th { text-align:left; padding:6px 10px; background:var(--bg3); color:var(--text3);
  border-bottom:1px solid var(--border); white-space:nowrap; position:sticky; top:0; z-index:1;
  font-size:9.5px; font-family:var(--mono); letter-spacing:.07em; text-transform:uppercase; font-weight:700; }
.sm-tbl td { padding:6px 10px; border-bottom:1px solid var(--border); color:var(--text); vertical-align:middle; line-height:1.4; }
.sm-tbl tr:last-child td { border-bottom:none; }
.sm-tbl tr.clickable { transition:background .07s; }
.sm-tbl tr.clickable:hover td { background:var(--bg3); cursor:pointer; }

/* ── inline elements ── */
.sm-badge { display:inline-flex; align-items:center; gap:3px; padding:2px 7px; border-radius:999px;
  font-size:9.5px; font-weight:700; font-family:var(--mono); text-transform:uppercase; white-space:nowrap; letter-spacing:.04em; }
.sm-pill { display:inline-block; padding:1px 7px; border-radius:5px;
  font-size:10px; font-weight:600; font-family:var(--mono); white-space:nowrap; letter-spacing:.02em; }
.sm-status-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
.sm-online  { background:#22c55e; }
.sm-offline { background:#ef4444; }

/* ── alerts ── */
.sm-err  { background:rgba(239,68,68,.06); border:1px solid rgba(239,68,68,.2); color:var(--red);
  padding:9px 13px; border-radius:var(--sm-r); margin-bottom:10px; font-size:12px; }
.sm-info { background:rgba(59,130,246,.06); border:1px solid rgba(59,130,246,.18); color:var(--accent);
  padding:9px 13px; border-radius:var(--sm-r); margin-bottom:10px; font-size:12px; }
.sm-empty { padding:36px; text-align:center; color:var(--text3); font-size:12.5px; }

/* ── toolbar ── */
.sm-toolbar { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; align-items:center; }
.sm-input { background:var(--bg2); border:1px solid var(--border); border-radius:7px;
  padding:5px 10px; color:var(--text); font-size:12px; outline:none; transition:border-color .12s; }
.sm-input:focus { border-color:var(--accent); }
.sm-select { background:var(--bg2); border:1px solid var(--border); border-radius:7px;
  padding:5px 9px; color:var(--text); font-size:12px; cursor:pointer; }
.sm-select:focus { outline:none; border-color:var(--accent); }

/* ── buttons ── */
.sm-btn { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:7px;
  border:1px solid var(--border); background:var(--bg3); color:var(--text2);
  font-size:11.5px; font-weight:600; cursor:pointer; transition:all .1s; font-family:var(--sans); white-space:nowrap; }
.sm-btn:hover:not(:disabled) { background:var(--bg4); color:var(--text); border-color:var(--border2); }
.sm-btn:disabled { opacity:.45; cursor:not-allowed; }
.sm-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.sm-btn.primary:hover:not(:disabled) { opacity:.88; }
.sm-btn.danger  { background:rgba(239,68,68,.08); border-color:rgba(239,68,68,.25); color:var(--red); }
.sm-btn.danger:hover:not(:disabled) { background:rgba(239,68,68,.16); }
.sm-btn.sm-sm   { padding:3px 9px; font-size:11px; }

/* ── group cards ── */
.sm-group-card { background:var(--bg2); border:1px solid var(--border); border-radius:var(--sm-r);
  padding:12px 14px; display:flex; flex-direction:column; gap:9px; transition:border-color .15s; }
.sm-group-card:hover { border-color:var(--border2); }
.sm-group-card-hd { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sm-group-name { font-size:12.5px; font-weight:700; display:flex; align-items:center; gap:6px; }
.sm-group-stats { display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; }
.sm-group-stat { text-align:center; background:var(--bg3); border-radius:6px; padding:5px 2px; }
.sm-group-stat-val { font-size:17px; font-weight:700; line-height:1.1; }
.sm-group-stat-label { font-size:9px; font-family:var(--mono); color:var(--text3); text-transform:uppercase; letter-spacing:.04em; }

/* ── charts ── */
.sm-chart { height:200px; position:relative; }
.sm-chart-tall { height:230px; position:relative; }
.sm-bar { height:5px; border-radius:3px; background:var(--bg3); overflow:hidden; }
.sm-bar-fill { height:100%; border-radius:3px; transition:width .45s ease; }

/* ── business hours ── */
.sm-bh-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px;
  background:var(--bg2); border:1px solid var(--border); border-radius:var(--sm-r);
  padding:8px 12px; margin-bottom:10px; }
.sm-bh-dayBtn { padding:2px 7px; border-radius:5px; border:1px solid var(--border);
  background:transparent; color:var(--text3); font-size:10.5px; font-weight:600;
  cursor:pointer; font-family:var(--mono); transition:all .1s; }
.sm-bh-dayBtn.on { background:var(--accent); border-color:var(--accent); color:#fff; }

/* ── device snapshot grid ── */
.sm-snapshot-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:6px; }
.sm-snap-item { background:var(--bg3); border:1px solid var(--border); border-radius:7px;
  padding:7px 11px; display:flex; justify-content:space-between; align-items:center; gap:6px; }
.sm-snap-label { font-size:10.5px; font-family:var(--mono); color:var(--text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sm-snap-val { font-size:12px; font-weight:700; font-family:var(--mono); text-align:right; white-space:nowrap; }

/* ── modal ── */
.sm-modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6);
  display:flex; align-items:center; justify-content:center; z-index:200; backdrop-filter:blur(2px); }
.sm-modal { background:var(--bg); border:1px solid var(--border2); border-radius:var(--sm-r-lg);
  padding:20px; width:min(580px,96vw); max-height:90vh; overflow-y:auto;
  display:flex; flex-direction:column; gap:14px; box-shadow:var(--sm-shadow); }
.sm-modal-hd { display:flex; align-items:center; justify-content:space-between; }
.sm-modal-title { font-size:14px; font-weight:700; margin:0; }
.sm-modal-x { background:none; border:none; color:var(--text3); cursor:pointer; font-size:17px; line-height:1; padding:0; }
.sm-modal-x:hover { color:var(--text); }

/* ── alert channel list ── */
.sm-ch-list { display:flex; flex-direction:column; gap:7px; }
.sm-ch-item { background:var(--bg2); border:1px solid var(--border); border-radius:8px;
  padding:9px 11px; display:flex; align-items:flex-start; gap:9px; }
.sm-ch-body { flex:1; display:flex; flex-direction:column; gap:5px; }

/* ── forms ── */
.sm-form { display:flex; flex-direction:column; gap:11px; }
.sm-form-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.sm-form-field { display:flex; flex-direction:column; gap:4px; }
.sm-form-label { font-size:9.5px; font-family:var(--mono); color:var(--text2); text-transform:uppercase; letter-spacing:.07em; }

/* ── store picker ── */
.sm-picker-wrap { position:relative; }
.sm-picker-btn { display:flex; align-items:center; gap:7px; min-width:320px; max-width:500px;
  padding:6px 10px; background:var(--bg2); border:1px solid var(--border); border-radius:7px;
  cursor:pointer; font-size:12px; color:var(--text); font-family:var(--sans); transition:border-color .12s; }
.sm-picker-btn:hover,.sm-picker-btn.open { border-color:var(--accent); }
.sm-picker-btn-text { flex:1; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.sm-picker-caret { font-size:9px; color:var(--text3); flex-shrink:0; }
.sm-picker-dropdown { position:absolute; top:calc(100% + 3px); left:0; width:max(100%,400px);
  background:var(--bg); border:1px solid var(--border2); border-radius:var(--sm-r-lg);
  box-shadow:0 8px 40px rgba(0,0,0,.5); z-index:100; overflow:hidden; }
.sm-picker-search-wrap { padding:7px; border-bottom:1px solid var(--border); }
.sm-picker-search { width:100%; box-sizing:border-box; background:var(--bg3); border:1px solid var(--border);
  border-radius:6px; padding:6px 10px; color:var(--text); font-size:12px; outline:none; }
.sm-picker-search:focus { border-color:var(--accent); }
.sm-picker-list { max-height:300px; overflow-y:auto; }
.sm-picker-item { display:flex; align-items:center; gap:7px; padding:6px 11px;
  cursor:pointer; font-size:12px; transition:background .07s; border-bottom:1px solid transparent; }
.sm-picker-item:hover { background:var(--bg3); }
.sm-picker-item.selected { background:rgba(79,126,245,.1); }
.sm-picker-item-name { font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sm-picker-item-meta { font-size:10px; font-family:var(--mono); color:var(--text3); flex-shrink:0; }
.sm-picker-empty { padding:20px; text-align:center; color:var(--text3); font-size:12px; }
.sm-picker-count { padding:4px 11px 6px; font-size:10px; font-family:var(--mono); color:var(--text3); border-top:1px solid var(--border); background:var(--bg2); }
`

/* ─── component ──────────────────────────────────── */
export default function StoreMonitorPage() {
  const theme      = useThemeStore((s) => s.theme)
  const tc         = useMemo(() => getThemeCssColors(theme), [theme])
  const [tab, setTabRaw] = useUrlTab('noc', TABS.map((t) => t.id), 'smtab')
  const [range, setRange] = useState('-24h')
  const [meta, setMeta] = useState(null)
  const [overview, setOverview] = useState(null)
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  /* stores table state */
  const [search, setSearch]           = useState('')
  const [connFilter, setConnFilter]   = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [ifaceFilter, setIfaceFilter] = useState('')
  const [issuesOnly, setIssuesOnly]   = useState(false)
  /* chart-driven filters (clicking doughnut / bar) */
  const [chartConnFilter, setChartConnFilter] = useState('')
  const [chartGroupFilter, setChartGroupFilter] = useState('')

  /* detail */
  const [selectedTag, setSelectedTag] = useState('')
  const [history, setHistory] = useState(null)
  const [histLoading, setHistLoading] = useState(false)
  const [bh, setBh] = useState({ enabled: false, startHour: 9, endHour: 18, weekdays: [1,2,3,4,5] })
  /* searchable store picker */
  const [storeSearch, setStoreSearch] = useState('')
  const [storePickerOpen, setStorePickerOpen] = useState(false)
  const storePickerRef = useRef(null)

  /* reports */
  const [downloading, setDownloading] = useState('')
  const [reportGroup, setReportGroup] = useState('all')

  /* alerts */
  const [alertRules, setAlertRules]     = useState([])
  const [alertModal, setAlertModal]     = useState(null) // null | {rule?}
  const [alertForm, setAlertForm]       = useState(blankRule())
  const [alertSaving, setAlertSaving]   = useState(false)
  const [testResult, setTestResult]     = useState({})

  const setTab = useCallback((id) => {
    setTabRaw(id)
    if (id !== 'detail') setSelectedTag('')
  }, [setTabRaw])

  /* ── close store picker on outside click ── */
  useEffect(() => {
    if (!storePickerOpen) return
    function handle(e) {
      if (storePickerRef.current && !storePickerRef.current.contains(e.target)) {
        setStorePickerOpen(false)
        setStoreSearch('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [storePickerOpen])

  /* ── load meta once ── */
  useEffect(() => { api.get('/api/store-monitor/meta').then((r) => setMeta(r.data)).catch(() => {}) }, [])

  /* ── load overview ── */
  const loadOverview = useCallback(async () => {
    setError('')
    try {
      const { data } = await api.get('/api/store-monitor/overview', { params: { range } })
      setOverview(data)
      if (!selectedTag && data.stores?.length) setSelectedTag(data.stores[0].storeTag)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to fetch data')
    } finally { setLoading(false) }
  }, [range, selectedTag])

  useSmartPolling(loadOverview, 60_000, [range])

  /* ── load problems ── */
  const loadProblems = useCallback(async () => {
    try {
      const { data } = await api.get('/api/store-monitor/problems')
      setProblems(data.problems || [])
    } catch { setProblems([]) }
  }, [])

  useEffect(() => { if (tab === 'problems') loadProblems() }, [tab, loadProblems])

  /* ── load history ── */
  const loadHistory = useCallback(async (tag) => {
    if (!tag) return
    setHistLoading(true)
    try {
      const { data } = await api.get(`/api/store-monitor/stores/${encodeURIComponent(tag)}/history`, {
        params: { rangeSec: HISTORY_SECS[range] || 86400 },
      })
      setHistory(data)
    } catch { setHistory(null) }
    finally { setHistLoading(false) }
  }, [range])

  useEffect(() => { if (tab === 'detail' && selectedTag) loadHistory(selectedTag) }, [tab, selectedTag, loadHistory])

  /* ── load alert rules ── */
  const loadAlerts = useCallback(async () => {
    try { const { data } = await api.get('/api/store-alerts'); setAlertRules(data) }
    catch { setAlertRules([]) }
  }, [])
  useEffect(() => { if (tab === 'alerts') loadAlerts() }, [tab, loadAlerts])

  /* ── derived stores with group ── */
  const stores = useMemo(
    () => (overview?.stores || []).map((s) => ({ ...s, systemGroup: deriveGroup(s.hostname, s.gatewayVendor, s.isFortinet) })),
    [overview?.stores],
  )

  /* merge manual + chart-driven filters (chart filters take priority when set) */
  const activeConnFilter  = chartConnFilter  || connFilter
  const activeGroupFilter = chartGroupFilter || groupFilter

  const filteredStores = useMemo(() => {
    let out = stores
    const q = search.trim().toLowerCase()
    if (q)                out = out.filter((s) => [s.hostname, s.serial, s.gatewayIp, s.storeTag, s.activeSsid].some((v) => String(v || '').toLowerCase().includes(q)))
    if (activeConnFilter) out = out.filter((s) => s.connState === activeConnFilter)
    if (activeGroupFilter)out = out.filter((s) => s.systemGroup === activeGroupFilter)
    if (statusFilter)     out = out.filter((s) => statusFilter === 'online' ? s.online : !s.online)
    if (ifaceFilter)      out = out.filter((s) => {
      const iface = String(s.activeInterface || '').toLowerCase()
      if (ifaceFilter === 'ethernet') return iface === 'ethernet' || iface === 'lan'
      if (ifaceFilter === 'wifi')     return iface === 'wi-fi' || iface === 'wifi' || iface.includes('wireless')
      return true
    })
    if (issuesOnly)       out = out.filter((s) => s.issueCount > 0)
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, search, activeConnFilter, activeGroupFilter, statusFilter, ifaceFilter, issuesOnly])

  /* navigate to Stores tab when a chart filter is applied */
  const applyChartConnFilter = useCallback((key) => {
    setChartConnFilter((prev) => prev === key ? '' : key)
    setTabRaw('stores')
  }, [setTabRaw])

  const applyChartGroupFilter = useCallback((label) => {
    setChartGroupFilter((prev) => prev === label ? '' : label)
    setTabRaw('stores')
  }, [setTabRaw])

  /* ── group summary ── */
  const groupSummary = useMemo(() => {
    const map = {}
    for (const g of GROUP_DEFS) map[g.id] = { ...g, total: 0, online: 0, issues: 0, avgPingMs: 0, pingCount: 0 }
    for (const s of stores) {
      const g = map[s.systemGroup] || map['General Group']
      g.total++
      if (s.online) g.online++
      if ((s.issueCount || 0) > 0) g.issues++
      const p = primaryPing(s)
      if (p?.avgMs != null && Number.isFinite(p.avgMs)) { g.avgPingMs += p.avgMs; g.pingCount++ }
    }
    return GROUP_DEFS.map((gd) => {
      const g = map[gd.id]
      return { ...g, health: pct(g.online, g.total), avgPing: g.pingCount ? g.avgPingMs / g.pingCount : null }
    })
  }, [stores])

  const summary = overview?.summary

  /* ── net health ── */
  const netHealth = useMemo(() => {
    let healthy=0, dnsOk=0, dnsT=0, httpOk=0, httpT=0, latSum=0, latC=0, lossSum=0, lossC=0
    const pingAgg={}, dnsAgg={}, httpAgg={}
    for (const s of stores) {
      if (s.connState==='lan_healthy'||s.connState==='wifi_healthy') healthy++
      for (const [t,p] of Object.entries(s.ping||{})) {
        const c=pingAgg[t]||{lat:0,latC:0,loss:0,lossC:0}
        if(p.avgMs!=null&&Number.isFinite(p.avgMs)){c.lat+=p.avgMs;c.latC++;latSum+=p.avgMs;latC++}
        if(p.packetLossPct!=null&&Number.isFinite(p.packetLossPct)){c.loss+=p.packetLossPct;c.lossC++;lossSum+=p.packetLossPct;lossC++}
        pingAgg[t]=c
      }
      for (const [d,v] of Object.entries(s.dns||{})) {
        const c=dnsAgg[d]||{ok:0,t:0}; c.t++;dnsT++; if(v.success===true){c.ok++;dnsOk++} dnsAgg[d]=c
      }
      for (const [u,v] of Object.entries(s.http||{})) {
        const c=httpAgg[u]||{ok:0,t:0}; c.t++;httpT++; if(v.success===true&&(v.statusCode==null||Number(v.statusCode)<500)){c.ok++;httpOk++} httpAgg[u]=c
      }
    }
    const latRows=Object.entries(pingAgg).map(([t,c])=>({target:t,avgMs:c.latC?c.lat/c.latC:0})).sort((a,b)=>b.avgMs-a.avgMs).slice(0,8)
    const lossRows=Object.entries(pingAgg).map(([t,c])=>({target:t,lossPct:c.lossC?c.loss/c.lossC:0})).sort((a,b)=>b.lossPct-a.lossPct).slice(0,8)
    const dnsRows=Object.entries(dnsAgg).map(([d,c])=>({domain:d,pct:pct(c.ok,c.t),t:c.t}))
    const httpRows=Object.entries(httpAgg).map(([u,c])=>({url:u,pct:pct(c.ok,c.t),t:c.t}))
    return { uptimePct:pct(healthy,stores.length||1), dnsOkPct:pct(dnsOk,dnsT||1), httpOkPct:pct(httpOk,httpT||1),
      avgLatency:latC?latSum/latC:null, avgLoss:lossC?lossSum/lossC:null, latRows, lossRows, dnsRows, httpRows }
  }, [stores])

  /* ── charts ── */
  const connChartKeys = useMemo(() => summary?.connBreakdown ? Object.keys(summary.connBreakdown) : [], [summary])

  const connChart = useMemo(() => {
    if (!summary?.connBreakdown) return null
    const entries = Object.entries(summary.connBreakdown)
    const hasSel = Boolean(chartConnFilter)
    const bgColors = entries.map(([k]) => {
      const base = CONN_COLORS[k] || '#64748b'
      return hasSel ? (k === chartConnFilter ? base : `${base}40`) : base
    })
    const borderColors = entries.map(([k]) => chartConnFilter === k ? '#fff' : 'transparent')
    const borderWidths = entries.map(([k]) => chartConnFilter === k ? 2 : 0)
    return {
      data: {
        labels: entries.map(([k]) => CONN_LABELS[k]||k),
        datasets: [{ data: entries.map(([,v])=>v), backgroundColor: bgColors, borderColor: borderColors, borderWidth: borderWidths, hoverBorderWidth: 3, hoverBorderColor:'#fff' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position:'right', labels:{ color:tc.text2, boxWidth:10, font:{size:10} } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw} stores` } },
        },
        onClick: (_e, elements, chart) => {
          if (!elements.length) return
          const idx = elements[0].index
          const key = entries[idx]?.[0]
          if (key) applyChartConnFilter(key)
        },
      },
    }
  }, [summary, tc, chartConnFilter, applyChartConnFilter])

  const groupHealthChart = useMemo(() => {
    const labels = groupSummary.map((g) => g.id.replace(' Group', ''))
    const hasSel = Boolean(chartGroupFilter)
    const onlineColors  = groupSummary.map((g) => hasSel ? (g.id === chartGroupFilter ? '#22c55e' : '#22c55e40') : '#22c55e88')
    const offlineColors = groupSummary.map((g) => hasSel ? (g.id === chartGroupFilter ? '#ef4444' : '#ef444440') : '#ef444488')
    return {
      data: {
        labels,
        datasets: [
          { label: 'Online',  data: groupSummary.map((g) => g.online),         backgroundColor: onlineColors },
          { label: 'Offline', data: groupSummary.map((g) => g.total - g.online), backgroundColor: offlineColors },
        ],
      },
      options: {
        ...chartOpts(tc, { indexAxis:'y', scales:{ x:{ stacked:true, ticks:{color:tc.text3}, grid:{color:tc.border} }, y:{ stacked:true, ticks:{color:tc.text2}, grid:{display:false} } } }),
        onClick: (_e, elements, chart) => {
          if (!elements.length) return
          const idx = elements[0].index
          const fullLabel = groupSummary[idx]?.id
          if (fullLabel) applyChartGroupFilter(fullLabel)
        },
      },
    }
  }, [groupSummary, tc, chartGroupFilter, applyChartGroupFilter])

  const latChart = useMemo(() => {
    if (!netHealth.latRows.length) return null
    return { data:{ labels:netHealth.latRows.map((r)=>r.target), datasets:[{ label:'Avg Latency (ms)', data:netHealth.latRows.map((r)=>+r.avgMs.toFixed(1)), backgroundColor:'#3b82f688' }] }, options:chartOpts(tc) }
  }, [netHealth, tc])
  const lossChart = useMemo(() => {
    if (!netHealth.lossRows.length) return null
    return { data:{ labels:netHealth.lossRows.map((r)=>r.target), datasets:[{ label:'Packet Loss (%)', data:netHealth.lossRows.map((r)=>+r.lossPct.toFixed(1)), backgroundColor:'#f59e0b88' }] }, options:chartOpts(tc) }
  }, [netHealth, tc])
  const histSeries = useMemo(() => {
    const raw = history?.series || []
    return applyBusinessHours(raw, bh)
  }, [history, bh])

  const pingChart     = useMemo(() => buildTimeChart(histSeries.filter((s) => s.measurement === 'ping'   && s.field === 'average_response_ms'), tc, 'ms'), [histSeries, tc])
  const lossHistChart = useMemo(() => buildTimeChart(histSeries.filter((s) => s.measurement === 'ping'   && s.field === 'packet_loss_pct'),    tc, '%'), [histSeries, tc])
  const cpuChart      = useMemo(() => buildTimeChart(histSeries.filter((s) => s.measurement === 'system' && (s.field==='cpu_usage_pct'||s.field==='mem_used_pct')), tc, '%'), [histSeries, tc])
  const speedChart    = useMemo(() => buildTimeChart(histSeries.filter((s) => s.measurement === 'speedtest'), tc, 'Mbps'), [histSeries, tc])
  const connHistChart = useMemo(() => buildTimeChart(histSeries.filter((s) => s.measurement === 'connectivity'), tc), [histSeries, tc])

  const selected = stores.find((s) => s.storeTag === selectedTag)

  /* ── export helpers ── */
  function exportCSV(rows, filename) {
    const ping0 = primaryPing(rows[0])
    const headers = ['Hostname','Serial','Group','Status','Interface','SSID','Connectivity','Gateway IP','Vendor',
      'Ping Avg (ms)','Packet Loss %','CPU %','RAM %','Download Mbps','Upload Mbps','Issues','Severity','Last Seen']
    const lines = [headers.join(',')]
    for (const s of rows) {
      const p = primaryPing(s)
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
      lines.push([
        esc(s.hostname), esc(s.serial), esc(s.systemGroup||deriveGroup(s.hostname,s.gatewayVendor,s.isFortinet)),
        s.online?'ONLINE':'OFFLINE',
        esc(s.activeInterface||''), esc(s.activeSsid&&s.activeSsid!=='n/a'?s.activeSsid:''),
        s.connState, s.gatewayIp||'', s.gatewayVendor||'',
        p?.avgMs??'', p?.packetLossPct??'',
        s.cpuPct??'', s.memPct??'',
        s.downloadMbps??'', s.uploadMbps??'',
        s.issueCount||0, s.severity||'ok',
        s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '',
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function downloadReport(type) {
    setDownloading(type)
    try {
      const token = useAuthStore.getState().token
      const groupParam = reportGroup !== 'all' ? `&group=${encodeURIComponent(reportGroup)}` : ''
      const url = `/api/store-monitor/reports/${type}?range=${encodeURIComponent(range)}${groupParam}`
      const base = resolvedApiBase()
      const res = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { const j = await res.json().catch(()=>({})); throw new Error(j.error||`HTTP ${res.status}`) }
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${type}_${new Date().toISOString().slice(0,10)}.xlsx`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      alert(`Report failed: ${e.message}`)
    } finally { setDownloading('') }
  }

  /* ── alert form helpers ── */
  function blankRule() {
    return { name:'', description:'', enabled:true, group:'all', severity:'high', cooldownMinutes:30,
      condition:{ metric:'offline', operator:'gt', threshold:0, target:'' }, channels:[] }
  }
  function openAlertModal(rule) {
    setAlertForm(rule ? JSON.parse(JSON.stringify(rule)) : blankRule())
    setAlertModal(rule || {})
    setTestResult({})
  }
  function closeAlertModal() { setAlertModal(null); setTestResult({}) }
  async function saveAlert() {
    setAlertSaving(true)
    try {
      if (alertForm._id) await api.put(`/api/store-alerts/${alertForm._id}`, alertForm)
      else await api.post('/api/store-alerts', alertForm)
      await loadAlerts(); closeAlertModal()
    } catch (e) { alert(e.response?.data?.error || e.message) }
    finally { setAlertSaving(false) }
  }
  async function deleteAlert(id) {
    if (!window.confirm('Delete this alert rule?')) return
    await api.delete(`/api/store-alerts/${id}`).catch(() => {})
    loadAlerts()
  }
  async function toggleAlert(rule) {
    await api.put(`/api/store-alerts/${rule._id}`, { ...rule, enabled: !rule.enabled }).catch(() => {})
    loadAlerts()
  }
  async function testCh(ch) {
    const key = ch.type
    setTestResult((p) => ({ ...p, [key]: 'sending…' }))
    const { data } = await api.post('/api/store-alerts/test-channel', ch).catch((e) => ({ data: { ok:false, error:e.message } }))
    setTestResult((p) => ({ ...p, [key]: data.ok ? '✅ Sent' : `❌ ${data.error}` }))
  }
  function addChannel(type) {
    const ch = { type, webhookUrl: '', emails: [] }
    setAlertForm((f) => ({ ...f, channels: [...f.channels, ch] }))
  }
  function updateChannel(i, patch) {
    setAlertForm((f) => { const chs = [...f.channels]; chs[i] = { ...chs[i], ...patch }; return { ...f, channels: chs } })
  }
  function removeChannel(i) {
    setAlertForm((f) => { const chs = [...f.channels]; chs.splice(i,1); return { ...f, channels: chs } })
  }

  /* ── render helpers ── */
  function GroupBadge({ group }) {
    const g = GROUP_MAP[group] || GROUP_MAP['General Group']
    return (
      <span className="sm-pill" style={{ background:`${g.color}18`, color:g.color, border:`1px solid ${g.color}30` }}>
        {g.icon} {group.replace(' Group','')}
      </span>
    )
  }
  function SevBadge({ sev }) {
    const c = SEV_COLORS[sev] || '#64748b'
    return (
      <span className="sm-badge" style={{ background:`${c}15`, color:c, border:`1px solid ${c}28` }}>
        {sev === 'critical' ? '●' : sev === 'high' ? '◆' : '▲'} {sev}
      </span>
    )
  }
  function ConnPill({ state }) {
    const c = CONN_COLORS[state] || '#64748b'
    const label = CONN_LABELS[state] || state
    return (
      <span className="sm-pill" style={{ background:`${c}15`, color:c, border:`1px solid ${c}25` }}>
        {state === 'lan_healthy' ? '🔌' : state === 'wifi_healthy' ? '📶' : state === 'isp_down' ? '⚡' : state === 'hotspot' ? '📱' : '—'} {label}
      </span>
    )
  }
  function OnlineBadge({ online }) {
    return (
      <span style={{ display:'inline-flex', alignItems:'center', gap:5,
        padding:'2px 7px', borderRadius:999,
        background: online ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)',
        border: `1px solid ${online ? 'rgba(34,197,94,.2)' : 'rgba(239,68,68,.2)'}` }}>
        <span className={`sm-status-dot ${online?'sm-online':'sm-offline'}`}/>
        <span style={{ fontSize:9.5, fontFamily:'var(--mono)', fontWeight:800,
          color: online ? '#22c55e' : '#ef4444', letterSpacing:'.05em' }}>
          {online ? 'ONLINE' : 'OFFLINE'}
        </span>
      </span>
    )
  }
  function HealthBar({ pct: p, color }) {
    const col = color || (p>=90?'#22c55e':p>=70?'#eab308':'#ef4444')
    return <div className="sm-bar"><div className="sm-bar-fill" style={{ width:`${p}%`, background:col }}/></div>
  }

  if (loading && !overview) return <div style={{padding:40,textAlign:'center',color:'var(--text3)'}}>Loading Store Network Monitor…</div>

  return (
    <div className="sm">
      <style>{CSS}</style>

      {/* ── header ── */}
      <div className="sm-hd">
        <div className="sm-hd-left">
          <h1 className="sm-title">
            <span className={`sm-dot ${meta?.connected?'sm-online':meta?.configured?'':'sm-offline'}`} style={meta?.configured&&!meta?.connected?{background:'var(--amber)'}:{}}/>
            Store Network Monitor
            {meta?.connected && <span className="sm-live">LIVE</span>}
          </h1>
          <p className="sm-sub">
            InfluxDB · {meta?.bucket||'store-monitoring'}
            {meta?.url ? ` · ${meta.url}` : ''}
            {overview?.fetchedAt ? ` · updated ${relAge(overview.fetchedAt)} ago` : ''}
          </p>
        </div>
        <div className="sm-hd-right">
          <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--mono)'}}>Range:</span>
          <select className="sm-select" value={range} onChange={(e)=>setRange(e.target.value)}>
            {TIME_RANGES.map((r)=><option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <button className="sm-btn sm-sm" onClick={loadOverview}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="sm-err">⚠ {error}</div>}
      {meta?.configured && !meta?.connected && meta?.error && <div className="sm-err">{meta.error}</div>}
      {!meta?.configured && <div className="sm-info">Set INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET in server env</div>}

      {/* ── tabs ── */}
      <div className="sm-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`sm-tab${tab===t.id?' active':''}`} onClick={()=>setTab(t.id)}>
            {t.icon} {t.label}
            {t.id==='problems' && problems.length>0 && <span className={tab===t.id?'sm-badge-count':'sm-badge-count-red'}>{problems.length}</span>}
            {t.id==='stores'   && stores.length>0   && <span className="sm-badge-count">{stores.length}</span>}
          </button>
        ))}
      </div>

      {/* ══════════ NOC OVERVIEW ══════════ */}
      {tab==='noc' && (
        <>
          {/* top KPIs */}
          <div className="sm-g4 sm-section-mb">
            {[
              { label:'Total Stores',   val: summary?.total||0,   color:'var(--text)' },
              { label:'Online',         val: summary?.online||0,  color:'var(--green)', sub:`${pct(summary?.online||0,summary?.total||1).toFixed(1)}% uptime` },
              { label:'Offline',        val: summary?.offline||0, color:'var(--red)',   sub:`${pct(summary?.offline||0,summary?.total||1).toFixed(1)}% down` },
              { label:'With Issues',    val: summary?.withIssues||0, color:'var(--amber)' },
              { label:'Avg Latency',    val: summary?.avgPingMs!=null?`${summary.avgPingMs} ms`:'—', color:'var(--text)' },
              { label:'Avg Download',   val: summary?.avgDownloadMbps!=null?`${summary.avgDownloadMbps} Mbps`:'—', color:'var(--text)' },
            ].map((k) => (
              <div key={k.label} className="sm-kpi">
                <div className="sm-kpi-label">{k.label}</div>
                <div className="sm-kpi-val" style={{color:k.color}}>{k.val}</div>
                {k.sub && <div className="sm-kpi-sub">{k.sub}</div>}
              </div>
            ))}
          </div>

          {/* group cards */}
          <div className="sm-g4 sm-section-mb">
            {groupSummary.map((g) => (
              <div key={g.id} className="sm-group-card" style={{borderLeft:`3px solid ${g.color}`}}>
                <div className="sm-group-card-hd">
                  <div className="sm-group-name" style={{color:g.color}}>{g.icon} {g.id}</div>
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>{g.health.toFixed(0)}% healthy</span>
                </div>
                <div className="sm-group-stats">
                  <div className="sm-group-stat"><div className="sm-group-stat-val">{g.total}</div><div className="sm-group-stat-label">Total</div></div>
                  <div className="sm-group-stat"><div className="sm-group-stat-val" style={{color:'var(--green)'}}>{g.online}</div><div className="sm-group-stat-label">Online</div></div>
                  <div className="sm-group-stat"><div className="sm-group-stat-val" style={{color:'var(--red)'}}>{g.total-g.online}</div><div className="sm-group-stat-label">Offline</div></div>
                </div>
                <HealthBar pct={g.health}/>
                <div style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                  {g.issues} issue store{g.issues!==1?'s':''} · avg ping {g.avgPing!=null?`${g.avgPing.toFixed(0)}ms`:'—'}
                </div>
              </div>
            ))}
          </div>

          {/* charts row */}
          <div className="sm-g2 sm-section-mb">
            <div className="sm-tr">
              <div className="sm-tr-hd">
                <span className="sm-tr-title">Connectivity Breakdown</span>
                {chartConnFilter
                  ? <button className="sm-btn sm-sm" onClick={()=>setChartConnFilter('')}>
                      <span style={{color:CONN_COLORS[chartConnFilter]||'var(--accent)'}}>● {CONN_LABELS[chartConnFilter]||chartConnFilter}</span>
                      &nbsp;✕ Clear
                    </button>
                  : <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>Click slice to filter stores</span>}
              </div>
              <div className="sm-tr-body sm-chart" style={{cursor:'pointer'}}>
                {connChart
                  ? <Doughnut data={connChart.data} options={connChart.options}/>
                  : <div className="sm-empty">No data</div>}
              </div>
            </div>
            <div className="sm-tr">
              <div className="sm-tr-hd">
                <span className="sm-tr-title">Online / Offline by Group</span>
                {chartGroupFilter
                  ? <button className="sm-btn sm-sm" onClick={()=>setChartGroupFilter('')}>
                      <span style={{color:GROUP_MAP[chartGroupFilter]?.color||'var(--accent)'}}>{GROUP_MAP[chartGroupFilter]?.icon} {chartGroupFilter}</span>
                      &nbsp;✕ Clear
                    </button>
                  : <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>Click bar to filter stores</span>}
              </div>
              <div className="sm-tr-body sm-chart" style={{cursor:'pointer'}}>
                <Bar data={groupHealthChart.data} options={groupHealthChart.options}/>
              </div>
            </div>
          </div>

          {/* critical problems */}
          <div className="sm-tr sm-section-mb">
            <div className="sm-tr-hd">
              <span className="sm-tr-title">Critical &amp; High Issues</span>
              <button className="sm-btn sm-sm" onClick={()=>setTab('problems')}>View all →</button>
            </div>
            <div className="sm-tr-body sm-tbl-wrap">
              <table className="sm-tbl">
                <thead><tr><th>Severity</th><th>Store</th><th>Group</th><th>Issue</th><th>Connectivity</th><th>Last seen</th></tr></thead>
                <tbody>
                  {stores.filter((s)=>s.issueCount>0).slice(0,15).flatMap((s) =>
                    s.issues.filter((i)=>i.severity==='critical'||i.severity==='high').slice(0,2).map((issue,i)=>(
                      <tr key={`${s.storeTag}-${issue.code}-${i}`} className="clickable" onClick={()=>{setSelectedTag(s.storeTag);setTab('detail')}}>
                        <td><SevBadge sev={issue.severity}/></td>
                        <td style={{fontWeight:600}}>{s.hostname}</td>
                        <td><GroupBadge group={s.systemGroup}/></td>
                        <td>{issue.message}</td>
                        <td><ConnPill state={s.connState}/></td>
                        <td style={{fontFamily:'var(--mono)',fontSize:11}}>{relAge(s.lastSeen)}</td>
                      </tr>
                    ))
                  )}
                  {!stores.some((s)=>s.issueCount>0) && <tr><td colSpan={6} className="sm-empty">✅ All stores healthy</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ══════════ STORES ══════════ */}
      {tab==='stores' && (
        <>
          {/* chart-driven filter banner */}
          {(chartConnFilter || chartGroupFilter) && (
            <div className="sm-info" style={{display:'flex',alignItems:'center',gap:10,padding:'7px 12px',marginBottom:8}}>
              <span style={{fontSize:11,flex:1}}>
                Filtered by chart:
                {chartConnFilter && <span style={{fontWeight:700,color:CONN_COLORS[chartConnFilter]}}> {CONN_LABELS[chartConnFilter]}</span>}
                {chartGroupFilter && <span style={{fontWeight:700,color:GROUP_MAP[chartGroupFilter]?.color}}> {GROUP_MAP[chartGroupFilter]?.icon} {chartGroupFilter}</span>}
                {' '}— showing {filteredStores.length} of {stores.length} stores
              </span>
              <button className="sm-btn sm-sm" onClick={()=>{setChartConnFilter('');setChartGroupFilter('')}}>✕ Clear chart filter</button>
            </div>
          )}

          <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:6,marginBottom:10,padding:'8px 12px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:'var(--sm-r-lg)'}}>
            <input className="sm-input" placeholder="Search hostname, serial, IP, SSID…"
              value={search} onChange={(e)=>setSearch(e.target.value)} style={{minWidth:190,flex:'1 1 190px'}}/>
            <div style={{width:1,height:20,background:'var(--border)',flexShrink:0}}/>
            <select className="sm-select" value={activeGroupFilter} onChange={(e)=>{setChartGroupFilter('');setGroupFilter(e.target.value)}}>
              <option value="">All Groups</option>
              {GROUP_DEFS.map((g)=><option key={g.id} value={g.id}>{g.icon} {g.id.replace(' Group','')}</option>)}
            </select>
            <select className="sm-select" value={activeConnFilter} onChange={(e)=>{setChartConnFilter('');setConnFilter(e.target.value)}}>
              <option value="">All Connectivity</option>
              {Object.entries(CONN_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
            <select className="sm-select" value={ifaceFilter} onChange={(e)=>setIfaceFilter(e.target.value)}>
              <option value="">All Interface</option>
              <option value="ethernet">🔌 Ethernet</option>
              <option value="wifi">📶 Wi-Fi</option>
            </select>
            <select className="sm-select" value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="online">🟢 Online</option>
              <option value="offline">🔴 Offline</option>
            </select>
            <label style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--text2)',cursor:'pointer',userSelect:'none'}}>
              <input type="checkbox" checked={issuesOnly} onChange={(e)=>setIssuesOnly(e.target.checked)}/>
              Issues only
            </label>
            {(search||activeConnFilter||activeGroupFilter||ifaceFilter||statusFilter||issuesOnly) && (
              <button className="sm-btn sm-sm danger" onClick={()=>{setSearch('');setConnFilter('');setGroupFilter('');setChartConnFilter('');setChartGroupFilter('');setIfaceFilter('');setStatusFilter('');setIssuesOnly(false)}}>
                ✕ Clear
              </button>
            )}
            <span style={{marginLeft:'auto',fontSize:10.5,color:'var(--text3)',fontFamily:'var(--mono)',whiteSpace:'nowrap'}}>
              {filteredStores.length}/{stores.length} stores
            </span>
            <div style={{width:1,height:20,background:'var(--border)',flexShrink:0}}/>
            <button className="sm-btn sm-sm" onClick={()=>exportCSV(filteredStores,`stores_${new Date().toISOString().slice(0,10)}.csv`)}>⬇ CSV</button>
            <button className="sm-btn sm-sm primary" onClick={()=>downloadReport('inventory')} disabled={!!downloading}>
              {downloading==='inventory'?'⏳':'⬇'} Excel
            </button>
          </div>

          <div className="sm-tbl-wrap">
            <table className="sm-tbl">
              <thead>
                <tr>
                  <th>Status</th><th>Hostname</th><th>Group</th><th>Serial</th>
                  <th>Interface</th><th>Connectivity</th><th>SSID</th><th>Gateway IP</th><th>Vendor</th>
                  <th>Ping (8.8.8.8)</th><th>Loss</th><th>CPU</th><th>RAM</th>
                  <th>↓ Speed</th><th>↑ Speed</th><th>Last seen</th><th>Issues</th>
                </tr>
              </thead>
              <tbody>
                {filteredStores.map((s) => {
                  const ping = primaryPing(s)
                  return (
                    <tr key={s.storeTag} className="clickable" onClick={()=>{setSelectedTag(s.storeTag);setTab('detail')}}>
                      <td><OnlineBadge online={s.online}/></td>
                      <td style={{fontWeight:600}}>{s.hostname}</td>
                      <td><GroupBadge group={s.systemGroup}/></td>
                      <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{s.serial}</td>
                      <td>
                        {s.activeInterface
                          ? <span className="sm-pill" style={{
                              background: String(s.activeInterface).toLowerCase().includes('wi') ? 'rgba(6,182,212,.15)' : 'rgba(34,197,94,.15)',
                              color:      String(s.activeInterface).toLowerCase().includes('wi') ? '#06b6d4' : '#22c55e',
                            }}>
                              {String(s.activeInterface).toLowerCase().includes('wi') ? '📶' : '🔌'} {s.activeInterface}
                            </span>
                          : <span style={{color:'var(--text3)'}}>—</span>}
                      </td>
                      <td><ConnPill state={s.connState}/></td>
                      <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)',maxWidth:100,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                        {s.activeSsid && s.activeSsid!=='n/a' ? s.activeSsid : '—'}
                      </td>
                      <td style={{fontFamily:'var(--mono)',fontSize:11}}>{s.gatewayIp||'—'}</td>
                      <td>{s.gatewayVendor||'—'}</td>
                      <td style={{fontFamily:'var(--mono)'}}>{fmtMs(ping?.avgMs)}</td>
                      <td style={{color: ping?.packetLossPct>10?'var(--red)':ping?.packetLossPct>0?'var(--amber)':'var(--green)'}}>{ping?.packetLossPct!=null?fmtPct(ping.packetLossPct):'—'}</td>
                      <td style={{color:s.cpuPct>90?'var(--red)':s.cpuPct>70?'var(--amber)':'var(--text)'}}>{fmtPct(s.cpuPct)}</td>
                      <td style={{color:s.memPct>90?'var(--red)':s.memPct>70?'var(--amber)':'var(--text)'}}>{fmtPct(s.memPct)}</td>
                      <td>{fmtMbps(s.downloadMbps)}</td>
                      <td>{fmtMbps(s.uploadMbps)}</td>
                      <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{relAge(s.lastSeen)}</td>
                      <td>
                        {s.issueCount>0
                          ? <span style={{color:SEV_COLORS[s.severity]||'var(--amber)',fontWeight:700,fontFamily:'var(--mono)'}}>{s.issueCount}</span>
                          : <span style={{color:'var(--green)',fontSize:11}}>✓</span>}
                      </td>
                    </tr>
                  )
                })}
                {!filteredStores.length && <tr><td colSpan={17} className="sm-empty">No stores match filters</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ══════════ PROBLEMS ══════════ */}
      {tab==='problems' && (
        <div className="sm-tr">
          <div className="sm-tr-hd">
            <span className="sm-tr-title">Active Problems — {problems.length}</span>
            <select className="sm-select" style={{fontSize:11}} onChange={(e)=>setGroupFilter(e.target.value)} value={groupFilter}>
              <option value="">All Groups</option>
              {GROUP_DEFS.map((g)=><option key={g.id} value={g.id}>{g.icon} {g.id}</option>)}
            </select>
          </div>
          <div className="sm-tr-body sm-tbl-wrap">
            <table className="sm-tbl">
              <thead><tr><th>Severity</th><th>Hostname</th><th>Group</th><th>Serial</th><th>Problem</th><th>Connectivity</th><th>Vendor</th><th>Last seen</th></tr></thead>
              <tbody>
                {problems
                  .filter((p)=>!groupFilter||deriveGroup(p.hostname,p.gatewayVendor,false)===groupFilter)
                  .map((p,i)=>{
                    const grp = deriveGroup(p.hostname,p.gatewayVendor,false)
                    return (
                      <tr key={`${p.storeTag}-${p.code}-${i}`} className="clickable" onClick={()=>{setSelectedTag(p.storeTag);setTab('detail')}}>
                        <td><SevBadge sev={p.severity}/></td>
                        <td style={{fontWeight:600}}>{p.hostname}</td>
                        <td><GroupBadge group={grp}/></td>
                        <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{p.serial}</td>
                        <td>{p.message}</td>
                        <td><ConnPill state={p.connState}/></td>
                        <td>{p.gatewayVendor||'—'}</td>
                        <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{relAge(p.lastSeen)}</td>
                      </tr>
                    )
                  })}
                {!problems.length && <tr><td colSpan={8} className="sm-empty">✅ No problems detected</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════ NET HEALTH ══════════ */}
      {tab==='netHealth' && (
        <>
          <div className="sm-g4 sm-section-mb">
            {[
              { label:'Healthy Connectivity', val:`${netHealth.uptimePct.toFixed(1)}%`, color: netHealth.uptimePct>=95?'var(--green)':'var(--amber)' },
              { label:'DNS Success Rate',     val:`${netHealth.dnsOkPct.toFixed(1)}%`,  color: netHealth.dnsOkPct>=98?'var(--green)':'var(--amber)' },
              { label:'HTTP Success Rate',    val:`${netHealth.httpOkPct.toFixed(1)}%`, color: netHealth.httpOkPct>=98?'var(--green)':'var(--amber)' },
              { label:'Avg Latency',          val: netHealth.avgLatency!=null?`${netHealth.avgLatency.toFixed(1)} ms`:'—', color:'var(--text)' },
              { label:'Avg Packet Loss',      val: netHealth.avgLoss!=null?`${netHealth.avgLoss.toFixed(2)}%`:'—', color: netHealth.avgLoss>5?'var(--red)':netHealth.avgLoss>1?'var(--amber)':'var(--green)' },
            ].map((k)=>(
              <div key={k.label} className="sm-kpi">
                <div className="sm-kpi-label">{k.label}</div>
                <div className="sm-kpi-val" style={{color:k.color}}>{k.val}</div>
              </div>
            ))}
          </div>

          {/* group health table */}
          <div className="sm-tr sm-section-mb">
            <div className="sm-tr-hd"><span className="sm-tr-title">Group Network Health</span></div>
            <div className="sm-tr-body sm-tbl-wrap">
              <table className="sm-tbl">
                <thead><tr><th>Group</th><th>Total</th><th>Online</th><th>Offline</th><th>Issues</th><th>Health</th><th>Avg Ping</th></tr></thead>
                <tbody>
                  {groupSummary.map((g)=>(
                    <tr key={g.id}>
                      <td><GroupBadge group={g.id}/></td>
                      <td>{g.total}</td>
                      <td style={{color:'var(--green)',fontWeight:600}}>{g.online}</td>
                      <td style={{color:'var(--red)',fontWeight:600}}>{g.total-g.online}</td>
                      <td style={{color:g.issues>0?'var(--amber)':'var(--text)'}}>{g.issues}</td>
                      <td style={{minWidth:120}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <div style={{flex:1}}><HealthBar pct={g.health}/></div>
                          <span style={{fontSize:11,fontFamily:'var(--mono)',minWidth:38}}>{g.health.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{fontFamily:'var(--mono)',fontSize:11}}>{g.avgPing!=null?`${g.avgPing.toFixed(0)}ms`:'—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sm-g2 sm-section-mb">
            <div className="sm-tr">
              <div className="sm-tr-hd"><span className="sm-tr-title">Average Latency by Target</span></div>
              <div className="sm-tr-body sm-chart">{latChart?<Bar data={latChart.data} options={latChart.options}/>:<div className="sm-empty">No data</div>}</div>
            </div>
            <div className="sm-tr">
              <div className="sm-tr-hd"><span className="sm-tr-title">Packet Loss by Target</span></div>
              <div className="sm-tr-body sm-chart">{lossChart?<Bar data={lossChart.data} options={lossChart.options}/>:<div className="sm-empty">No data</div>}</div>
            </div>
          </div>

          <div className="sm-g2">
            <div className="sm-tr">
              <div className="sm-tr-hd"><span className="sm-tr-title">DNS Health</span></div>
              <div className="sm-tr-body sm-tbl-wrap">
                <table className="sm-tbl">
                  <thead><tr><th>Domain</th><th>Success %</th><th>Samples</th></tr></thead>
                  <tbody>
                    {netHealth.dnsRows.map((d)=>(
                      <tr key={d.domain}>
                        <td>{d.domain}</td>
                        <td style={{color:d.pct>=99?'var(--green)':d.pct>=95?'var(--amber)':'var(--red)',fontWeight:600,fontFamily:'var(--mono)'}}>{d.pct.toFixed(1)}%</td>
                        <td style={{color:'var(--text3)',fontFamily:'var(--mono)',fontSize:11}}>{d.t}</td>
                      </tr>
                    ))}
                    {!netHealth.dnsRows.length && <tr><td colSpan={3} className="sm-empty">No data</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="sm-tr">
              <div className="sm-tr-hd"><span className="sm-tr-title">HTTP Health</span></div>
              <div className="sm-tr-body sm-tbl-wrap">
                <table className="sm-tbl">
                  <thead><tr><th>URL</th><th>Success %</th><th>Samples</th></tr></thead>
                  <tbody>
                    {netHealth.httpRows.map((h)=>(
                      <tr key={h.url}>
                        <td style={{wordBreak:'break-all',maxWidth:220,fontSize:11}}>{h.url}</td>
                        <td style={{color:h.pct>=99?'var(--green)':h.pct>=95?'var(--amber)':'var(--red)',fontWeight:600,fontFamily:'var(--mono)'}}>{h.pct.toFixed(1)}%</td>
                        <td style={{color:'var(--text3)',fontFamily:'var(--mono)',fontSize:11}}>{h.t}</td>
                      </tr>
                    ))}
                    {!netHealth.httpRows.length && <tr><td colSpan={3} className="sm-empty">No data</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ══════════ STORE DETAIL ══════════ */}
      {tab==='detail' && (
        <>
          {/* searchable store picker */}
          <div className="sm-toolbar" style={{marginBottom:10}}>
            {(() => {
              const q = storeSearch.trim().toLowerCase()
              const filtered = q
                ? stores.filter((s) =>
                    String(s.hostname).toLowerCase().includes(q) ||
                    String(s.serial).toLowerCase().includes(q) ||
                    String(s.gatewayIp||'').toLowerCase().includes(q) ||
                    String(s.systemGroup||'').toLowerCase().includes(q))
                : stores
              const sel = stores.find((s) => s.storeTag === selectedTag)
              return (
                <div className="sm-picker-wrap" ref={storePickerRef}>
                  <button
                    type="button"
                    className={`sm-picker-btn${storePickerOpen?' open':''}`}
                    onClick={() => { setStorePickerOpen((v) => !v); setStoreSearch('') }}
                  >
                    {sel ? (
                      <>
                        <span style={{ color: sel.online ? '#22c55e' : '#ef4444', fontSize: 10 }}>●</span>
                        <span className="sm-picker-btn-text">
                          {sel.hostname} — {sel.serial}
                          <span style={{ fontWeight: 400, color: 'var(--text3)', marginLeft: 6 }}>
                            [{sel.systemGroup}]
                          </span>
                        </span>
                      </>
                    ) : (
                      <span className="sm-picker-btn-text" style={{ color: 'var(--text3)', fontWeight: 400 }}>
                        Select a store…
                      </span>
                    )}
                    <span className="sm-picker-caret">{storePickerOpen ? '▲' : '▼'}</span>
                  </button>

                  {storePickerOpen && (
                    <div className="sm-picker-dropdown">
                      <div className="sm-picker-search-wrap">
                        <input
                          autoFocus
                          className="sm-picker-search"
                          placeholder={`🔍 Search ${stores.length} stores by hostname, serial, IP, group…`}
                          value={storeSearch}
                          onChange={(e) => setStoreSearch(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { setStorePickerOpen(false); setStoreSearch('') }
                            if (e.key === 'Enter' && filtered.length === 1) {
                              const s = filtered[0]
                              setSelectedTag(s.storeTag); loadHistory(s.storeTag)
                              setStorePickerOpen(false); setStoreSearch('')
                            }
                          }}
                        />
                      </div>
                      <div className="sm-picker-list">
                        {filtered.slice(0, 120).map((s) => (
                          <div
                            key={s.storeTag}
                            className={`sm-picker-item${s.storeTag === selectedTag ? ' selected' : ''}`}
                            onClick={() => {
                              setSelectedTag(s.storeTag); loadHistory(s.storeTag)
                              setStorePickerOpen(false); setStoreSearch('')
                            }}
                          >
                            <span style={{ color: s.online ? '#22c55e' : '#ef4444', fontSize: 10, flexShrink: 0 }}>●</span>
                            <span className="sm-picker-item-name">{s.hostname} — {s.serial}</span>
                            <span className="sm-picker-item-meta">{s.systemGroup}</span>
                            {s.issueCount > 0 && (
                              <span style={{ background: `${SEV_COLORS[s.severity] || '#64748b'}22`, color: SEV_COLORS[s.severity] || '#64748b', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                                {s.issueCount} issue{s.issueCount !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        ))}
                        {!filtered.length && <div className="sm-picker-empty">No stores match "{storeSearch}"</div>}
                        {filtered.length > 120 && (
                          <div className="sm-picker-count">Showing 120 of {filtered.length} — refine search to narrow down</div>
                        )}
                      </div>
                      {filtered.length > 0 && (
                        <div className="sm-picker-count">{filtered.length} store{filtered.length !== 1 ? 's' : ''} found</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}

            <button className="sm-btn sm-sm" onClick={() => loadHistory(selectedTag)} disabled={histLoading}>
              {histLoading ? '⏳' : '↻'} Refresh
            </button>
          </div>

          {selected ? (
            <>
              {/* ── KPI row (Zabbix-style snapshot header) ── */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:10,marginBottom:14}}>

                {/* Status */}
                <div className="sm-kpi" style={{borderLeft:`3px solid ${selected.online?'#22c55e':'#ef4444'}`}}>
                  <div className="sm-kpi-label">Status</div>
                  <div className="sm-kpi-val" style={{fontSize:16}}><OnlineBadge online={selected.online}/></div>
                  <div className="sm-kpi-sub">Last seen {relAge(selected.lastSeen)} ago</div>
                </div>

                {/* Group */}
                <div className="sm-kpi" style={{borderLeft:`3px solid ${GROUP_MAP[selected.systemGroup]?.color||'#64748b'}`}}>
                  <div className="sm-kpi-label">Group</div>
                  <div style={{marginTop:4}}><GroupBadge group={selected.systemGroup}/></div>
                  {selected.isFortinet && <div className="sm-kpi-sub">Fortinet / SD-WAN</div>}
                </div>

                {/* Interface & Connectivity */}
                <div className="sm-kpi">
                  <div className="sm-kpi-label">Interface</div>
                  <div className="sm-kpi-val" style={{fontSize:13,marginTop:2}}>
                    {selected.activeInterface
                      ? <span style={{color:String(selected.activeInterface).toLowerCase().includes('wi')?'#06b6d4':'#22c55e'}}>
                          {String(selected.activeInterface).toLowerCase().includes('wi')?'📶':'🔌'} {selected.activeInterface}
                        </span>
                      : '—'}
                  </div>
                  <div className="sm-kpi-sub"><ConnPill state={selected.connState}/></div>
                  {selected.activeSsid && selected.activeSsid!=='n/a' &&
                    <div className="sm-kpi-sub">SSID: {selected.activeSsid}</div>}
                </div>

                {/* Gateway */}
                <div className="sm-kpi">
                  <div className="sm-kpi-label">Gateway</div>
                  <div className="sm-kpi-val" style={{fontSize:13}}>{selected.gatewayIp||'—'}</div>
                  <div className="sm-kpi-sub">{selected.gatewayVendor||'Unknown vendor'}</div>
                </div>

                {/* Ping (8.8.8.8) */}
                {(() => { const p = primaryPing(selected); return (
                  <div className="sm-kpi" style={{borderLeft:`3px solid ${p?.avgMs>200?'#ef4444':p?.avgMs>100?'#eab308':'#22c55e'}`}}>
                    <div className="sm-kpi-label">Ping 8.8.8.8</div>
                    <div className="sm-kpi-val" style={{fontSize:18,color:p?.avgMs>200?'var(--red)':p?.avgMs>100?'var(--amber)':'var(--green)'}}>
                      {fmtMs(p?.avgMs)}
                    </div>
                    <div className="sm-kpi-sub">Loss {fmtPct(p?.packetLossPct)} · min {fmtMs(p?.minMs)} · max {fmtMs(p?.maxMs)}</div>
                  </div>
                )})()}

                {/* CPU */}
                <div className="sm-kpi" style={{borderLeft:`3px solid ${selected.cpuPct>90?'#ef4444':selected.cpuPct>70?'#eab308':'#22c55e'}`}}>
                  <div className="sm-kpi-label">CPU Usage</div>
                  <div className="sm-kpi-val" style={{color:selected.cpuPct>90?'var(--red)':selected.cpuPct>70?'var(--amber)':'var(--green)'}}>{fmtPct(selected.cpuPct)}</div>
                  <div style={{marginTop:4}}><HealthBar pct={selected.cpuPct||0}/></div>
                </div>

                {/* RAM */}
                <div className="sm-kpi" style={{borderLeft:`3px solid ${selected.memPct>90?'#ef4444':selected.memPct>70?'#eab308':'#22c55e'}`}}>
                  <div className="sm-kpi-label">Memory</div>
                  <div className="sm-kpi-val" style={{color:selected.memPct>90?'var(--red)':selected.memPct>70?'var(--amber)':'var(--green)'}}>{fmtPct(selected.memPct)}</div>
                  <div style={{marginTop:4}}><HealthBar pct={selected.memPct||0}/></div>
                </div>

                {/* Download */}
                <div className="sm-kpi" style={{borderLeft:'3px solid #3b82f6'}}>
                  <div className="sm-kpi-label">↓ Download</div>
                  <div className="sm-kpi-val" style={{color:'#3b82f6'}}>{fmtMbps(selected.downloadMbps)}</div>
                  <div className="sm-kpi-sub">Last speedtest</div>
                </div>

                {/* Upload */}
                <div className="sm-kpi" style={{borderLeft:'3px solid #8b5cf6'}}>
                  <div className="sm-kpi-label">↑ Upload</div>
                  <div className="sm-kpi-val" style={{color:'#8b5cf6'}}>{fmtMbps(selected.uploadMbps)}</div>
                  <div className="sm-kpi-sub">Last speedtest</div>
                </div>
              </div>

              {/* ── Device snapshot (all metrics, Zabbix style) ── */}
              <div className="sm-tr sm-section-mb">
                <div className="sm-tr-hd">
                  <span className="sm-tr-title">📋 Device Snapshot</span>
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>Hostname: {selected.hostname} · Serial: {selected.serial}</span>
                </div>
                <div className="sm-tr-body">
                  <div className="sm-snapshot-grid">
                    {/* identity */}
                    {[
                      ['Hostname',       selected.hostname,      ''],
                      ['Serial',         selected.serial,        ''],
                      ['Store Tag',      selected.storeTag,      ''],
                      ['Interface',      selected.activeInterface||'—', ''],
                      ['Connectivity',   CONN_LABELS[selected.connState]||selected.connState, CONN_COLORS[selected.connState]||''],
                      ['SSID',           selected.activeSsid && selected.activeSsid!=='n/a' ? selected.activeSsid : '—', ''],
                      ['Gateway IP',     selected.gatewayIp||'—', ''],
                      ['Gateway Vendor', selected.gatewayVendor||'—', ''],
                      ['Is Hotspot',     selected.isHotspot ? 'YES' : 'No', selected.isHotspot?'#f97316':''],
                      ['Is Fortinet',    selected.isFortinet ? 'YES' : 'No', selected.isFortinet?'#8b5cf6':''],
                    ].map(([k,v,c])=>(
                      <div key={k} className="sm-snap-item">
                        <span className="sm-snap-label">{k}</span>
                        <span className="sm-snap-val" style={{color:c||'var(--text)',fontFamily:'var(--mono)',fontSize:12,textAlign:'right',maxWidth:'55%',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v}</span>
                      </div>
                    ))}
                    {/* ping per target */}
                    {Object.entries(selected.ping||{}).flatMap(([t,p])=>[
                      [`Ping ${t} avg`,   fmtMs(p.avgMs),          p.avgMs>200?'var(--red)':p.avgMs>100?'var(--amber)':'var(--green)'],
                      [`Ping ${t} loss`,  fmtPct(p.packetLossPct), p.packetLossPct>10?'var(--red)':p.packetLossPct>0?'var(--amber)':'var(--green)'],
                    ]).map(([k,v,c])=>(
                      <div key={k} className="sm-snap-item">
                        <span className="sm-snap-label">{k}</span>
                        <span className="sm-snap-val" style={{color:c||'var(--text)'}}>{v}</span>
                      </div>
                    ))}
                    {/* DNS */}
                    {Object.entries(selected.dns||{}).map(([d,v])=>(
                      <div key={`dns-${d}`} className="sm-snap-item">
                        <span className="sm-snap-label">DNS {d}</span>
                        <span className="sm-snap-val" style={{color:v.success?'var(--green)':'var(--red)'}}>{v.success?`OK ${fmtMs(v.responseMs)}`:'FAIL'}</span>
                      </div>
                    ))}
                    {/* HTTP */}
                    {Object.entries(selected.http||{}).map(([u,v])=>(
                      <div key={`http-${u}`} className="sm-snap-item">
                        <span className="sm-snap-label" style={{maxWidth:'55%',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{u.replace(/^https?:\/\//,'')}</span>
                        <span className="sm-snap-val" style={{color:v.success?'var(--green)':'var(--red)'}}>{v.success?`${v.statusCode||200} ${fmtMs(v.responseMs)}`:'FAIL'}</span>
                      </div>
                    ))}
                    {/* CPU / MEM / Speed */}
                    {[
                      ['CPU Usage',      fmtPct(selected.cpuPct),      selected.cpuPct>90?'var(--red)':selected.cpuPct>70?'var(--amber)':'var(--green)'],
                      ['Memory Used',    fmtPct(selected.memPct),      selected.memPct>90?'var(--red)':selected.memPct>70?'var(--amber)':'var(--green)'],
                      ['Download Speed', fmtMbps(selected.downloadMbps), '#3b82f6'],
                      ['Upload Speed',   fmtMbps(selected.uploadMbps),   '#8b5cf6'],
                    ].map(([k,v,c])=>(
                      <div key={k} className="sm-snap-item">
                        <span className="sm-snap-label">{k}</span>
                        <span className="sm-snap-val" style={{color:c||'var(--text)'}}>{v}</span>
                      </div>
                    ))}
                    {/* issues */}
                    {selected.issues?.length>0 && (
                      <div className="sm-snap-item" style={{gridColumn:'1/-1',background:'rgba(239,68,68,.07)',borderColor:'rgba(239,68,68,.25)'}}>
                        <span className="sm-snap-label" style={{color:'var(--red)'}}>Active Issues</span>
                        <span className="sm-snap-val" style={{color:'var(--red)'}}>{selected.issueCount} issue{selected.issueCount!==1?'s':''} · {selected.severity}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Issues list ── */}
              {selected.issues?.length>0 && (
                <div className="sm-tr sm-section-mb">
                  <div className="sm-tr-hd"><span className="sm-tr-title">⚠ Active Issues — {selected.issues.length}</span></div>
                  <div className="sm-tr-body">
                    {selected.issues.map((issue,i)=>(
                      <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
                        <SevBadge sev={issue.severity}/>
                        <span style={{fontSize:12,flex:1}}>{issue.message}</span>
                        <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>{issue.code}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Business Hours + time-range control ── */}
              <div className="sm-bh-row">
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--text2)',cursor:'pointer',fontWeight:700}}>
                  <input type="checkbox" checked={bh.enabled} onChange={(e)=>setBh((b)=>({...b,enabled:e.target.checked}))}/>
                  Business Hours Filter
                </label>
                {bh.enabled && (
                  <>
                    <div style={{display:'flex',alignItems:'center',gap:4}}>
                      {BH_DAYS.map((d)=>(
                        <button key={d.val} type="button"
                          className={`sm-bh-dayBtn${bh.weekdays.includes(d.val)?' on':''}`}
                          onClick={()=>setBh((b)=>({...b,weekdays:b.weekdays.includes(d.val)?b.weekdays.filter((x)=>x!==d.val):[...b.weekdays,d.val].sort()}))}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:6,fontSize:12}}>
                      <span style={{color:'var(--text3)'}}>From</span>
                      <input type="number" min={0} max={23} value={bh.startHour} className="sm-input"
                        style={{width:54}} onChange={(e)=>setBh((b)=>({...b,startHour:+e.target.value}))}/>
                      <span style={{color:'var(--text3)'}}>:00 to</span>
                      <input type="number" min={1} max={24} value={bh.endHour} className="sm-input"
                        style={{width:54}} onChange={(e)=>setBh((b)=>({...b,endHour:+e.target.value}))}/>
                      <span style={{color:'var(--text3)'}}>:00</span>
                    </div>
                    <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',marginLeft:'auto'}}>
                      Charts show only selected hours
                    </span>
                  </>
                )}
              </div>

              {/* ── Periodic charts ── */}
              <div style={{display:'flex',flexDirection:'column',gap:12}}>

                {/* Ping latency */}
                <div className="sm-tr">
                  <div className="sm-tr-hd">
                    <span className="sm-tr-title">📡 Ping Latency over Time</span>
                    <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>All targets · ms</span>
                  </div>
                  <div className="sm-tr-body sm-chart-tall">
                    {histLoading ? <div className="sm-empty">Loading…</div>
                      : pingChart
                        ? <Line data={pingChart.data} options={chartOpts(tc,{ plugins:{ legend:{ position:'top', labels:{color:tc.text2,boxWidth:10,font:{size:10}} } } })}/>
                        : <div className="sm-empty">No ping history for this range</div>}
                  </div>
                </div>

                {/* Packet loss */}
                <div className="sm-tr">
                  <div className="sm-tr-hd">
                    <span className="sm-tr-title">📉 Packet Loss over Time</span>
                    <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>All targets · %</span>
                  </div>
                  <div className="sm-tr-body sm-chart-tall">
                    {histLoading ? <div className="sm-empty">Loading…</div>
                      : lossHistChart
                        ? <Line data={lossHistChart.data} options={chartOpts(tc,{})}/>
                        : <div className="sm-empty">No loss history</div>}
                  </div>
                </div>

                {/* CPU & Memory */}
                <div className="sm-tr">
                  <div className="sm-tr-hd">
                    <span className="sm-tr-title">🖥 CPU &amp; Memory over Time</span>
                    <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>%</span>
                  </div>
                  <div className="sm-tr-body sm-chart-tall">
                    {histLoading ? <div className="sm-empty">Loading…</div>
                      : cpuChart
                        ? <Line data={cpuChart.data} options={chartOpts(tc,{ scales:{ y:{ min:0, max:100, ticks:{color:tc.text3}, grid:{color:tc.border} }, x:{ ticks:{color:tc.text3,maxTicksLimit:8}, grid:{color:tc.border} } } })}/>
                        : <div className="sm-empty">No CPU/memory history</div>}
                  </div>
                </div>

                {/* Speedtest */}
                <div className="sm-tr">
                  <div className="sm-tr-hd">
                    <span className="sm-tr-title">⚡ Speedtest History</span>
                    <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>Download &amp; Upload · Mbps</span>
                  </div>
                  <div className="sm-tr-body sm-chart-tall">
                    {histLoading ? <div className="sm-empty">Loading…</div>
                      : speedChart
                        ? <Line data={speedChart.data} options={chartOpts(tc,{})}/>
                        : <div className="sm-empty">No speedtest history</div>}
                  </div>
                </div>

                {/* Ping targets current snapshot table */}
                <div className="sm-tr">
                  <div className="sm-tr-hd"><span className="sm-tr-title">🎯 Ping Targets — Current</span></div>
                  <div className="sm-tr-body sm-tbl-wrap">
                    <table className="sm-tbl">
                      <thead><tr><th>Target</th><th>Avg</th><th>Min</th><th>Max</th><th>Packet Loss</th><th>Status</th></tr></thead>
                      <tbody>
                        {Object.entries(selected.ping||{}).map(([t,p])=>(
                          <tr key={t}>
                            <td style={{fontFamily:'var(--mono)',fontWeight:600}}>{t}</td>
                            <td style={{color:p.avgMs>200?'var(--red)':p.avgMs>100?'var(--amber)':'var(--green)',fontFamily:'var(--mono)',fontWeight:700}}>{fmtMs(p.avgMs)}</td>
                            <td style={{fontFamily:'var(--mono)',color:'var(--text3)'}}>{fmtMs(p.minMs)}</td>
                            <td style={{fontFamily:'var(--mono)',color:'var(--text3)'}}>{fmtMs(p.maxMs)}</td>
                            <td style={{color:p.packetLossPct>10?'var(--red)':p.packetLossPct>0?'var(--amber)':'var(--green)',fontFamily:'var(--mono)'}}>{fmtPct(p.packetLossPct)}</td>
                            <td>{p.packetLossPct===0?<span style={{color:'var(--green)',fontSize:11}}>✓ OK</span>:p.packetLossPct>=100?<span style={{color:'var(--red)',fontSize:11}}>✕ Unreachable</span>:<span style={{color:'var(--amber)',fontSize:11}}>⚠ Degraded</span>}</td>
                          </tr>
                        ))}
                        {!Object.keys(selected.ping||{}).length && <tr><td colSpan={6} className="sm-empty">No ping data</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            </>
          ) : (
            <div className="sm-empty">Select a store to view its detail</div>
          )}
        </>
      )}

      {/* ══════════ REPORTS ══════════ */}
      {tab==='reports' && (
        <>
          {/* ── Reports header + filters ── */}
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:12,marginBottom:14}}>
            <div>
              <h3 style={{margin:0,fontSize:15,fontWeight:700}}>📊 Reports</h3>
              <p style={{margin:'3px 0 0',fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                Excel files include color-coded values and multiple sheets.
              </p>
            </div>

            {/* filter controls */}
            <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <div style={{display:'flex',flexDirection:'column',gap:3}}>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em'}}>Time range</span>
                <select className="sm-select" value={range} onChange={(e)=>setRange(e.target.value)}>
                  {TIME_RANGES.map((r)=><option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:3}}>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em'}}>Group</span>
                <select className="sm-select" value={reportGroup} onChange={(e)=>setReportGroup(e.target.value)}>
                  <option value="all">All Groups ({stores.length} stores)</option>
                  {GROUP_DEFS.map((g)=>{
                    const cnt = stores.filter(s=>s.systemGroup===g.id).length
                    return <option key={g.id} value={g.id}>{g.icon} {g.id} ({cnt})</option>
                  })}
                </select>
              </div>
              {reportGroup !== 'all' && (
                <div style={{display:'flex',alignItems:'flex-end',paddingBottom:1}}>
                  <button className="sm-btn sm-sm" onClick={()=>setReportGroup('all')}>✕ Clear</button>
                </div>
              )}
            </div>
          </div>

          {/* active filter banner */}
          {reportGroup !== 'all' && (() => {
            const g = GROUP_MAP[reportGroup]
            const cnt = stores.filter(s=>s.systemGroup===reportGroup).length
            return (
              <div className="sm-info" style={{marginBottom:12,padding:'8px 14px',fontSize:12}}>
                {g?.icon} Reporting on <strong style={{color:g?.color}}>{reportGroup}</strong> only
                — <strong>{cnt}</strong> stores · range <strong>{TIME_RANGES.find(r=>r.key===range)?.label}</strong>
              </div>
            )
          })()}

          {/* compute report-scoped stores */}
          {(()=>{
            const rStores = reportGroup==='all' ? stores : stores.filter(s=>s.systemGroup===reportGroup)
            const connBk  = overview?.summary?.connBreakdown || {}
            const rConnBk = reportGroup==='all' ? connBk : Object.fromEntries(
              Object.entries(connBk).map(([k])=>[k, rStores.filter(s=>s.connState===k).length]).filter(([,v])=>v>0)
            )

          return (
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14}}>
            {REPORT_TYPES.map((rt)=>(
              <div key={rt.key} className="sm-tr" style={{display:'flex',flexDirection:'column'}}>
                <div className="sm-tr-hd" style={{background:'var(--bg3)'}}>
                  <span style={{fontSize:13,fontWeight:700}}>{rt.icon} {rt.label}</span>
                  {downloading===rt.key && <span style={{fontSize:11,color:'var(--accent)',fontFamily:'var(--mono)'}}>Generating…</span>}
                </div>
                <div className="sm-tr-body" style={{flex:1,display:'flex',flexDirection:'column',gap:12}}>
                  <p style={{margin:0,fontSize:12,color:'var(--text2)',lineHeight:1.5}}>{rt.desc}</p>

                  {/* quick stats — all use rStores (group-filtered) */}
                  {rt.key==='inventory' && (
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
                      {[['Total',rStores.length,'var(--text)'],['Online',rStores.filter(s=>s.online).length,'var(--green)'],['Offline',rStores.filter(s=>!s.online).length,'var(--red)']].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:'center',background:'var(--bg3)',borderRadius:6,padding:'6px 4px'}}>
                          <div style={{fontSize:16,fontWeight:700,color:c}}>{v}</div>
                          <div style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase'}}>{l}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {rt.key==='uptime' && (
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                      {[
                        ['Uptime',`${pct(rStores.filter(s=>s.online).length,rStores.length||1).toFixed(1)}%`,'var(--green)'],
                        ['Issues',`${rStores.filter(s=>s.issueCount>0).length} stores`,'var(--amber)'],
                      ].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:'center',background:'var(--bg3)',borderRadius:6,padding:'6px 4px'}}>
                          <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                          <div style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase'}}>{l}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {rt.key==='issues' && (
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
                      {[
                        ['Critical', rStores.flatMap(s=>s.issues||[]).filter(i=>i.severity==='critical').length, SEV_COLORS.critical],
                        ['High',     rStores.flatMap(s=>s.issues||[]).filter(i=>i.severity==='high').length,     SEV_COLORS.high],
                        ['Warning',  rStores.flatMap(s=>s.issues||[]).filter(i=>i.severity==='warning').length,  SEV_COLORS.warning],
                      ].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:'center',background:'var(--bg3)',borderRadius:6,padding:'6px 4px'}}>
                          <div style={{fontSize:16,fontWeight:700,color:c}}>{v}</div>
                          <div style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase'}}>{l}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {rt.key==='connectivity' && (
                    <div style={{display:'flex',flexDirection:'column',gap:4}}>
                      {Object.entries(rConnBk).map(([k,v])=>(
                        <div key={k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:11}}>
                          <span style={{color:CONN_COLORS[k]||'var(--text2)'}}>{CONN_LABELS[k]||k}</span>
                          <span style={{fontFamily:'var(--mono)',fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {rt.key==='speedtest' && (() => {
                    const withDl = rStores.filter(s=>s.downloadMbps!=null&&s.downloadMbps>0)
                    const withUl = rStores.filter(s=>s.uploadMbps!=null&&s.uploadMbps>0)
                    const avgDl  = withDl.length ? withDl.reduce((a,s)=>a+s.downloadMbps,0)/withDl.length : 0
                    const avgUl  = withUl.length ? withUl.reduce((a,s)=>a+s.uploadMbps,0)/withUl.length   : 0
                    return (
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                        {[['Avg Download',`${avgDl.toFixed(1)} Mbps`,'#3b82f6'],['Avg Upload',`${avgUl.toFixed(1)} Mbps`,'#8b5cf6']].map(([l,v,c])=>(
                          <div key={l} style={{textAlign:'center',background:'var(--bg3)',borderRadius:6,padding:'6px 4px'}}>
                            <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                            <div style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase'}}>{l}</div>
                          </div>
                        ))}
                      </div>
                    )
                  })()}

                  <div style={{marginTop:'auto',display:'flex',gap:8}}>
                    <button className="sm-btn sm-sm primary" style={{flex:1,justifyContent:'center'}}
                      onClick={()=>downloadReport(rt.key)} disabled={!!downloading}>
                      {downloading===rt.key ? '⏳ Generating…' : '⬇ Download Excel'}
                    </button>
                    {rt.key==='inventory' && (
                      <button className="sm-btn sm-sm" onClick={()=>exportCSV(rStores,`inventory_${reportGroup==='all'?'all':reportGroup.replace(/ /g,'_')}_${new Date().toISOString().slice(0,10)}.csv`)}
                        title="Quick CSV export">CSV</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          ) /* end return */ })() /* end IIFE */}

          {/* issue detail table for quick view */}
          {(()=>{
            const rStores2 = reportGroup==='all' ? stores : stores.filter(s=>s.systemGroup===reportGroup)
            return (
          <div className="sm-tr" style={{marginTop:16}}>
            <div className="sm-tr-hd">
              <span className="sm-tr-title">⚠ Issues — Quick View{reportGroup!=='all'?` · ${reportGroup}`:''}</span>
              <button className="sm-btn sm-sm primary" onClick={()=>downloadReport('issues')} disabled={!!downloading}>
                {downloading==='issues'?'⏳':'⬇'} Excel
              </button>
            </div>
            <div className="sm-tr-body sm-tbl-wrap">
              <table className="sm-tbl">
                <thead><tr><th>Severity</th><th>Hostname</th><th>Group</th><th>Issue</th><th>Code</th><th>Connectivity</th><th>Last Seen</th></tr></thead>
                <tbody>
                  {rStores2.filter(s=>s.issueCount>0).flatMap(s=>
                    (s.issues||[]).map((iss,i)=>(
                      <tr key={`${s.storeTag}-${iss.code}-${i}`} className="clickable" onClick={()=>{setSelectedTag(s.storeTag);setTab('detail')}}>
                        <td><SevBadge sev={iss.severity}/></td>
                        <td style={{fontWeight:600}}>{s.hostname}</td>
                        <td><GroupBadge group={s.systemGroup}/></td>
                        <td>{iss.message}</td>
                        <td style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)'}}>{iss.code}</td>
                        <td><ConnPill state={s.connState}/></td>
                        <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{relAge(s.lastSeen)}</td>
                      </tr>
                    ))
                  )}
                  {!rStores2.some(s=>s.issueCount>0) && <tr><td colSpan={7} className="sm-empty">✅ No active issues</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
            ) /* end return */ })() /* end IIFE */}
        </>
      )}

      {/* ══════════ ALERT RULES ══════════ */}
      {tab==='alerts' && (
        <>
          <div className="sm-toolbar">
            <h3 style={{margin:0,fontSize:14,fontWeight:700,flex:1}}>Alert Rules</h3>
            <button className="sm-btn primary" onClick={()=>openAlertModal(null)}>+ New Rule</button>
          </div>

          <div className="sm-info" style={{fontSize:11}}>
            Rules evaluate live store data. Notifications go to Slack, Google Chat, or Email when conditions are met.
            Cooldown prevents repeated alerts.
          </div>

          {!alertRules.length
            ? <div className="sm-empty">No alert rules yet. Create one to get started.</div>
            : alertRules.map((rule) => (
              <div key={rule._id} className="sm-tr sm-section-mb" style={{borderLeft:`3px solid ${SEV_COLORS[rule.severity]||'#64748b'}`}}>
                <div className="sm-tr-hd">
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <span style={{fontSize:13,fontWeight:700}}>{rule.name}</span>
                    <SevBadge sev={rule.severity}/>
                    {rule.group!=='all' && <GroupBadge group={rule.group}/>}
                    <span className="sm-pill" style={{background:rule.enabled?'rgba(34,197,94,.15)':'rgba(100,116,139,.15)',color:rule.enabled?'var(--green)':'var(--text3)',fontSize:10}}>
                      {rule.enabled?'ENABLED':'DISABLED'}
                    </span>
                  </div>
                  <div style={{display:'flex',gap:6}}>
                    <button className="sm-btn sm-sm" onClick={()=>toggleAlert(rule)}>{rule.enabled?'Disable':'Enable'}</button>
                    <button className="sm-btn sm-sm" onClick={()=>openAlertModal(rule)}>Edit</button>
                    <button className="sm-btn sm-sm danger" onClick={()=>deleteAlert(rule._id)}>Delete</button>
                  </div>
                </div>
                <div className="sm-tr-body" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:'6px 20px',fontSize:12}}>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>CONDITION </span><br/>{rule.condition.metric} {BOOLEAN_METRICS.has(rule.condition.metric)?'=true':`${rule.condition.operator||'>'} ${rule.condition.threshold}`}</div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>GROUP </span><br/>{rule.group}</div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>COOLDOWN </span><br/>{rule.cooldownMinutes} min</div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>CHANNELS </span><br/>{(rule.channels||[]).map((c)=>c.type).join(', ')||'None'}</div>
                  {rule.lastFiredAt && <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>LAST FIRED </span><br/>{new Date(rule.lastFiredAt).toLocaleString()}</div>}
                </div>
              </div>
            ))
          }
        </>
      )}

      {/* ══════════ ALERT MODAL ══════════ */}
      {alertModal !== null && (
        <div className="sm-modal-bg" onClick={(e)=>e.target===e.currentTarget&&closeAlertModal()}>
          <div className="sm-modal">
            <div className="sm-modal-hd">
              <h3 className="sm-modal-title">{alertForm._id?'Edit Alert Rule':'New Alert Rule'}</h3>
              <button className="sm-modal-x" onClick={closeAlertModal}>✕</button>
            </div>

            <div className="sm-form">
              <div className="sm-form-row">
                <div className="sm-form-field">
                  <label className="sm-form-label">Rule Name *</label>
                  <input className="sm-input" value={alertForm.name} onChange={(e)=>setAlertForm((f)=>({...f,name:e.target.value}))} placeholder="e.g. ISP Down Alert"/>
                </div>
                <div className="sm-form-field">
                  <label className="sm-form-label">Severity</label>
                  <select className="sm-select" value={alertForm.severity} onChange={(e)=>setAlertForm((f)=>({...f,severity:e.target.value}))}>
                    <option value="critical">🔴 Critical</option>
                    <option value="high">🟠 High</option>
                    <option value="warning">🟡 Warning</option>
                  </select>
                </div>
              </div>

              <div className="sm-form-field">
                <label className="sm-form-label">Description</label>
                <input className="sm-input" value={alertForm.description} onChange={(e)=>setAlertForm((f)=>({...f,description:e.target.value}))} placeholder="Optional description…"/>
              </div>

              <div className="sm-form-row">
                <div className="sm-form-field">
                  <label className="sm-form-label">Target Group</label>
                  <select className="sm-select" value={alertForm.group} onChange={(e)=>setAlertForm((f)=>({...f,group:e.target.value}))}>
                    <option value="all">All Groups</option>
                    {GROUP_DEFS.map((g)=><option key={g.id} value={g.id}>{g.icon} {g.id}</option>)}
                  </select>
                </div>
                <div className="sm-form-field">
                  <label className="sm-form-label">Cooldown (minutes)</label>
                  <input className="sm-input" type="number" min={1} max={1440} value={alertForm.cooldownMinutes}
                    onChange={(e)=>setAlertForm((f)=>({...f,cooldownMinutes:+e.target.value}))}/>
                </div>
              </div>

              {/* condition */}
              <div className="sm-form-field">
                <label className="sm-form-label">Condition</label>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                  <select className="sm-select" value={alertForm.condition.metric}
                    onChange={(e)=>setAlertForm((f)=>({...f,condition:{...f.condition,metric:e.target.value}}))}>
                    {METRIC_OPTS.map((m)=><option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  {!BOOLEAN_METRICS.has(alertForm.condition.metric) && (
                    <>
                      <select className="sm-select" value={alertForm.condition.operator}
                        onChange={(e)=>setAlertForm((f)=>({...f,condition:{...f.condition,operator:e.target.value}}))}>
                        <option value="gt">&gt; greater than</option>
                        <option value="gte">≥ at least</option>
                        <option value="lt">&lt; less than</option>
                        <option value="lte">≤ at most</option>
                      </select>
                      <input className="sm-input" type="number" placeholder="Threshold" value={alertForm.condition.threshold}
                        onChange={(e)=>setAlertForm((f)=>({...f,condition:{...f.condition,threshold:+e.target.value}}))}/>
                    </>
                  )}
                </div>
                {(alertForm.condition.metric==='latency'||alertForm.condition.metric==='packet_loss') && (
                  <input className="sm-input" placeholder="Ping target (default: 8.8.8.8)" style={{marginTop:6}} value={alertForm.condition.target}
                    onChange={(e)=>setAlertForm((f)=>({...f,condition:{...f.condition,target:e.target.value}}))}/>
                )}
              </div>

              {/* channels */}
              <div className="sm-form-field">
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                  <label className="sm-form-label">Notification Channels</label>
                  <div style={{display:'flex',gap:6}}>
                    <button className="sm-btn sm-sm" onClick={()=>addChannel('slack')}>+ Slack</button>
                    <button className="sm-btn sm-sm" onClick={()=>addChannel('google_chat')}>+ Google Chat</button>
                    <button className="sm-btn sm-sm" onClick={()=>addChannel('email')}>+ Email</button>
                  </div>
                </div>
                {!alertForm.channels.length && <div style={{fontSize:12,color:'var(--text3)'}}>No channels — add at least one to receive notifications.</div>}
                <div className="sm-ch-list">
                  {alertForm.channels.map((ch,i)=>(
                    <div key={i} className="sm-ch-item">
                      <div className="sm-ch-icon">{ch.type==='slack'?'💬':ch.type==='google_chat'?'💬':'📧'}</div>
                      <div className="sm-ch-body">
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                          <span style={{fontSize:12,fontWeight:700,textTransform:'capitalize'}}>{ch.type.replace('_',' ')}</span>
                          <div style={{display:'flex',gap:6,alignItems:'center'}}>
                            <span style={{fontSize:11,color:'var(--text3)'}}>{testResult[ch.type]||''}</span>
                            <button className="sm-btn sm-sm" onClick={()=>testCh(ch)}>Test</button>
                            <button className="sm-btn sm-sm danger" onClick={()=>removeChannel(i)}>✕</button>
                          </div>
                        </div>
                        {(ch.type==='slack'||ch.type==='google_chat') && (
                          <input className="sm-input" style={{width:'100%',marginTop:4}} placeholder="Webhook URL"
                            value={ch.webhookUrl} onChange={(e)=>updateChannel(i,{webhookUrl:e.target.value})}/>
                        )}
                        {ch.type==='email' && (
                          <input className="sm-input" style={{width:'100%',marginTop:4}} placeholder="Comma-separated email addresses"
                            value={(ch.emails||[]).join(', ')} onChange={(e)=>updateChannel(i,{emails:e.target.value.split(',').map((s)=>s.trim()).filter(Boolean)})}/>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{display:'flex',gap:8,justifyContent:'flex-end',paddingTop:4,borderTop:'1px solid var(--border)'}}>
              <button className="sm-btn" onClick={closeAlertModal}>Cancel</button>
              <button className="sm-btn primary" onClick={saveAlert} disabled={alertSaving}>
                {alertSaving?'Saving…':alertForm._id?'Save Changes':'Create Rule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

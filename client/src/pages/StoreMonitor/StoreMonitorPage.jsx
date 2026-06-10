import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io as ioClient } from 'socket.io-client'
import { Bar, Chart, Doughnut, Line } from 'react-chartjs-2'
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
import { resolvedApiBase, resolvedWsUrl } from '../../utils/backendOrigin.js'
import {
  buildManualRopStoreList,
  parseManualStoreCodes,
} from '../../config/manualRopSdwanStoreCodes.js'

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip)

/* ─── constants ──────────────────────────────────── */
const TABS = [
  { id: 'noc',        label: 'NOC Overview',    icon: '🖥' },
  { id: 'stores',     label: 'Stores',          icon: '🏪' },
  { id: 'problems',   label: 'Problems',        icon: '⚠' },
  { id: 'netHealth',  label: 'Net Health',      icon: '📶' },
  { id: 'detail',     label: 'Store Detail',    icon: '🔍' },
  { id: 'rop',        label: 'ROP Groups',      icon: '📡' },
  { id: 'probHist',   label: 'Problem History', icon: '🕓' },
  { id: 'crashes',    label: 'Crash Events',    icon: '💥' },
  { id: 'reports',    label: 'Reports',         icon: '📊' },
  { id: 'alerts',     label: 'Alert Rules',     icon: '🔔' },
]

const ROP_SUBTABS = [
  { id: 'all',          label: 'All ROP',              icon: '📡' },
  { id: 'sdwan',        label: 'ROP + SD-WAN',          icon: '🛡' },
  { id: 'no_sdwan',     label: 'ROP without SD-WAN',    icon: '🔗' },
  { id: 'manual_sdwan', label: 'Manual ROP + SD-WAN',   icon: '📋' },
]

const REPORT_TYPES = [
  { key: 'inventory',    label: 'Store Inventory',      icon: '🏪', desc: 'Full store list with connectivity, ping, CPU, RAM and speedtest data for all stores.' },
  { key: 'uptime',       label: 'Uptime Report',        icon: '⏱', desc: 'Online/offline status per store and group. Highlights stores that went offline during the period.' },
  { key: 'issues',       label: 'Issues Report',        icon: '⚠',  desc: 'All active issues with severity, issue code, affected store and last-seen time.' },
  { key: 'connectivity', label: 'Connectivity Report',  icon: '🌐', desc: 'Connectivity state breakdown (LAN/Wi-Fi/ISP Down/Hotspot) per store and as summary.' },
  { key: 'speedtest',    label: 'Speedtest Report',     icon: '⚡', desc: 'Download & upload speeds sorted by performance. Group averages included.' },
  { key: 'manual_sdwan_daily_disconnect', label: 'Manual ROP + SD-WAN Daily Disconnects', icon: '📋', desc: 'Per-store day-wise disconnection counts for Manual ROP + SD-WAN in business hours.' },
  { key: 'rop_no_sdwan_daily_disconnect', label: 'ROP without SD-WAN Daily Disconnects',  icon: '🔗', desc: 'Per-store day-wise disconnection counts for ROP without SD-WAN in business hours.' },
]
const DAILY_DISCONNECT_REPORT_GROUP = {
  manual_sdwan_daily_disconnect: 'Manual ROP + SD-WAN',
  rop_no_sdwan_daily_disconnect: 'ROP without SD-WAN',
}

const TIME_RANGES = [
  { key: '-15m', label: '15 Min' },
  { key: '-1h',  label: '1 Hour' },
  { key: '-3h',  label: '3 Hours' },
  { key: '-6h',  label: '6 Hours' },
  { key: '-12h', label: '12 Hours' },
  { key: '-24h', label: '24 Hours' },
  { key: '-2d',  label: '2 Days' },
  { key: '-7d',  label: '7 Days' },
]
const HISTORY_SECS = { '-15m': 900, '-1h': 3600, '-3h': 10800, '-6h': 21600, '-12h': 43200, '-24h': 86400, '-2d': 172800, '-7d': 604800, '-30d': 30 * 86400 }

function friendlyApiError(e) {
  const raw = String(e?.response?.data?.error || e?.message || 'Failed to fetch data')
  if (/fetch failed|cannot connect to influxdb|ECONNREFUSED|ENOTFOUND/i.test(raw)) {
    return 'Cannot reach InfluxDB from the Netpulse server — check INFLUX_URL (http://192.168.10.204:8086) and firewall/port 8086.'
  }
  return raw
}

function isBenignFetchError(e) {
  const msg = String(e?.message || '').toLowerCase()
  const code = String(e?.code || '')
  return (
    e?.name === 'AbortError' ||
    e?.name === 'CanceledError' ||
    code === 'ERR_CANCELED' ||
    /aborted|cancelled|canceled|terminated/.test(msg)
  )
}

function toLocalInput(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(str) {
  if (!str) return null
  const d = new Date(str)
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000)
}

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
const EXTRA_GROUP_META = {
  'Manual ROP + SD-WAN': { color: '#a855f7', icon: '📋' },
  'ROP without SD-WAN':  { color: '#0ea5e9', icon: '📡' },
}
function groupMetaFor(name) {
  return GROUP_MAP[name] || EXTRA_GROUP_META[name] || { color: '#64748b', icon: '🏷' }
}
function shortGroupLabel(name) {
  return name.endsWith(' Group') ? name.replace(' Group', '') : name
}
function fmtOfflineMinutes(mins) {
  const n = Number(mins || 0)
  if (n <= 0) return '0m'
  const h = Math.floor(n / 60)
  const m = n % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
function dayWindowMinutes(dayMs, bh) {
  const day = new Date(dayMs)
  day.setHours(0, 0, 0, 0)
  const now = new Date()
  const isToday = day.toDateString() === now.toDateString()
  const dow = day.getDay()

  if (bh?.enabled) {
    if (!bh.weekdays.includes(dow)) return 0
    const totalMins = Math.max(0, (bh.endHour - bh.startHour) * 60)
    if (!isToday) return totalMins
    const curMins = now.getHours() * 60 + now.getMinutes()
    const bhStartMins = bh.startHour * 60
    const bhEndMins = bh.endHour * 60
    if (curMins <= bhStartMins) return 0
    return Math.min(totalMins, curMins - bhStartMins)
  }

  if (!isToday) return 1440
  return now.getHours() * 60 + now.getMinutes()
}
function uptimePctForDay(offlineMinutes, storeCount, windowMins) {
  const possible = (storeCount || 0) * (windowMins || 0)
  if (possible <= 0) return null
  const off = Math.max(0, Number(offlineMinutes) || 0)
  return Math.max(0, Math.min(100, ((possible - off) / possible) * 100))
}
function uptimeColor(pct) {
  if (pct == null) return 'var(--text3)'
  if (pct >= 99) return '#22c55e'
  if (pct >= 95) return '#f59e0b'
  return '#ef4444'
}
function fmtUptimePct(pct) {
  if (pct == null) return '—'
  if (pct >= 99.95) return '100%'
  return `${pct.toFixed(2)}%`
}
function fmtDurationMin(mins) {
  if (mins == null) return '—'
  const n = Math.max(0, Math.round(Number(mins) || 0))
  if (n <= 0) return '<1m'
  if (n < 60) return `${n}m`
  const h = Math.floor(n / 60)
  const m = n % 60
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d}d ${rh}h` : `${d}d`
}
function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
function downloadDisconnectEventsCsv(groupId, events) {
  if (!events?.length) return
  const header = ['store_tag', 'hostname', 'disconnect_at', 'reconnect_at', 'duration_minutes', 'still_offline']
  const rows = events.map((e) => [
    e.storeTag,
    e.hostname || '',
    e.disconnectTs ? new Date(e.disconnectTs * 1000).toISOString() : '',
    e.reconnectTs ? new Date(e.reconnectTs * 1000).toISOString() : '',
    e.durationMin ?? '',
    e.stillOffline ? 'true' : 'false',
  ])
  const csv = [header, ...rows].map((r) => r.map((c) => {
    const s = String(c ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const safe = String(groupId || 'group').replace(/[^A-Za-z0-9._-]+/g, '_')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  a.download = `disconnect_events_${safe}_${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url) }, 250)
}
function buildSingleGroupDisconnectChart(group, days, groupName, tc) {
  if (!group || !days?.length) return null
  const color = groupMetaFor(groupName).color
  const labels = days.map((d) =>
    new Date(d.dayMs).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  )
  const disconnectSeries = days.map((d) => {
    const day = group.days.find((x) => x.dayMs === d.dayMs)
    return day?.disconnections ?? 0
  })
  const avgDisconnects = disconnectSeries.length
    ? disconnectSeries.reduce((sum, v) => sum + v, 0) / disconnectSeries.length
    : 0
  const avgSeries = disconnectSeries.map(() => Number(avgDisconnects.toFixed(2)))
  return {
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'Disconnect Events',
          data: disconnectSeries,
          backgroundColor: color + '88',
          borderColor: color,
          borderWidth: 1.5,
          yAxisID: 'y',
        },
        {
          type: 'line',
          label: 'Average / Day',
          data: avgSeries,
          borderColor: color,
          backgroundColor: color,
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0,
          yAxisID: 'y',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: tc.text2, font: { family: 'var(--mono)', size: 9 }, boxWidth: 10 },
        },
        tooltip: {
          backgroundColor: tc.bg2,
          titleColor: tc.text,
          bodyColor: tc.text2,
          borderColor: tc.border,
          borderWidth: 1,
          callbacks: {
            afterLabel: (ctx) => {
              const day = group.days.find((x, i) => i === ctx.dataIndex)
              if (!day) return ''
              const m = day.offlineMinutes || 0
              const h = Math.floor(m / 60)
              const r = m % 60
              const dur = h > 0 ? `${h}h ${r}m` : `${m}m`
              return `Offline: ${dur} · Stores down: ${day.storesDown ?? day.disconnections ?? 0}`
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: tc.text3, font: { family: 'var(--mono)', size: 9 }, maxRotation: 45 },
          grid: { color: tc.border + '40' },
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'Disconnect Events', color: tc.text3, font: { family: 'var(--mono)', size: 10 } },
          ticks: { color: tc.text3, font: { family: 'var(--mono)', size: 9 }, precision: 0 },
          grid: { color: tc.border + '40' },
          beginAtZero: true,
        },
      },
    },
  }
}

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
  { value: 'crash_count',   label: '💥 App Crash Count' },
]
const BOOLEAN_METRICS = new Set(['offline', 'isp_down', 'hotspot', 'dns_fail', 'http_fail'])

/* ─── helpers ────────────────────────────────────── */
/**
 * Returns ALL groups a device belongs to.
 * A device with RP prefix AND Fortinet vendor → ['RP Group', 'SD-WAN Group']
 * Rules are ADDITIVE — Fortinet never replaces the hostname-based group.
 */
function vendorIsFortinet(vendor, flag = false) {
  return flag === true || /fortinet|fortigate/i.test(String(vendor || ''))
}

function deriveGroups(hostname, vendor, isFortinet, lastVendor = '', lastIsFortinet = false) {
  const h = String(hostname || '').toUpperCase()
  const groups = []
  // Hostname-based group (primary identity)
  if (h.startsWith('RP')) groups.push('RP Group')
  else if (h.startsWith('LK')) groups.push('POS System Group')
  // SD-WAN: current gateway OR last-known gateway (7d) was Fortinet — includes offline stores.
  if (vendorIsFortinet(vendor, isFortinet) || vendorIsFortinet(lastVendor, lastIsFortinet)) {
    groups.push('SD-WAN Group')
  }
  // If nothing matched fall back to General
  if (groups.length === 0) groups.push('General Group')
  return groups
}
/** Convenience: primary group (first in list, used for single-badge contexts) */
function deriveGroup(hostname, vendor, isFortinet, lastVendor, lastIsFortinet) {
  return deriveGroups(hostname, vendor, isFortinet, lastVendor, lastIsFortinet)[0]
}

function ropSubTabLabel(id) {
  if (id === 'sdwan') return 'ROP + SD-WAN'
  if (id === 'no_sdwan') return 'ROP without SD-WAN'
  if (id === 'manual_sdwan') return 'Manual ROP + SD-WAN'
  return 'All ROP'
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
const VENDOR_FALLBACKS = new Set(['unknown', 'unidentified', 'n/a', 'none', ''])
const fmtVendor = (v) => (!v || VENDOR_FALLBACKS.has(String(v).toLowerCase().trim())) ? '—' : v

const CRASH_TYPE_META = {
  app_crash:           { label: 'App Crash',          sev: 'error',    color: '#f97316', icon: '💥', evtId: '1000',         src: 'Application Log' },
  app_wer_report:      { label: 'WER Report',         sev: 'error',    color: '#f59e0b', icon: '📋', evtId: '1001',         src: 'Application Log' },
  app_hang:            { label: 'App Hang',            sev: 'error',    color: '#eab308', icon: '⏸',  evtId: '1002',         src: 'Application Log' },
  dotnet_crash:        { label: '.NET Crash',         sev: 'error',    color: '#8b5cf6', icon: '🔷', evtId: '1026',         src: 'Application Log' },
  app_critical:        { label: 'App Critical',       sev: 'critical', color: '#ef4444', icon: '🔴', evtId: 'Any',          src: 'Application Log' },
  service_crash:       { label: 'Service Crash',      sev: 'error',    color: '#f97316', icon: '⚙',  evtId: '7031 / 7034',  src: 'System Log' },
  unexpected_shutdown: { label: 'Unexpected Shutdown',sev: 'error',    color: '#f59e0b', icon: '⚡', evtId: '6008',         src: 'System Log' },
  bsod_kernel_power:   { label: 'BSOD / Kernel',      sev: 'critical', color: '#dc2626', icon: '💀', evtId: '41',           src: 'System Log' },
  app_crash_wer:       { label: 'WER Folder Crash',   sev: 'error',    color: '#06b6d4', icon: '📁', evtId: '—',            src: 'WER Folder' },
}
function crashMeta(type) { return CRASH_TYPE_META[type] || { label: type||'Unknown', sev:'error', color:'#64748b', icon:'❓', evtId:'—', src:'—' } }
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

/**
 * Build a time-series chart anchored to the FULL requested window.
 *
 * Key behaviours:
 * - Generates a uniform time grid from windowFromSec → windowToSec so the
 *   x-axis always shows the full range (e.g. 6 hours), not just where data exists.
 * - Periods with no data (device offline) appear as gaps / blank space.
 * - spanGaps=false (default) means Chart.js does NOT connect across nulls → visible gaps.
 *
 * @param {object[]} series
 * @param {object}   tc               theme colours
 * @param {string}   [yLabel]
 * @param {object}   [opts]
 * @param {number}   [opts.yMin]
 * @param {number}   [opts.yMax]
 * @param {number}   [opts.windowFromSec]  start of range (Unix sec); anchors left edge
 * @param {number}   [opts.windowToSec]    end of range (Unix sec); anchors right edge
 * @param {number}   [opts.agentIntervalSec=60]   expected gap between data points
 * @param {number}   [opts.maxTicks=400]   max x-axis ticks (downsampled if needed)
 */
function buildTimeChart(series, tc, yLabel = '', _legacy = 350, opts = {}) {
  const {
    yMin, yMax,
    windowFromSec, windowToSec,
    agentIntervalSec = 60,
    maxTicks = 400,
    bhFilter,
  } = opts

  const active = (series || []).filter((s) => (s.points || []).length > 0)

  // Even if no data, if we have a window we can render the empty range
  const nowSec = Math.floor(Date.now() / 1000)
  const winFrom = windowFromSec ?? (active.length
    ? Math.min(...active.flatMap((s) => s.points.map((p) => Number(p.clock))))
    : nowSec - 3600)
  const winTo   = windowToSec ?? (active.length
    ? Math.max(...active.flatMap((s) => s.points.map((p) => Number(p.clock))))
    : nowSec)

  // Generate a uniform grid every agentIntervalSec across the full window
  const rawTicks = []
  for (let t = winFrom; t <= winTo + agentIntervalSec; t += agentIntervalSec) rawTicks.push(t)

  // Downsample if needed
  let ticks = rawTicks
  if (ticks.length > maxTicks) {
    const step = Math.ceil(ticks.length / maxTicks)
    ticks = ticks.filter((_, i) => i % step === 0 || i === ticks.length - 1)
  }

  // Always include winFrom and winTo as boundary ticks
  if (ticks[0] > winFrom) ticks.unshift(winFrom)
  if (ticks[ticks.length - 1] < winTo) ticks.push(winTo)

  const labels = ticks.map((c) =>
    new Date(c * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  )

  if (!active.length) {
    // No data — return empty chart with correct x-axis
    return {
      data: { labels, datasets: [{ label: 'No data', data: ticks.map(() => null), borderColor: '#475569', backgroundColor: 'transparent', borderWidth: 0 }] },
      yLabel, scaleOpts: { min: yMin, max: yMax },
      isEmpty: true,
    }
  }

  const tolerance = agentIntervalSec * 1.6   // ±1.6 intervals to match a tick to a data point

  const datasets = active.slice(0, 8).map((s, i) => {
    const hex = PAL[i % PAL.length]
    // Map clock → value
    const pts = (s.points || [])
      .map((p) => ({ t: Number(p.clock), v: Number(p.value) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t)

    const data = ticks.map((tick) => {
      // If a business-hours filter is active, ticks outside BH must always be null
      // so that BH data points near the boundary don't bleed into non-BH slots.
      if (bhFilter && !bhFilter(tick)) return null
      // Binary-search for the nearest point within tolerance
      let lo = 0; let hi = pts.length - 1; let best = null; let bestDist = Infinity
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const dist = Math.abs(pts[mid].t - tick)
        if (dist < bestDist) { bestDist = dist; best = pts[mid] }
        if (pts[mid].t < tick) lo = mid + 1; else hi = mid - 1
      }
      return best && bestDist <= tolerance ? best.v : null
    })

    const cleanName = (s.field || s.name || '')
      .replace(/^(ping\.|system\.|speedtest\.|connectivity\.)/,'')
      .replace(/_/g,' ')
    const targetSuffix = s.target ? ` (${s.target})` : ''

    return {
      label: cleanName + targetSuffix,
      data,
      borderColor: hex,
      backgroundColor: 'transparent',
      tension: 0.25,
      spanGaps: false,      // ← gaps = offline periods, never connect
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 1.5,
      fill: false,
    }
  })

  const scaleOpts = {}
  if (yMin !== undefined) scaleOpts.min = yMin
  if (yMax !== undefined) scaleOpts.max = yMax

  return { data: { labels, datasets }, yLabel, scaleOpts }
}

/**
 * Build a smooth time-series chart for **already aggregated** data (e.g. Flux
 * aggregateWindow output that's uniformly spaced).
 *
 * Differences from buildTimeChart:
 *  - Uses the actual data timestamps as the x-axis (no tick resampling →
 *    no proximity gaps, no dotted line look).
 *  - spanGaps=true so the line stays continuous across short data gaps.
 *  - Auto-picks a tight y-max for small-value series (e.g. packet-loss is
 *    usually 0–5% so capping at 100% wastes the chart area).
 *  - Small visible point markers + smooth tension.
 *  - Optional bhFilter excludes points whose timestamp falls outside BH.
 *
 * @param {object[]} series  [{ name|field, target?, points:[{clock,value}] }]
 * @param {object}   tc      theme colours
 * @param {object}   [opts]
 * @param {string}   [opts.yLabel='']
 * @param {number}   [opts.yMin=0]
 * @param {number}   [opts.yMax]              hard cap; defaults to auto
 * @param {number}   [opts.yMaxCeiling]       only used when yMax is auto; clamps the auto pick
 * @param {(clockSec:number)=>boolean} [opts.bhFilter]
 * @param {number}   [opts.decimals=2]        tooltip decimal places
 */
function buildAggregateLineChart(series, tc, opts = {}) {
  const {
    yLabel = '',
    yMin,                // hard lower bound (e.g. 0). When undefined, auto-scaling is used.
    yMax,                // hard upper bound. When undefined, auto-scaling is used.
    yMaxCeiling,         // when yMax is auto, clamp to this maximum
    yMinFloor = 0,       // when yMin is auto, never go below this
    bhFilter,
    decimals = 2,
  } = opts

  // Filter + sort + collect timestamps
  const cleaned = (series || []).map((s) => {
    const pts = (s.points || [])
      .filter((p) => Number.isFinite(Number(p.clock)) && Number.isFinite(Number(p.value)))
      .filter((p) => !bhFilter || bhFilter(Number(p.clock)))
      .map((p) => ({ t: Number(p.clock), v: Number(p.value) }))
      .sort((a, b) => a.t - b.t)
    return { ...s, _pts: pts }
  }).filter((s) => s._pts.length > 0)

  if (!cleaned.length) {
    return { data: { labels: [], datasets: [] }, isEmpty: true, yLabel,
      scaleOpts: { min: yMin ?? yMinFloor, max: yMax }, stats: [] }
  }

  // Union of timestamps across all series → one shared x-axis
  const tsSet = new Set()
  for (const s of cleaned) for (const p of s._pts) tsSet.add(p.t)
  const ts = [...tsSet].sort((a, b) => a - b)
  const labels = ts.map((t) =>
    new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  )

  // Build per-series value arrays + per-series stats (min/max/avg/latest)
  const stats = []
  const datasets = cleaned.slice(0, 12).map((s, i) => {
    const hex = PAL[i % PAL.length]
    const map = new Map(s._pts.map((p) => [p.t, p.v]))
    const data = ts.map((t) => (map.has(t) ? map.get(t) : null))
    const cleanName = (s.field || s.name || '').replace(/^(ping\.|system\.|speedtest\.|connectivity\.|dns\.|http\.)/,'').replace(/_/g,' ')
    const targetSuffix = s.target ? ` (${s.target})` : ''
    const label = (cleanName + targetSuffix).trim()

    const vals = s._pts.map((p) => p.v)
    const sum = vals.reduce((a, v) => a + v, 0)
    stats.push({
      label,
      target: s.target,
      color: hex,
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: vals.length ? sum / vals.length : 0,
      latest: vals[vals.length - 1],
      n: vals.length,
    })

    return {
      label,
      data,
      borderColor: hex,
      backgroundColor: `${hex}25`,
      tension: 0.35,
      spanGaps: true,        // keep line continuous across short data holes
      pointRadius: 2.4,
      pointHoverRadius: 6,
      borderWidth: 2,
      fill: false,
    }
  })

  // ── y-axis auto-scaling ──
  // Goal: zoom around (min, max) so even small fleet-wide variations are visible.
  let observedMin = Infinity
  let observedMax = -Infinity
  for (const s of cleaned) for (const p of s._pts) {
    if (p.v < observedMin) observedMin = p.v
    if (p.v > observedMax) observedMax = p.v
  }
  if (!Number.isFinite(observedMin) || !Number.isFinite(observedMax)) {
    observedMin = 0; observedMax = 1
  }
  const range = Math.max(observedMax - observedMin, 0.0001)
  const pad   = range * 0.18

  let resolvedYMin = yMin
  if (resolvedYMin == null) {
    resolvedYMin = Math.max(yMinFloor, observedMin - pad)
    // If everything sits well above the floor, pick a snappier round value
    if (resolvedYMin > yMinFloor) {
      const step = niceAxisStep(range)
      resolvedYMin = Math.floor(resolvedYMin / step) * step
      if (resolvedYMin < yMinFloor) resolvedYMin = yMinFloor
    }
  }

  let resolvedYMax = yMax
  if (resolvedYMax == null) {
    const candidate = observedMax + pad
    const step = niceAxisStep(range)
    resolvedYMax = Math.ceil(candidate / step) * step
    if (yMaxCeiling != null) resolvedYMax = Math.min(resolvedYMax, yMaxCeiling)
  }
  if (resolvedYMax <= resolvedYMin) resolvedYMax = resolvedYMin + Math.max(range, 1)

  return {
    data: { labels, datasets },
    yLabel,
    scaleOpts: { min: resolvedYMin, max: resolvedYMax },
    decimals,
    stats,
  }
}

/** Pick a "nice" axis step roughly proportional to the data range. */
function niceAxisStep(range) {
  if (range <= 0.5)   return 0.05
  if (range <= 1)     return 0.1
  if (range <= 2)     return 0.2
  if (range <= 5)     return 0.5
  if (range <= 10)    return 1
  if (range <= 25)    return 2
  if (range <= 50)    return 5
  if (range <= 100)   return 10
  if (range <= 500)   return 50
  return 100
}

/** Build chart options tuned for aggregate line charts (rounded tooltips, dense ticks ok). */
function buildAggregateChartOptions(tc, yLabel = '', scaleOpts = {}, decimals = 2) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { color: tc.text2, boxWidth: 10, font: { size: 10 }, padding: 10 } },
      tooltip: {
        mode: 'index',
        intersect: false,
        callbacks: {
          label: (ctx) => {
            if (ctx.parsed.y == null) return null
            const v = Number(ctx.parsed.y).toFixed(decimals)
            return ` ${ctx.dataset.label}: ${v}${yLabel ? ' ' + yLabel : ''}`
          },
        },
      },
    },
    scales: {
      x: { ticks: { color: tc.text3, font: { size: 10 }, maxTicksLimit: 10, autoSkip: true }, grid: { color: tc.border } },
      y: { ticks: { color: tc.text3, font: { size: 10 } }, grid: { color: tc.border }, ...scaleOpts },
    },
  }
}

function buildChartOptions(tc, yLabel = '', scaleOpts = {}, extras = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: tc.text2, boxWidth: 10, font: { size: 10 }, padding: 10 } },
      tooltip: { mode: 'index', intersect: false, callbacks: {
        label: (ctx) => ctx.parsed.y !== null ? ` ${ctx.dataset.label}: ${ctx.parsed.y}${yLabel ? ' ' + yLabel : ''}` : null,
      }},
    },
    scales: {
      x: { ticks: { color: tc.text3, font: { size: 10 }, maxTicksLimit: 8 }, grid: { color: tc.border } },
      y: { ticks: { color: tc.text3, font: { size: 10 } }, grid: { color: tc.border }, ...scaleOpts },
    },
    ...extras,
  }
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
/* ── rop sub-tabs ── */
.sm-subtabs { display:flex; gap:2px; flex-wrap:wrap; margin-bottom:12px;
  background:var(--bg3); border:1px solid var(--border); border-radius:var(--sm-r); padding:3px; }
.sm-subtab { display:inline-flex; align-items:center; gap:5px; padding:4px 14px; border-radius:6px; border:none;
  background:transparent; color:var(--text3); font-size:11px; font-weight:600; cursor:pointer;
  transition:all .12s; font-family:var(--sans); white-space:nowrap; }
.sm-subtab:hover { background:var(--bg2); color:var(--text2); }
.sm-subtab.active { background:var(--bg); color:var(--text); box-shadow:0 1px 4px rgba(0,0,0,.18); }
.sm-subtab-count { background:var(--bg3); color:var(--text2); font-size:9px; font-weight:800;
  border-radius:999px; min-width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center; padding:0 3px; }
.sm-subtab.active .sm-subtab-count { background:rgba(0,0,0,.12); }

/* ── crash event modal ── */
.sm-crash-modal { background:var(--bg); border:1px solid var(--border2); border-radius:var(--sm-r-lg);
  padding:0; width:min(760px,97vw); max-height:90vh; overflow-y:auto;
  display:flex; flex-direction:column; box-shadow:0 8px 40px rgba(0,0,0,.55); }
.sm-crash-modal-hd { display:flex; align-items:center; justify-content:space-between; padding:14px 18px;
  border-bottom:1px solid var(--border); background:var(--bg3); border-radius:var(--sm-r-lg) var(--sm-r-lg) 0 0; }
.sm-crash-modal-body { padding:16px 18px; display:flex; flex-direction:column; gap:14px; }
.sm-crash-meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:6px; }
.sm-crash-meta-item { background:var(--bg3); border:1px solid var(--border); border-radius:7px;
  padding:7px 11px; display:flex; flex-direction:column; gap:2px; }
.sm-crash-meta-label { font-size:9.5px; font-family:var(--mono); color:var(--text3); text-transform:uppercase; letter-spacing:.06em; }
.sm-crash-meta-val { font-size:12.5px; font-weight:700; font-family:var(--mono); word-break:break-all; }
/* ── alert feed ── */
.sm-alert-feed { display:flex; flex-direction:column; gap:6px; }
.sm-alert-card { background:var(--bg2); border:1px solid var(--border); border-radius:var(--sm-r); overflow:hidden; }
.sm-alert-card-hd { display:flex; align-items:center; gap:10px; padding:9px 13px; border-bottom:1px solid var(--border); background:var(--bg3); }
.sm-alert-card-body { padding:10px 13px; font-size:11px; }
.sm-alert-stores { display:flex; flex-direction:column; gap:2px; margin-top:6px; }
.sm-alert-store-row { font-size:10px; font-family:var(--mono); color:var(--text3); padding:2px 0; }
.sm-alert-subtabs { display:flex; gap:2px; margin-bottom:10px; border-bottom:1px solid var(--border); }
.sm-alert-subtab { padding:6px 14px; border:none; background:transparent; color:var(--text3); font-size:12px; font-weight:600; cursor:pointer; border-bottom:2px solid transparent; font-family:var(--sans); transition:all .12s; }
.sm-alert-subtab:hover { color:var(--text2); }
.sm-alert-subtab.active { color:var(--accent); border-bottom-color:var(--accent); }
`

/* ─── component ──────────────────────────────────── */
export default function StoreMonitorPage() {
  const theme      = useThemeStore((s) => s.theme)
  const tc         = useMemo(() => getThemeCssColors(theme), [theme])
  const [tab, setTabRaw] = useUrlTab('noc', TABS.map((t) => t.id), 'smtab')
  const [range, setRange] = useState('-15m')
  /* global custom time range */
  const _nowDef = new Date()
  const [globalCustom, setGlobalCustom] = useState({
    enabled: false,
    from: toLocalInput(new Date(_nowDef.getTime() - 1 * 3600 * 1000)),
    to:   toLocalInput(_nowDef),
  })
  const [meta, setMeta] = useState(undefined)  // undefined = loading, null = failed, object = loaded
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
  const [bh, setBh] = useState({ enabled: false, startHour: 11, endHour: 20, weekdays: [0,1,2,3,4,5,6] })
  const [bhPanelOpen, setBhPanelOpen] = useState(false)

  /* custom time range for charts */
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 6 * 3600 * 1000)
  const [customHist, setCustomHist] = useState({
    enabled: false,
    from: toLocalInput(defaultFrom),
    to:   toLocalInput(now),
  })
  /* searchable store picker */
  const [storeSearch, setStoreSearch] = useState('')
  const [storePickerOpen, setStorePickerOpen] = useState(false)
  const storePickerRef = useRef(null)

  /* crash events */
  const [crashData, setCrashData] = useState(null)
  const [crashLoading, setCrashLoading] = useState(false)
  const [crashSearch, setCrashSearch] = useState('')
  const [crashAppFilter, setCrashAppFilter] = useState('')
  const [crashTypeFilter, setCrashTypeFilter] = useState('')
  const [crashModal, setCrashModal] = useState(null)   // selected crash summary row
  const [crashRawRows, setCrashRawRows] = useState([]) // raw event rows for modal
  const [crashRawLoading, setCrashRawLoading] = useState(false)

  /* reports */
  const [downloading, setDownloading] = useState('')
  const [reportGroup, setReportGroup] = useState('all')
  /* alert engine status */
  const [evalStatus, setEvalStatus] = useState(null)
  const [evalRunning, setEvalRunning] = useState(false)
  /* alert sub-tabs and feeds */
  const [alertSubTab, setAlertSubTab] = useState('live')  // 'rules' | 'live' | 'history'
  const [liveAlerts, setLiveAlerts] = useState([])         // WebSocket events this session
  const [alertHistory, setAlertHistory] = useState([])    // DB history
  const [histTotal, setHistTotal] = useState(0)
  const [alertHistLoading, setAlertHistLoading] = useState(false)
  const socketRef = useRef(null)
  const loadOverviewRef = useRef(null)
  const overviewRef = useRef(null)

  /* alerts */
  const [alertRules, setAlertRules]     = useState([])
  const [alertModal, setAlertModal]     = useState(null) // null | {rule?}
  const [alertForm, setAlertForm]       = useState(blankRule())
  const [alertSaving, setAlertSaving]   = useState(false)
  const [testResult, setTestResult]     = useState({})

  const [ropSubTab, setRopSubTab] = useState('all')
  const [ropSearch, setRopSearch] = useState('')
  const [ropStatusFilter, setRopStatusFilter] = useState('')
  const [ropConnFilter, setRopConnFilter] = useState('')

  /* ── net health time-series (aggregate across fleet for selected range) ── */
  const [netHist, setNetHist] = useState(null)
  const [netHistLoading, setNetHistLoading] = useState(false)
  const [netHistError, setNetHistError] = useState('')

  /* ── per-group time-series for the Group × Day health matrix ── */
  const [groupHist, setGroupHist] = useState(null)
  const [groupHistLoading, setGroupHistLoading] = useState(false)
  /* ── day-wise group disconnections/offline report (one API call per group) ── */
  const [groupDisconnectById, setGroupDisconnectById] = useState({})
  const [groupDisconnectLoadingById, setGroupDisconnectLoadingById] = useState({})
  const [groupDisconnectErrorById, setGroupDisconnectErrorById] = useState({})
  const groupDisconnectReqSeqRef = useRef(0)

  /* ── per-store disconnect events timeline (one group at a time) ── */
  const [disconnectEventsExpandedGroup, setDisconnectEventsExpandedGroup] = useState(null)
  const [disconnectEventsByGroup, setDisconnectEventsByGroup] = useState({})
  const [disconnectEventsLoadingByGroup, setDisconnectEventsLoadingByGroup] = useState({})
  const [disconnectEventsErrorByGroup, setDisconnectEventsErrorByGroup] = useState({})
  const [disconnectEventsSearch, setDisconnectEventsSearch] = useState('')
  const [disconnectEventsFilter, setDisconnectEventsFilter] = useState('all') /* all | offline | reconnected */
  const disconnectEventsReqSeqRef = useRef(0)

  /* ── problem history tab ── */
  const [probHist, setProbHist] = useState(null)
  const [probHistLoading, setProbHistLoading] = useState(false)
  const [probHistRange, setProbHistRange] = useState('24h')
  const [probHistSeverity, setProbHistSeverity] = useState('')
  const [probHistSearch, setProbHistSearch] = useState('')
  const [probHistPage, setProbHistPage] = useState(1)
  const [probHistSnapping, setProbHistSnapping] = useState(false)
  const [probHistStatus, setProbHistStatus] = useState('') // '' | 'active' | 'resolved'
  const [manualRopCodesText, setManualRopCodesText] = useState('')
  const [manualRopCodesOpen, setManualRopCodesOpen] = useState(false)
  const [manualRopCodesSaving, setManualRopCodesSaving] = useState(false)
  const [manualRopCodesSaved, setManualRopCodesSaved] = useState(false)
  const [manualRopCodesUpdatedAt, setManualRopCodesUpdatedAt] = useState(null)
  const [manualRopCodesDraft, setManualRopCodesDraft] = useState('')
  const manualCodesInitRef = useRef(false)

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
  /* ── Socket.IO: subscribe for real-time store alerts ── */
  useEffect(() => {
    const token = useAuthStore.getState().token
    const ws    = resolvedWsUrl()
    const sock  = ws ? ioClient(ws, { auth: { token }, transports: ['websocket', 'polling'] })
                     : ioClient({ auth: { token }, transports: ['websocket', 'polling'] })
    socketRef.current = sock
    sock.emit('subscribe:store-alerts')
    sock.on('store:alert', (event) => {
      const id = `${Date.now()}-${Math.random()}`
      setLiveAlerts((prev) => [{ id, ...event }, ...prev].slice(0, 50))
      setAlertHistory((prev) => [{ ...event }, ...prev].slice(0, 200))
    })
    // When the problem tracker detects new/resolved problems — reload overview so
    // Problems tab reflects changes immediately without waiting for the 60s poll
    sock.on('store:problems:changed', () => {
      if (loadOverviewRef.current) loadOverviewRef.current()
    })
    return () => {
      sock.emit('unsubscribe:store-alerts')
      sock.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── load meta once ── */
  useEffect(() => {
    api.get('/api/store-monitor/meta')
      .then((r) => setMeta(r.data))
      .catch(() => setMeta(null))  // null = load failed, won't show stale warning
  }, [])

  /* ── load server-side store settings (manual ROP codes shared for all users) ── */
  useEffect(() => {
    if (manualCodesInitRef.current) return
    manualCodesInitRef.current = true
    api.get('/api/store-monitor/settings')
      .then((r) => {
        const raw = r.data?.manualRopSdwanCodes ?? ''
        setManualRopCodesText(raw)
        setManualRopCodesDraft(raw)
        setManualRopCodesUpdatedAt(r.data?.updatedAt ?? null)
      })
      .catch(() => {})
  }, [])

  useEffect(() => { overviewRef.current = overview }, [overview])

  /* ── load overview ── */
  const OVERVIEW_TIMEOUT_MS = 95000

  const loadOverview = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      // Live overview always reads last ~15m from Influx — UI range is for charts/reports only.
      const params = globalCustom.enabled && globalCustom.from
        ? { from: fromLocalInput(globalCustom.from), to: fromLocalInput(globalCustom.to) || Math.floor(Date.now()/1000) }
        : {}
      const { data } = await api.get('/api/store-monitor/overview', { params, timeout: OVERVIEW_TIMEOUT_MS })
      setOverview(data)
      overviewRef.current = data
      if (data.stores?.length) setSelectedTag((prev) => prev || data.stores[0].storeTag)
      if (data.stale) {
        setError('Showing cached data — InfluxDB was slow. Data will refresh automatically.')
      } else {
        setError('')
      }
    } catch (e) {
      if (isBenignFetchError(e)) {
        if (!overviewRef.current?.stores?.length) {
          setError('Request was cancelled — click Retry if data does not appear.')
        }
        return
      }
      const isTimeout = e.code === 'ECONNABORTED' || /timeout|aborted due to timeout|budget exceeded/i.test(String(e.message || ''))
      const isGatewayTimeout = e.response?.status === 504
      const msg = isGatewayTimeout
        ? 'Gateway timeout (504) — nginx cut off the request before InfluxDB finished. Reload nginx with the updated store-monitor timeout, or ask admin to extend proxy_read_timeout for /api/store-monitor/.'
        : isTimeout
        ? 'InfluxDB is slow or unreachable (timed out after ~90s). Check INFLUX_URL on the server and click Retry.'
        : friendlyApiError(e)
      // Background refresh failed — keep showing last good data without a scary banner
      if (overviewRef.current?.stores?.length) return
      setError(msg)
    } finally { setLoading(false) }
  }, [globalCustom])

  useSmartPolling(loadOverview, 60_000, [globalCustom])
  // keep ref always current so socket handler can call it without stale closure
  useEffect(() => { loadOverviewRef.current = loadOverview }, [loadOverview])

  /* ── load problems: derived from overview stores to avoid a duplicate Influx round-trip ── */
  useEffect(() => {
    if (tab !== 'problems') return
    const stores = overview?.stores
    if (!stores?.length) { setProblems([]); return }
    const flat = []
    for (const s of stores) {
      for (const issue of s.issues ?? []) {
        flat.push({ storeTag: s.storeTag, hostname: s.hostname, serial: s.serial, lastSeen: s.lastSeen, connState: s.connState, gatewayVendor: s.gatewayVendor, ...issue })
      }
    }
    const sev = { critical: 0, high: 1, warning: 2 }
    flat.sort((a, b) => (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9))
    setProblems(flat)
  }, [tab, overview])

  /* ── load history ── */
  const loadHistory = useCallback(async (tag) => {
    if (!tag) return
    setHistLoading(true)
    try {
      let params
      if (customHist.enabled && customHist.from) {
        // Chart-level custom range takes highest priority
        const fromSec = fromLocalInput(customHist.from)
        const toSec   = customHist.to ? fromLocalInput(customHist.to) : Math.floor(Date.now() / 1000)
        params = { from: fromSec, to: toSec }
      } else if (globalCustom.enabled && globalCustom.from) {
        // Fall back to global custom range
        const fromSec = fromLocalInput(globalCustom.from)
        const toSec   = globalCustom.to ? fromLocalInput(globalCustom.to) : Math.floor(Date.now() / 1000)
        params = { from: fromSec, to: toSec }
      } else {
        params = { rangeSec: HISTORY_SECS[range] || 86400 }
      }
      const { data } = await api.get(`/api/store-monitor/stores/${encodeURIComponent(tag)}/history`, { params })
      setHistory(data)
    } catch { setHistory(null) }
    finally { setHistLoading(false) }
  }, [range, customHist, globalCustom])

  useEffect(() => { if (tab === 'detail' && selectedTag) loadHistory(selectedTag) }, [tab, selectedTag, loadHistory])

  /* ── load aggregate Net Health time series for the selected range ── */
  const loadNetHist = useCallback(async () => {
    setNetHistLoading(true)
    setNetHistError('')
    try {
      let params
      if (globalCustom.enabled && globalCustom.from) {
        const fromSec = fromLocalInput(globalCustom.from)
        const toSec   = globalCustom.to ? fromLocalInput(globalCustom.to) : Math.floor(Date.now() / 1000)
        params = { from: fromSec, to: toSec }
      } else {
        params = { rangeSec: HISTORY_SECS[range] || 86400 }
      }
      const { data } = await api.get('/api/store-monitor/net-health/history', { params })
      setNetHist(data)
    } catch (e) {
      setNetHistError(e.response?.data?.error || e.message || 'Failed to load')
      setNetHist(null)
    } finally {
      setNetHistLoading(false)
    }
  }, [range, globalCustom])

  useEffect(() => { if (tab === 'netHealth') loadNetHist() }, [tab, loadNetHist])

  // loadGroupHist is defined further down — after ropManualStores is in scope —
  // because it needs to include the manual ROP tag lists in its POST body.

  /* ── load alert rules ── */
  const loadAlerts = useCallback(async () => {
    try { const { data } = await api.get('/api/store-alerts'); setAlertRules(data) }
    catch { setAlertRules([]) }
  }, [])

  /* ── load problem history ── */
  const loadProbHist = useCallback(async (page = 1) => {
    setProbHistLoading(true)
    try {
      const params = { range: probHistRange, page, limit: 200 }
      if (probHistSeverity) params.severity = probHistSeverity
      if (probHistStatus)   params.status   = probHistStatus
      if (probHistSearch.trim()) params.q = probHistSearch.trim()
      const { data } = await api.get('/api/store-monitor/problem-history', { params })
      setProbHist(data)
      setProbHistPage(page)
    } catch { setProbHist(null) }
    finally { setProbHistLoading(false) }
  }, [probHistRange, probHistSeverity, probHistSearch])

  useEffect(() => {
    if (tab === 'probHist') loadProbHist(1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, probHistRange, probHistSeverity, probHistStatus])

  const openCrashModal = useCallback(async (row) => {
    setCrashModal(row)
    setCrashRawRows([])
    setCrashRawLoading(true)
    try {
      const params = {
        storeTag: row.storeTag || row.hostname,
        ...(row.appName ? { appName: row.appName } : {}),
        ...(globalCustom.enabled && globalCustom.from
          ? { from: fromLocalInput(globalCustom.from), to: fromLocalInput(globalCustom.to) || Math.floor(Date.now()/1000) }
          : { range }),
      }
      const { data } = await api.get('/api/store-monitor/crashes/raw', { params })
      setCrashRawRows(data.rows || [])
    } catch { setCrashRawRows([]) }
    finally { setCrashRawLoading(false) }
  }, [range, globalCustom])

  const loadCrashes = useCallback(async () => {
    setCrashLoading(true)
    try {
      const params = globalCustom.enabled && globalCustom.from
        ? { from: fromLocalInput(globalCustom.from), to: fromLocalInput(globalCustom.to) || Math.floor(Date.now()/1000) }
        : { range }
      const { data } = await api.get('/api/store-monitor/crashes', { params })
      setCrashData(data)
    } catch { setCrashData(null) }
    finally { setCrashLoading(false) }
  }, [range, globalCustom])

  useEffect(() => { if (tab === 'crashes') loadCrashes() }, [tab, loadCrashes])

  useEffect(() => {
    if (tab === 'alerts') {
      loadAlerts()
      api.get('/api/store-alerts/status').then((r) => setEvalStatus(r.data)).catch(() => {})
    }
  }, [tab, loadAlerts])

  useEffect(() => {
    if (tab === 'alerts' && alertSubTab === 'history') {
      setAlertHistLoading(true)
      api.get('/api/store-alerts/events', { params: { limit: 100 } })
        .then(({ data }) => { setAlertHistory(data.events || []); setHistTotal(data.total || 0) })
        .catch(() => {})
        .finally(() => setAlertHistLoading(false))
    }
  }, [tab, alertSubTab])

  async function runAlertsNow() {
    setEvalRunning(true)
    try {
      const { data } = await api.post('/api/store-alerts/evaluate')
      setEvalStatus((s) => ({ ...s, lastEvalAt: data.evaluatedAt, lastEvalStats: data }))
      await loadAlerts()
    } catch (e) { alert(e.response?.data?.error || e.message) }
    finally { setEvalRunning(false) }
  }

  /* ── derived stores with group ── */
  const stores = useMemo(
    () => (overview?.stores || []).map((s) => {
      const groups = deriveGroups(s.hostname, s.gatewayVendor, s.isFortinet, s.lastGatewayVendor, s.lastIsFortinet)
      return { ...s, systemGroups: groups, systemGroup: groups[0] }
    }),
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
    if (activeGroupFilter)out = out.filter((s) => (s.systemGroups||[s.systemGroup]).includes(activeGroupFilter))
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

  /* ── group summary — a store counted in each group it belongs to ── */
  const groupSummary = useMemo(() => {
    const map = {}
    for (const g of GROUP_DEFS) map[g.id] = { ...g, total: 0, online: 0, issues: 0, avgPingMs: 0, pingCount: 0 }
    for (const s of stores) {
      const memberGroups = s.systemGroups || [s.systemGroup || 'General Group']
      for (const gid of memberGroups) {
        const g = map[gid] || map['General Group']
        g.total++
        if (s.online) g.online++
        if ((s.issueCount || 0) > 0) g.issues++
        const p = primaryPing(s)
        if (p?.avgMs != null && Number.isFinite(p.avgMs)) { g.avgPingMs += p.avgMs; g.pingCount++ }
      }
    }
    return GROUP_DEFS.map((gd) => {
      const g = map[gd.id]
      return { ...g, health: pct(g.online, g.total), avgPing: g.pingCount ? g.avgPingMs / g.pingCount : null }
    })
  }, [stores])

  /** Build a snapshot summary for an arbitrary slice of stores (used for Manual ROP rollups). */
  function summarizeStoresSlice(slice, meta) {
    let online = 0, issues = 0, pingSum = 0, pingCount = 0
    for (const s of slice) {
      if (s.online) online++
      if ((s.issueCount || 0) > 0) issues++
      const p = primaryPing(s)
      if (p?.avgMs != null && Number.isFinite(p.avgMs)) { pingSum += p.avgMs; pingCount++ }
    }
    return {
      ...meta,
      total: slice.length,
      online,
      issues,
      health: pct(online, slice.length || 1),
      avgPing: pingCount ? pingSum / pingCount : null,
      avgPingMs: pingSum,
      pingCount,
    }
  }

  /* ── ROP-oriented store slices ── */
  const ropAllStores = useMemo(
    () => stores.filter((s) => (s.systemGroups || [s.systemGroup]).includes('RP Group')),
    [stores]
  )
  const ropSdwanStores = useMemo(
    () => ropAllStores.filter((s) => (s.systemGroups || [s.systemGroup]).includes('SD-WAN Group')),
    [ropAllStores]
  )
  const ropOnlyStores = useMemo(
    () => ropAllStores.filter((s) => !(s.systemGroups || [s.systemGroup]).includes('SD-WAN Group')),
    [ropAllStores]
  )
  const manualRopCodeList = useMemo(
    () => parseManualStoreCodes(manualRopCodesText),
    [manualRopCodesText],
  )
  const ropManualStores = useMemo(
    () => buildManualRopStoreList(stores, manualRopCodeList),
    [stores, manualRopCodeList],
  )
  // ROP without SD-WAN must exclude systems that are part of Manual ROP + SD-WAN.
  const ropOnlyWithoutManualStores = useMemo(() => {
    const manualTags = new Set((ropManualStores || []).map((s) => s.storeTag).filter(Boolean))
    return (ropOnlyStores || []).filter((s) => !manualTags.has(s.storeTag))
  }, [ropOnlyStores, ropManualStores])

  // Shared custom-group payload for Net Health APIs so group cards/matrix/reports
  // use exactly the same membership definitions.
  // Stringified tag lists keep the memo identity stable across snapshot polls
  // (so loaders don't refetch every poll cycle when the underlying content
  // hasn't actually changed).
  const ropManualTagsCsv = useMemo(
    () => (ropManualStores || [])
      .filter((s) => s && s.storeTag && !s.isPlaceholder)
      .map((s) => s.storeTag)
      .sort()
      .join(','),
    [ropManualStores],
  )
  const ropNoSdwanTagsCsv = useMemo(
    () => (ropOnlyWithoutManualStores || [])
      .filter((s) => s && s.storeTag && !s.isPlaceholder)
      .map((s) => s.storeTag)
      .sort()
      .join(','),
    [ropOnlyWithoutManualStores],
  )
  const netHealthCustomGroups = useMemo(() => {
    const manualTags = ropManualTagsCsv ? ropManualTagsCsv.split(',') : []
    const noSdwanTags = ropNoSdwanTagsCsv ? ropNoSdwanTagsCsv.split(',') : []
    const groups = []
    if (manualTags.length) groups.push({ name: 'Manual ROP + SD-WAN', storeTags: manualTags })
    if (noSdwanTags.length) groups.push({ name: 'ROP without SD-WAN', storeTags: noSdwanTags })
    return groups
  }, [ropManualTagsCsv, ropNoSdwanTagsCsv])
  // Reports must always have a usable "Manual ROP + SD-WAN" group:
  // when manual code list is empty/unmatched, fall back to RP + SD-WAN stores.
  const reportManualSdwanStores = useMemo(() => {
    const manualMatched = (ropManualStores || []).filter((s) => !s.isPlaceholder)
    if (manualMatched.length) return manualMatched
    return (ropSdwanStores || []).filter((s) => !s.isPlaceholder)
  }, [ropManualStores, ropSdwanStores])
  const reportManualSdwanTagsCsv = useMemo(
    () => (reportManualSdwanStores || [])
      .filter((s) => s && s.storeTag)
      .map((s) => s.storeTag)
      .sort()
      .join(','),
    [reportManualSdwanStores],
  )
  const reportDailyCustomGroups = useMemo(() => {
    const manualTags = reportManualSdwanTagsCsv ? reportManualSdwanTagsCsv.split(',') : []
    const noSdwanTags = ropNoSdwanTagsCsv ? ropNoSdwanTagsCsv.split(',') : []
    const groups = []
    if (manualTags.length) groups.push({ name: 'Manual ROP + SD-WAN', storeTags: manualTags })
    if (noSdwanTags.length) groups.push({ name: 'ROP without SD-WAN', storeTags: noSdwanTags })
    return groups
  }, [reportManualSdwanTagsCsv, ropNoSdwanTagsCsv])

  /* Snapshot cards shown on the Net Health tab.
     Excludes "General Group" and adds the two ROP-tab rollups so the numbers
     match the counts on the ROP Groups tab exactly. */
  const displayedGroupCards = useMemo(() => {
    const base = groupSummary.filter((g) => g.id !== 'General Group')

    const manualAll = (ropManualStores || []).filter((s) => !s.isPlaceholder)
    const ropNoSdwan = (ropOnlyWithoutManualStores || []).filter((s) => !s.isPlaceholder)

    const out = [...base]
    if (manualAll.length > 0) {
      out.push(summarizeStoresSlice(manualAll, {
        id: 'Manual ROP + SD-WAN', color: '#a855f7', icon: '📋',
      }))
    }
    if (ropNoSdwan.length > 0) {
      out.push(summarizeStoresSlice(ropNoSdwan, {
        id: 'ROP without SD-WAN', color: '#0ea5e9', icon: '📡',
      }))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSummary, ropManualStores, ropOnlyWithoutManualStores])
  // Keep a stable signature based only on group IDs so disconnect loaders do not
  // refire every overview poll when only counts/health values change.
  const disconnectGroupIdsSig = useMemo(
    () => displayedGroupCards.map((g) => g.id).join('|'),
    [displayedGroupCards],
  )

  /* ── load per-group time series (fuels the Group × Day matrix) ──
     POSTs the manual ROP store-tag lists so the backend can include them
     as custom groups (Manual ROP + SD-WAN, Manual ROP w/o SD-WAN). */
  const loadGroupHist = useCallback(async () => {
    setGroupHistLoading(true)
    try {
      let params
      if (globalCustom.enabled && globalCustom.from) {
        const fromSec = fromLocalInput(globalCustom.from)
        const toSec   = globalCustom.to ? fromLocalInput(globalCustom.to) : Math.floor(Date.now() / 1000)
        params = { from: fromSec, to: toSec }
      } else {
        params = { rangeSec: HISTORY_SECS[range] || 86400 }
      }
      const { data } = await api.post(
        '/api/store-monitor/net-health/group-history',
        { customGroups: netHealthCustomGroups },
        { params },
      )
      setGroupHist(data)
    } catch {
      setGroupHist(null)
    } finally {
      setGroupHistLoading(false)
    }
  }, [range, globalCustom, netHealthCustomGroups])

  useEffect(() => { if (tab === 'netHealth') loadGroupHist() }, [tab, loadGroupHist])

  /* ── load day-wise internet disconnection/offline report per group ── */
  // Stable BH signature so the loader callback doesn't churn on irrelevant
  // bh-object identity changes (the actual fields drive the payload).
  const bhSig = useMemo(
    () => bh.enabled
      ? `1|${bh.startHour}|${bh.endHour}|${[...bh.weekdays].sort().join(',')}`
      : '0',
    [bh.enabled, bh.startHour, bh.endHour, bh.weekdays],
  )
  const loadGroupDisconnect = useCallback(async () => {
    const groupIds = disconnectGroupIdsSig ? disconnectGroupIdsSig.split('|') : []
    if (!groupIds.length) {
      setGroupDisconnectById({})
      setGroupDisconnectLoadingById({})
      return
    }

    // Ignore stale responses from previous invocations.
    const reqSeq = ++groupDisconnectReqSeqRef.current
    setGroupDisconnectLoadingById((prev) => ({
      ...prev,
      ...Object.fromEntries(groupIds.map((id) => [id, true])),
    }))

    let params
    if (globalCustom.enabled && globalCustom.from) {
      const fromSec = fromLocalInput(globalCustom.from)
      const toSec   = globalCustom.to ? fromLocalInput(globalCustom.to) : Math.floor(Date.now() / 1000)
      params = { from: fromSec, to: toSec }
    } else {
      params = { rangeSec: HISTORY_SECS[range] || 86400 }
    }
    const body = { customGroups: netHealthCustomGroups }
    if (bh.enabled) {
      body.businessHours = {
        startHour: bh.startHour,
        endHour: bh.endHour,
        weekdays: bh.weekdays,
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
      }
    }

    // Avoid hammering Influx with 5 heavy group queries at once.
    // Two concurrent workers keep progressive UI updates while improving success rate.
    const queue = [...groupIds]
    const workerCount = Math.min(2, queue.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const groupId = queue.shift()
        if (!groupId) return
        if (reqSeq !== groupDisconnectReqSeqRef.current) return
        try {
          const { data } = await api.post(
            '/api/store-monitor/net-health/group-disconnect-report',
            body,
            { params: { ...params, groupName: groupId }, timeout: 180000 },
          )
          if (reqSeq !== groupDisconnectReqSeqRef.current) return
          setGroupDisconnectById((prev) => ({ ...prev, [groupId]: data }))
          setGroupDisconnectErrorById((prev) => ({ ...prev, [groupId]: '' }))
        } catch (err) {
          if (reqSeq !== groupDisconnectReqSeqRef.current) return
          setGroupDisconnectById((prev) => ({ ...prev, [groupId]: null }))
          const msg = err?.response?.data?.error
            || err?.message
            || (err?.code === 'ECONNABORTED' ? 'Request timed out' : 'Request failed')
          setGroupDisconnectErrorById((prev) => ({ ...prev, [groupId]: String(msg) }))
        } finally {
          if (reqSeq !== groupDisconnectReqSeqRef.current) return
          setGroupDisconnectLoadingById((prev) => ({ ...prev, [groupId]: false }))
        }
      }
    })
    await Promise.all(workers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, globalCustom, netHealthCustomGroups, bhSig, disconnectGroupIdsSig])

  useEffect(() => {
    if (tab === 'netHealth' || tab === 'reports') loadGroupDisconnect()
  }, [tab, loadGroupDisconnect])

  /* ── per-store disconnect events for the currently expanded group ── */
  const loadDisconnectEventsForGroup = useCallback(async (groupId, { force = false } = {}) => {
    if (!groupId) return
    if (!force && disconnectEventsByGroup[groupId]) return /* already loaded */

    const reqSeq = ++disconnectEventsReqSeqRef.current
    setDisconnectEventsLoadingByGroup((prev) => ({ ...prev, [groupId]: true }))
    setDisconnectEventsErrorByGroup((prev) => ({ ...prev, [groupId]: '' }))

    let params
    if (globalCustom.enabled && globalCustom.from) {
      const fromSec = fromLocalInput(globalCustom.from)
      const toSec   = globalCustom.to ? fromLocalInput(globalCustom.to) : Math.floor(Date.now() / 1000)
      params = { from: fromSec, to: toSec }
    } else {
      params = { rangeSec: HISTORY_SECS[range] || 86400 }
    }
    const body = { customGroups: netHealthCustomGroups }
    try {
      const { data } = await api.post(
        '/api/store-monitor/net-health/group-disconnect-events',
        body,
        { params: { ...params, groupName: groupId }, timeout: 180000 },
      )
      if (reqSeq !== disconnectEventsReqSeqRef.current) return
      setDisconnectEventsByGroup((prev) => ({ ...prev, [groupId]: data }))
    } catch (err) {
      if (reqSeq !== disconnectEventsReqSeqRef.current) return
      const msg = err?.response?.data?.error
        || err?.message
        || (err?.code === 'ECONNABORTED' ? 'Request timed out' : 'Request failed')
      setDisconnectEventsErrorByGroup((prev) => ({ ...prev, [groupId]: String(msg) }))
    } finally {
      if (reqSeq === disconnectEventsReqSeqRef.current) {
        setDisconnectEventsLoadingByGroup((prev) => ({ ...prev, [groupId]: false }))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, globalCustom, netHealthCustomGroups, disconnectEventsByGroup])

  const toggleDisconnectEventsGroup = useCallback((groupId) => {
    setDisconnectEventsExpandedGroup((prev) => {
      if (prev === groupId) return null
      loadDisconnectEventsForGroup(groupId)
      return groupId
    })
    setDisconnectEventsSearch('')
    setDisconnectEventsFilter('all')
  }, [loadDisconnectEventsForGroup])

  /* Invalidate cached event lists when the global window/custom-groups change so
     the next expand triggers a fresh fetch. */
  useEffect(() => {
    setDisconnectEventsByGroup({})
    setDisconnectEventsErrorByGroup({})
    if (disconnectEventsExpandedGroup) {
      loadDisconnectEventsForGroup(disconnectEventsExpandedGroup, { force: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, globalCustom, netHealthCustomGroups])

  const ropActiveStores = useMemo(() => {
    if (ropSubTab === 'sdwan')        return ropSdwanStores
    if (ropSubTab === 'no_sdwan')     return ropOnlyWithoutManualStores
    if (ropSubTab === 'manual_sdwan') return ropManualStores
    return ropAllStores
  }, [ropSubTab, ropAllStores, ropSdwanStores, ropOnlyWithoutManualStores, ropManualStores])
  useEffect(() => {
    if (tab === 'rop' && ropSubTab === 'manual_sdwan' && !manualRopCodeList.length) {
      setManualRopCodesOpen(true)
    }
  }, [tab, ropSubTab, manualRopCodeList.length])
  const ropFilteredStores = useMemo(() => {
    let out = ropActiveStores
    const q = ropSearch.trim().toLowerCase()
    if (q) out = out.filter((s) =>
      [s.hostname, s.serial, s.gatewayIp, s.storeTag, s.storeCode].some((v) => String(v || '').toLowerCase().includes(q))
    )
    if (ropStatusFilter === 'online')  out = out.filter((s) => s.online)
    if (ropStatusFilter === 'offline') out = out.filter((s) => !s.online)
    if (ropStatusFilter === 'issues')  out = out.filter((s) => s.issueCount > 0)
    if (ropConnFilter)                 out = out.filter((s) => s.connState === ropConnFilter)
    return out
  }, [ropActiveStores, ropSearch, ropStatusFilter, ropConnFilter])
  function ropKpi(list) {
    const total   = list.length
    const online  = list.filter((s) => s.online).length
    const issues  = list.filter((s) => s.issueCount > 0).length
    const pings   = list.map((s) => primaryPing(s)?.avgMs).filter((v) => v != null && Number.isFinite(v))
    const avgPing = pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : null
    return { total, online, offline: total - online, issues, avgPing }
  }

  /* ── ROP charts (recompute whenever the active sub-list changes) ── */
  const ropConnBreakdown = useMemo(() => {
    const counts = {}
    for (const s of ropActiveStores) {
      const k = s.connState || 'unknown'
      counts[k] = (counts[k] || 0) + 1
    }
    return counts
  }, [ropActiveStores])

  const ropConnChart = useMemo(() => {
    const entries = Object.entries(ropConnBreakdown)
    if (!entries.length) return null
    const bgColors = entries.map(([k]) => CONN_COLORS[k] || '#64748b')
    return {
      data: {
        labels: entries.map(([k]) => CONN_LABELS[k] || k),
        datasets: [{
          data: entries.map(([, v]) => v),
          backgroundColor: bgColors,
          borderColor: 'transparent',
          hoverBorderWidth: 2, hoverBorderColor: '#fff',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: tc.text2, boxWidth: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw} devices` } },
        },
      },
    }
  }, [ropConnBreakdown, tc])

  const summary = overview?.summary

  /* ── net health ── */
  const netHealth = useMemo(() => {
    let healthy=0, dnsOk=0, dnsT=0, httpOk=0, httpT=0, latSum=0, latC=0, lossSum=0, lossC=0
    for (const s of stores) {
      if (s.connState==='lan_healthy'||s.connState==='wifi_healthy') healthy++
      for (const p of Object.values(s.ping||{})) {
        if(p.avgMs!=null&&Number.isFinite(p.avgMs)){latSum+=p.avgMs;latC++}
        if(p.packetLossPct!=null&&Number.isFinite(p.packetLossPct)){lossSum+=p.packetLossPct;lossC++}
      }
      for (const v of Object.values(s.dns||{})) {
        dnsT++
        if (v.success === true) dnsOk++
      }
      for (const v of Object.values(s.http||{})) {
        httpT++
        if (v.success === true && (v.statusCode == null || Number(v.statusCode) < 500)) httpOk++
      }
    }
    return {
      uptimePct: pct(healthy, stores.length || 1),
      dnsOkPct: pct(dnsOk, dnsT || 1),
      httpOkPct: pct(httpOk, httpT || 1),
      avgLatency: latC ? latSum / latC : null,
      avgLoss: lossC ? lossSum / lossC : null,
    }
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

  // Aggregate net-health charts are computed AFTER bhTickFilter is defined (below).
  const histSeries = useMemo(() => {
    const raw = history?.series || []
    return applyBusinessHours(raw, bh)
  }, [history, bh])

  // Memoised tick-level BH guard passed to buildTimeChart so that ticks
  // just outside the BH boundary never "grab" nearby in-hours data points.
  const bhTickFilter = useMemo(() => {
    if (!bh.enabled) return null
    const days = new Set(bh.weekdays.map(Number))
    const { startHour, endHour } = bh
    return (clockSec) => {
      const d = new Date(clockSec * 1000)
      if (!days.has(d.getDay())) return false
      const h = d.getHours()
      if (startHour <= endHour) return h >= startHour && h < endHour
      return h >= startHour || h < endHour
    }
  }, [bh])

  // Generic BH predicate that accepts a Date, ms-since-epoch, or ISO string.
  // Returns null when BH is disabled (callers should skip filtering in that case).
  const bhAllow = useMemo(() => {
    if (!bh.enabled) return null
    const days = new Set(bh.weekdays.map(Number))
    const { startHour, endHour } = bh
    return (dateLike) => {
      if (dateLike == null) return false
      const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
      const t = d.getTime()
      if (!Number.isFinite(t)) return false
      if (!days.has(d.getDay())) return false
      const h = d.getHours()
      if (startHour <= endHour) return h >= startHour && h < endHour
      return h >= startHour || h < endHour
    }
  }, [bh])

  // Compute window anchors from the history response (so charts cover the FULL requested range)
  const histWindowFrom = useMemo(() => history?.requestedFrom ? Math.floor(new Date(history.requestedFrom).getTime() / 1000) : undefined, [history])
  const histWindowTo   = useMemo(() => history?.requestedTo   ? Math.floor(new Date(history.requestedTo  ).getTime() / 1000) : undefined, [history])

  const pingChart = useMemo(() => buildTimeChart(
    histSeries.filter((s) => s.measurement === 'ping' && s.field === 'average_response_ms'),
    tc, 'ms', 350, { yMin: 0, windowFromSec: histWindowFrom, windowToSec: histWindowTo, bhFilter: bhTickFilter }
  ), [histSeries, tc, histWindowFrom, histWindowTo, bhTickFilter])

  const lossHistChart = useMemo(() => buildTimeChart(
    histSeries.filter((s) => s.measurement === 'ping' && s.field === 'packet_loss_pct'),
    tc, '%', 350, { yMin: 0, yMax: 100, windowFromSec: histWindowFrom, windowToSec: histWindowTo, bhFilter: bhTickFilter }
  ), [histSeries, tc, histWindowFrom, histWindowTo, bhTickFilter])

  const cpuChart = useMemo(() => buildTimeChart(
    histSeries.filter((s) => s.measurement === 'system' && (s.field === 'cpu_usage_pct' || s.field === 'mem_used_pct')),
    tc, '%', 350, { yMin: 0, yMax: 100, windowFromSec: histWindowFrom, windowToSec: histWindowTo, bhFilter: bhTickFilter }
  ), [histSeries, tc, histWindowFrom, histWindowTo, bhTickFilter])

  const speedChart = useMemo(() => buildTimeChart(
    histSeries.filter((s) => s.measurement === 'speedtest'),
    tc, 'Mbps', 350, { yMin: 0, agentIntervalSec: 600, windowFromSec: histWindowFrom, windowToSec: histWindowTo, bhFilter: bhTickFilter }
  ), [histSeries, tc, histWindowFrom, histWindowTo, bhTickFilter])

  const connHistChart = useMemo(() => buildTimeChart(
    histSeries.filter((s) => s.measurement === 'connectivity'),
    tc, '', 350, { yMin: 0, windowFromSec: histWindowFrom, windowToSec: histWindowTo, bhFilter: bhTickFilter }
  ), [histSeries, tc, histWindowFrom, histWindowTo, bhTickFilter])

  // Points remaining after BH filtering — shown in the info bar when BH is active
  const bhFilteredCount = useMemo(
    () => bh.enabled ? histSeries.reduce((n, s) => n + s.points.length, 0) : null,
    [histSeries, bh.enabled],
  )

  /* ── aggregate Net Health time-series charts ──
     Use buildAggregateLineChart for clean continuous lines (the data from
     Flux aggregateWindow is already uniformly spaced — no need to resample
     onto a synthetic tick grid). BH filter (if active) drops points whose
     timestamp falls outside BH; spanGaps keeps the line continuous visually. */
  const netLatencyTimeChart = useMemo(() => buildAggregateLineChart(
    netHist?.latencySeries || [], tc,
    // yMin/yMax auto-scale around observed range so small variations are visible
    { yLabel: 'ms', yMinFloor: 0, bhFilter: bhTickFilter, decimals: 1 }
  ), [netHist, tc, bhTickFilter])

  const netLossTimeChart = useMemo(() => buildAggregateLineChart(
    netHist?.lossSeries || [], tc,
    { yLabel: '%', yMinFloor: 0, yMaxCeiling: 100, bhFilter: bhTickFilter, decimals: 2 }
  ), [netHist, tc, bhTickFilter])

  /* ── Daily rollups across the fleet (best-practice multi-day view) ──
     Groups all aggregated series by calendar day (local time). For each
     day we compute headline metrics and a 0–100 health score so the user
     can spot a bad day at a glance instead of squinting at a 168-point chart.
  */
  const dailyHealth = useMemo(() => {
    if (!netHist) return null

    // Determine span in days (use the requested window, not the data window)
    const fromMs = netHist.requestedFrom ? new Date(netHist.requestedFrom).getTime() : Date.now()
    const toMs   = netHist.requestedTo   ? new Date(netHist.requestedTo  ).getTime() : Date.now()
    const spanDays = Math.max(0, Math.round((toMs - fromMs) / 86_400_000))

    function dayKey(clockSec) {
      const d = new Date(clockSec * 1000)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }

    // Initialise day buckets (so empty days still show)
    const start = new Date(fromMs); start.setHours(0,0,0,0)
    const end   = new Date(toMs);   end.setHours(0,0,0,0)
    const buckets = new Map()
    for (let d = new Date(start); d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
      const k = d.getTime()
      buckets.set(k, {
        dayMs: k,
        latency: [], loss: [], dnsPct: [], httpPct: [],
        // per-target breakdowns for the detail table
        perTargetLatency: new Map(),
        perTargetLoss:    new Map(),
      })
    }

    function pushDay(seriesArr, bucketField, perTargetField) {
      if (!seriesArr) return
      for (const s of seriesArr) {
        for (const p of (s.points || [])) {
          const k = dayKey(Number(p.clock))
          const b = buckets.get(k)
          if (!b) continue
          const v = Number(p.value)
          if (!Number.isFinite(v)) continue
          b[bucketField].push(v)
          if (perTargetField && s.target) {
            const m = b[perTargetField]
            if (!m.has(s.target)) m.set(s.target, [])
            m.get(s.target).push(v)
          }
        }
      }
    }

    pushDay(netHist.latencySeries, 'latency', 'perTargetLatency')
    pushDay(netHist.lossSeries,    'loss',    'perTargetLoss')
    pushDay(netHist.dnsSeries,     'dnsPct')
    pushDay(netHist.httpSeries,    'httpPct')

    const stat = (arr, fn) => arr.length ? fn(arr) : null
    const sum  = (arr) => arr.reduce((a, v) => a + v, 0)
    const avg  = (arr) => arr.length ? sum(arr) / arr.length : null
    const max  = (arr) => arr.length ? Math.max(...arr) : null
    const min  = (arr) => arr.length ? Math.min(...arr) : null

    // Health score 0-100:
    //   start at 100, subtract penalties for each metric breaching its target
    function healthScore({ latencyAvg, lossAvg, dnsAvg, httpAvg }) {
      let score = 100
      // Latency target ≤ 50 ms; ≥ 200 ms is bad
      if (latencyAvg != null) {
        if (latencyAvg > 200) score -= 25
        else if (latencyAvg > 100) score -= 12
        else if (latencyAvg > 50)  score -=  5
      }
      // Packet loss target ≤ 1 %; ≥ 10 % is bad
      if (lossAvg != null) {
        if (lossAvg > 10) score -= 35
        else if (lossAvg >  5) score -= 20
        else if (lossAvg >  1) score -=  8
      }
      // DNS target ≥ 99 %
      if (dnsAvg  != null && dnsAvg  < 99) score -= Math.min(20, (99 - dnsAvg)  * 2)
      // HTTP target ≥ 98 %
      if (httpAvg != null && httpAvg < 98) score -= Math.min(25, (98 - httpAvg) * 2)
      return Math.max(0, Math.min(100, Math.round(score)))
    }

    function healthBand(score) {
      if (score >= 95) return { label: 'Healthy',  color: '#22c55e' }
      if (score >= 85) return { label: 'OK',       color: '#eab308' }
      if (score >= 70) return { label: 'Degraded', color: '#f97316' }
      return                  { label: 'Poor',     color: '#ef4444' }
    }

    const days = []
    for (const b of buckets.values()) {
      const d = new Date(b.dayMs)
      const latencyAvg = stat(b.latency, avg)
      const latencyMax = stat(b.latency, max)
      const lossAvg    = stat(b.loss,    avg)
      const lossMax    = stat(b.loss,    max)
      const dnsAvg     = stat(b.dnsPct,  avg)
      const httpAvg    = stat(b.httpPct, avg)
      const samples    = b.latency.length + b.loss.length + b.dnsPct.length + b.httpPct.length
      const score      = samples > 0 ? healthScore({ latencyAvg, lossAvg, dnsAvg, httpAvg }) : null
      const band       = score != null ? healthBand(score) : { label: 'No data', color: '#64748b' }

      // Per-target detail (for the table)
      const perTarget = []
      const allTargets = new Set([...b.perTargetLatency.keys(), ...b.perTargetLoss.keys()])
      for (const t of allTargets) {
        const lat = b.perTargetLatency.get(t) || []
        const ls  = b.perTargetLoss.get(t)    || []
        perTarget.push({
          target: t,
          latencyAvg: stat(lat, avg),
          latencyMax: stat(lat, max),
          latencyMin: stat(lat, min),
          lossAvg:    stat(ls,  avg),
          lossMax:    stat(ls,  max),
          samples:    lat.length + ls.length,
        })
      }
      perTarget.sort((a, b) => (b.lossAvg || 0) - (a.lossAvg || 0) || (b.latencyAvg || 0) - (a.latencyAvg || 0))

      days.push({
        dayMs:      b.dayMs,
        dateLabel:  d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        weekday:    d.toLocaleDateString(undefined, { weekday: 'short' }),
        isToday:    d.toDateString() === new Date().toDateString(),
        latencyAvg, latencyMax,
        lossAvg, lossMax,
        dnsAvg, httpAvg,
        samples,
        score, band,
        perTarget,
      })
    }

    return { spanDays, days }
  }, [netHist])

  /* ── Per-group Daily Health Summary ──
     Same rollup as `dailyHealth` above but split per group using the data we
     already fetched for the Group × Day matrix (groupHist.groupSeries).
     Returns: { spanDays, byGroup: Map<groupName, days[]> }
  */
  const dailyHealthByGroup = useMemo(() => {
    if (!groupHist?.groupSeries?.length) return null

    const fromMs = groupHist.requestedFrom ? new Date(groupHist.requestedFrom).getTime() : Date.now()
    const toMs   = groupHist.requestedTo   ? new Date(groupHist.requestedTo  ).getTime() : Date.now()
    const spanDays = Math.max(0, Math.round((toMs - fromMs) / 86_400_000))
    const start = new Date(fromMs); start.setHours(0,0,0,0)
    const end   = new Date(toMs);   end.setHours(0,0,0,0)
    const dayMsList = []
    for (let d = new Date(start); d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
      dayMsList.push(d.getTime())
    }

    function dayKey(clockSec) {
      const d = new Date(clockSec * 1000); d.setHours(0,0,0,0)
      return d.getTime()
    }
    const avg = (arr) => arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : null
    const max = (arr) => arr.length ? Math.max(...arr) : null

    function healthScore({ latencyAvg, lossAvg }) {
      let score = 100
      if (latencyAvg != null) {
        if (latencyAvg > 200) score -= 25
        else if (latencyAvg > 100) score -= 12
        else if (latencyAvg > 50)  score -= 5
      }
      if (lossAvg != null) {
        if (lossAvg > 10) score -= 35
        else if (lossAvg >  5) score -= 20
        else if (lossAvg >  1) score -= 8
      }
      return Math.max(0, Math.min(100, Math.round(score)))
    }
    function healthBand(score) {
      if (score == null) return { label: 'No data', color: '#64748b' }
      if (score >= 95) return { label: 'Healthy',  color: '#22c55e' }
      if (score >= 85) return { label: 'OK',       color: '#eab308' }
      if (score >= 70) return { label: 'Degraded', color: '#f97316' }
      return                   { label: 'Poor',    color: '#ef4444' }
    }

    // groupName -> dayMs -> { latency:[], loss:[] }
    const buckets = new Map()
    for (const s of groupHist.groupSeries) {
      if (!s?.group) continue
      if (!buckets.has(s.group)) {
        const m = new Map()
        for (const k of dayMsList) m.set(k, { latency: [], loss: [] })
        buckets.set(s.group, m)
      }
      const dayMap = buckets.get(s.group)
      const which = s.field === 'packet_loss_pct' ? 'loss'
                  : s.field === 'average_response_ms' ? 'latency'
                  : null
      if (!which) continue
      for (const p of (s.points || [])) {
        const k = dayKey(Number(p.clock))
        const b = dayMap.get(k)
        if (!b) continue
        const v = Number(p.value)
        if (Number.isFinite(v)) b[which].push(v)
      }
    }

    const byGroup = new Map()
    for (const [name, dayMap] of buckets.entries()) {
      const days = dayMsList.map((dayMs) => {
        const b = dayMap.get(dayMs) || { latency: [], loss: [] }
        const d = new Date(dayMs)
        const latencyAvg = avg(b.latency)
        const latencyMax = max(b.latency)
        const lossAvg = avg(b.loss)
        const lossMax = max(b.loss)
        const samples = b.latency.length + b.loss.length
        const score = samples > 0 ? healthScore({ latencyAvg, lossAvg }) : null
        const band = healthBand(score)
        return {
          dayMs,
          dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
          isToday: d.toDateString() === new Date().toDateString(),
          latencyAvg, latencyMax,
          lossAvg, lossMax,
          samples,
          score, band,
        }
      })
      byGroup.set(name, days)
    }

    return { spanDays, dayMsList, byGroup }
  }, [groupHist])

  /* ── Group × Day health matrix (latency + loss per group per calendar day) ── */
  const groupDailyMatrix = useMemo(() => {
    if (!groupHist?.groupSeries?.length) return null

    const fromMs = groupHist.requestedFrom ? new Date(groupHist.requestedFrom).getTime() : Date.now()
    const toMs   = groupHist.requestedTo   ? new Date(groupHist.requestedTo  ).getTime() : Date.now()
    const start = new Date(fromMs); start.setHours(0,0,0,0)
    const end   = new Date(toMs);   end.setHours(0,0,0,0)

    const dayMsList = []
    for (let d = new Date(start); d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
      dayMsList.push(d.getTime())
    }

    function dayKey(clockSec) {
      const d = new Date(clockSec * 1000); d.setHours(0,0,0,0)
      return d.getTime()
    }

    function scoreFromMetrics(latencyAvg, lossAvg) {
      let score = 100
      if (latencyAvg != null) {
        if (latencyAvg > 200) score -= 25
        else if (latencyAvg > 100) score -= 12
        else if (latencyAvg > 50)  score -= 5
      }
      if (lossAvg != null) {
        if (lossAvg > 10) score -= 40
        else if (lossAvg > 5) score -= 22
        else if (lossAvg > 1) score -= 10
      }
      return Math.max(0, Math.min(100, Math.round(score)))
    }
    function band(score) {
      if (score == null) return { label: 'No data', color: '#475569' }
      if (score >= 95) return { label: 'Healthy',  color: '#22c55e' }
      if (score >= 85) return { label: 'OK',       color: '#eab308' }
      if (score >= 70) return { label: 'Degraded', color: '#f97316' }
      return                   { label: 'Poor',    color: '#ef4444' }
    }

    // groupName → { dayMs → { latency:[], loss:[] } }
    const buckets = new Map()
    for (const s of groupHist.groupSeries) {
      if (!buckets.has(s.group)) {
        buckets.set(s.group, new Map(dayMsList.map((d) => [d, { latency: [], loss: [] }])))
      }
      const dayMap = buckets.get(s.group)
      for (const p of (s.points || [])) {
        const k = dayKey(Number(p.clock))
        const slot = dayMap.get(k)
        if (!slot) continue
        const v = Number(p.value)
        if (!Number.isFinite(v)) continue
        if (s.field === 'average_response_ms') slot.latency.push(v)
        else if (s.field === 'packet_loss_pct') slot.loss.push(v)
      }
    }

    const avg = (arr) => arr.length ? arr.reduce((a,v) => a+v, 0) / arr.length : null
    const max = (arr) => arr.length ? Math.max(...arr) : null

    // Build the matrix rows in the canonical group order.
    // General Group is intentionally excluded (visible elsewhere in the Stores tab).
    // ROP-tab-derived groups appear after the three primary system groups.
    const orderedGroups = [
      'SD-WAN Group',
      'RP Group',
      'POS System Group',
      'Manual ROP + SD-WAN',
      'ROP without SD-WAN',
    ].filter((g) => buckets.has(g))
    // Append any other unexpected groups (but skip General)
    for (const k of buckets.keys()) {
      if (k === 'General Group') continue
      if (!orderedGroups.includes(k)) orderedGroups.push(k)
    }

    const rows = orderedGroups.map((groupName) => {
      const dayMap = buckets.get(groupName)
      const cells = dayMsList.map((dayMs) => {
        const slot = dayMap.get(dayMs) || { latency: [], loss: [] }
        const latencyAvg = avg(slot.latency)
        const latencyMax = max(slot.latency)
        const lossAvg    = avg(slot.loss)
        const lossMax    = max(slot.loss)
        const samples    = slot.latency.length + slot.loss.length
        const score      = samples > 0 ? scoreFromMetrics(latencyAvg, lossAvg) : null
        const b          = band(score)
        const date       = new Date(dayMs)
        return {
          dayMs,
          date,
          dateLabel: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          weekday:   date.toLocaleDateString(undefined, { weekday: 'short' }),
          latencyAvg, latencyMax,
          lossAvg, lossMax,
          samples,
          score, band: b,
        }
      })
      // overall score = mean of cell scores that have data
      const valid = cells.filter((c) => c.score != null)
      const overall = valid.length ? Math.round(valid.reduce((a,c) => a + c.score, 0) / valid.length) : null
      const groupAvgLatency = avg(cells.flatMap((c) => c.latencyAvg != null ? [c.latencyAvg] : []))
      const groupAvgLoss    = avg(cells.flatMap((c) => c.lossAvg    != null ? [c.lossAvg]    : []))
      return {
        groupName,
        cells,
        overall,
        overallBand: band(overall),
        avgLatency: groupAvgLatency,
        avgLoss: groupAvgLoss,
      }
    })

    return { dayMsList, rows }
  }, [groupHist])

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
      const base = resolvedApiBase()
      const fixedGroup = DAILY_DISCONNECT_REPORT_GROUP[type]
      if (fixedGroup) {
        const q = new URLSearchParams()
        if (globalCustom.enabled && globalCustom.from) {
          const fromSec = fromLocalInput(globalCustom.from)
          const toSec = globalCustom.to ? fromLocalInput(globalCustom.to) : Math.floor(Date.now() / 1000)
          if (fromSec) q.set('from', String(fromSec))
          if (toSec) q.set('to', String(toSec))
        } else {
          q.set('rangeSec', String(HISTORY_SECS[range] || 86400))
        }
        const tzOffsetMinutes = -new Date().getTimezoneOffset()
        const body = {
          groupName: fixedGroup,
          customGroups: reportDailyCustomGroups,
          tzOffsetMinutes,
        }
        if (bh.enabled) {
          body.businessHours = {
            startHour: bh.startHour,
            endHour: bh.endHour,
            weekdays: bh.weekdays,
            tzOffsetMinutes,
          }
        }
        const res = await fetch(`${base}/api/store-monitor/reports/group-disconnect-daily?${q.toString()}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) { const j = await res.json().catch(()=>({})); throw new Error(j.error||`HTTP ${res.status}`) }
        const blob = await res.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${type}_${new Date().toISOString().slice(0,10)}.xlsx`
        a.click()
        URL.revokeObjectURL(a.href)
        return
      }

      const groupParam = reportGroup !== 'all' ? `&group=${encodeURIComponent(reportGroup)}` : ''
      const url = `/api/store-monitor/reports/${type}?range=${encodeURIComponent(range)}${groupParam}`
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
  const EVAL_RANGES = [
    { key: '-15m', label: '15 minutes' },
    { key: '-30m', label: '30 minutes' },
    { key: '-1h',  label: '1 hour' },
    { key: '-3h',  label: '3 hours' },
    { key: '-6h',  label: '6 hours' },
    { key: '-12h', label: '12 hours' },
    { key: '-24h', label: '24 hours' },
  ]

  function blankRule() {
    return { name:'', description:'', enabled:true, group:'all', severity:'high',
      cooldownMinutes:30,
      schedule:{ enabled:false, fromHour:9, toHour:18, weekdays:[1,2,3,4,5] },
      condition:{ metric:'offline', operator:'gt', threshold:0, target:'', appName:'', crashType:'' }, channels:[] }
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

  if (loading && !overview) return (
    <div style={{padding:40,textAlign:'center',color:'var(--text3)'}}>
      <div style={{marginBottom:12}}>Loading Store Network Monitor…</div>
      <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)',marginBottom:16}}>
        Fetching ~3000 stores from InfluxDB (usually 10–30s)
      </div>
      {error && (
        <div>
          <div style={{color:'#f97316',marginBottom:12,fontSize:14}}>⚠ {error}</div>
          <button className="sm-btn sm-sm primary" onClick={() => loadOverview()}>↺ Retry</button>
        </div>
      )}
    </div>
  )

  return (
    <div className="sm">
      <style>{CSS}</style>

      {/* No more floating popups — alerts shown in the Alerts tab */}

      {/* ── page header ── */}
      <div style={{borderBottom:'1px solid var(--border)',paddingBottom:10,marginBottom:10}}>

        {/* row 1: title + controls */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
          {/* left: title */}
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span className={`sm-dot ${meta?.connected?'sm-online':meta?.configured?'':'sm-offline'}`}
              style={meta?.configured&&!meta?.connected?{background:'var(--amber)'}:{}}/>
            <h1 className="sm-title" style={{margin:0}}>Store Network Monitor</h1>
            {meta?.connected && <span className="sm-live">LIVE</span>}
          </div>

          {/* right: BH filter + range controls */}
          <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0,flexWrap:'wrap'}}>
            {/* Business Hours toggle — placed BEFORE Range so it acts as the primary time filter */}
            <label
              title="Filter time-based data (Problems, History, Crashes, Detail charts) to business hours only"
              style={{
                display:'flex',alignItems:'center',gap:5,fontSize:11,cursor:'pointer',
                padding:'4px 9px',borderRadius:6,fontWeight:600,
                background: bh.enabled ? 'rgba(245,158,11,.15)' : 'transparent',
                border: `1px solid ${bh.enabled ? 'rgba(245,158,11,.45)' : 'var(--border)'}`,
                color: bh.enabled ? 'var(--amber)' : 'var(--text2)',
              }}>
              <input type="checkbox" checked={bh.enabled}
                onChange={(e)=>setBh((b)=>({...b,enabled:e.target.checked}))}/>
              🕒 Business Hours
            </label>
            <button type="button" className="sm-btn sm-sm"
              onClick={()=>setBhPanelOpen((v)=>!v)}
              title="Configure business-hours days & times"
              style={bhPanelOpen?{borderColor:'var(--accent)',color:'var(--accent)'}:undefined}>
              ⚙ {bh.startHour.toString().padStart(2,'0')}–{bh.endHour.toString().padStart(2,'0')} · {bh.weekdays.length}d
            </button>

            <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)',marginLeft:6}}>Range:</span>
            {!globalCustom.enabled ? (
              <select className="sm-select" value={range}
                onChange={(e)=>{ if(e.target.value==='custom') setGlobalCustom(c=>({...c,enabled:true})); else setRange(e.target.value) }}
                style={{minWidth:120}}>
                {TIME_RANGES.map((r)=><option key={r.key} value={r.key}>{r.label}</option>)}
                <option value="custom">📅 Custom…</option>
              </select>
            ) : (
              <button className="sm-btn sm-sm" style={{color:'var(--accent)',borderColor:'rgba(79,126,245,.3)',background:'rgba(79,126,245,.1)'}}
                onClick={()=>setGlobalCustom(c=>({...c,enabled:false}))}>
                📅 Custom ✕
              </button>
            )}
            <button className="sm-btn sm-sm" onClick={loadOverview} style={{gap:4}}>↻ Refresh</button>
          </div>
        </div>

        {/* BH configuration panel (collapsible) */}
        {bhPanelOpen && (
          <div style={{marginTop:8,display:'flex',flexWrap:'wrap',alignItems:'center',gap:10,
            padding:'8px 12px',background:'var(--bg2)',
            border:'1px solid rgba(245,158,11,.3)',borderRadius:'var(--sm-r)'}}>
            <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.06em'}}>
              Business Hours
            </span>
            <div style={{display:'flex',alignItems:'center',gap:3}}>
              {BH_DAYS.map((d)=>(
                <button key={d.val} type="button"
                  className={`sm-bh-dayBtn${bh.weekdays.includes(d.val)?' on':''}`}
                  onClick={()=>setBh((b)=>({
                    ...b,
                    weekdays: b.weekdays.includes(d.val)
                      ? b.weekdays.filter((x)=>x!==d.val)
                      : [...b.weekdays, d.val].sort(),
                  }))}>
                  {d.label}
                </button>
              ))}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:5,fontSize:11}}>
              <input type="number" min={0} max={23} value={bh.startHour} className="sm-input"
                style={{width:54,textAlign:'center'}}
                onChange={(e)=>setBh((b)=>({...b,startHour:+e.target.value}))}/>
              <span style={{color:'var(--text3)'}}>:00 — </span>
              <input type="number" min={1} max={24} value={bh.endHour} className="sm-input"
                style={{width:54,textAlign:'center'}}
                onChange={(e)=>setBh((b)=>({...b,endHour:+e.target.value}))}/>
              <span style={{color:'var(--text3)'}}>:00</span>
            </div>
            <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',marginLeft:'auto'}}>
              Affects: Problems · History · Crashes · Detail charts
            </span>
            <button type="button" className="sm-btn sm-sm"
              onClick={()=>setBhPanelOpen(false)}>Done</button>
          </div>
        )}

        {/* row 2: subtitle */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:4,flexWrap:'wrap',gap:6}}>
          <p className="sm-sub" style={{margin:0}}>
            InfluxDB · {meta?.bucket||'store-monitoring'}
            {meta?.url ? ` · ${meta.url}` : ''}
            {globalCustom.enabled && globalCustom.from
              ? <> · <strong style={{color:'var(--accent)'}}>{new Date(globalCustom.from).toLocaleString()} → {globalCustom.to ? new Date(globalCustom.to).toLocaleString() : 'now'}</strong></>
              : ` · ${TIME_RANGES.find(r=>r.key===range)?.label||range}`}
            {bh.enabled && (
              <> · <strong style={{color:'var(--amber)'}}>
                🕒 BH {bh.startHour.toString().padStart(2,'0')}:00–{bh.endHour.toString().padStart(2,'0')}:00 · {bh.weekdays.length}d
              </strong></>
            )}
            {overview?.fetchedAt
              ? <span style={{color:'var(--text3)'}}> · updated {relAge(overview.fetchedAt)} ago</span>
              : null}
          </p>
          {overview?.summary && (
            <div style={{display:'flex',gap:10,alignItems:'center',fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)'}}>
              <span>{overview.summary.total} stores</span>
              <span style={{color:'#22c55e'}}>{overview.summary.online} online</span>
              <span style={{color:'#ef4444'}}>{overview.summary.offline} offline</span>
              {overview.summary.withIssues > 0 && <span style={{color:'#eab308'}}>⚠ {overview.summary.withIssues} issues</span>}
            </div>
          )}
        </div>

        {/* row 3: custom date pickers (only when custom enabled) */}
        {globalCustom.enabled && (
          <div style={{marginTop:8,display:'flex',flexWrap:'wrap',alignItems:'center',gap:6,
            padding:'8px 12px',background:'var(--bg2)',border:'1px solid rgba(79,126,245,.25)',
            borderRadius:'var(--sm-r)',}}>
            <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',whiteSpace:'nowrap'}}>FROM</span>
            <input type="datetime-local" className="sm-input" style={{fontSize:11,padding:'4px 8px'}}
              value={globalCustom.from} onChange={(e)=>setGlobalCustom(c=>({...c,from:e.target.value}))}/>
            <span style={{color:'var(--text3)',fontSize:12}}>→</span>
            <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',whiteSpace:'nowrap'}}>TO</span>
            <input type="datetime-local" className="sm-input" style={{fontSize:11,padding:'4px 8px'}}
              value={globalCustom.to} onChange={(e)=>setGlobalCustom(c=>({...c,to:e.target.value}))}/>
            <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
              {[['30m',30*60],['1h',3600],['3h',3*3600],['6h',6*3600],['12h',12*3600],['24h',86400],['3d',3*86400],['7d',7*86400],['30d',30*86400]].map(([lbl,sec])=>(
                <button key={lbl} type="button" className="sm-btn sm-sm"
                  style={{minWidth:34,justifyContent:'center',fontSize:10,padding:'2px 6px'}}
                  onClick={()=>{
                    const t=new Date(); const f=new Date(t.getTime()-sec*1000)
                    setGlobalCustom(c=>({...c,enabled:true,from:toLocalInput(f),to:toLocalInput(t)}))
                    setTimeout(loadOverview, 50)
                  }}>{lbl}</button>
              ))}
            </div>
            <button className="sm-btn sm-sm primary" style={{marginLeft:'auto'}} onClick={loadOverview}>Apply</button>
          </div>
        )}
      </div>

      {error && (
        <div className={overview?.stores?.length ? 'sm-info' : 'sm-err'} style={{display:'flex',alignItems:'center',gap:10}}>
          <span>{overview?.stores?.length ? 'ℹ' : '⚠'} {error}</span>
          <button className="sm-btn sm-sm" style={{marginLeft:'auto',flexShrink:0}} onClick={() => loadOverview()}>↺ Retry</button>
        </div>
      )}
      {meta?.configured && !meta?.connected && meta?.error && <div className="sm-err">{meta.error}</div>}
      {meta !== undefined && meta !== null && !meta?.configured && !overview?.totalStores && (
        <div className="sm-info">Set INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET in server env</div>
      )}

      {/* ── tabs ── */}
      <div className="sm-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`sm-tab${tab===t.id?' active':''}`} onClick={()=>setTab(t.id)}>
            {t.icon} {t.label}
            {t.id==='problems' && problems.length>0 && <span className={tab===t.id?'sm-badge-count':'sm-badge-count-red'}>{problems.length}</span>}
            {t.id==='stores'   && stores.length>0   && <span className="sm-badge-count">{stores.length}</span>}
            {t.id==='crashes'  && (crashData?.totalEvents||0)>0 && <span className={tab===t.id?'sm-badge-count':'sm-badge-count-red'}>{crashData.totalEvents}</span>}
          </button>
        ))}
      </div>

      {/* ══════════ NOC OVERVIEW ══════════ */}
      {tab==='noc' && (
        <>
          {/* top KPIs — clickable: jumps to Stores tab with filter pre-applied */}
          <div className="sm-g4 sm-section-mb">
            {[
              { label:'Total Stores',  val: summary?.total||0,       color:'var(--text)',  action: () => { setStatusFilter(''); setIssuesOnly(false); setTab('stores') } },
              { label:'Online',        val: summary?.online||0,       color:'var(--green)', sub:`${pct(summary?.online||0,summary?.total||1).toFixed(1)}% uptime`, action: () => { setStatusFilter('online'); setIssuesOnly(false); setTab('stores') } },
              { label:'Offline',       val: summary?.offline||0,      color:'var(--red)',   sub:`${pct(summary?.offline||0,summary?.total||1).toFixed(1)}% down`, action: () => { setStatusFilter('offline'); setIssuesOnly(false); setTab('stores') } },
              { label:'With Issues',   val: summary?.withIssues||0,   color:'var(--amber)', action: () => { setStatusFilter(''); setIssuesOnly(true); setTab('stores') } },
              { label:'Avg Latency',   val: summary?.avgPingMs!=null?`${summary.avgPingMs} ms`:'—', color:'var(--text)', action: () => { setStatusFilter(''); setIssuesOnly(false); setTab('stores') } },
              { label:'Avg Download',  val: summary?.avgDownloadMbps!=null?`${summary.avgDownloadMbps} Mbps`:'—', color:'var(--text)', action: () => { setStatusFilter(''); setIssuesOnly(false); setTab('stores') } },
            ].map((k) => (
              <div key={k.label} className="sm-kpi" onClick={k.action}
                style={{cursor:'pointer', transition:'box-shadow .15s, transform .15s'}}
                onMouseEnter={(e)=>{ e.currentTarget.style.boxShadow='0 0 0 2px var(--accent)40'; e.currentTarget.style.transform='translateY(-1px)' }}
                onMouseLeave={(e)=>{ e.currentTarget.style.boxShadow=''; e.currentTarget.style.transform='' }}>
                <div className="sm-kpi-label">{k.label}</div>
                <div className="sm-kpi-val" style={{color:k.color}}>{k.val}</div>
                {k.sub && <div className="sm-kpi-sub">{k.sub}</div>}
              </div>
            ))}
          </div>

          {/* group cards — click total/online/offline to jump to Stores tab filtered by group + status */}
          <div className="sm-g4 sm-section-mb">
            {groupSummary.map((g) => {
              const goGroup = (status, issues) => {
                setGroupFilter(g.id); setChartGroupFilter(''); setStatusFilter(status||''); setIssuesOnly(!!issues); setTab('stores')
              }
              return (
              <div key={g.id} className="sm-group-card" style={{borderLeft:`3px solid ${g.color}`}}>
                <div className="sm-group-card-hd">
                  <div className="sm-group-name" style={{color:g.color,cursor:'pointer'}} onClick={()=>goGroup('',false)} title="View all stores in this group">{g.icon} {g.id}</div>
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>{g.health.toFixed(0)}% healthy</span>
                </div>
                <div className="sm-group-stats">
                  <div className="sm-group-stat" style={{cursor:'pointer'}} onClick={()=>goGroup('',false)} title="All stores">
                    <div className="sm-group-stat-val">{g.total}</div><div className="sm-group-stat-label">Total</div>
                  </div>
                  <div className="sm-group-stat" style={{cursor:'pointer'}} onClick={()=>goGroup('online',false)} title="Online stores">
                    <div className="sm-group-stat-val" style={{color:'var(--green)'}}>{g.online}</div><div className="sm-group-stat-label">Online</div>
                  </div>
                  <div className="sm-group-stat" style={{cursor:'pointer'}} onClick={()=>goGroup('offline',false)} title="Offline stores">
                    <div className="sm-group-stat-val" style={{color:'var(--red)'}}>{g.total-g.online}</div><div className="sm-group-stat-label">Offline</div>
                  </div>
                </div>
                <HealthBar pct={g.health}/>
                <div style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',cursor:'pointer'}} onClick={()=>goGroup('',true)} title="Stores with issues">
                  {g.issues} issue store{g.issues!==1?'s':''} · avg ping {g.avgPing!=null?`${g.avgPing.toFixed(0)}ms`:'—'}
                </div>
              </div>
            )})}
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
                      <td>
                        <div style={{display:'flex',flexWrap:'wrap',gap:3}}>
                          {(s.systemGroups||[s.systemGroup]).map((g)=><GroupBadge key={g} group={g}/>)}
                        </div>
                      </td>
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
                      <td>{fmtVendor(s.gatewayVendor)}</td>
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
      {tab==='problems' && (() => {
        const visibleProblems = problems.filter((p)=>{
          if (groupFilter && !deriveGroups(p.hostname,p.gatewayVendor,false).includes(groupFilter)) return false
          if (bhAllow && !bhAllow(p.lastSeen)) return false
          return true
        })
        return (
        <div className="sm-tr">
          <div className="sm-tr-hd">
            <span className="sm-tr-title">
              Active Problems — {visibleProblems.length}
              {bhAllow && visibleProblems.length !== problems.length && (
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--amber)',marginLeft:8,fontWeight:500}}>
                  ● BH filter active ({problems.length - visibleProblems.length} hidden)
                </span>
              )}
            </span>
            <select className="sm-select" style={{fontSize:11}} onChange={(e)=>setGroupFilter(e.target.value)} value={groupFilter}>
              <option value="">All Groups</option>
              {GROUP_DEFS.map((g)=><option key={g.id} value={g.id}>{g.icon} {g.id}</option>)}
            </select>
          </div>
          <div className="sm-tr-body sm-tbl-wrap">
            <table className="sm-tbl">
              <thead><tr><th>Severity</th><th>Hostname</th><th>Group</th><th>Serial</th><th>Problem</th><th>Connectivity</th><th>Vendor</th><th>Last seen</th></tr></thead>
              <tbody>
                {visibleProblems
                  .map((p,i)=>{
                    const grps = deriveGroups(p.hostname,p.gatewayVendor,false)
                    return (
                      <tr key={`${p.storeTag}-${p.code}-${i}`} className="clickable" onClick={()=>{setSelectedTag(p.storeTag);setTab('detail')}}>
                        <td><SevBadge sev={p.severity}/></td>
                        <td style={{fontWeight:600}}>{p.hostname}</td>
                        <td><div style={{display:'flex',flexWrap:'wrap',gap:3}}>{grps.map((g)=><GroupBadge key={g} group={g}/>)}</div></td>
                        <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{p.serial}</td>
                        <td>{p.message}</td>
                        <td><ConnPill state={p.connState}/></td>
                        <td>{fmtVendor(p.gatewayVendor)}</td>
                        <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{relAge(p.lastSeen)}</td>
                      </tr>
                    )
                  })}
                {!visibleProblems.length && (
                  <tr><td colSpan={8} className="sm-empty">
                    {problems.length === 0
                      ? '✅ No problems detected'
                      : bhAllow ? '✅ No problems detected during business hours' : '✅ No problems match filters'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        )
      })()}

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

          {/* ── Group Network Health (snapshot cards + multi-day heatmap matrix) ── */}
          <div className="sm-tr sm-section-mb">
            <div className="sm-tr-hd">
              <span className="sm-tr-title">🏷 Group Network Health</span>
              <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                snapshot below · matrix shows historical breakdown for selected range
              </span>
            </div>

            {/* ── 1. Current snapshot cards (one per group) ── */}
            <div style={{padding:'8px 12px 4px',display:'flex',alignItems:'center',gap:6}}>
              <span style={{
                display:'inline-flex',alignItems:'center',gap:5,
                padding:'2px 8px',borderRadius:4,
                background:'rgba(34,197,94,.15)',border:'1px solid rgba(34,197,94,.35)',
                fontSize:10,fontFamily:'var(--mono)',fontWeight:700,color:'#22c55e',
                textTransform:'uppercase',letterSpacing:'.06em',
              }}>● LIVE · Right now</span>
              <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                {overview?.fetchedAt ? `Snapshot at ${new Date(overview.fetchedAt).toLocaleTimeString()}` : 'Current state'}
                {' '}— for historical breakdown over the selected range, see the matrix below.
              </span>
            </div>
            <div style={{padding:'4px 12px 10px',display:'grid',
              gridTemplateColumns:`repeat(auto-fit, minmax(220px, 1fr))`,gap:10}}>
              {displayedGroupCards.map((g) => {
                const offline = g.total - g.online
                const offlinePct = g.total > 0 ? (offline / g.total) * 100 : 0
                const statusColor = g.health >= 95 ? '#22c55e' : g.health >= 85 ? '#eab308' : g.health >= 70 ? '#f97316' : '#ef4444'
                const ropSubKey = g.id === 'Manual ROP + SD-WAN' ? 'manual_sdwan'
                                : g.id === 'ROP without SD-WAN'  ? 'no_sdwan'
                                : null
                const handleCardClick = ropSubKey
                  ? () => { setRopSubTab(ropSubKey); setTab('rop') }
                  : () => { setGroupFilter(g.id); setChartGroupFilter(''); setStatusFilter(''); setIssuesOnly(false); setTab('stores') }
                return (
                  <div key={g.id}
                    onClick={handleCardClick}
                    title={ropSubKey ? `Open ROP Groups tab → ${g.id}` : `Open Stores tab filtered to ${g.id}`}
                    style={{
                      cursor:'pointer',
                      padding:'10px 12px',
                      borderRadius:8,
                      background:'var(--bg3)',
                      border:`1px solid ${g.color}40`,
                      borderLeft:`4px solid ${g.color}`,
                      transition:'transform .12s, box-shadow .12s',
                    }}
                    onMouseEnter={(e)=>{ e.currentTarget.style.transform='translateY(-1px)'; e.currentTarget.style.boxShadow=`0 0 0 2px ${g.color}30` }}
                    onMouseLeave={(e)=>{ e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow='' }}>
                    <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:6,marginBottom:6}}>
                      <div style={{display:'flex',alignItems:'center',gap:6,color:g.color,fontWeight:700,fontSize: g.id.endsWith(' Group') ? 13 : 11.5}}>
                        <span>{g.icon}</span>
                        <span>{g.id.endsWith(' Group') ? g.id.replace(' Group','') : g.id}</span>
                      </div>
                      <div style={{textAlign:'right'}}>
                        <div style={{fontSize:18,fontWeight:800,color:statusColor,fontFamily:'var(--mono)',lineHeight:1}}>
                          {g.health.toFixed(0)}<span style={{fontSize:11,color:'var(--text3)'}}>%</span>
                        </div>
                        <div style={{fontSize:8.5,fontFamily:'var(--mono)',color:statusColor,textTransform:'uppercase',letterSpacing:'.06em',marginTop:2}}>
                          {g.health >= 95 ? 'Healthy' : g.health >= 85 ? 'OK' : g.health >= 70 ? 'Degraded' : 'Poor'}
                        </div>
                      </div>
                    </div>
                    {/* Online / Offline / Issues breakdown */}
                    <div style={{display:'grid',gridTemplateColumns:'repeat(3, 1fr)',gap:6,marginTop:4}}>
                      <div style={{padding:'4px 6px',borderRadius:5,background:'rgba(34,197,94,.08)',textAlign:'center'}}>
                        <div style={{fontSize:13,fontWeight:700,color:'#22c55e',fontFamily:'var(--mono)'}}>{g.online}</div>
                        <div style={{fontSize:8.5,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em'}}>online</div>
                      </div>
                      <div style={{padding:'4px 6px',borderRadius:5,background:'rgba(239,68,68,.08)',textAlign:'center'}}>
                        <div style={{fontSize:13,fontWeight:700,color:offline > 0 ? '#ef4444' : 'var(--text3)',fontFamily:'var(--mono)'}}>{offline}</div>
                        <div style={{fontSize:8.5,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em'}}>offline</div>
                      </div>
                      <div style={{padding:'4px 6px',borderRadius:5,background:'rgba(234,179,8,.08)',textAlign:'center'}}>
                        <div style={{fontSize:13,fontWeight:700,color: g.issues > 0 ? '#eab308' : 'var(--text3)',fontFamily:'var(--mono)'}}>{g.issues}</div>
                        <div style={{fontSize:8.5,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em'}}>issues</div>
                      </div>
                    </div>
                    {/* Down % bar */}
                    <div style={{marginTop:8,display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontSize:8.5,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em',minWidth:34}}>down</span>
                      <div style={{flex:1,height:5,background:'var(--bg)',borderRadius:3,overflow:'hidden'}}>
                        <div style={{
                          width:`${Math.min(offlinePct,100)}%`,height:'100%',
                          background: offlinePct > 10 ? '#ef4444' : offlinePct > 0 ? '#eab308' : 'var(--text3)',
                          transition:'width .25s',
                        }}/>
                      </div>
                      <span style={{fontSize:9.5,fontFamily:'var(--mono)',fontWeight:700,minWidth:40,textAlign:'right',
                        color: offlinePct > 10 ? '#ef4444' : offlinePct > 0 ? '#eab308' : 'var(--text3)'}}>
                        {offlinePct.toFixed(1)}%
                      </span>
                    </div>
                    {/* Health % bar */}
                    <div style={{marginTop:4,display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontSize:8.5,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em',minWidth:34}}>health</span>
                      <div style={{flex:1,height:5,background:'var(--bg)',borderRadius:3,overflow:'hidden'}}>
                        <div style={{
                          width:`${Math.min(g.health,100)}%`,height:'100%',
                          background:statusColor,transition:'width .25s',
                        }}/>
                      </div>
                      <span style={{fontSize:9.5,fontFamily:'var(--mono)',fontWeight:700,minWidth:40,textAlign:'right',color:statusColor}}>
                        {g.health.toFixed(1)}%
                      </span>
                    </div>
                    {/* Footer line */}
                    <div style={{marginTop:6,display:'flex',justifyContent:'space-between',fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                      <span>{g.total} stores</span>
                      {g.avgPing != null && <span>avg ping <strong style={{color:'var(--text2)'}}>{g.avgPing.toFixed(0)}ms</strong></span>}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* ── 2. Group × Day matrix (heatmap) — when range spans multiple days ── */}
            {groupDailyMatrix && groupDailyMatrix.dayMsList.length >= 2 && (
              <div style={{borderTop:'1px solid var(--border)',padding:'10px 12px'}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,flexWrap:'wrap'}}>
                  <span style={{
                    display:'inline-flex',alignItems:'center',gap:5,
                    padding:'2px 8px',borderRadius:4,
                    background:'rgba(245,158,11,.15)',border:'1px solid rgba(245,158,11,.35)',
                    fontSize:10,fontFamily:'var(--mono)',fontWeight:700,color:'var(--amber)',
                    textTransform:'uppercase',letterSpacing:'.06em',
                  }}>📅 HISTORICAL · {groupDailyMatrix.dayMsList.length} days</span>
                  <span style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text2)',fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em'}}>
                    Group × Day Health Matrix
                  </span>
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                    hover any cell for avg/max latency &amp; loss
                  </span>
                  {groupHistLoading && <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--accent)'}}>⏳ Loading…</span>}
                  {groupHist?.sdwanStoreCount > 0 && (
                    <span style={{marginLeft:'auto',fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                      SD-WAN derived from {groupHist.sdwanStoreCount} Fortinet store{groupHist.sdwanStoreCount===1?'':'s'} in current snapshot
                    </span>
                  )}
                </div>
                <div style={{overflowX:'auto'}}>
                  <table style={{borderCollapse:'separate',borderSpacing:3,fontSize:11,fontFamily:'var(--mono)',width:'100%',minWidth:600}}>
                    <thead>
                      <tr>
                        <th style={{textAlign:'left',padding:'4px 8px',color:'var(--text3)',fontWeight:600,fontSize:10,textTransform:'uppercase',letterSpacing:'.06em'}}>Group</th>
                        <th style={{textAlign:'center',padding:'4px 8px',color:'var(--text3)',fontWeight:600,fontSize:10,textTransform:'uppercase',letterSpacing:'.06em',whiteSpace:'nowrap'}}>Overall</th>
                        {groupDailyMatrix.dayMsList.map((dayMs) => {
                          const d = new Date(dayMs)
                          const isToday = d.toDateString() === new Date().toDateString()
                          return (
                            <th key={dayMs} style={{textAlign:'center',padding:'4px 6px',color: isToday ? 'var(--accent)' : 'var(--text3)',fontWeight:600,fontSize:9.5,textTransform:'uppercase',letterSpacing:'.04em',whiteSpace:'nowrap'}}>
                              <div>{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                              <div style={{fontWeight:400,fontSize:9,color:'var(--text3)'}}>{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                            </th>
                          )
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {groupDailyMatrix.rows.map((row) => {
                        const EXTRA_GROUP_META = {
                          'Manual ROP + SD-WAN': { color: '#a855f7', icon: '📋' },
                          'ROP without SD-WAN':  { color: '#0ea5e9', icon: '📡' },
                        }
                        const meta = GROUP_MAP[row.groupName] || EXTRA_GROUP_META[row.groupName] || { color: '#64748b', icon: '🏷' }
                        return (
                          <tr key={row.groupName}>
                            <td style={{padding:'5px 8px',whiteSpace:'nowrap',borderLeft:`3px solid ${meta.color}`,background:`${meta.color}10`,borderRadius:'4px 0 0 4px'}}>
                              <span style={{display:'inline-flex',alignItems:'center',gap:5,fontWeight:700,color:meta.color,fontSize:row.groupName.endsWith(' Group') ? 11 : 10.5}}>
                                <span>{meta.icon}</span>
                                <span>{row.groupName.endsWith(' Group') ? row.groupName.replace(' Group','') : row.groupName}</span>
                              </span>
                            </td>
                            <td style={{textAlign:'center',padding:'5px 8px',background:`${row.overallBand.color}15`,borderRadius:4}}>
                              {row.overall != null
                                ? <div>
                                    <div style={{fontWeight:800,color:row.overallBand.color,fontSize:13,lineHeight:1}}>{row.overall}</div>
                                    <div style={{fontSize:8.5,color:row.overallBand.color,textTransform:'uppercase',letterSpacing:'.05em',marginTop:1}}>{row.overallBand.label}</div>
                                  </div>
                                : <span style={{color:'var(--text3)'}}>—</span>}
                            </td>
                            {row.cells.map((c) => {
                              const noData = c.score == null
                              const fmt = (v, d=1) => v == null ? '—' : v.toFixed(d)
                              const tooltip = noData
                                ? `${row.groupName} · ${c.weekday}, ${c.dateLabel}\nNo data`
                                : `${row.groupName} · ${c.weekday}, ${c.dateLabel}\n` +
                                  `Score: ${c.score}/100 (${c.band.label})\n` +
                                  `Latency: avg ${fmt(c.latencyAvg)}ms · max ${fmt(c.latencyMax)}ms\n` +
                                  `Loss: avg ${fmt(c.lossAvg,2)}% · max ${fmt(c.lossMax,2)}%`
                              return (
                                <td key={c.dayMs}
                                  title={tooltip}
                                  style={{
                                    textAlign:'center',
                                    padding:'5px 4px',
                                    borderRadius:4,
                                    background: noData ? 'var(--bg)' : `${c.band.color}28`,
                                    border: `1px solid ${noData ? 'var(--border)' : c.band.color + '60'}`,
                                    minWidth:54,
                                    cursor:'help',
                                  }}>
                                  {noData
                                    ? <span style={{color:'var(--text3)',fontSize:11}}>—</span>
                                    : <>
                                        <div style={{fontWeight:800,color:c.band.color,fontSize:12,lineHeight:1}}>{c.score}</div>
                                        <div style={{display:'flex',flexDirection:'column',marginTop:3,fontSize:9.5,color:'var(--text3)',lineHeight:1.3}}>
                                          {c.latencyAvg != null && (
                                            <span style={{color: c.latencyAvg > 100 ? '#ef4444' : c.latencyAvg > 50 ? '#eab308' : 'var(--text2)'}}>
                                              {c.latencyAvg.toFixed(0)}ms
                                            </span>
                                          )}
                                          {c.lossAvg != null && c.lossAvg > 0.5 && (
                                            <span style={{color: c.lossAvg > 5 ? '#ef4444' : c.lossAvg > 1 ? '#eab308' : 'var(--text2)'}}>
                                              {c.lossAvg.toFixed(1)}%
                                            </span>
                                          )}
                                        </div>
                                      </>}
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{marginTop:8,display:'flex',flexWrap:'wrap',gap:10,fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                  <span><span style={{display:'inline-block',width:10,height:10,background:'#22c55e',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>Healthy 95+</span>
                  <span><span style={{display:'inline-block',width:10,height:10,background:'#eab308',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>OK 85-94</span>
                  <span><span style={{display:'inline-block',width:10,height:10,background:'#f97316',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>Degraded 70-84</span>
                  <span><span style={{display:'inline-block',width:10,height:10,background:'#ef4444',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>Poor &lt;70</span>
                  <span style={{marginLeft:'auto'}}>
                    Note: SD-WAN devices may also appear within RP / POS rows (vendor-based group overlaps hostname groups)
                  </span>
                </div>
              </div>
            )}

            {!groupDailyMatrix && groupHistLoading && (
              <div style={{padding:'12px',fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)',borderTop:'1px solid var(--border)'}}>
                ⏳ Loading per-group time series for the selected range…
              </div>
            )}

            {/* ── 3. Day-wise disconnection + offline duration — one widget per group ── */}
            <div style={{borderTop:'1px solid var(--border)',padding:'10px 12px'}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,flexWrap:'wrap'}}>
                <span style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text2)',fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em'}}>
                  🌐 Group Internet Disconnections & Offline Time (Day-wise)
                </span>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                  disconnect events = stores with >=1 new offline session that day (per-store/day dedup) · uptime % = online machine-minutes ÷ possible machine-minutes
                </span>
                {bh.enabled && (
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--amber)'}}>
                    🕒 BH {String(bh.startHour).padStart(2,'0')}:00–{String(bh.endHour).padStart(2,'0')}:00 · {bh.weekdays.length}d
                  </span>
                )}
                <span style={{marginLeft:'auto',fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                  {displayedGroupCards.length} groups · parallel per-group queries
                </span>
                <button type="button" className="sm-btn sm-sm"
                  onClick={loadGroupDisconnect}>
                  {Object.values(groupDisconnectLoadingById).some(Boolean) ? '⏳ Loading…' : '↻ Refresh'}
                </button>
              </div>

              <div style={{display:'flex', flexDirection:'column', gap:12}}>
                {displayedGroupCards.map((card) => {
                  const meta = groupMetaFor(card.id)
                  const payload = groupDisconnectById[card.id]
                  const loading = groupDisconnectLoadingById[card.id]
                  const errorMsg = groupDisconnectErrorById[card.id] || ''
                  const days = payload?.days || []
                  const group = payload?.groups?.find((g) => g.name === card.id) || payload?.groups?.[0]
                  const chart = group && days.length ? buildSingleGroupDisconnectChart(group, days, card.id, tc) : null

                  return (
                    <div key={card.id} style={{
                      border:`1px solid ${meta.color}40`,
                      borderLeft:`3px solid ${meta.color}`,
                      borderRadius:'var(--sm-r)',
                      background:'var(--bg)',
                      overflow:'hidden',
                    }}>
                      <div style={{
                        display:'flex', alignItems:'center', gap:8, flexWrap:'wrap',
                        padding:'8px 12px', background:`${meta.color}10`,
                        borderBottom:'1px solid var(--border)',
                      }}>
                        <span style={{display:'inline-flex', alignItems:'center', gap:6, color:meta.color, fontWeight:700, fontSize:12}}>
                          <span>{meta.icon}</span>
                          <span>{shortGroupLabel(card.id)}</span>
                        </span>
                        {payload?.source && (
                          <span style={{fontSize:10, fontFamily:'var(--mono)', color:'var(--text3)'}}>
                            source: {payload.source}
                          </span>
                        )}
                        {loading && (
                          <span style={{marginLeft:'auto', fontSize:10, fontFamily:'var(--mono)', color:'var(--accent)'}}>
                            ⏳ Loading…
                          </span>
                        )}
                        {!loading && payload && (
                          <span style={{marginLeft: loading ? 0 : 'auto', fontSize:10, fontFamily:'var(--mono)', color:'var(--text3)'}}>
                            {payload.bucketMin || 5}m buckets ·{' '}
                            <strong style={{color:'var(--text2)'}}>{group?.storeCount ?? 0}</strong>
                            {' '}reporting / <strong style={{color:'var(--text2)'}}>{card.total ?? 0}</strong> total stores
                            {' '}· avg/day <strong style={{color:'var(--text2)'}}>
                              {days.length ? ((group?.totals?.disconnections || 0) / days.length).toFixed(2) : '0.00'}
                            </strong>
                            {card.total > 0 && (
                              <>
                                {' '}·{' '}
                                <span style={{color: card.online === card.total ? '#22c55e' : '#22c55e'}}>{card.online} online</span>
                                {' / '}
                                <span style={{color: (card.total - card.online) > 0 ? '#ef4444' : 'var(--text3)'}}>
                                  {card.total - card.online} offline
                                </span>
                              </>
                            )}
                          </span>
                        )}
                      </div>

                      {!loading && group && days.length > 0 ? (
                        <div style={{
                          display:'grid',
                          gridTemplateColumns:'minmax(240px, 1fr) minmax(260px, 1fr)',
                          gap:12,
                          padding:'10px 12px',
                          alignItems:'stretch',
                        }}>
                          <div style={{overflowX:'auto'}}>
                            <table className="sm-tbl" style={{minWidth:220, margin:0}}>
                              <thead>
                                <tr>
                                  <th>Day</th>
                                  <th title="Stores with >=1 new offline session that started this day (flap-coalesced, per-store/day dedup)">Disconnects</th>
                                  <th>Uptime %</th>
                                </tr>
                              </thead>
                              <tbody>
                                {days.map((d) => {
                                  const day = group.days.find((x) => x.dayMs === d.dayMs) || { disconnections: 0, offlineMinutes: 0 }
                                  const dt = new Date(d.dayMs)
                                  const isToday = dt.toDateString() === new Date().toDateString()
                                  const winMins = dayWindowMinutes(d.dayMs, bh)
                                  const upPct = uptimePctForDay(day.offlineMinutes, group.storeCount, winMins)
                                  const upTitle = winMins > 0
                                    ? `${fmtOfflineMinutes(day.offlineMinutes)} offline · ${group.storeCount} stores × ${winMins}m window`
                                    : (bh?.enabled ? 'Outside business hours' : 'No window')
                                  return (
                                    <tr key={d.dayMs}>
                                      <td style={{whiteSpace:'nowrap', fontWeight: isToday ? 700 : 500, color: isToday ? 'var(--accent)' : 'var(--text2)'}}>
                                        {dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                                      </td>
                                      <td style={{fontFamily:'var(--mono)', fontWeight:700, color: day.disconnections > 0 ? '#ef4444' : 'var(--text3)'}}>
                                        {day.disconnections}
                                      </td>
                                      <td title={upTitle}
                                        style={{fontFamily:'var(--mono)', fontWeight:700, color: uptimeColor(upPct)}}>
                                        {fmtUptimePct(upPct)}
                                      </td>
                                    </tr>
                                  )
                                })}
                                {(() => {
                                  const totalWin = days.reduce((sum, d) => sum + dayWindowMinutes(d.dayMs, bh), 0)
                                  const totalUp = uptimePctForDay(group.totals.offlineMinutes, group.storeCount, totalWin)
                                  const totalTitle = totalWin > 0
                                    ? `${fmtOfflineMinutes(group.totals.offlineMinutes)} offline · ${group.storeCount} stores × ${totalWin}m window`
                                    : 'No window'
                                  return (
                                    <tr style={{borderTop:'2px solid var(--border)'}}>
                                      <td style={{fontWeight:700, color:'var(--text2)'}}>Total</td>
                                      <td
                                        title={group.totals.uniqueStoresWithNewEvents != null
                                          ? `${group.totals.uniqueStoresWithNewEvents} unique stores with new events · raw events: ${group.totals.rawEvents || 0} · impacted stores: ${group.totals.uniqueStoresImpacted || 0}`
                                          : undefined}
                                        style={{fontFamily:'var(--mono)', fontWeight:700, color: group.totals.disconnections > 0 ? '#ef4444' : 'var(--text3)'}}>
                                        {group.totals.disconnections}
                                      </td>
                                      <td title={totalTitle}
                                        style={{fontFamily:'var(--mono)', fontWeight:700, color: uptimeColor(totalUp)}}>
                                        {fmtUptimePct(totalUp)}
                                      </td>
                                    </tr>
                                  )
                                })()}
                              </tbody>
                            </table>
                          </div>

                          <div style={{
                            border:'1px solid var(--border)', borderRadius:'var(--sm-r)', background:'var(--bg2)',
                            padding:'8px 10px', minHeight:220, display:'flex', flexDirection:'column',
                          }}>
                            <div style={{fontSize:10, fontFamily:'var(--mono)', color:'var(--text3)', marginBottom:6, textTransform:'uppercase', letterSpacing:'.06em'}}>
                              Disconnect events per day (bars) · hover for offline duration + stores down
                            </div>
                            {chart ? (
                              <div style={{flex:1, minHeight:180, position:'relative'}}>
                                <Chart type="bar" data={chart.data} options={chart.options} />
                              </div>
                            ) : (
                              <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontFamily:'var(--mono)', color:'var(--text3)'}}>
                                No chart data
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div style={{padding:'12px', fontSize:11, fontFamily:'var(--mono)'}}>
                          {loading ? (
                            <span style={{color:'var(--text3)'}}>Loading day-wise disconnection report…</span>
                          ) : errorMsg ? (
                            <span style={{color:'#ef4444'}}>
                              ⚠ Failed to load: {errorMsg}
                            </span>
                          ) : (
                            <span style={{color:'var(--text3)'}}>No disconnection/offline data for this range.</span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* ── periodic Net Health charts (across full fleet, selected range) ── */}
          <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:10,padding:'8px 12px',
            background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:'var(--sm-r)',
            fontSize:11,fontFamily:'var(--mono)',marginBottom:10}}>
            <span style={{color:'var(--text3)'}}>
              📅 Window: <strong style={{color:'var(--text2)'}}>
                {netHist
                  ? `${new Date(netHist.requestedFrom).toLocaleString()} → ${new Date(netHist.requestedTo).toLocaleString()}`
                  : (globalCustom.enabled && globalCustom.from
                      ? `${new Date(globalCustom.from).toLocaleString()} → ${globalCustom.to ? new Date(globalCustom.to).toLocaleString() : 'now'}`
                      : (TIME_RANGES.find(r=>r.key===range)?.label || range))}
              </strong>
            </span>
            {netHist?.aggregateEvery && (
              <span style={{color:'var(--text3)'}}>
                ⏱ Bucket: <strong style={{color:'var(--text2)'}}>{netHist.aggregateEvery}</strong>
              </span>
            )}
            {netHist?.pointCount != null && (
              <span style={{color:'var(--text3)'}}>📊 {netHist.pointCount} pts</span>
            )}
            {bh.enabled && <span style={{color:'var(--amber)'}}>● BH filter active</span>}
            {netHistError && <span style={{color:'var(--red)'}}>⚠ {netHistError}</span>}
            <button className="sm-btn sm-sm" style={{marginLeft:'auto'}}
              onClick={loadNetHist} disabled={netHistLoading}>
              {netHistLoading ? '⏳ Loading…' : '↻ Refresh'}
            </button>
          </div>

          {/* ── DAILY HEALTH (Pingdom / UptimeRobot / StatusCake style) ──
              Shown when the selected range spans 2+ days. One card per day with
              a 0-100 health score, headline metrics, and a status colour band.
          */}
          {dailyHealth && dailyHealth.spanDays >= 1 && dailyHealth.days.length >= 2 && (
            <div className="sm-tr sm-section-mb">
              <div className="sm-tr-hd">
                <span className="sm-tr-title">📅 Daily Health Summary</span>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                  {dailyHealth.days.length} day{dailyHealth.days.length === 1 ? '' : 's'} · fleet-wide rollup
                </span>
              </div>
              {/* Day cards strip */}
              <div style={{padding:'10px 12px',display:'grid',
                gridTemplateColumns:`repeat(auto-fit, minmax(118px, 1fr))`,gap:8}}>
                {dailyHealth.days.map((d) => {
                  const noData = d.samples === 0
                  return (
                    <div key={d.dayMs}
                      title={`${d.weekday}, ${d.dateLabel} — ${noData ? 'no data' : `${d.band.label} (${d.score}/100)`}`}
                      style={{
                        position:'relative',
                        padding:'8px 10px 9px',
                        borderRadius:8,
                        background:`linear-gradient(180deg, ${d.band.color}10 0%, var(--bg3) 60%)`,
                        border:`1px solid ${d.band.color}40`,
                        borderLeft:`4px solid ${d.band.color}`,
                      }}>
                      {/* Day header */}
                      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:6}}>
                        <div>
                          <div style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.06em'}}>
                            {d.weekday}{d.isToday && <span style={{marginLeft:4,padding:'1px 5px',background:'var(--accent)',color:'#fff',borderRadius:3,fontSize:8}}>TODAY</span>}
                          </div>
                          <div style={{fontSize:13,fontWeight:700,color:'var(--text)',marginTop:1}}>{d.dateLabel}</div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          {noData
                            ? <div style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>no data</div>
                            : <>
                                <div style={{fontSize:18,fontWeight:800,lineHeight:1,color:d.band.color,fontFamily:'var(--mono)'}}>
                                  {d.score}
                                </div>
                                <div style={{fontSize:8.5,fontFamily:'var(--mono)',color:d.band.color,textTransform:'uppercase',letterSpacing:'.06em',marginTop:2}}>
                                  {d.band.label}
                                </div>
                              </>}
                        </div>
                      </div>

                      {/* Score bar */}
                      {!noData && (
                        <div style={{marginTop:6,height:3,background:'var(--bg)',borderRadius:2,overflow:'hidden'}}>
                          <div style={{width:`${d.score}%`,height:'100%',background:d.band.color,transition:'width .2s'}}/>
                        </div>
                      )}

                      {/* Headline metrics */}
                      {!noData && (
                        <div style={{marginTop:7,display:'flex',flexDirection:'column',gap:3,fontSize:10.5,fontFamily:'var(--mono)'}}>
                          {d.latencyAvg != null && (
                            <div style={{display:'flex',justifyContent:'space-between'}}>
                              <span style={{color:'var(--text3)'}}>Latency</span>
                              <span style={{color: d.latencyAvg > 100 ? '#ef4444' : d.latencyAvg > 50 ? '#eab308' : 'var(--text)', fontWeight:700}}>
                                {d.latencyAvg.toFixed(0)}<span style={{color:'var(--text3)',fontWeight:400}}> ms</span>
                              </span>
                            </div>
                          )}
                          {d.lossAvg != null && (
                            <div style={{display:'flex',justifyContent:'space-between'}}>
                              <span style={{color:'var(--text3)'}}>Loss</span>
                              <span style={{color: d.lossAvg > 5 ? '#ef4444' : d.lossAvg > 1 ? '#eab308' : 'var(--text)', fontWeight:700}}>
                                {d.lossAvg.toFixed(2)}<span style={{color:'var(--text3)',fontWeight:400}}> %</span>
                              </span>
                            </div>
                          )}
                          {d.dnsAvg != null && (
                            <div style={{display:'flex',justifyContent:'space-between'}}>
                              <span style={{color:'var(--text3)'}}>DNS</span>
                              <span style={{color: d.dnsAvg >= 99 ? '#22c55e' : d.dnsAvg >= 95 ? '#eab308' : '#ef4444', fontWeight:700}}>
                                {d.dnsAvg.toFixed(1)}<span style={{color:'var(--text3)',fontWeight:400}}> %</span>
                              </span>
                            </div>
                          )}
                          {d.httpAvg != null && (
                            <div style={{display:'flex',justifyContent:'space-between'}}>
                              <span style={{color:'var(--text3)'}}>HTTP</span>
                              <span style={{color: d.httpAvg >= 98 ? '#22c55e' : d.httpAvg >= 95 ? '#eab308' : '#ef4444', fontWeight:700}}>
                                {d.httpAvg.toFixed(1)}<span style={{color:'var(--text3)',fontWeight:400}}> %</span>
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Per-day detail table */}
              <div className="sm-tbl-wrap" style={{borderTop:'1px solid var(--border)'}}>
                <table className="sm-tbl">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Health</th>
                      <th>Latency avg / max</th>
                      <th>Loss avg / max</th>
                      <th>DNS %</th>
                      <th>HTTP %</th>
                      <th>Worst target (loss)</th>
                      <th>Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyHealth.days.map((d) => {
                      const worst = d.perTarget[0]
                      const noData = d.samples === 0
                      const cell = (val, unit, thresholds) => {
                        if (val == null) return <span style={{color:'var(--text3)'}}>—</span>
                        const [warn, crit] = thresholds || [Infinity, Infinity]
                        const color = val >= crit ? '#ef4444' : val >= warn ? '#eab308' : 'var(--text)'
                        return <span style={{color,fontFamily:'var(--mono)',fontWeight:600}}>{val.toFixed(unit === '%' ? 2 : 1)}{unit}</span>
                      }
                      return (
                        <tr key={d.dayMs} style={noData ? {opacity:.6} : undefined}>
                          <td>
                            <div style={{display:'flex',flexDirection:'column'}}>
                              <span style={{fontWeight:700}}>{d.weekday}</span>
                              <span style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)'}}>{d.dateLabel}</span>
                            </div>
                          </td>
                          <td>
                            {noData
                              ? <span style={{color:'var(--text3)',fontSize:11}}>—</span>
                              : <span className="sm-pill" style={{background:`${d.band.color}22`,color:d.band.color,fontWeight:700,fontFamily:'var(--mono)'}}>
                                  {d.score} · {d.band.label}
                                </span>}
                          </td>
                          <td>
                            {d.latencyAvg != null
                              ? <>
                                  {cell(d.latencyAvg, ' ms', [50, 100])}
                                  <span style={{color:'var(--text3)',fontFamily:'var(--mono)'}}> / </span>
                                  {cell(d.latencyMax, ' ms', [100, 200])}
                                </>
                              : <span style={{color:'var(--text3)'}}>—</span>}
                          </td>
                          <td>
                            {d.lossAvg != null
                              ? <>
                                  {cell(d.lossAvg, '%', [1, 5])}
                                  <span style={{color:'var(--text3)',fontFamily:'var(--mono)'}}> / </span>
                                  {cell(d.lossMax, '%', [5, 10])}
                                </>
                              : <span style={{color:'var(--text3)'}}>—</span>}
                          </td>
                          <td>
                            {d.dnsAvg != null
                              ? <span style={{color: d.dnsAvg >= 99 ? '#22c55e' : d.dnsAvg >= 95 ? '#eab308' : '#ef4444',fontFamily:'var(--mono)',fontWeight:600}}>
                                  {d.dnsAvg.toFixed(1)}%
                                </span>
                              : <span style={{color:'var(--text3)'}}>—</span>}
                          </td>
                          <td>
                            {d.httpAvg != null
                              ? <span style={{color: d.httpAvg >= 98 ? '#22c55e' : d.httpAvg >= 95 ? '#eab308' : '#ef4444',fontFamily:'var(--mono)',fontWeight:600}}>
                                  {d.httpAvg.toFixed(1)}%
                                </span>
                              : <span style={{color:'var(--text3)'}}>—</span>}
                          </td>
                          <td>
                            {worst && worst.lossAvg != null && worst.lossAvg > 0.5
                              ? <span style={{fontFamily:'var(--mono)',fontSize:11}}>
                                  <strong>{worst.target}</strong>
                                  <span style={{color: worst.lossAvg > 5 ? '#ef4444' : '#eab308',marginLeft:6}}>
                                    {worst.lossAvg.toFixed(2)}%
                                  </span>
                                </span>
                              : <span style={{color:'var(--text3)',fontSize:11}}>—</span>}
                          </td>
                          <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{d.samples}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{padding:'6px 12px',borderTop:'1px solid var(--border)',
                display:'flex',flexWrap:'wrap',gap:12,fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                Health bands:
                <span><span style={{display:'inline-block',width:8,height:8,background:'#22c55e',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>95–100 Healthy</span>
                <span><span style={{display:'inline-block',width:8,height:8,background:'#eab308',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>85–94 OK</span>
                <span><span style={{display:'inline-block',width:8,height:8,background:'#f97316',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>70–84 Degraded</span>
                <span><span style={{display:'inline-block',width:8,height:8,background:'#ef4444',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>&lt;70 Poor</span>
                <span style={{marginLeft:'auto'}}>Score = 100 − penalties for latency &gt;50/100/200ms, loss &gt;1/5/10%, DNS &lt;99%, HTTP &lt;98%</span>
              </div>
            </div>
          )}

          {/* ── DAILY HEALTH per group ── */}
          {dailyHealthByGroup && dailyHealthByGroup.spanDays >= 1 && dailyHealthByGroup.dayMsList.length >= 2 && (
            <div className="sm-tr sm-section-mb">
              <div className="sm-tr-hd">
                <span className="sm-tr-title">👥 Daily Health Summary · per group</span>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                  {dailyHealthByGroup.dayMsList.length} days · one section per group
                </span>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:10,padding:'10px 12px'}}>
                {displayedGroupCards.map((card) => {
                  const meta = groupMetaFor(card.id)
                  const days = dailyHealthByGroup.byGroup.get(card.id) || []
                  const hasData = days.some((d) => d.samples > 0)
                  return (
                    <div key={card.id} style={{
                      border:`1px solid ${meta.color}40`,
                      borderLeft:`3px solid ${meta.color}`,
                      borderRadius:'var(--sm-r)',
                      background:'var(--bg)',
                      overflow:'hidden',
                    }}>
                      <div style={{
                        display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',
                        padding:'8px 12px',background:`${meta.color}10`,
                        borderBottom:'1px solid var(--border)',
                      }}>
                        <span style={{display:'inline-flex',alignItems:'center',gap:6,color:meta.color,fontWeight:700,fontSize:12}}>
                          <span>{meta.icon}</span>
                          <span>{shortGroupLabel(card.id)}</span>
                        </span>
                        <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                          {card.total ?? 0} total stores
                        </span>
                      </div>

                      {hasData ? (
                        <>
                          {/* Day cards strip */}
                          <div style={{padding:'10px 12px',display:'grid',
                            gridTemplateColumns:`repeat(auto-fit, minmax(118px, 1fr))`,gap:8}}>
                            {days.map((d) => {
                              const noData = d.samples === 0
                              return (
                                <div key={d.dayMs}
                                  title={`${d.weekday}, ${d.dateLabel} — ${noData ? 'no data' : `${d.band.label} (${d.score}/100)`}`}
                                  style={{
                                    position:'relative',
                                    padding:'8px 10px 9px',
                                    borderRadius:8,
                                    background:`linear-gradient(180deg, ${d.band.color}10 0%, var(--bg3) 60%)`,
                                    border:`1px solid ${d.band.color}40`,
                                    borderLeft:`4px solid ${d.band.color}`,
                                  }}>
                                  <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:6}}>
                                    <div>
                                      <div style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.06em'}}>
                                        {d.weekday}{d.isToday && <span style={{marginLeft:4,padding:'1px 5px',background:'var(--accent)',color:'#fff',borderRadius:3,fontSize:8}}>TODAY</span>}
                                      </div>
                                      <div style={{fontSize:13,fontWeight:700,color:'var(--text)',marginTop:1}}>{d.dateLabel}</div>
                                    </div>
                                    <div style={{textAlign:'right'}}>
                                      {noData
                                        ? <div style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>no data</div>
                                        : <>
                                            <div style={{fontSize:18,fontWeight:800,lineHeight:1,color:d.band.color,fontFamily:'var(--mono)'}}>
                                              {d.score}
                                            </div>
                                            <div style={{fontSize:8.5,fontFamily:'var(--mono)',color:d.band.color,textTransform:'uppercase',letterSpacing:'.06em',marginTop:2}}>
                                              {d.band.label}
                                            </div>
                                          </>}
                                    </div>
                                  </div>
                                  {!noData && (
                                    <div style={{marginTop:6,height:3,background:'var(--bg)',borderRadius:2,overflow:'hidden'}}>
                                      <div style={{width:`${d.score}%`,height:'100%',background:d.band.color,transition:'width .2s'}}/>
                                    </div>
                                  )}
                                  {!noData && (
                                    <div style={{marginTop:7,display:'flex',flexDirection:'column',gap:3,fontSize:10.5,fontFamily:'var(--mono)'}}>
                                      {d.latencyAvg != null && (
                                        <div style={{display:'flex',justifyContent:'space-between'}}>
                                          <span style={{color:'var(--text3)'}}>Latency</span>
                                          <span style={{color: d.latencyAvg > 100 ? '#ef4444' : d.latencyAvg > 50 ? '#eab308' : 'var(--text)', fontWeight:700}}>
                                            {d.latencyAvg.toFixed(0)}<span style={{color:'var(--text3)',fontWeight:400}}> ms</span>
                                          </span>
                                        </div>
                                      )}
                                      {d.lossAvg != null && (
                                        <div style={{display:'flex',justifyContent:'space-between'}}>
                                          <span style={{color:'var(--text3)'}}>Loss</span>
                                          <span style={{color: d.lossAvg > 5 ? '#ef4444' : d.lossAvg > 1 ? '#eab308' : 'var(--text)', fontWeight:700}}>
                                            {d.lossAvg.toFixed(2)}<span style={{color:'var(--text3)',fontWeight:400}}> %</span>
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>

                          {/* Per-day detail table */}
                          <div className="sm-tbl-wrap" style={{borderTop:'1px solid var(--border)'}}>
                            <table className="sm-tbl">
                              <thead>
                                <tr>
                                  <th>Day</th>
                                  <th>Health</th>
                                  <th>Latency avg / max</th>
                                  <th>Loss avg / max</th>
                                  <th>Samples</th>
                                </tr>
                              </thead>
                              <tbody>
                                {days.map((d) => {
                                  const noData = d.samples === 0
                                  const cell = (val, unit, thresholds) => {
                                    if (val == null) return <span style={{color:'var(--text3)'}}>—</span>
                                    const [warn, crit] = thresholds || [Infinity, Infinity]
                                    const color = val >= crit ? '#ef4444' : val >= warn ? '#eab308' : 'var(--text)'
                                    return <span style={{color,fontFamily:'var(--mono)',fontWeight:600}}>{val.toFixed(unit === '%' ? 2 : 1)}{unit}</span>
                                  }
                                  return (
                                    <tr key={d.dayMs} style={noData ? {opacity:.6} : undefined}>
                                      <td>
                                        <div style={{display:'flex',flexDirection:'column'}}>
                                          <span style={{fontWeight:700}}>{d.weekday}</span>
                                          <span style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)'}}>{d.dateLabel}</span>
                                        </div>
                                      </td>
                                      <td>
                                        {noData
                                          ? <span style={{color:'var(--text3)',fontSize:11}}>—</span>
                                          : <span className="sm-pill" style={{background:`${d.band.color}22`,color:d.band.color,fontWeight:700,fontFamily:'var(--mono)'}}>
                                              {d.score} · {d.band.label}
                                            </span>}
                                      </td>
                                      <td>
                                        {d.latencyAvg != null
                                          ? <>
                                              {cell(d.latencyAvg, ' ms', [50, 100])}
                                              <span style={{color:'var(--text3)',fontFamily:'var(--mono)'}}> / </span>
                                              {cell(d.latencyMax, ' ms', [100, 200])}
                                            </>
                                          : <span style={{color:'var(--text3)'}}>—</span>}
                                      </td>
                                      <td>
                                        {d.lossAvg != null
                                          ? <>
                                              {cell(d.lossAvg, '%', [1, 5])}
                                              <span style={{color:'var(--text3)',fontFamily:'var(--mono)'}}> / </span>
                                              {cell(d.lossMax, '%', [5, 10])}
                                            </>
                                          : <span style={{color:'var(--text3)'}}>—</span>}
                                      </td>
                                      <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{d.samples}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      ) : (
                        <div style={{padding:'12px',fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                          {groupHistLoading ? 'Loading per-group time series…' : 'No latency / loss samples for this group in the selected range.'}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {(() => {
            const renderStatsStrip = (chart) => {
              if (!chart || !chart.stats?.length) return null
              const unit = chart.yLabel || ''
              const dec  = chart.decimals ?? 2
              const fmt  = (v) => Number(v).toFixed(dec)
              return (
                <div style={{
                  display:'flex',flexWrap:'wrap',gap:6,padding:'6px 12px',
                  background:'var(--bg3)',borderBottom:'1px solid var(--border)',
                  fontSize:10.5,fontFamily:'var(--mono)',
                }}>
                  {chart.stats.map((st) => (
                    <div key={st.label} style={{
                      display:'flex',alignItems:'center',gap:6,
                      padding:'4px 8px',borderRadius:5,
                      background:`${st.color}14`,border:`1px solid ${st.color}30`,
                    }}>
                      <span style={{
                        width:8,height:8,borderRadius:'50%',background:st.color,flexShrink:0,
                      }}/>
                      <span style={{color:'var(--text2)',fontWeight:700,fontSize:10}}>
                        {st.target || st.label}
                      </span>
                      <span style={{color:'var(--text3)'}}>
                        avg <strong style={{color:'var(--text)'}}>{fmt(st.avg)}{unit}</strong>
                      </span>
                      <span style={{color:'var(--text3)'}}>
                        min <strong style={{color:'var(--green)'}}>{fmt(st.min)}</strong>
                      </span>
                      <span style={{color:'var(--text3)'}}>
                        max <strong style={{color:'var(--red)'}}>{fmt(st.max)}</strong>
                      </span>
                      <span style={{color:'var(--text3)'}}>
                        latest <strong style={{color:'var(--accent)'}}>{fmt(st.latest)}{unit}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              )
            }
            const renderAggChart = (chart, emptyLabel) => {
              if (netHistLoading) return <div className="sm-empty">Loading…</div>
              if (!chart || chart.isEmpty) return <div className="sm-empty">{emptyLabel}</div>
              return (
                <Line
                  data={chart.data}
                  options={buildAggregateChartOptions(tc, chart.yLabel, chart.scaleOpts || {}, chart.decimals)}
                />
              )
            }
            return (
              <>
                {/* Section divider before the trend drill-down */}
                {dailyHealth && dailyHealth.spanDays >= 1 && dailyHealth.days.length >= 2 && (
                  <div style={{margin:'4px 0 8px',display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.08em'}}>
                      ▾ Drill-down · Trend by target
                    </span>
                    <div style={{flex:1,height:1,background:'var(--border)'}}/>
                  </div>
                )}

                <div className="sm-g2 sm-section-mb">
                  <div className="sm-tr">
                    <div className="sm-tr-hd">
                      <span className="sm-tr-title">📡 Avg Ping Latency by Target</span>
                      <span style={{fontSize:9.5,fontFamily:'var(--mono)',color:'var(--text3)'}}>ms · fleet-wide mean · auto-scaled</span>
                    </div>
                    {renderStatsStrip(netLatencyTimeChart)}
                    <div className="sm-tr-body sm-chart-tall">
                      {renderAggChart(netLatencyTimeChart, 'No ping latency data in this range')}
                    </div>
                  </div>
                  <div className="sm-tr">
                    <div className="sm-tr-hd">
                      <span className="sm-tr-title">📉 Packet Loss by Target</span>
                      <span style={{fontSize:9.5,fontFamily:'var(--mono)',color:'var(--text3)'}}>% · fleet-wide mean · auto-scaled</span>
                    </div>
                    {renderStatsStrip(netLossTimeChart)}
                    <div className="sm-tr-body sm-chart-tall">
                      {renderAggChart(netLossTimeChart, 'No packet loss data in this range')}
                    </div>
                  </div>
                </div>
              </>
            )
          })()}

          {/* ── 🕒 Store Disconnect Events Timeline ──
              Click a group to load per-store disconnect → reconnect events for the
              selected range. Stores that are still offline show "—" in Reconnected. */}
          <div className="sm-tr sm-section-mb">
            <div className="sm-tr-hd">
              <span className="sm-tr-title">🕒 Store Disconnect Events Timeline</span>
              <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                10 min silence min · per-store gap windows · still-offline cross-checked against snapshot
              </span>
            </div>
            <div style={{padding:'10px 12px'}}>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
                {displayedGroupCards.map((card) => {
                  const meta = groupMetaFor(card.id)
                  const active = disconnectEventsExpandedGroup === card.id
                  const loading = disconnectEventsLoadingByGroup[card.id]
                  const payload = disconnectEventsByGroup[card.id]
                  const cnt = payload?.eventCount
                  return (
                    <button key={card.id} type="button"
                      onClick={() => toggleDisconnectEventsGroup(card.id)}
                      title={active ? 'Click to collapse' : 'Click to load disconnect events'}
                      style={{
                        display:'inline-flex',alignItems:'center',gap:6,
                        padding:'6px 12px',borderRadius:6,fontSize:12,fontWeight:active?700:500,
                        cursor:'pointer',transition:'all 120ms ease',
                        background:active?meta.color:'transparent',
                        color:active?'#fff':meta.color,
                        border:`1px solid ${meta.color}`,
                      }}>
                      <span>{meta.icon}</span>
                      <span>{shortGroupLabel(card.id)}</span>
                      {loading && <span style={{fontFamily:'var(--mono)',fontSize:10,opacity:.85}}>⏳</span>}
                      {!loading && cnt != null && (
                        <span style={{
                          fontFamily:'var(--mono)',fontSize:10,
                          background: active ? 'rgba(255,255,255,.2)' : `${meta.color}22`,
                          padding:'1px 6px',borderRadius:3,
                        }}>{cnt}</span>
                      )}
                    </button>
                  )
                })}
              </div>

              {disconnectEventsExpandedGroup && (() => {
                const groupId = disconnectEventsExpandedGroup
                const meta = groupMetaFor(groupId)
                const payload = disconnectEventsByGroup[groupId]
                const loading = disconnectEventsLoadingByGroup[groupId]
                const errorMsg = disconnectEventsErrorByGroup[groupId] || ''
                const allEvents = payload?.events || []
                const q = disconnectEventsSearch.trim().toLowerCase()
                const filtered = allEvents.filter((e) => {
                  if (disconnectEventsFilter === 'offline' && !e.stillOffline) return false
                  if (disconnectEventsFilter === 'reconnected' && e.stillOffline) return false
                  if (!q) return true
                  return String(e.hostname || '').toLowerCase().includes(q)
                    || String(e.storeTag || '').toLowerCase().includes(q)
                })
                const rowCap = 500
                const shown = filtered.slice(0, rowCap)
                const truncated = filtered.length > rowCap

                return (
                  <div style={{
                    border:`1px solid ${meta.color}40`,
                    borderLeft:`3px solid ${meta.color}`,
                    borderRadius:'var(--sm-r)',background:'var(--bg)',overflow:'hidden',
                  }}>
                    <div style={{
                      display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',
                      padding:'8px 12px',background:`${meta.color}10`,borderBottom:'1px solid var(--border)',
                    }}>
                      <span style={{display:'inline-flex',alignItems:'center',gap:6,color:meta.color,fontWeight:700,fontSize:12}}>
                        <span>{meta.icon}</span>
                        <span>{shortGroupLabel(groupId)}</span>
                      </span>
                      {payload && (
                        <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                          {payload.eventCount} event{payload.eventCount === 1 ? '' : 's'}
                          {' · '}<strong style={{color:'#ef4444'}}>{payload.stillOfflineCount}</strong> still offline
                          {payload.source && <> · source: {payload.source}</>}
                        </span>
                      )}
                      <div style={{marginLeft:'auto',display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                        <input
                          type="text" placeholder="Search hostname / store_tag…"
                          value={disconnectEventsSearch}
                          onChange={(e) => setDisconnectEventsSearch(e.target.value)}
                          style={{
                            background:'var(--bg2)',border:'1px solid var(--border)',color:'var(--text)',
                            padding:'4px 8px',borderRadius:4,fontSize:11,fontFamily:'var(--mono)',width:200,
                          }}
                        />
                        <select
                          value={disconnectEventsFilter}
                          onChange={(e) => setDisconnectEventsFilter(e.target.value)}
                          style={{
                            background:'var(--bg2)',border:'1px solid var(--border)',color:'var(--text)',
                            padding:'4px 6px',borderRadius:4,fontSize:11,fontFamily:'var(--mono)',
                          }}
                        >
                          <option value="all">All events</option>
                          <option value="offline">Still offline</option>
                          <option value="reconnected">Reconnected</option>
                        </select>
                        <button type="button" className="sm-btn sm-sm"
                          onClick={() => downloadDisconnectEventsCsv(groupId, filtered)}
                          disabled={!filtered.length}
                          title="Download visible rows as CSV">
                          ⬇ CSV
                        </button>
                        <button type="button" className="sm-btn sm-sm"
                          onClick={() => loadDisconnectEventsForGroup(groupId, { force: true })}
                          disabled={loading}>
                          {loading ? '⏳ Loading…' : '↻ Refresh'}
                        </button>
                      </div>
                    </div>

                    <div style={{padding:'10px 12px'}}>
                      {loading && !payload ? (
                        <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                          Loading per-store disconnect events…
                        </div>
                      ) : errorMsg ? (
                        <div style={{fontSize:11,fontFamily:'var(--mono)',color:'#ef4444'}}>
                          ⚠ Failed to load: {errorMsg}
                        </div>
                      ) : !filtered.length ? (
                        <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                          {allEvents.length
                            ? 'No events match the current filter.'
                            : 'No disconnect events recorded for this group in the selected range.'}
                        </div>
                      ) : (
                        <>
                          <div style={{overflowX:'auto',maxHeight:520,overflowY:'auto'}}>
                            <table className="sm-tbl" style={{margin:0,minWidth:780}}>
                              <thead style={{position:'sticky',top:0,background:'var(--bg)',zIndex:1}}>
                                <tr>
                                  <th style={{width:34}}>#</th>
                                  <th>Hostname</th>
                                  <th>Store Tag</th>
                                  <th style={{whiteSpace:'nowrap'}}>Disconnected</th>
                                  <th style={{whiteSpace:'nowrap'}}>Reconnected</th>
                                  <th style={{whiteSpace:'nowrap'}}>Duration</th>
                                  <th>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {shown.map((e, idx) => (
                                  <tr key={`${e.storeTag}|${e.disconnectTs}`}>
                                    <td style={{color:'var(--text3)',fontFamily:'var(--mono)',fontSize:10}}>{idx + 1}</td>
                                    <td style={{fontWeight:600}}>{e.hostname || '—'}</td>
                                    <td style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)'}}>{e.storeTag}</td>
                                    <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text2)',whiteSpace:'nowrap'}}>
                                      {fmtTs(e.disconnectTs)}
                                    </td>
                                    <td style={{fontFamily:'var(--mono)',fontSize:11,whiteSpace:'nowrap',
                                                color: e.reconnectTs ? '#22c55e' : 'var(--text3)'}}>
                                      {e.reconnectTs ? fmtTs(e.reconnectTs) : '—'}
                                    </td>
                                    <td style={{fontFamily:'var(--mono)',fontWeight:700,whiteSpace:'nowrap',
                                                color: e.stillOffline ? '#ef4444' : '#f59e0b'}}>
                                      {fmtDurationMin(e.durationMin)}
                                      {e.flapCount > 1 && (
                                        <span title={`${e.flapCount} short flaps merged (gaps <= 30 min)`}
                                          style={{marginLeft:6, color:'#f59e0b', fontSize:9, fontWeight:600}}>
                                          · {e.flapCount}× flap
                                        </span>
                                      )}
                                    </td>
                                    <td>
                                      {e.stillOffline ? (
                                        <span style={{display:'inline-flex',alignItems:'center',gap:4,
                                          fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:3,
                                          background:'#ef444422',color:'#ef4444',fontFamily:'var(--mono)'}}>
                                          ● STILL OFFLINE
                                        </span>
                                      ) : (
                                        <span style={{display:'inline-flex',alignItems:'center',gap:4,
                                          fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:3,
                                          background:'#22c55e22',color:'#22c55e',fontFamily:'var(--mono)'}}>
                                          ✓ RECONNECTED
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {truncated && (
                            <div style={{marginTop:8,fontSize:10,fontFamily:'var(--mono)',color:'var(--amber)'}}>
                              Showing first {rowCap} of {filtered.length} rows · narrow the search or download CSV for the full list.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })()}
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
                            <span className="sm-picker-item-meta">{(s.systemGroups||[s.systemGroup]).map(g=>g.replace(' Group','')).join(' · ')}</span>
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

            <button className="sm-btn sm-sm" onClick={() => { loadHistory(selectedTag) }} disabled={histLoading}>
              {histLoading ? '⏳' : '↻'} Refresh charts
            </button>
            {!customHist.enabled && (
              <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                Using global range: {TIME_RANGES.find(r=>r.key===range)?.label}
              </span>
            )}
          </div>

          {selected ? (
            <>
              {/* ── KPI banner: fixed 5-column grid, uniform card height ── */}
              {(() => {
                const p = primaryPing(selected)
                const pingColor = !p ? '#64748b' : p.avgMs > 200 ? '#ef4444' : p.avgMs > 100 ? '#eab308' : '#22c55e'
                const cpuColor  = selected.cpuPct  > 90 ? '#ef4444' : selected.cpuPct  > 70 ? '#eab308' : '#22c55e'
                const memColor  = selected.memPct  > 90 ? '#ef4444' : selected.memPct  > 70 ? '#eab308' : '#22c55e'
                const ifaceIsWifi = String(selected.activeInterface||'').toLowerCase().includes('wi')

                return (
                  <div style={{display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:8, marginBottom:10}}>

                    {/* 1 Status */}
                    <div className="sm-kpi" style={{borderTop:`2px solid ${selected.online?'#22c55e':'#ef4444'}`}}>
                      <div className="sm-kpi-label">Status</div>
                      <div style={{marginTop:4,marginBottom:2}}><OnlineBadge online={selected.online}/></div>
                      <div className="sm-kpi-sub">Last seen: {relAge(selected.lastSeen)}</div>
                      <div style={{marginTop:3,display:'flex',flexWrap:'wrap',gap:3}}>
                        {(selected.systemGroups||[selected.systemGroup]).map((g)=><GroupBadge key={g} group={g}/>)}
                      </div>
                    </div>

                    {/* 2 Network */}
                    <div className="sm-kpi" style={{borderTop:`2px solid ${CONN_COLORS[selected.connState]||'#64748b'}`}}>
                      <div className="sm-kpi-label">Network</div>
                      <div style={{marginTop:3,fontWeight:700,fontSize:12,color:ifaceIsWifi?'#06b6d4':'#22c55e'}}>
                        {ifaceIsWifi?'📶':'🔌'} {selected.activeInterface||'—'}
                      </div>
                      <div style={{marginTop:3}}><ConnPill state={selected.connState}/></div>
                      {selected.activeSsid && selected.activeSsid!=='n/a' &&
                        <div className="sm-kpi-sub" style={{marginTop:3}}>SSID: {selected.activeSsid}</div>}
                      <div className="sm-kpi-sub" style={{marginTop:3}}>GW: {selected.gatewayIp||'—'} · {fmtVendor(selected.gatewayVendor)}</div>
                    </div>

                    {/* 3 Ping */}
                    <div className="sm-kpi" style={{borderTop:`2px solid ${pingColor}`}}>
                      <div className="sm-kpi-label">Ping (8.8.8.8)</div>
                      <div className="sm-kpi-val" style={{color:pingColor,marginTop:2}}>{fmtMs(p?.avgMs)}</div>
                      <div className="sm-kpi-sub" style={{marginTop:4}}>Loss: {fmtPct(p?.packetLossPct)}</div>
                      <div className="sm-kpi-sub">Min {fmtMs(p?.minMs)} · Max {fmtMs(p?.maxMs)}</div>
                    </div>

                    {/* 4 CPU + RAM combined */}
                    <div className="sm-kpi" style={{borderTop:`2px solid ${cpuColor}`}}>
                      <div className="sm-kpi-label">CPU / Memory</div>
                      <div style={{display:'flex',alignItems:'baseline',gap:6,marginTop:2}}>
                        <span className="sm-kpi-val" style={{color:cpuColor}}>{fmtPct(selected.cpuPct)}</span>
                        <span style={{color:'var(--text3)',fontSize:10}}>/</span>
                        <span className="sm-kpi-val" style={{color:memColor,fontSize:18}}>{fmtPct(selected.memPct)}</span>
                      </div>
                      <div style={{marginTop:5,display:'flex',flexDirection:'column',gap:3}}>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <span style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',width:26}}>CPU</span>
                          <div style={{flex:1}}><HealthBar pct={selected.cpuPct||0}/></div>
                        </div>
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <span style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',width:26}}>RAM</span>
                          <div style={{flex:1}}><HealthBar pct={selected.memPct||0}/></div>
                        </div>
                      </div>
                    </div>

                    {/* 5 Speedtest */}
                    <div className="sm-kpi" style={{borderTop:'2px solid #3b82f6'}}>
                      <div className="sm-kpi-label">Speedtest</div>
                      <div style={{display:'flex',flexDirection:'column',gap:4,marginTop:3}}>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                          <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>↓ DL</span>
                          <span style={{fontWeight:700,fontSize:16,color:'#3b82f6',fontFamily:'var(--mono)'}}>{fmtMbps(selected.downloadMbps)}</span>
                        </div>
                        <div style={{height:1,background:'var(--border)'}}/>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                          <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>↑ UL</span>
                          <span style={{fontWeight:700,fontSize:16,color:'#8b5cf6',fontFamily:'var(--mono)'}}>{fmtMbps(selected.uploadMbps)}</span>
                        </div>
                      </div>
                      <div className="sm-kpi-sub" style={{marginTop:4}}>Last speedtest</div>
                    </div>
                  </div>
                )
              })()}

              {/* ── Device Snapshot: 2-column grouped table ── */}
              <div className="sm-tr sm-section-mb">
                <div className="sm-tr-hd">
                  <span className="sm-tr-title">📋 Device Snapshot</span>
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                    {selected.hostname} · {selected.serial}
                    {selected.issues?.length > 0 && (
                      <span style={{marginLeft:10,color:SEV_COLORS[selected.severity],fontWeight:700}}>
                        ● {selected.issueCount} issue{selected.issueCount!==1?'s':''} ({selected.severity})
                      </span>
                    )}
                  </span>
                </div>
                <div className="sm-tr-body" style={{padding:'10px 14px'}}>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 24px'}}>
                    {/* ─ left column ─ */}
                    <table style={{borderCollapse:'collapse',width:'100%',fontSize:12}}>
                      <tbody>
                        {[
                          ['Hostname',    selected.hostname,   ''],
                          ['Serial',      selected.serial,     'var(--text3)'],
                          ['Group', null, null, <span key="grps" style={{display:'flex',flexWrap:'wrap',gap:3}}>{(selected.systemGroups||[selected.systemGroup]).map((g)=><GroupBadge key={g} group={g}/>)}</span>],
                          ['Interface',   selected.activeInterface||'—', String(selected.activeInterface||'').toLowerCase().includes('wi')?'#06b6d4':'#22c55e'],
                          ['Connectivity',null, null, <ConnPill key="c" state={selected.connState}/>],
                          ['SSID',        selected.activeSsid&&selected.activeSsid!=='n/a'?selected.activeSsid:'—', ''],
                          ['Gateway IP',  selected.gatewayIp||'—',  ''],
                          ['Vendor',      fmtVendor(selected.gatewayVendor), ''],
                          ['Is Hotspot',  selected.isHotspot?'YES':'No', selected.isHotspot?'#f97316':'var(--text3)'],
                          ['Is Fortinet', selected.isFortinet?'YES':'No', selected.isFortinet?'#8b5cf6':'var(--text3)'],
                        ].map(([k,v,c,node],i)=>(
                          <tr key={k} style={{borderBottom:'1px solid var(--border)'}}>
                            <td style={{padding:'5px 8px 5px 0',color:'var(--text3)',fontFamily:'var(--mono)',fontSize:10,whiteSpace:'nowrap',width:'40%'}}>{k}</td>
                            <td style={{padding:'5px 0',fontWeight:600,color:c||'var(--text)'}}>{node||v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* ─ right column ─ */}
                    <table style={{borderCollapse:'collapse',width:'100%',fontSize:12}}>
                      <tbody>
                        {[
                          ['CPU Usage',   fmtPct(selected.cpuPct),  selected.cpuPct>90?'var(--red)':selected.cpuPct>70?'var(--amber)':'var(--green)'],
                          ['Memory',      fmtPct(selected.memPct),  selected.memPct>90?'var(--red)':selected.memPct>70?'var(--amber)':'var(--green)'],
                          ['Download',    fmtMbps(selected.downloadMbps), '#3b82f6'],
                          ['Upload',      fmtMbps(selected.uploadMbps),   '#8b5cf6'],
                          ...Object.entries(selected.ping||{}).flatMap(([t,p])=>[
                            [`Ping ${t}`,   fmtMs(p.avgMs),          p.avgMs>200?'var(--red)':p.avgMs>100?'var(--amber)':'var(--green)'],
                            [`Loss ${t}`,   fmtPct(p.packetLossPct), p.packetLossPct>10?'var(--red)':p.packetLossPct>0?'var(--amber)':'var(--green)'],
                          ]),
                          ...Object.entries(selected.dns||{}).map(([d,v])=>[
                            `DNS ${d}`, v.success?`OK · ${fmtMs(v.responseMs)}`:'FAIL', v.success?'var(--green)':'var(--red)',
                          ]),
                          ...Object.entries(selected.http||{}).map(([u,v])=>[
                            u.replace(/^https?:\/\//,'').slice(0,28), v.success?`${v.statusCode||200} · ${fmtMs(v.responseMs)}`:'FAIL', v.success?'var(--green)':'var(--red)',
                          ]),
                        ].map(([k,v,c])=>(
                          <tr key={k} style={{borderBottom:'1px solid var(--border)'}}>
                            <td style={{padding:'5px 8px 5px 0',color:'var(--text3)',fontFamily:'var(--mono)',fontSize:10,whiteSpace:'nowrap',width:'40%'}}>{k}</td>
                            <td style={{padding:'5px 0',fontWeight:600,color:c||'var(--text)',fontFamily:'var(--mono)'}}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* ── Active Issues (only shown when issues exist) ── */}
              {selected.issues?.length > 0 && (
                <div className="sm-tr sm-section-mb" style={{borderLeft:`3px solid ${SEV_COLORS[selected.severity]||'#64748b'}`}}>
                  <div className="sm-tr-hd">
                    <span className="sm-tr-title">⚠ Active Issues ({selected.issues.length})</span>
                    <span style={{fontSize:10,fontFamily:'var(--mono)',color:SEV_COLORS[selected.severity]}}>{selected.severity.toUpperCase()}</span>
                  </div>
                  <div className="sm-tr-body" style={{padding:'6px 14px'}}>
                    {selected.issues.map((issue, i) => (
                      <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'6px 0',borderBottom:'1px solid var(--border)'}}>
                        <SevBadge sev={issue.severity}/>
                        <span style={{fontSize:12,flex:1}}>{issue.message}</span>
                        <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>{issue.code}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Time Range + Custom picker (BH lives in global page header) ── */}
              <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:'var(--sm-r-lg)',padding:'10px 14px',marginBottom:10,display:'flex',flexDirection:'column',gap:10}}>

                {/* row 1: preset + custom toggle + data info */}
                <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8}}>
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.06em',whiteSpace:'nowrap'}}>Chart range:</span>
                  <label style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--text2)',cursor:'pointer'}}>
                    <input type="radio" name="histRangeMode" checked={!customHist.enabled}
                      onChange={()=>setCustomHist((c)=>({...c,enabled:false}))}/>
                    Global ({TIME_RANGES.find(r=>r.key===range)?.label||range})
                  </label>
                  <label style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--text2)',cursor:'pointer'}}>
                    <input type="radio" name="histRangeMode" checked={customHist.enabled}
                      onChange={()=>setCustomHist((c)=>({...c,enabled:true}))}/>
                    Custom range
                  </label>

                  {/* data availability info */}
                  {history && (
                    <span style={{marginLeft:'auto',fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textAlign:'right'}}>
                      {history.pointCount > 0
                        ? <>Data: {new Date(history.dataFrom).toLocaleString()} → {new Date(history.dataTo).toLocaleString()} · {history.pointCount} pts</>
                        : <span style={{color:'var(--amber)'}}>⚠ No data in selected range</span>}
                    </span>
                  )}
                </div>

                {/* row 2: custom date-time pickers (only when custom enabled) */}
                {customHist.enabled && (
                  <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8}}>
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>FROM</span>
                      <input type="datetime-local" className="sm-input" value={customHist.from}
                        onChange={(e)=>setCustomHist((c)=>({...c,from:e.target.value}))}
                        style={{fontSize:11,padding:'4px 8px'}}/>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontSize:10,color:'var(--text3)',fontFamily:'var(--mono)'}}>TO</span>
                      <input type="datetime-local" className="sm-input" value={customHist.to}
                        onChange={(e)=>setCustomHist((c)=>({...c,to:e.target.value}))}
                        style={{fontSize:11,padding:'4px 8px'}}/>
                    </div>
                    <button className="sm-btn sm-sm primary" onClick={()=>loadHistory(selectedTag)} disabled={histLoading}>
                      {histLoading?'⏳':'▶'} Apply
                    </button>
                    {/* quick presets */}
                    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                      {[
                        ['30m',30*60],['1h',3600],['3h',3*3600],['6h',6*3600],
                        ['12h',12*3600],['24h',86400],['3d',3*86400],['7d',7*86400],
                      ].map(([lbl,sec])=>(
                        <button key={lbl} type="button" className="sm-btn sm-sm"
                          style={{minWidth:36,justifyContent:'center'}}
                          onClick={()=>{
                            const now2 = new Date()
                            const from2 = new Date(now2.getTime()-sec*1000)
                            setCustomHist((c)=>({...c,enabled:true,from:toLocalInput(from2),to:toLocalInput(now2)}))
                          }}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Periodic charts ── */}
              <div style={{display:'flex',flexDirection:'column',gap:12}}>

                {/* ── chart window info ── */}
                {history && (
                  <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:12,padding:'8px 12px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:'var(--sm-r)',fontSize:11,fontFamily:'var(--mono)'}}>
                    <span style={{color:'var(--text3)'}}>
                      📅 Requested: <strong style={{color:'var(--text2)'}}>
                        {new Date(history.requestedFrom).toLocaleString()} → {new Date(history.requestedTo).toLocaleString()}
                      </strong>
                    </span>
                    {history.pointCount > 0 ? (
                      <span style={{color:'var(--text3)'}}>
                        📊 Data available: <strong style={{color:'var(--green)'}}>
                          {new Date(history.dataFrom).toLocaleString()} → {new Date(history.dataTo).toLocaleString()}
                        </strong>
                        <span style={{marginLeft:8,color:'var(--text3)'}}>
                          {bhFilteredCount !== null ? (
                            <>{bhFilteredCount} pts <span style={{color:'var(--text3)',opacity:.6}}>({history.pointCount} total)</span></>
                          ) : (
                            <>{history.pointCount} pts</>
                          )}
                        </span>
                      </span>
                    ) : (
                      <span style={{color:'var(--amber)'}}>
                        ⚠ No data in this range — device may have been offline
                      </span>
                    )}
                    {bh.enabled && <span style={{color:'var(--amber)',marginLeft:'auto'}}>● BH filter active</span>}
                  </div>
                )}

                {/* ── helper: render a Line chart card ── */}
                {[
                  {
                    title: '📡 Ping Latency', sub: 'ms — gaps = device offline',
                    chart: pingChart,
                    empty: 'No ping data in this range',
                    opts:  buildChartOptions(tc, 'ms', { min: 0 }),
                  },
                  {
                    title: '📉 Packet Loss', sub: '% — 0 is good · gaps = device offline',
                    chart: lossHistChart,
                    empty: 'No packet-loss data in this range',
                    opts:  buildChartOptions(tc, '%', { min: 0, max: 100 }),
                  },
                  {
                    title: '🖥 CPU & Memory', sub: '% used',
                    chart: cpuChart,
                    empty: 'No CPU/memory data in this range',
                    opts:  buildChartOptions(tc, '%', { min: 0, max: 100 }),
                  },
                  {
                    title: '⚡ Speedtest', sub: 'Mbps · runs every ~10 min · gaps = no test run',
                    chart: speedChart,
                    empty: 'No speedtest data in this range',
                    opts:  buildChartOptions(tc, 'Mbps', { min: 0 }),
                  },
                  {
                    title: '🔗 Connectivity', sub: 'state over time — gaps = no data',
                    chart: connHistChart,
                    empty: 'No connectivity data in this range',
                    opts:  buildChartOptions(tc, '', { min: 0 }),
                  },
                ].map(({ title, sub, chart, empty, opts }) => (
                  <div key={title} className="sm-tr">
                    <div className="sm-tr-hd">
                      <span className="sm-tr-title">{title}</span>
                      <span style={{fontSize:9.5,fontFamily:'var(--mono)',color:'var(--text3)'}}>{sub}</span>
                    </div>
                    <div className="sm-tr-body sm-chart-tall">
                      {histLoading
                        ? <div className="sm-empty">Loading…</div>
                        : chart
                          ? <Line data={chart.data}
                              options={buildChartOptions(tc, chart.yLabel, chart.scaleOpts || {})}/>
                          : <div className="sm-empty" style={{padding:24}}>
                              <div style={{fontSize:28,marginBottom:8}}>—</div>
                              <div>{empty}</div>
                            </div>}
                    </div>
                  </div>
                ))}

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
      {/* ══════════ CRASH EVENTS ══════════ */}
      {tab==='crashes' && (
        <>
          {/* toolbar */}
          <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:10,alignItems:'center',padding:'8px 12px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:'var(--sm-r-lg)'}}>
            <input className="sm-input" placeholder="🔍 Hostname, serial, app…"
              value={crashSearch} onChange={(e)=>setCrashSearch(e.target.value)} style={{minWidth:180,flex:'1 1 180px'}}/>
            <select className="sm-select" value={crashTypeFilter} onChange={(e)=>setCrashTypeFilter(e.target.value)}>
              <option value="">All crash types</option>
              {Object.entries(CRASH_TYPE_META).map(([k,m])=>(
                <option key={k} value={k}>{m.icon} {m.label}</option>
              ))}
            </select>
            <select className="sm-select" value={crashAppFilter} onChange={(e)=>setCrashAppFilter(e.target.value)}>
              <option value="">All apps</option>
              {(crashData?.byApp||[]).filter(a=>a.appName).map(a=>(
                <option key={a.appName} value={a.appName}>{a.appName}</option>
              ))}
            </select>
            {(crashSearch||crashTypeFilter||crashAppFilter) && (
              <button className="sm-btn sm-sm danger" onClick={()=>{setCrashSearch('');setCrashTypeFilter('');setCrashAppFilter('')}}>✕ Clear</button>
            )}
            <button className="sm-btn sm-sm primary" onClick={loadCrashes} disabled={crashLoading}>
              {crashLoading?'⏳':'↻'} Refresh
            </button>
            {crashData?.fetchedAt && (
              <span style={{marginLeft:'auto',fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                Updated {relAge(crashData.fetchedAt)} ago
              </span>
            )}
          </div>

          {/* KPI cards */}
          {crashData && (
            <div className="sm-g4 sm-section-mb">
              {[
                { label:'Total Events',     val: crashData.totalEvents||0,     color:'var(--amber)' },
                { label:'Critical Events',  val: crashData.criticalEvents||0,  color:'var(--red)', sub:'BSOD + App Critical' },
                { label:'Affected Stores',  val: crashData.affectedStores||0,  color:'var(--text)' },
                { label:'Crash Types',      val: (crashData.byType||[]).length, color:'var(--text)' },
                { label:'Unique Apps',      val: (crashData.byApp||[]).length,  color:'var(--text)' },
              ].map(k=>(
                <div key={k.label} className="sm-kpi">
                  <div className="sm-kpi-label">{k.label}</div>
                  <div className="sm-kpi-val" style={{color:k.color}}>{k.val}</div>
                  {k.sub && <div className="sm-kpi-sub">{k.sub}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Crash type breakdown */}
          {(crashData?.byType||[]).length > 0 && (
            <div className="sm-g2 sm-section-mb">
              <div className="sm-tr">
                <div className="sm-tr-hd"><span className="sm-tr-title">Crashes by Type</span></div>
                <div className="sm-tr-body sm-tbl-wrap">
                  <table className="sm-tbl">
                    <thead><tr><th>Type</th><th>Source</th><th>Event ID</th><th>Severity</th><th>Count</th><th>Stores</th></tr></thead>
                    <tbody>
                      {crashData.byType.map(t=>{
                        const m = crashMeta(t.crashType)
                        return (
                          <tr key={t.crashType} className="clickable"
                            onClick={()=>setCrashTypeFilter(t.crashType===crashTypeFilter?'':t.crashType)}>
                            <td><span style={{display:'inline-flex',alignItems:'center',gap:5,fontWeight:600}}>
                              <span>{m.icon}</span>
                              <span style={{color:m.color}}>{m.label}</span>
                            </span></td>
                            <td style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>{m.src}</td>
                            <td style={{fontFamily:'var(--mono)',fontSize:11}}>{m.evtId}</td>
                            <td><span className="sm-badge" style={{background:`${m.sev==='critical'?'#ef4444':'#f97316'}18`,color:m.sev==='critical'?'#ef4444':'#f97316'}}>{m.sev}</span></td>
                            <td style={{fontWeight:700,color:m.sev==='critical'?'var(--red)':'var(--amber)',fontFamily:'var(--mono)'}}>{t.totalCrashes}</td>
                            <td>{t.affectedStores}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              {(crashData?.byApp||[]).length > 0 && (
                <div className="sm-tr">
                  <div className="sm-tr-hd"><span className="sm-tr-title">Crashes by Application</span></div>
                  <div className="sm-tr-body sm-tbl-wrap">
                    <table className="sm-tbl">
                      <thead><tr><th>App Name</th><th>Total Crashes</th><th>Affected Stores</th></tr></thead>
                      <tbody>
                        {crashData.byApp.map(a=>(
                          <tr key={a.appName} className="clickable" onClick={()=>setCrashAppFilter(a.appName===crashAppFilter?'':a.appName)}>
                            <td style={{fontWeight:600,color:'var(--amber)'}}>{a.appName}</td>
                            <td style={{color:'var(--red)',fontWeight:700,fontFamily:'var(--mono)'}}>{a.totalCrashes}</td>
                            <td>{a.affectedStores}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Per-store crash table */}
          <div className="sm-tr">
            <div className="sm-tr-hd">
              <span className="sm-tr-title">
                Store-wise Crash Details
                {bhAllow && (
                  <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--amber)',marginLeft:8,fontWeight:500}}>
                    ● BH filter active
                  </span>
                )}
              </span>
              <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>
                {(crashData?.summary||[]).length} records
              </span>
            </div>
            <div className="sm-tr-body sm-tbl-wrap">
              <table className="sm-tbl">
                  <thead>
                  <tr>
                    <th>Hostname</th><th>Serial</th><th>Group</th>
                    <th>Crash Type</th><th>App Name</th><th>Version</th>
                    <th>Count</th><th>Last Event ID</th><th>Last Message</th><th>Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {crashLoading ? (
                    <tr><td colSpan={10} className="sm-empty">Loading crash data…</td></tr>
                  ) : (() => {
                    const q = crashSearch.trim().toLowerCase()
                    const filtered = (crashData?.summary||[]).filter(s=>{
                      if (crashAppFilter  && s.appName   !== crashAppFilter)  return false
                      if (crashTypeFilter && s.crashType !== crashTypeFilter) return false
                      if (q && !`${s.hostname} ${s.serial} ${s.appName||''} ${s.crashType||''}`.toLowerCase().includes(q)) return false
                      if (bhAllow && !bhAllow(s.lastSeen || s.lastEventAt || s.lastSeenAt)) return false
                      return true
                    })
                    if (!filtered.length) return <tr><td colSpan={10} className="sm-empty">
                      {bhAllow ? 'No crash events during business hours' : 'No crash events found'}
                    </td></tr>
                    return filtered.map((s,i)=>{
                      const groups = deriveGroups(s.hostname, '', false)
                      const cm = crashMeta(s.crashType)
                      return (
                        <tr key={i} className="clickable" onClick={()=>openCrashModal(s)}>
                          <td style={{fontWeight:600}}>{s.hostname}</td>
                          <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{s.serial}</td>
                          <td><div style={{display:'flex',gap:3,flexWrap:'wrap'}}>{groups.map(g=><GroupBadge key={g} group={g}/>)}</div></td>
                          <td>
                            <span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:10,fontFamily:'var(--mono)',
                              padding:'1px 6px',borderRadius:5,
                              background:`${cm.color}18`,color:cm.color,fontWeight:600,whiteSpace:'nowrap'}}>
                              {cm.icon} {cm.label}
                            </span>
                          </td>
                          <td style={{fontWeight:600,color:s.appName?'var(--amber)':'var(--text3)'}}>{s.appName||'—'}</td>
                          <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{s.appVersion||'—'}</td>
                          <td style={{color:'var(--red)',fontWeight:700,fontFamily:'var(--mono)'}}>{s.totalCrashes}</td>
                          <td style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)',maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.lastEventId||'—'}</td>
                          <td style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:11}}>{s.lastMessage||'—'}</td>
                          <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--text3)'}}>{relAge(s.lastSeen)}</td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

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
                {globalCustom.enabled
                  ? <span style={{padding:'5px 9px',background:'rgba(79,126,245,.12)',border:'1px solid rgba(79,126,245,.25)',borderRadius:7,fontSize:11,fontFamily:'var(--mono)',color:'var(--accent)'}}>
                      Custom: {globalCustom.from?.slice(0,16)} → {(globalCustom.to||'').slice(0,16)||'now'}
                    </span>
                  : <select className="sm-select" value={range} onChange={(e)=>setRange(e.target.value)}>
                      {TIME_RANGES.map((r)=><option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                }
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:3}}>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.05em'}}>Group</span>
                <select className="sm-select" value={reportGroup} onChange={(e)=>setReportGroup(e.target.value)}>
                  <option value="all">All Groups ({stores.length} stores)</option>
                  {GROUP_DEFS.map((g)=>{
                    const cnt = stores.filter(s=>(s.systemGroups||[s.systemGroup]).includes(g.id)).length
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
            const cnt = stores.filter(s=>(s.systemGroups||[s.systemGroup]).includes(reportGroup)).length
            return (
              <div className="sm-info" style={{marginBottom:12,padding:'8px 14px',fontSize:12}}>
                {g?.icon} Reporting on <strong style={{color:g?.color}}>{reportGroup}</strong> only
                — <strong>{cnt}</strong> stores · range <strong>{TIME_RANGES.find(r=>r.key===range)?.label}</strong>
              </div>
            )
          })()}

          {/* compute report-scoped stores */}
          {(()=>{
            const rStores = reportGroup==='all' ? stores : stores.filter(s=>(s.systemGroups||[s.systemGroup]).includes(reportGroup))
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
                  {(rt.key==='manual_sdwan_daily_disconnect' || rt.key==='rop_no_sdwan_daily_disconnect') && (() => {
                    const targetStores = rt.key === 'manual_sdwan_daily_disconnect'
                      ? reportManualSdwanStores
                      : (ropOnlyWithoutManualStores || []).filter((s) => !s.isPlaceholder)
                    const previewGroup = DAILY_DISCONNECT_REPORT_GROUP[rt.key]
                    const previewPayload = previewGroup ? groupDisconnectById[previewGroup] : null
                    const previewDays = previewPayload?.days || []
                    const previewData = previewPayload?.groups?.find((g) => g.name === previewGroup) || previewPayload?.groups?.[0]
                    const previewChart = previewData && previewDays.length
                      ? buildSingleGroupDisconnectChart(previewData, previewDays, previewGroup, tc)
                      : null
                    const previewLoading = previewGroup ? !!groupDisconnectLoadingById[previewGroup] : false
                    return (
                      <>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                          {[
                            ['Group stores', targetStores.length, 'var(--text)'],
                            ['BH filter', bh.enabled ? 'ON' : 'OFF', bh.enabled ? 'var(--amber)' : 'var(--text3)'],
                          ].map(([l,v,c])=>(
                            <div key={l} style={{textAlign:'center',background:'var(--bg3)',borderRadius:6,padding:'6px 4px'}}>
                              <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                              <div style={{fontSize:9,fontFamily:'var(--mono)',color:'var(--text3)',textTransform:'uppercase'}}>{l}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{border:'1px solid var(--border)',borderRadius:6,background:'var(--bg2)',padding:'6px 8px'}}>
                          <div style={{fontSize:9.5,fontFamily:'var(--mono)',textTransform:'uppercase',letterSpacing:'.05em',color:'var(--text3)',marginBottom:5}}>
                            Daily disconnections graph
                          </div>
                          {previewLoading ? (
                            <div style={{height:120,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:'var(--text3)',fontFamily:'var(--mono)'}}>
                              Loading graph…
                            </div>
                          ) : previewChart ? (
                            <div style={{height:120}}>
                              <Chart
                                type="bar"
                                data={previewChart.data}
                                options={{
                                  ...previewChart.options,
                                  plugins: {
                                    ...(previewChart.options?.plugins || {}),
                                    legend: {
                                      ...(previewChart.options?.plugins?.legend || {}),
                                      display: false,
                                    },
                                  },
                                }}
                              />
                            </div>
                          ) : (
                            <div style={{height:120,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:'var(--text3)',fontFamily:'var(--mono)'}}>
                              No graph data
                            </div>
                          )}
                        </div>
                      </>
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
            const rStores2 = reportGroup==='all' ? stores : stores.filter(s=>(s.systemGroups||[s.systemGroup]).includes(reportGroup))
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
                        <td><div style={{display:'flex',flexWrap:'wrap',gap:3}}>{(s.systemGroups||[s.systemGroup]).map((g)=><GroupBadge key={g} group={g}/>)}</div></td>
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
          {/* engine status bar */}
          <div style={{display:'flex',alignItems:'center',gap:10,padding:'7px 12px',background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:'var(--sm-r)',marginBottom:10,flexWrap:'wrap',fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)'}}>
            <span style={{color:'var(--green)'}}>●</span>
            Auto-evaluates every 2 min · Last run:{' '}
            <strong style={{color:'var(--text2)'}}>
              {evalStatus?.lastEvalAt ? `${relAge(evalStatus.lastEvalAt)} ago` : 'not yet — restart server'}
            </strong>
            {evalStatus?.lastEvalStats && (
              <span>
                {evalStatus.lastEvalStats.fired > 0
                  ? <span style={{color:'var(--red)',fontWeight:700}}>· 🔔 {evalStatus.lastEvalStats.fired} fired</span>
                  : <span style={{color:'var(--green)'}}>· ✓ {evalStatus.lastEvalStats.total} rules, 0 fired</span>}
                {' '}· {evalStatus.lastEvalStats.storesChecked} stores checked
              </span>
            )}
            <div style={{marginLeft:'auto',display:'flex',gap:6}}>
              <button className="sm-btn sm-sm" onClick={runAlertsNow} disabled={evalRunning}>
                {evalRunning ? '⏳' : '▶'} Run now
              </button>
            </div>
          </div>

          {/* sub-tabs */}
          <div className="sm-alert-subtabs">
            {[
              { id:'rules',   label:'⚙ Alert Rules',  badge: alertRules.length },
              { id:'live',    label:'🔴 Live Alerts',  badge: liveAlerts.length },
              { id:'history', label:'📋 History',      badge: histTotal || null },
            ].map((t)=>(
              <button key={t.id} type="button"
                className={`sm-alert-subtab${alertSubTab===t.id?' active':''}`}
                onClick={()=>setAlertSubTab(t.id)}>
                {t.label}
                {t.badge > 0 && <span style={{marginLeft:5,background:t.id==='live'?'var(--red)':'var(--accent)',color:'#fff',borderRadius:999,fontSize:9,fontWeight:800,padding:'1px 5px'}}>{t.badge}</span>}
              </button>
            ))}
            {alertSubTab==='rules' && <button className="sm-btn sm-sm primary" style={{marginLeft:'auto',marginBottom:4}} onClick={()=>openAlertModal(null)}>+ New Rule</button>}
            {alertSubTab==='history' && alertHistory.length > 0 && (
              <button className="sm-btn sm-sm danger" style={{marginLeft:'auto',marginBottom:4}}
                onClick={()=>api.delete('/api/store-alerts/events').then(()=>{ setAlertHistory([]); setHistTotal(0) }).catch(()=>{})}>
                🗑 Clear history
              </button>
            )}
          </div>

          {/* ── Rules sub-tab ── */}
          {alertSubTab==='rules' && !alertRules.length
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
                  <div>
                    <span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>CONDITION </span><br/>
                    {rule.condition.metric} {BOOLEAN_METRICS.has(rule.condition.metric)?'=true':`${rule.condition.operator||'>'} ${rule.condition.threshold}`}
                    {rule.condition.metric==='crash_count' && rule.condition.appName && (
                      <span style={{color:'var(--amber)',fontSize:10}}> · app: {rule.condition.appName}</span>
                    )}
                    {rule.condition.metric==='crash_count' && rule.condition.crashType && (
                      <span style={{color:'var(--red)',fontSize:10}}> · type: {CRASH_TYPE_META[rule.condition.crashType]?.label||rule.condition.crashType}</span>
                    )}
                  </div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>GROUP </span><br/>{rule.group}</div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>MODE </span><br/><span style={{color:'var(--green)',fontSize:11}}>Real-time</span></div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>COOLDOWN </span><br/>{rule.cooldownMinutes} min</div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>TRIGGER SCHEDULE </span><br/>
                    {rule.schedule?.enabled
                      ? <span style={{color:'var(--accent)',fontSize:11}}>
                          {(rule.schedule.weekdays||[]).map((d)=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join('/')}
                          {' '}{rule.schedule.fromHour??9}:00–{rule.schedule.toHour??18}:00
                        </span>
                      : <span style={{color:'var(--text3)'}}>24/7</span>}
                  </div>
                  <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>CHANNELS </span><br/>{(rule.channels||[]).map((c)=>c.type).join(', ')||'None'}</div>
                  {rule.lastFiredAt && <div><span style={{color:'var(--text3)',fontSize:10,fontFamily:'var(--mono)'}}>LAST FIRED </span><br/>{new Date(rule.lastFiredAt).toLocaleString()}</div>}
                </div>
              </div>
            ))
          }

          {/* ── Live Alerts sub-tab ── */}
          {alertSubTab==='live' && (
            <div className="sm-alert-feed">
              {liveAlerts.length === 0 ? (
                <div className="sm-empty">
                  <div style={{fontSize:28,marginBottom:8}}>🔔</div>
                  No alerts fired this session. Live alerts appear here instantly when rules trigger.
                </div>
              ) : liveAlerts.map((ev)=>{
                const sevColor = SEV_COLORS[ev.severity]||'#64748b'
                return (
                  <div key={ev.id||ev._id} className="sm-alert-card" style={{borderLeft:`3px solid ${sevColor}`}}>
                    <div className="sm-alert-card-hd">
                      <span style={{fontSize:15}}>{ev.severity==='critical'?'🔴':ev.severity==='high'?'🟠':'🟡'}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13}}>{ev.ruleName}</div>
                        <div style={{fontSize:10,fontFamily:'var(--mono)',color:sevColor}}>
                          {ev.severity?.toUpperCase()} · {ev.affectedCount} store{ev.affectedCount!==1?'s':''} affected
                          {ev.group&&ev.group!=='all'?` · ${ev.group}`:''}
                        </div>
                      </div>
                      <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',whiteSpace:'nowrap'}}>
                        {new Date(ev.firedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="sm-alert-card-body">
                      <div style={{marginBottom:4,color:'var(--text2)'}}>
                        Condition: <strong>{ev.condition?.metric} {BOOLEAN_METRICS.has(ev.condition?.metric)?'= true':`${ev.condition?.operator||'>'} ${ev.condition?.threshold??''}`}</strong>
                      </div>
                      <div className="sm-alert-stores">
                        {(ev.stores||[]).slice(0,5).map((s,i)=>(
                          <div key={i} className="sm-alert-store-row">
                            ● {s.hostname} ({s.serial}) · <span style={{color:CONN_COLORS[s.connState]||'var(--text3)'}}>{CONN_LABELS[s.connState]||s.connState}</span> · {s.gatewayIp||'?'}
                          </div>
                        ))}
                        {ev.hasMore && <div style={{color:'var(--accent)',fontSize:10}}>…and {ev.affectedCount-10} more stores</div>}
                      </div>
                    </div>
                  </div>
                )
              })}
              {liveAlerts.length > 0 && (
                <button className="sm-btn sm-sm danger" style={{alignSelf:'flex-start'}} onClick={()=>setLiveAlerts([])}>
                  🗑 Clear live feed
                </button>
              )}
            </div>
          )}

          {/* ── History sub-tab ── */}
          {alertSubTab==='history' && (
            <div className="sm-alert-feed">
              {alertHistLoading ? (
                <div className="sm-empty">Loading alert history…</div>
              ) : alertHistory.length === 0 ? (
                <div className="sm-empty">
                  <div style={{fontSize:28,marginBottom:8}}>📋</div>
                  No alert history yet. History is recorded every time a rule fires.
                </div>
              ) : alertHistory.map((ev,idx)=>{
                const sevColor = SEV_COLORS[ev.severity]||'#64748b'
                return (
                  <div key={ev._id||idx} className="sm-alert-card" style={{borderLeft:`3px solid ${sevColor}`}}>
                    <div className="sm-alert-card-hd">
                      <span style={{fontSize:15}}>{ev.severity==='critical'?'🔴':ev.severity==='high'?'🟠':'🟡'}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13}}>{ev.ruleName}</div>
                        <div style={{fontSize:10,fontFamily:'var(--mono)',color:sevColor}}>
                          {ev.severity?.toUpperCase()} · {ev.affectedCount} store{ev.affectedCount!==1?'s':''} affected
                          {ev.group&&ev.group!=='all'?` · ${ev.group}`:''}
                        </div>
                      </div>
                      <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',whiteSpace:'nowrap'}}>
                        {new Date(ev.firedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="sm-alert-card-body">
                      <div style={{marginBottom:4,color:'var(--text2)'}}>
                        Condition: <strong>{ev.condition?.metric} {BOOLEAN_METRICS.has(ev.condition?.metric)?'= true':`${ev.condition?.operator||'>'} ${ev.condition?.threshold??''}`}</strong>
                        {(ev.dispatch||[]).length > 0 && (
                          <span style={{marginLeft:10,color:'var(--text3)'}}>
                            Sent via: {ev.dispatch.filter(d=>d.ok).map(d=>d.channel).join(', ')||'—'}
                          </span>
                        )}
                      </div>
                      <div className="sm-alert-stores">
                        {(ev.stores||[]).slice(0,5).map((s,i)=>(
                          <div key={i} className="sm-alert-store-row">
                            ● {s.hostname} ({s.serial}) · <span style={{color:CONN_COLORS[s.connState]||'var(--text3)'}}>{CONN_LABELS[s.connState]||s.connState}</span> · {s.gatewayIp||'?'}
                          </div>
                        ))}
                        {ev.hasMore && <div style={{color:'var(--accent)',fontSize:10}}>…and {ev.affectedCount-10} more stores</div>}
                      </div>
                    </div>
                  </div>
                )
              })}
              {histTotal > alertHistory.length && (
                <div style={{textAlign:'center',fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)',padding:10}}>
                  Showing {alertHistory.length} of {histTotal} events
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ══════════ ROP GROUPS ══════════ */}
      {tab==='rop' && (() => {
        const kpi = ropKpi(ropActiveStores)
        const manualMatched = ropManualStores.length
        const manualMissing = manualRopCodeList.length - manualMatched
        return (
          <>
            {/* sub-tab bar */}
            <div className="sm-subtabs">
              {ROP_SUBTABS.map((st) => {
                const count = st.id === 'all' ? ropAllStores.length
                  : st.id === 'sdwan' ? ropSdwanStores.length
                  : st.id === 'manual_sdwan' ? ropManualStores.length
                  : ropOnlyWithoutManualStores.length
                return (
                  <button key={st.id} type="button"
                    className={`sm-subtab${ropSubTab === st.id ? ' active' : ''}`}
                    onClick={() => { setRopSubTab(st.id); setRopSearch(''); setRopStatusFilter(''); setRopConnFilter('') }}>
                    {st.icon} {st.label}
                    <span className="sm-subtab-count">{count}</span>
                  </button>
                )
              })}
            </div>

            {ropSubTab === 'manual_sdwan' && (
              <div className="sm-tr sm-section-mb">
                <div className="sm-tr-hd" style={{ cursor:'pointer' }} onClick={() => setManualRopCodesOpen((v) => !v)}>
                  <span className="sm-tr-title">⚙ Manual ROP + SD-WAN — Store Code Settings</span>
                  <span style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)' }}>
                    {manualRopCodeList.length} configured · {manualMatched} matched · {manualMissing} no data
                    {manualRopCodesUpdatedAt && ` · saved ${relAge(manualRopCodesUpdatedAt)} ago`}
                  </span>
                  <span style={{ marginLeft:'auto', fontSize:10, color:'var(--text3)' }}>{manualRopCodesOpen ? '▲' : '▼'}</span>
                </div>
                {manualRopCodesOpen && (
                  <div className="sm-tr-body" style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ fontSize:11, color:'var(--text3)', lineHeight:1.6 }}>
                      Paste store codes — one per line, or comma / semicolon separated.<br />
                      Matches by store tag, hostname (e.g. <code style={{ fontFamily:'var(--mono)' }}>RP1234</code>), or serial number.<br />
                      <strong style={{ color:'var(--text2)' }}>Changes are saved to the server and visible to all users.</strong>
                    </div>
                    <textarea
                      className="sm-input"
                      rows={8}
                      placeholder={'S001\nS002\nRP1234\n1234'}
                      value={manualRopCodesDraft}
                      onChange={(e) => { setManualRopCodesDraft(e.target.value); setManualRopCodesSaved(false) }}
                      style={{ width:'100%', minHeight:140, fontFamily:'var(--mono)', fontSize:11.5, resize:'vertical', lineHeight:1.7 }}
                    />
                    <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                      <button
                        type="button"
                        className="sm-btn sm-sm primary"
                        disabled={manualRopCodesSaving}
                        onClick={async () => {
                          setManualRopCodesSaving(true)
                          setManualRopCodesSaved(false)
                          try {
                            const { data } = await api.put('/api/store-monitor/settings', { manualRopSdwanCodes: manualRopCodesDraft })
                            setManualRopCodesText(data.manualRopSdwanCodes ?? manualRopCodesDraft)
                            setManualRopCodesUpdatedAt(data.updatedAt ?? new Date().toISOString())
                            setManualRopCodesSaved(true)
                          } catch (e) {
                            alert(e.response?.data?.error || e.message || 'Failed to save')
                          } finally { setManualRopCodesSaving(false) }
                        }}>
                        {manualRopCodesSaving ? 'Saving…' : '💾 Save to server'}
                      </button>
                      <button
                        type="button"
                        className="sm-btn sm-sm"
                        disabled={manualRopCodesSaving}
                        onClick={() => { setManualRopCodesDraft(manualRopCodesText); setManualRopCodesSaved(false) }}>
                        ✕ Cancel
                      </button>
                      {manualRopCodesSaved && (
                        <span style={{ fontSize:11, color:'var(--green)', fontFamily:'var(--mono)' }}>✓ Saved — visible to all users</span>
                      )}
                      <span style={{ marginLeft:'auto', fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)' }}>
                        {parseManualStoreCodes(manualRopCodesDraft).length} codes
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* KPI strip */}
            <div className="sm-g4 sm-section-mb">
              {[
                { label: 'Total Devices', val: kpi.total,   color: 'var(--text)',  filter: '' },
                { label: 'Online',        val: kpi.online,  color: 'var(--green)', sub: kpi.total ? `${pct(kpi.online, kpi.total).toFixed(1)}% uptime` : undefined, filter: 'online' },
                { label: 'Offline',       val: kpi.offline, color: 'var(--red)',   sub: kpi.total ? `${pct(kpi.offline, kpi.total).toFixed(1)}% down` : undefined,   filter: 'offline' },
                { label: 'With Issues',   val: kpi.issues,  color: kpi.issues > 0 ? 'var(--amber)' : 'var(--text)', filter: 'issues' },
                { label: 'Avg Ping',      val: kpi.avgPing != null ? `${kpi.avgPing.toFixed(0)} ms` : '—', color: 'var(--text)', filter: null },
              ].map((k) => {
                const isActive = k.filter != null && ropStatusFilter === k.filter && k.filter !== ''
                const clickable = k.filter != null
                return (
                  <div key={k.label} className="sm-kpi"
                    style={{ cursor: clickable ? 'pointer' : 'default', outline: isActive ? '2px solid var(--accent)' : 'none', borderRadius: 'var(--sm-r-lg)', transition: 'outline .15s' }}
                    onClick={clickable ? () => setRopStatusFilter((p) => p === k.filter ? '' : k.filter) : undefined}
                    title={clickable ? (isActive ? 'Click to clear filter' : `Filter by ${k.label}`) : undefined}>
                    <div className="sm-kpi-label">{k.label}</div>
                    <div className="sm-kpi-val" style={{ color: k.color }}>{k.val}</div>
                    {k.sub && <div className="sm-kpi-sub">{k.sub}</div>}
                  </div>
                )
              })}
            </div>

            {/* widgets row: uptime health + connectivity breakdown */}
            <div className="sm-g2 sm-section-mb">

              {/* ── Uptime / Health widget ── */}
              <div className="sm-tr">
                <div className="sm-tr-hd">
                  <span className="sm-tr-title">Uptime &amp; Health</span>
                  <span style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)' }}>
                    {ropSubTabLabel(ropSubTab)} · {kpi.total} devices
                  </span>
                </div>
                <div className="sm-tr-body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
                  {/* big health % */}
                  {(() => {
                    const healthPct = kpi.total ? pct(kpi.online, kpi.total) : 0
                    const col = healthPct >= 90 ? '#22c55e' : healthPct >= 70 ? '#eab308' : '#ef4444'
                    return (
                      <>
                        <div style={{ display:'flex', alignItems:'flex-end', gap:12, flexWrap:'wrap' }}>
                          <div>
                            <div style={{ fontSize:9.5, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:2 }}>Health Score</div>
                            <div style={{ fontSize:38, fontWeight:800, lineHeight:1, color: col, letterSpacing:'-.02em' }}>
                              {healthPct.toFixed(1)}<span style={{ fontSize:18, fontWeight:600 }}>%</span>
                            </div>
                          </div>
                          <div style={{ flex:1, minWidth:100 }}>
                            <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, fontFamily:'var(--mono)', color:'var(--text3)', marginBottom:4 }}>
                              <span>0%</span><span>100%</span>
                            </div>
                            <div style={{ height:10, background:'var(--bg3)', borderRadius:6, overflow:'hidden' }}>
                              <div style={{ height:'100%', width:`${healthPct}%`, background: col, borderRadius:6, transition:'width .5s ease' }}/>
                            </div>
                          </div>
                        </div>

                        {/* online / offline / issues row */}
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
                          {[
                            { label:'Online',  val: kpi.online,  color:'#22c55e', filter:'online' },
                            { label:'Offline', val: kpi.offline, color:'#ef4444', filter:'offline' },
                            { label:'Issues',  val: kpi.issues,  color:'#eab308', filter:'issues' },
                          ].map((s) => {
                            const isActive = ropStatusFilter === s.filter
                            return (
                              <div key={s.label} onClick={() => setRopStatusFilter((p) => p === s.filter ? '' : s.filter)}
                                style={{ background: isActive ? `${s.color}22` : 'var(--bg3)', borderRadius:7, padding:'7px 10px', textAlign:'center', cursor:'pointer',
                                  outline: isActive ? `2px solid ${s.color}` : 'none', transition:'all .15s' }}
                                title={isActive ? 'Click to clear filter' : `Filter by ${s.label}`}>
                                <div style={{ fontSize:18, fontWeight:700, color: s.color, lineHeight:1.1 }}>{s.val}</div>
                                <div style={{ fontSize:9, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.05em', marginTop:2 }}>{s.label}</div>
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )
                  })()}
                </div>
              </div>

              {/* ── Connectivity Breakdown widget ── */}
              <div className="sm-tr">
                <div className="sm-tr-hd">
                  <span className="sm-tr-title">Connectivity Breakdown</span>
                  <span style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)' }}>
                    {Object.keys(ropConnBreakdown).length} states · {kpi.total} devices
                    {ropConnFilter && <span style={{ color: CONN_COLORS[ropConnFilter] || 'var(--accent)', marginLeft:6 }}>· {CONN_LABELS[ropConnFilter] || ropConnFilter}</span>}
                  </span>
                  {ropConnFilter && (
                    <button className="sm-btn sm-sm" style={{ marginLeft:'auto' }} onClick={() => setRopConnFilter('')}>✕ Clear</button>
                  )}
                </div>
                <div className="sm-tr-body sm-chart" style={{ cursor: Object.keys(ropConnBreakdown).length ? 'pointer' : 'default' }}
                  onClick={() => {
                    // clicking the chart area clears the filter; individual legend pills set it
                    if (ropConnFilter) setRopConnFilter('')
                  }}>
                  {ropConnChart
                    ? <Doughnut data={ropConnChart.data} options={{
                        ...ropConnChart.options,
                        onClick: (_e, elements) => {
                          if (!elements.length) { setRopConnFilter(''); return }
                          const idx = elements[0].index
                          const key = Object.keys(ropConnBreakdown)[idx]
                          if (key) setRopConnFilter((p) => p === key ? '' : key)
                        },
                      }} />
                    : <div className="sm-empty">No connectivity data</div>}
                </div>
                {/* legend row under chart */}
                {Object.keys(ropConnBreakdown).length > 0 && (
                  <div style={{ padding:'0 14px 12px', display:'flex', flexWrap:'wrap', gap:'6px 14px' }}>
                    {Object.entries(ropConnBreakdown).map(([k, v]) => {
                      const isActive = ropConnFilter === k
                      return (
                        <div key={k} onClick={() => setRopConnFilter((p) => p === k ? '' : k)}
                          style={{ display:'flex', alignItems:'center', gap:5, fontSize:10, fontFamily:'var(--mono)', color:'var(--text2)',
                            cursor:'pointer', opacity: ropConnFilter && !isActive ? 0.45 : 1,
                            padding:'2px 6px', borderRadius:4, background: isActive ? `${CONN_COLORS[k] || '#64748b'}22` : 'transparent',
                            outline: isActive ? `1px solid ${CONN_COLORS[k] || '#64748b'}` : 'none', transition:'all .15s' }}
                          title={isActive ? 'Click to clear filter' : `Filter by ${CONN_LABELS[k] || k}`}>
                          <span style={{ width:8, height:8, borderRadius:2, background: CONN_COLORS[k] || '#64748b', flexShrink:0 }}/>
                          <span>{CONN_LABELS[k] || k}</span>
                          <span style={{ color: CONN_COLORS[k] || 'var(--text3)', fontWeight:700 }}>{v}</span>
                          <span style={{ color:'var(--text3)' }}>({kpi.total ? pct(v, kpi.total).toFixed(0) : 0}%)</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

            </div>

            {/* search bar */}
            <div style={{ display:'flex', gap:8, marginBottom:10, alignItems:'center',
              padding:'7px 12px', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:'var(--sm-r-lg)' }}>
              <input className="sm-input" placeholder="Search hostname, serial, IP…"
                value={ropSearch} onChange={(e) => setRopSearch(e.target.value)}
                style={{ minWidth: 200, flex: '1 1 200px' }} />
              {ropSearch && (
                <button className="sm-btn sm-sm danger" onClick={() => setRopSearch('')}>✕ Search</button>
              )}
              {ropStatusFilter && (
                <button className="sm-btn sm-sm" onClick={() => setRopStatusFilter('')}
                  style={{ color: ropStatusFilter === 'online' ? 'var(--green)' : ropStatusFilter === 'offline' ? 'var(--red)' : 'var(--amber)' }}>
                  ✕ {ropStatusFilter === 'online' ? 'Online' : ropStatusFilter === 'offline' ? 'Offline' : 'Issues'}
                </button>
              )}
              {ropConnFilter && (
                <button className="sm-btn sm-sm" onClick={() => setRopConnFilter('')}
                  style={{ color: CONN_COLORS[ropConnFilter] || 'var(--accent)' }}>
                  ✕ {CONN_LABELS[ropConnFilter] || ropConnFilter}
                </button>
              )}
              {(ropStatusFilter || ropConnFilter) && (
                <button className="sm-btn sm-sm danger" onClick={() => { setRopStatusFilter(''); setRopConnFilter('') }}>Clear all</button>
              )}
              <span style={{ marginLeft:'auto', fontSize:10.5, color:'var(--text3)', fontFamily:'var(--mono)', whiteSpace:'nowrap' }}>
                {ropFilteredStores.length}/{ropActiveStores.length} devices
              </span>
            </div>

            {/* store table */}
            <div className="sm-tbl-wrap">
              <table className="sm-tbl">
                <thead>
                  <tr>
                    <th>Status</th>
                    {ropSubTab === 'manual_sdwan' && <th>Store code</th>}
                    <th>Hostname</th><th>Groups</th><th>Serial</th>
                    <th>Interface</th><th>Connectivity</th><th>Gateway IP</th><th>Vendor</th>
                    <th>Ping</th><th>Loss</th><th>CPU</th><th>RAM</th>
                    <th>↓ Speed</th><th>↑ Speed</th><th>Last seen</th><th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {ropFilteredStores.map((s) => {
                    const ping = primaryPing(s)
                    const grps = s.systemGroups || [s.systemGroup]
                    return (
                      <tr key={s.storeTag} className="clickable"
                        onClick={() => { setSelectedTag(s.storeTag); setTab('detail') }}>
                        <td><OnlineBadge online={s.online} /></td>
                        {ropSubTab === 'manual_sdwan' && (
                          <td style={{ fontFamily:'var(--mono)', fontWeight:700, fontSize:11 }}>{s.storeCode || '—'}</td>
                        )}
                        <td style={{ fontWeight: 600 }}>{s.hostname}</td>
                        <td>
                          <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
                            {grps.map((g) => <GroupBadge key={g} group={g} />)}
                          </div>
                        </td>
                        <td style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--text3)' }}>{s.serial}</td>
                        <td>
                          {s.activeInterface
                            ? <span className="sm-pill" style={{
                                background: String(s.activeInterface).toLowerCase().includes('wi') ? 'rgba(6,182,212,.15)' : 'rgba(34,197,94,.15)',
                                color:      String(s.activeInterface).toLowerCase().includes('wi') ? '#06b6d4' : '#22c55e',
                              }}>
                                {String(s.activeInterface).toLowerCase().includes('wi') ? '📶' : '🔌'} {s.activeInterface}
                              </span>
                            : <span style={{ color:'var(--text3)' }}>—</span>}
                        </td>
                        <td><ConnPill state={s.connState} /></td>
                        <td style={{ fontFamily:'var(--mono)', fontSize:11 }}>{s.gatewayIp || '—'}</td>
                        <td>{fmtVendor(s.gatewayVendor)}</td>
                        <td style={{ fontFamily:'var(--mono)' }}>{fmtMs(ping?.avgMs)}</td>
                        <td style={{ color: ping?.packetLossPct > 10 ? 'var(--red)' : ping?.packetLossPct > 0 ? 'var(--amber)' : 'var(--green)' }}>
                          {ping?.packetLossPct != null ? fmtPct(ping.packetLossPct) : '—'}
                        </td>
                        <td style={{ color: s.cpuPct > 90 ? 'var(--red)' : s.cpuPct > 70 ? 'var(--amber)' : 'var(--text)' }}>{fmtPct(s.cpuPct)}</td>
                        <td style={{ color: s.memPct > 90 ? 'var(--red)' : s.memPct > 70 ? 'var(--amber)' : 'var(--text)' }}>{fmtPct(s.memPct)}</td>
                        <td>{fmtMbps(s.downloadMbps)}</td>
                        <td>{fmtMbps(s.uploadMbps)}</td>
                        <td style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--text3)' }}>{relAge(s.lastSeen)}</td>
                        <td>
                          {s.issueCount > 0
                            ? <span style={{ color:SEV_COLORS[s.severity] || 'var(--amber)', fontWeight:700, fontFamily:'var(--mono)' }}>{s.issueCount}</span>
                            : <span style={{ color:'var(--green)', fontSize:11 }}>✓</span>}
                        </td>
                      </tr>
                    )
                  })}
                  {!ropFilteredStores.length && (
                    <tr><td colSpan={ropSubTab === 'manual_sdwan' ? 17 : 16} className="sm-empty">
                      {ropSubTab === 'manual_sdwan' && manualRopCodeList.length === 0
                        ? 'Add store codes above to build the Manual ROP + SD-WAN dashboard'
                        : ropActiveStores.length === 0
                        ? `No ${ropSubTabLabel(ropSubTab)} devices found`
                        : 'No devices match search'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )
      })()}

      {/* ══════════ PROBLEM HISTORY ══════════ */}
      {tab === 'probHist' && (() => {
        const PHRANGES = [
          { key: '1h',  label: '1 Hour' },
          { key: '6h',  label: '6 Hours' },
          { key: '24h', label: '24 Hours' },
          { key: '7d',  label: '7 Days' },
          { key: '30d', label: '30 Days' },
        ]
        const snapStatus = probHist?.snapshotStatus
        return (
          <>
            {/* toolbar */}
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', marginBottom:12,
              padding:'8px 12px', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:'var(--sm-r-lg)' }}>
              <span style={{ fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)', flexShrink:0 }}>Range:</span>
              <select className="sm-select" value={probHistRange} onChange={(e) => setProbHistRange(e.target.value)}>
                {PHRANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <select className="sm-select" value={probHistSeverity} onChange={(e) => setProbHistSeverity(e.target.value)}>
                <option value=''>All severities</option>
                <option value='critical'>Critical</option>
                <option value='high'>High</option>
                <option value='warning'>Warning</option>
              </select>
              <select className="sm-select" value={probHistStatus} onChange={(e) => setProbHistStatus(e.target.value)}>
                <option value=''>Active + Resolved</option>
                <option value='active'>🔴 Active only</option>
                <option value='resolved'>✅ Resolved only</option>
              </select>
              <input className="sm-input" placeholder="Search store / issue…"
                value={probHistSearch} onChange={(e) => setProbHistSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadProbHist(1)}
                style={{ minWidth:180, flex:'1 1 180px' }} />
              <button className="sm-btn sm-sm primary" onClick={() => loadProbHist(1)} disabled={probHistLoading}>
                {probHistLoading ? 'Loading…' : '⟳ Refresh'}
              </button>
              <button className="sm-btn sm-sm" title="Take an immediate snapshot now"
                disabled={probHistSnapping}
                onClick={async () => {
                  setProbHistSnapping(true)
                  try {
                    await api.post('/api/store-monitor/problem-history/snapshot')
                    setTimeout(() => loadProbHist(1), 1000)
                  } catch (e) { alert(e.response?.data?.error || e.message) }
                  finally { setProbHistSnapping(false) }
                }}>
                {probHistSnapping ? 'Snapping…' : '📸 Snapshot now'}
              </button>
              {snapStatus?.lastSnapAt && (
                <span style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)', marginLeft:'auto', whiteSpace:'nowrap' }}>
                  Last snap {relAge(snapStatus.lastSnapAt)} ago · {snapStatus.lastSnapCount} problems
                </span>
              )}
            </div>

            {probHistLoading && !probHist && (
              <div style={{ padding:40, textAlign:'center', color:'var(--text3)' }}>Loading problem history…</div>
            )}

            {probHist && !probHist.trend?.length && !probHist.records?.length && (
              <div className="sm-empty" style={{ padding:40 }}>
                No problem history yet for this period.<br />
                <span style={{ fontSize:11 }}>Snapshots are taken every 30 minutes automatically. Click <strong>Snapshot now</strong> to capture the first one.</span>
              </div>
            )}

            {probHist?.trend?.length > 0 && (() => {
              const trendData = probHist.trend
              const labels = trendData.map((t) => {
                const d = new Date(t.ts)
                return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
              })
              const chartData = {
                labels,
                datasets: [
                  { label: 'Critical', data: trendData.map((t) => t.critical), backgroundColor: '#ef444488', borderColor: '#ef4444', borderWidth: 1.5, fill: true },
                  { label: 'High',     data: trendData.map((t) => t.high),     backgroundColor: '#f9731688', borderColor: '#f97316', borderWidth: 1.5, fill: true },
                  { label: 'Warning',  data: trendData.map((t) => t.warning),  backgroundColor: '#eab30888', borderColor: '#eab308', borderWidth: 1.5, fill: true },
                ],
              }
              const chartOpts = {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { labels: { color: tc.text2, boxWidth: 12, font: { size: 10 } } } },
                scales: {
                  x: { stacked: true, ticks: { color: tc.text3, maxTicksLimit: 12, font: { size: 9 } }, grid: { color: tc.border } },
                  y: { stacked: true, ticks: { color: tc.text3, font: { size: 9 } }, grid: { color: tc.border } },
                },
              }
              return (
                <div className="sm-g2 sm-section-mb">
                  {/* trend chart */}
                  <div className="sm-tr" style={{ gridColumn: '1 / -1' }}>
                    <div className="sm-tr-hd">
                      <span className="sm-tr-title">Problem Trend</span>
                      <span style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)' }}>
                        {trendData.length} snapshots · {probHist.fromDate?.slice(0,16).replace('T',' ')} → {probHist.toDate?.slice(0,16).replace('T',' ')}
                      </span>
                    </div>
                    <div className="sm-tr-body sm-chart" style={{ minHeight:180 }}>
                      <Bar data={chartData} options={chartOpts} />
                    </div>
                  </div>

                  {/* top codes */}
                  {probHist.topCodes?.length > 0 && (
                    <div className="sm-tr">
                      <div className="sm-tr-hd"><span className="sm-tr-title">Top Issue Codes</span></div>
                      <div className="sm-tr-body" style={{ display:'flex', flexDirection:'column', gap:6 }}>
                        {probHist.topCodes.map(({ code, count }) => {
                          const maxCount = probHist.topCodes[0].count
                          return (
                            <div key={code} style={{ display:'flex', alignItems:'center', gap:8 }}>
                              <span style={{ fontFamily:'var(--mono)', fontSize:11, minWidth:110, color:'var(--text2)' }}>{code}</span>
                              <div style={{ flex:1, height:8, background:'var(--bg3)', borderRadius:4, overflow:'hidden' }}>
                                <div style={{ height:'100%', width:`${(count/maxCount)*100}%`, background:'var(--accent)', borderRadius:4, transition:'width .4s' }}/>
                              </div>
                              <span style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--text3)', minWidth:40, textAlign:'right' }}>{count}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* KPI summary */}
                  <div className="sm-tr">
                    <div className="sm-tr-hd"><span className="sm-tr-title">Period Summary</span></div>
                    <div className="sm-tr-body" style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
                      {[
                        { label:'Total Events', val: probHist.total, color:'var(--text)' },
                        { label:'Currently Active', val: probHist.activeCount ?? '—', color:'#ef4444' },
                        { label:'Critical', val: probHist.trend.reduce((a,t)=>a+t.critical,0), color:'#ef4444' },
                        { label:'High',     val: probHist.trend.reduce((a,t)=>a+t.high,0),     color:'#f97316' },
                        { label:'Warning',  val: probHist.trend.reduce((a,t)=>a+t.warning,0),  color:'#eab308' },
                        { label:'Resolved', val: probHist.trend.reduce((a,t)=>a+(t.resolved||0),0), color:'#22c55e' },
                      ].map((k) => (
                        <div key={k.label} style={{ background:'var(--bg3)', borderRadius:7, padding:'7px 10px', textAlign:'center' }}>
                          <div style={{ fontSize:17, fontWeight:700, color: k.color, lineHeight:1.1 }}>{k.val}</div>
                          <div style={{ fontSize:9, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.05em', marginTop:2 }}>{k.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* records table */}
            {probHist?.records?.length > 0 && (() => {
              const visibleRecords = bhAllow
                ? probHist.records.filter((r) => bhAllow(r.firstSeenAt))
                : probHist.records
              const hiddenCount = probHist.records.length - visibleRecords.length
              return (
              <>
                {bhAllow && hiddenCount > 0 && (
                  <div style={{marginBottom:8,padding:'6px 10px',background:'rgba(245,158,11,.08)',
                    border:'1px solid rgba(245,158,11,.25)',borderRadius:6,fontSize:11,
                    fontFamily:'var(--mono)',color:'var(--amber)'}}>
                    ● BH filter active — showing {visibleRecords.length} of {probHist.records.length} records
                    ({hiddenCount} hidden because they started outside business hours)
                  </div>
                )}
                <div className="sm-tbl-wrap">
                  <table className="sm-tbl">
                    <thead>
                      <tr>
                        <th>Status</th><th>First seen</th><th>Resolved at</th><th>Duration</th>
                        <th>Severity</th><th>Hostname</th><th>Serial</th>
                        <th>Issue code</th><th>Message</th><th>Connectivity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRecords.map((r, i) => {
                        const durSec = r.durationMs ? Math.floor(r.durationMs / 1000) : null
                        const durLabel = durSec == null ? '—'
                          : durSec < 60 ? `${durSec}s`
                          : durSec < 3600 ? `${Math.floor(durSec/60)}m`
                          : `${Math.floor(durSec/3600)}h ${Math.floor((durSec%3600)/60)}m`
                        return (
                          <tr key={`${r._id || i}`} className="clickable"
                            onClick={() => { setSelectedTag(r.storeTag); setTab('detail') }}>
                            <td>
                              {r.status === 'active'
                                ? <span className="sm-pill" style={{ background:'rgba(239,68,68,.15)', color:'#ef4444' }}>● Active</span>
                                : <span className="sm-pill" style={{ background:'rgba(34,197,94,.15)', color:'#22c55e' }}>✓ Resolved</span>}
                            </td>
                            <td style={{ fontFamily:'var(--mono)', fontSize:10.5, whiteSpace:'nowrap' }}>
                              {new Date(r.firstSeenAt).toLocaleString()}
                            </td>
                            <td style={{ fontFamily:'var(--mono)', fontSize:10.5, whiteSpace:'nowrap', color:'var(--text3)' }}>
                              {r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : '—'}
                            </td>
                            <td style={{ fontFamily:'var(--mono)', fontSize:11, color: durSec && durSec > 3600 ? 'var(--amber)' : 'var(--text3)' }}>
                              {durLabel}
                            </td>
                            <td>
                              <span className="sm-pill" style={{ background:`${SEV_COLORS[r.severity] || '#64748b'}22`, color: SEV_COLORS[r.severity] || 'var(--text3)', textTransform:'capitalize' }}>
                                {r.severity}
                              </span>
                            </td>
                            <td style={{ fontWeight:600 }}>{r.hostname || r.storeTag}</td>
                            <td style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--text3)' }}>{r.serial || '—'}</td>
                            <td style={{ fontFamily:'var(--mono)', fontSize:11 }}>{r.code}</td>
                            <td style={{ fontSize:11 }}>{r.message}</td>
                            <td><ConnPill state={r.connState} /></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {/* pagination */}
                {probHist.pages > 1 && (
                  <div style={{ display:'flex', gap:8, justifyContent:'center', marginTop:10, flexWrap:'wrap' }}>
                    <button className="sm-btn sm-sm" disabled={probHistPage <= 1}
                      onClick={() => loadProbHist(probHistPage - 1)}>← Prev</button>
                    <span style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--text3)', padding:'4px 0' }}>
                      Page {probHistPage} / {probHist.pages}
                    </span>
                    <button className="sm-btn sm-sm" disabled={probHistPage >= probHist.pages}
                      onClick={() => loadProbHist(probHistPage + 1)}>Next →</button>
                  </div>
                )}
              </>
              )
            })()}
          </>
        )
      })()}

      {/* ══════════ CRASH EVENT MODAL ══════════ */}
      {crashModal && (
        <div className="sm-modal-bg" onClick={(e)=>e.target===e.currentTarget&&setCrashModal(null)}>
          <div className="sm-crash-modal">
            {/* header */}
            <div className="sm-crash-modal-hd">
                {(() => { const cm = crashMeta(crashModal.crashType); return (
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={{fontSize:24}}>{cm.icon}</span>
                  <div>
                    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <span style={{fontWeight:700,fontSize:15}}>{crashModal.hostname}</span>
                      <span style={{fontWeight:400,fontSize:12,color:'var(--text3)'}}>({crashModal.serial})</span>
                      <span style={{padding:'2px 8px',borderRadius:5,fontSize:10,fontFamily:'var(--mono)',fontWeight:700,
                        background:`${cm.color}18`,color:cm.color}}>{cm.label}</span>
                      <span className="sm-badge" style={{background:`${cm.sev==='critical'?'#ef4444':'#f97316'}15`,
                        color:cm.sev==='critical'?'#ef4444':'#f97316',fontSize:9}}>{cm.sev.toUpperCase()}</span>
                    </div>
                    <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text3)',marginTop:3}}>
                      {crashModal.appName||'App name not reported'}
                      {crashModal.appVersion ? ` · v${crashModal.appVersion}` : ''}
                      {' · '}{cm.src}{' · '}Event ID {cm.evtId}
                    </div>
                  </div>
                </div>
                )})()}
              <button className="sm-modal-x" onClick={()=>setCrashModal(null)}>✕</button>
            </div>

            <div className="sm-crash-modal-body">
              {/* summary meta */}
              <div className="sm-crash-meta-grid">
                {[
                  ['Hostname',    crashModal.hostname],
                  ['Serial',      crashModal.serial],
                  ['Store Tag',   crashModal.storeTag||crashModal.hostname],
                  ['Crash Type',  crashMeta(crashModal.crashType).label],
                  ['Source',      crashMeta(crashModal.crashType).src],
                  ['Event ID',    crashMeta(crashModal.crashType).evtId],
                  ['App Name',    crashModal.appName||'—'],
                  ['App Version', crashModal.appVersion||'—'],
                  ['Crash Count', crashModal.totalCrashes],
                  ['Last Event',  crashModal.lastEventId||'—'],
                  ['Last Seen',   crashModal.lastSeen ? new Date(crashModal.lastSeen).toLocaleString() : '—'],
                ].map(([label,val])=>(
                  <div key={label} className="sm-crash-meta-item">
                    <div className="sm-crash-meta-label">{label}</div>
                    <div className="sm-crash-meta-val" style={{color:'var(--text)'}}>{val}</div>
                  </div>
                ))}
                {crashModal.lastMessage && (
                  <div className="sm-crash-meta-item" style={{gridColumn:'1/-1',background:'rgba(239,68,68,.06)',borderColor:'rgba(239,68,68,.2)'}}>
                    <div className="sm-crash-meta-label" style={{color:'var(--red)'}}>Last Message</div>
                    <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--text2)',marginTop:3,lineHeight:1.5,wordBreak:'break-all'}}>
                      {crashModal.lastMessage}
                    </div>
                  </div>
                )}
              </div>

              {/* groups */}
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>GROUPS:</span>
                {deriveGroups(crashModal.hostname,'',false).map(g=><GroupBadge key={g} group={g}/>)}
              </div>

              {/* raw event log */}
              <div className="sm-tr">
                <div className="sm-tr-hd">
                  <span className="sm-tr-title">Raw Event Log</span>
                  {crashRawLoading && <span style={{fontSize:10,color:'var(--accent)',fontFamily:'var(--mono)'}}>Loading…</span>}
                  {!crashRawLoading && <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)'}}>{crashRawRows.length} rows</span>}
                </div>
                <div className="sm-tr-body sm-tbl-wrap" style={{maxHeight:320,overflowY:'auto'}}>
                  {crashRawLoading ? (
                    <div className="sm-empty" style={{padding:24}}>Fetching events…</div>
                  ) : crashRawRows.length === 0 ? (
                    <div className="sm-empty" style={{padding:24}}>No raw events found in the selected time range.</div>
                  ) : (
                    <table className="sm-tbl">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Field</th>
                          <th>Value</th>
                          <th>App</th>
                          <th>Version</th>
                        </tr>
                      </thead>
                      <tbody>
                        {crashRawRows.map((r,i)=>(
                          <tr key={i}>
                            <td style={{fontFamily:'var(--mono)',fontSize:10,whiteSpace:'nowrap',color:'var(--text3)'}}>
                              {r._time ? new Date(r._time).toLocaleString() : '—'}
                            </td>
                            <td style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--accent)'}}>{r._field}</td>
                            <td style={{maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:11,
                              color: r._field==='count' ? 'var(--red)' : r._field==='message' ? 'var(--text2)' : 'var(--text3)'}}>
                              {r._value}
                            </td>
                            <td style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)'}}>{r.app_name||'—'}</td>
                            <td style={{fontFamily:'var(--mono)',fontSize:10,color:'var(--text3)'}}>{r.app_version||'—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* navigate to store */}
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',paddingTop:4,borderTop:'1px solid var(--border)'}}>
                <button className="sm-btn" onClick={()=>setCrashModal(null)}>Close</button>
                <button className="sm-btn primary" onClick={()=>{
                  const st = stores.find(st=>st.hostname===crashModal.hostname)
                  if (st) { setSelectedTag(st.storeTag); setTab('detail') }
                  setCrashModal(null)
                }}>
                  🔍 Open Store Detail
                </button>
              </div>
            </div>
          </div>
        </div>
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

                {/* Crash-specific filters */}
                {alertForm.condition.metric==='crash_count' && (
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8,padding:'10px 12px',background:'var(--bg3)',border:'1px solid rgba(239,68,68,.2)',borderRadius:'var(--sm-r)'}}>
                    <div className="sm-form-field">
                      <label className="sm-form-label">App / Process Name</label>
                      <input className="sm-input"
                        placeholder="e.g. TestApp.exe (empty = all apps)"
                        value={alertForm.condition.appName||''}
                        onChange={(e)=>setAlertForm((f)=>({...f,condition:{...f.condition,appName:e.target.value}}))}/>
                      <span style={{fontSize:10,color:'var(--text3)',marginTop:3,fontFamily:'var(--mono)'}}>
                        Leave empty to alert on any application crash
                      </span>
                    </div>
                    <div className="sm-form-field">
                      <label className="sm-form-label">Crash Type (optional)</label>
                      <select className="sm-select"
                        value={alertForm.condition.crashType||''}
                        onChange={(e)=>setAlertForm((f)=>({...f,condition:{...f.condition,crashType:e.target.value}}))}>
                        <option value="">All crash types</option>
                        {Object.entries(CRASH_TYPE_META).map(([k,m])=>(
                          <option key={k} value={k}>{m.icon} {m.label}</option>
                        ))}
                      </select>
                      <span style={{fontSize:10,color:'var(--text3)',marginTop:3,fontFamily:'var(--mono)'}}>
                        e.g. alert only on BSOD/Kernel
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Trigger Schedule ── */}
              <div className="sm-form-field" style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--sm-r)',padding:'10px 12px'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:alertForm.schedule?.enabled?10:0}}>
                  <label className="sm-form-label" style={{margin:0}}>🕐 Trigger Schedule</label>
                  <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--text2)',cursor:'pointer'}}>
                    <input type="checkbox"
                      checked={!!alertForm.schedule?.enabled}
                      onChange={(e)=>setAlertForm((f)=>({...f,schedule:{...f.schedule,enabled:e.target.checked}}))}/>
                    {alertForm.schedule?.enabled ? 'Active — alert only in defined window' : 'Disabled — alert any time (24/7)'}
                  </label>
                </div>

                {alertForm.schedule?.enabled && (
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    {/* Day selector */}
                    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',minWidth:60}}>Active days:</span>
                      {BH_DAYS.map((d)=>(
                        <button key={d.val} type="button"
                          className={`sm-bh-dayBtn${(alertForm.schedule.weekdays||[]).includes(d.val)?' on':''}`}
                          onClick={()=>{
                            const cur = alertForm.schedule.weekdays || []
                            const next = cur.includes(d.val) ? cur.filter((x)=>x!==d.val) : [...cur,d.val].sort()
                            setAlertForm((f)=>({...f,schedule:{...f.schedule,weekdays:next}}))
                          }}>
                          {d.label}
                        </button>
                      ))}
                    </div>

                    {/* Hour range */}
                    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <span style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--text3)',minWidth:60}}>Active hours:</span>
                      <div style={{display:'flex',alignItems:'center',gap:6,fontSize:12}}>
                        <input type="number" min={0} max={23} className="sm-input"
                          style={{width:52,textAlign:'center'}}
                          value={alertForm.schedule.fromHour??9}
                          onChange={(e)=>setAlertForm((f)=>({...f,schedule:{...f.schedule,fromHour:+e.target.value}}))}/>
                        <span style={{color:'var(--text3)'}}>:00 to</span>
                        <input type="number" min={0} max={24} className="sm-input"
                          style={{width:52,textAlign:'center'}}
                          value={alertForm.schedule.toHour??18}
                          onChange={(e)=>setAlertForm((f)=>({...f,schedule:{...f.schedule,toHour:+e.target.value}}))}/>
                        <span style={{color:'var(--text3)'}}>:00</span>
                        {/* Quick presets */}
                        {[['Business (9–18)',[1,2,3,4,5],9,18],['Office+ (8–20)',[1,2,3,4,5],8,20],['Always (0–24)',[0,1,2,3,4,5,6],0,24]].map(([lbl,days,fh,th])=>(
                          <button key={lbl} type="button" className="sm-btn sm-sm" style={{fontSize:10,padding:'2px 7px'}}
                            onClick={()=>setAlertForm((f)=>({...f,schedule:{...f.schedule,weekdays:days,fromHour:fh,toHour:th}}))}>
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Preview */}
                    <div style={{fontSize:10,fontFamily:'var(--mono)',color:'var(--accent)',background:'rgba(79,126,245,.08)',borderRadius:5,padding:'5px 8px'}}>
                      ⏰ Alert fires only on {(alertForm.schedule.weekdays||[]).map((d)=>BH_DAYS.find((x)=>x.val===d)?.label).join(', ')||'—'}
                      {' '}between {alertForm.schedule.fromHour??9}:00 – {alertForm.schedule.toHour??18}:00
                    </div>
                  </div>
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

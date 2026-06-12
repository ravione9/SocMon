import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import { Line, Bar, Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import api from '../../api/client'
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../../components/ui/ResizableTable.jsx'
import { useThemeStore } from '../../store/themeStore.js'
import { getThemeCssColors } from '../../utils/themeCssColors.js'
import { useSmartPolling } from '../../hooks/useSmartPolling.js'
import { useUrlTab } from '../../hooks/useUrlTab.js'
import { RP_OUTAGE_LABELS, ROP_SUBTABS, isRpGroupKey } from '../../utils/storeRopGrouping.js'
import { parseManualStoreCodes } from '../../config/manualRopSdwanStoreCodes.js'

const INFRA_TAB_IDS = ['overview', 'hosts', 'hostGraphs', 'topMon', 'problems', 'events', 'netHealth', 'rop']

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, BarController, ArcElement, Tooltip, Legend, Filler)

/* ─── Theme colors ─── */
const C = {
  accent: 'var(--accent)', accent2: 'var(--accent2)', green: 'var(--green)', red: 'var(--red)',
  amber: 'var(--amber)', cyan: 'var(--cyan)', text: 'var(--text)', text2: 'var(--text2)', text3: 'var(--text3)',
}
const SEV_COLORS = { 5: '#dc2626', 4: '#f97316', 3: '#eab308', 2: '#06b6d4', 1: '#94a3b8', 0: '#64748b' }
const SEV_LABELS = { 5: 'Disaster', 4: 'High', 3: 'Average', 2: 'Warning', 1: 'Information', 0: 'Not classified' }
const SEV_ORDER = [5, 4, 3, 2, 1, 0]
const DATASET_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#a78bfa']
const RANGE_SEC = { '15m': 900, '1h': 3600, '6h': 6 * 3600, '12h': 12 * 3600, '24h': 86400, '7d': 7 * 86400 }

function sevColor(s) { return SEV_COLORS[Number(s)] || '#64748b' }
function fmtClock(ts) {
  if (ts == null || ts === '') return '—'
  const n = Number(ts)
  return Number.isFinite(n) ? new Date(n * 1000).toLocaleString() : String(ts)
}
function relAge(ts) {
  const d = Math.floor(Date.now() / 1000) - Number(ts)
  if (!Number.isFinite(d) || d < 0) return ''
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`
  return `${Math.floor(d / 86400)}d ${Math.floor((d % 86400) / 3600)}h`
}

/* ─── Chart builders ─── */
function buildAlignedChart(payload) {
  const series = (payload?.series || []).filter((s) => (s.points || []).length > 0)
  if (!series.length) return null
  const clockSet = new Set()
  for (const s of series) for (const p of s.points || []) { const c = Number(p.clock); if (Number.isFinite(c)) clockSet.add(c) }
  let clocks = [...clockSet].sort((a, b) => a - b)
  if (clocks.length > 400) { const step = Math.ceil(clocks.length / 400); clocks = clocks.filter((_, i) => i % step === 0) }
  if (!clocks.length && series[0]?.points?.length) clocks = series[0].points.map((p) => Number(p.clock)).filter(Number.isFinite)
  const labels = clocks.map((c) => new Date(c * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  const datasets = series.map((s, i) => {
    const hex = s.color && /^#?[0-9a-f]{6}$/i.test(String(s.color)) ? (String(s.color).startsWith('#') ? s.color : `#${s.color}`) : DATASET_COLORS[i % DATASET_COLORS.length]
    const by = Object.fromEntries((s.points || []).map((p) => [Number(p.clock), Number(p.value)]).filter(([c, v]) => Number.isFinite(c) && Number.isFinite(v)))
    const data = clocks.map((t) => by[t] ?? null)
    const unit = s.units ? ` (${s.units})` : ''
    return { label: `${s.name || s.key || s.itemid}${unit}`, data, borderColor: hex, backgroundColor: `${hex}18`, tension: 0.35, spanGaps: true, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: hex, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, borderWidth: 2, fill: true }
  })
  return { labels, datasets }
}
function buildLatestBar(latest) {
  const rows = (latest || []).filter((r) => r.numeric && Number.isFinite(Number(r.value)))
  if (!rows.length) return null
  return {
    labels: rows.map((r) => { const n = (r.name || r.key || r.itemid || ''); return n.length > 42 ? n.slice(0, 40) + '…' : n }),
    datasets: [{ label: 'Latest', data: rows.map((r) => Number(r.value)), backgroundColor: rows.map((_, i) => `${DATASET_COLORS[i % DATASET_COLORS.length]}44`), borderColor: rows.map((_, i) => DATASET_COLORS[i % DATASET_COLORS.length]), borderWidth: 1, borderRadius: 3 }],
  }
}

/* ─── Smart value formatting for VMware / mixed-unit metrics ─── */
function fmtValue(val, units) {
  if (val == null || !Number.isFinite(Number(val))) return String(val ?? '—')
  const v = Number(val)
  const u = String(units || '').toLowerCase().trim()
  if (u === 'b' || u === 'bytes' || u === 'b/s' || u === 'bps') {
    const suffix = u === 'b/s' || u === 'bps' ? '/s' : ''
    if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)} TB${suffix}`
    if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} GB${suffix}`
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} MB${suffix}`
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)} KB${suffix}`
    return `${v} B${suffix}`
  }
  if (u === '%' || u === 'percent') return `${v.toFixed(1)}%`
  if (u === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`
  if (u === 's' || u === 'uptime') {
    if (v >= 86400) return `${(v / 86400).toFixed(1)} days`
    if (v >= 3600) return `${(v / 3600).toFixed(1)} hrs`
    if (v >= 60) return `${(v / 60).toFixed(1)} min`
    return `${v.toFixed(0)} s`
  }
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} G`
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} M`
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)} K`
  if (Number.isInteger(v)) return v.toLocaleString()
  return v.toFixed(2)
}

function classifyUnit(units) {
  const u = String(units || '').toLowerCase().trim()
  if (u === '%' || u === 'percent') return 'percentage'
  if (u === 'b' || u === 'bytes') return 'bytes'
  if (u === 'b/s' || u === 'bps') return 'throughput'
  if (u === 'ms' || u === 's' || u === 'uptime') return 'time'
  if (u === 'hz' || u === 'mhz' || u === 'ghz') return 'frequency'
  return 'general'
}

const UNIT_GROUP_LABELS = {
  percentage: 'Performance (%)',
  bytes: 'Storage / Memory',
  throughput: 'Network Throughput',
  time: 'Time / Uptime',
  frequency: 'Frequency',
  general: 'Other Metrics',
}
const UNIT_GROUP_ORDER = ['percentage', 'bytes', 'throughput', 'time', 'frequency', 'general']

function groupLatestMetrics(items) {
  const numericItems = (items || []).filter((r) => r.numeric && Number.isFinite(Number(r.value)))
  const textItems = (items || []).filter((r) => !r.numeric && r.rawValue != null)
  const groups = {}
  for (const item of numericItems) {
    const cat = classifyUnit(item.units)
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(item)
  }
  const ordered = UNIT_GROUP_ORDER.filter((k) => groups[k]?.length).map((k) => ({ key: k, label: UNIT_GROUP_LABELS[k], items: groups[k] }))
  return { groups: ordered, textItems, totalNumeric: numericItems.length }
}

const HISTORY_RANGES = [
  { key: '15m', label: '15m', sec: 900 },
  { key: '1h', label: '1h', sec: 3600 },
  { key: '6h', label: '6h', sec: 6 * 3600 },
  { key: '12h', label: '12h', sec: 12 * 3600 },
  { key: '24h', label: '24h', sec: 86400 },
  { key: '3d', label: '3d', sec: 3 * 86400 },
  { key: '7d', label: '7d', sec: 7 * 86400 },
  { key: '30d', label: '30d', sec: 30 * 86400 },
]

function toLocalInput(ts) {
  const d = new Date(ts * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ItemHistoryChart({ itemId, itemName, itemUnits, chartOpts, apiBase = '/api/zabbix' }) {
  const [range, setRange] = useState('1h')
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [customEpoch, setCustomEpoch] = useState(null)

  const selectPreset = useCallback((key) => {
    setRange(key)
    setCustomEpoch(null)
  }, [])

  const applyCustom = useCallback(() => {
    if (!customFrom || !customTo) return
    const fromTs = Math.floor(new Date(customFrom).getTime() / 1000)
    const toTs = Math.floor(new Date(customTo).getTime() / 1000)
    if (isNaN(fromTs) || isNaN(toTs) || fromTs >= toTs) return
    setRange('custom')
    setCustomEpoch({ from: fromTs, to: toTs })
  }, [customFrom, customTo])

  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    setBusy(true); setErr(null)
    let from, to
    if (range === 'custom' && customEpoch) {
      from = customEpoch.from
      to = customEpoch.to
    } else {
      const sec = HISTORY_RANGES.find((r) => r.key === range)?.sec || 3600
      to = Math.floor(Date.now() / 1000)
      from = to - sec
    }
    if (range !== 'custom' && !customFrom) {
      setCustomFrom(toLocalInput(from))
      setCustomTo(toLocalInput(to))
    }
    api.get(`${apiBase}/items/${encodeURIComponent(itemId)}/history?from=${from}&to=${to}&maxPoints=500`)
      .then(({ data: d }) => {
        if (cancelled) return
        setData(d)
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e.response?.data?.error || e.message || 'Failed to load history')
      })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [itemId, range, customEpoch, apiBase])

  const chartData = useMemo(() => {
    if (!data?.points?.length) return null
    const labels = data.points.map((p) => new Date(p.clock * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
    const color = '#3b82f6'
    return {
      labels,
      datasets: [{
        label: (itemName || 'Value').replace(/^VMware:\s*/i, '') + (itemUnits ? ` (${itemUnits})` : ''),
        data: data.points.map((p) => p.value),
        borderColor: color, backgroundColor: `${color}18`,
        tension: 0.35, spanGaps: true, pointRadius: 0,
        pointHoverRadius: 5, pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2,
        borderWidth: 2, fill: true,
      }],
    }
  }, [data, itemName, itemUnits])

  const displayName = (itemName || '').replace(/^VMware:\s*/i, '')

  return (
    <div className="opm-widget" style={{ animation: 'fadeIn .2s ease' }}>
      <div className="opm-widget-hd">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#3b82f6' }} />
          <span className="opm-widget-title" style={{ textTransform: 'none', fontSize: 12, letterSpacing: 0 }}>{displayName}</span>
          {data?.aggregated && <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: '#3b82f6' }}>Trend</span>}
          {data?.lastvalue != null && (
            <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)', marginLeft: 4 }}>
              Current: <strong style={{ color: 'var(--text)' }}>{fmtValue(Number(data.lastvalue), itemUnits)}</strong>
            </span>
          )}
        </div>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {/* Range selector */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
          {HISTORY_RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => selectPreset(r.key)}
              style={{
                padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600,
                border: range === r.key ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: range === r.key ? 'rgba(59,130,246,.12)' : 'transparent',
                color: range === r.key ? 'var(--accent)' : 'var(--text3)',
                cursor: 'pointer', transition: 'all .12s',
              }}>
              {r.label}
            </button>
          ))}
          <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
          <span style={{ fontSize: 10, fontWeight: 600, color: range === 'custom' ? 'var(--accent)' : 'var(--text3)', letterSpacing: .3 }}>Custom:</span>
        </div>
        {/* Custom date range */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
            style={{
              padding: '3px 8px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)',
              border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)',
              outline: 'none',
            }} />
          <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600 }}>to</span>
          <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
            style={{
              padding: '3px 8px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)',
              border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)',
              outline: 'none',
            }} />
          <button type="button" onClick={applyCustom}
            style={{
              padding: '4px 14px', borderRadius: 5, fontSize: 11, fontWeight: 700, fontFamily: 'var(--mono)',
              border: 'none', background: 'var(--accent)', color: '#fff',
              cursor: 'pointer', transition: 'opacity .12s',
              opacity: (customFrom && customTo) ? 1 : 0.4,
            }}>
            Apply
          </button>
          {range === 'custom' && <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: '#3b82f6', fontSize: 10 }}>Custom Range Active</span>}
        </div>

        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', padding: '40px 0', color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
            <span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading history…
          </div>
        )}
        {!busy && err && <p style={{ margin: 0, color: '#ef4444', fontSize: 12, fontFamily: 'var(--mono)', padding: '16px 0' }}>{err}</p>}
        {!busy && chartData && (
          <div style={{ height: 280, position: 'relative' }}>
            <Line data={chartData} options={chartOpts} />
          </div>
        )}
        {!busy && !err && data && !chartData && (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
            No history data in this range.
            {data.note && <div style={{ marginTop: 4, fontSize: 11, opacity: .7 }}>{data.note}</div>}
            <div style={{ marginTop: 8, fontSize: 10, opacity: .5 }}>Try a longer range (e.g. 7d or 30d) — VMware items may have sparse history.</div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Build a per-mount bytes index from the host's latest item list, then enrich
 * percentage rows (vfs.fs.size[*,pused/pfree]) with usedBytes/totalBytes/freeBytes
 * and mark raw byte siblings as `_hidden` so they don't duplicate the % row.
 */
function enrichDiskRows(items) {
  const list = items || []
  const fsByteRe = /^vfs\.fs(?:\.dependent)?\.size\[/i
  const modeOf = (key) => {
    const m = key.match(/\[[^,]*,\s*([^\]]+)\]/)
    return m ? m[1].trim().replace(/^"|"$/g, '').toLowerCase() : ''
  }
  const mountOf = (key) => {
    const m = key.match(/\[\s*([^,\]]+)/)
    return m ? m[1].replace(/^"|"$/g, '') : ''
  }
  const toBytes = (it) => {
    const v = Number(it.value)
    if (!Number.isFinite(v) || v < 0) return null
    const u = String(it.units || '').trim().toUpperCase()
    const mul = ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 })[u]
    return mul ? v * mul : v
  }

  const byteIdx = {} // `${mount}|${mode}` -> { bytes, itemid }
  for (const it of list) {
    const k = String(it.key || '')
    if (!fsByteRe.test(k)) continue
    const mode = modeOf(k)
    if (!['used', 'total', 'free'].includes(mode)) continue
    const u = String(it.units || '').trim().toUpperCase()
    if (u && !['B', 'KB', 'MB', 'GB', 'TB', 'PB'].includes(u)) continue
    const mount = mountOf(k)
    if (!mount) continue
    const b = toBytes(it)
    if (b == null) continue
    byteIdx[`${mount}|${mode}`] = { bytes: b, itemid: it.itemid }
  }

  const hiddenIds = new Set()
  const enriched = list.map((it) => {
    const k = String(it.key || '')
    if (!fsByteRe.test(k)) return it
    const mode = modeOf(k)
    const mount = mountOf(k)
    if (mode === 'pused' || mode === 'pfree') {
      const used = byteIdx[`${mount}|used`]?.bytes ?? null
      const total = byteIdx[`${mount}|total`]?.bytes ?? null
      const free = byteIdx[`${mount}|free`]?.bytes ?? null
      let usedBytes = used
      let totalBytes = total
      const pct = Number(it.value)
      if (usedBytes == null && total != null && free != null) usedBytes = Math.max(0, total - free)
      if (totalBytes == null && used != null && free != null) totalBytes = used + free
      if (Number.isFinite(pct) && pct > 0) {
        if (usedBytes == null && totalBytes != null) usedBytes = totalBytes * (pct / 100)
        if (totalBytes == null && usedBytes != null) totalBytes = usedBytes / (pct / 100)
      }
      // Hide sibling raw byte rows (used/total/free) — they're rolled up here.
      ;['used', 'total', 'free'].forEach((m) => {
        const sib = byteIdx[`${mount}|${m}`]
        if (sib?.itemid) hiddenIds.add(sib.itemid)
      })
      return {
        ...it,
        usedBytes: usedBytes != null ? Math.round(usedBytes) : null,
        totalBytes: totalBytes != null ? Math.round(totalBytes) : null,
        freeBytes: free != null ? Math.round(free) : null,
        _mount: mount,
      }
    }
    return it
  }).filter((it) => !hiddenIds.has(it.itemid))

  return enriched
}

function LatestMetricsView({ latestData, chartOpts, apiBase = '/api/zabbix' }) {
  const enrichedLatest = useMemo(() => enrichDiskRows(latestData?.latest), [latestData])
  const grouped = useMemo(() => groupLatestMetrics(enrichedLatest), [enrichedLatest])
  const [search, setSearch] = useState('')
  const firstNumericId = useMemo(() => {
    for (const g of grouped.groups) {
      if (g.items.length) return g.items[0].itemid
    }
    return null
  }, [grouped])
  const [selectedItemId, setSelectedItemId] = useState(null)

  useEffect(() => {
    if (selectedItemId == null && firstNumericId) setSelectedItemId(firstNumericId)
  }, [firstNumericId, selectedItemId])

  const allItemsById = useMemo(() => {
    const map = new Map()
    for (const g of grouped.groups) for (const it of g.items) map.set(it.itemid, it)
    return map
  }, [grouped])
  const selectedItem = selectedItemId ? allItemsById.get(selectedItemId) : null

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return grouped.groups
    return grouped.groups.map((g) => ({
      ...g,
      items: g.items.filter((i) => (i.name || i.key || '').toLowerCase().includes(q)),
    })).filter((g) => g.items.length)
  }, [grouped.groups, search])

  if (!grouped.groups.length && !grouped.textItems.length) {
    return <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)', textAlign: 'center', padding: '20px 0' }}>No metrics available for this device.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Sidebar + chart layout */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'start' }}>
        {/* Left sidebar: grouped metric list */}
        <div style={{ flex: '0 0 280px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)', overflow: 'hidden', maxHeight: 600, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: .8, textTransform: 'uppercase' }}>
              Metrics ({grouped.totalNumeric})
            </span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter metrics…"
              style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }} />
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filteredGroups.map((g) => {
              const max = Math.max(...g.items.map((r) => Math.abs(Number(r.value))), 1)
              const isPercentage = g.key === 'percentage'
              const effectiveMax = isPercentage ? 100 : max
              return (
                <div key={g.key}>
                  <div style={{ padding: '6px 12px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)', borderTop: '1px solid var(--border)', fontSize: 9, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: .8, textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{g.label}</span>
                    <span style={{ color: 'var(--accent)' }}>{g.items.length}</span>
                  </div>
                  {g.items.map((r, i) => {
                    const v = Number(r.value)
                    const pct = Math.min(Math.abs(v) / effectiveMax * 100, 100)
                    const color = DATASET_COLORS[i % DATASET_COLORS.length]
                    const barColor = isPercentage && v > 90 ? '#ef4444' : isPercentage && v > 75 ? '#eab308' : color
                    const isActive = r.itemid === selectedItemId
                    return (
                      <button key={r.itemid} type="button" onClick={() => setSelectedItemId(r.itemid)}
                        style={{ width: '100%', textAlign: 'left', border: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--border)', borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent', cursor: 'pointer', background: isActive ? 'rgba(59,130,246,.08)' : 'transparent', fontSize: 11, fontFamily: 'var(--mono)', transition: 'background .12s' }}
                        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(79,126,245,.06)' }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}>
                        <span style={{ width: 6, height: 6, borderRadius: 1, background: color, flexShrink: 0, opacity: .8 }} />
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ color: isActive ? 'var(--accent)' : 'var(--text2)', fontWeight: isActive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }} title={r.name || r.key}>
                            {(r.name || r.key || '').replace(/^VMware:\s*/i, '')}
                          </span>
                          {(r.usedBytes != null || r.totalBytes != null) && (
                            <span title={r.freeBytes != null ? `Free: ${fmtBytes(r.freeBytes)}` : undefined}
                              style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{fmtBytes(r.usedBytes) || '—'}</span>
                              <span style={{ opacity: .55 }}> / </span>
                              <span>{fmtBytes(r.totalBytes) || '—'}</span>
                            </span>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--bg4)', overflow: 'hidden' }}>
                              <div style={{ width: `${Math.max(pct, v > 0 ? 2 : 0)}%`, height: '100%', borderRadius: 2, background: barColor, transition: 'width .3s' }} />
                            </div>
                            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', flexShrink: 0, minWidth: 60, textAlign: 'right' }}>
                              {fmtValue(v, r.units)}
                            </span>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {!filteredGroups.length && search && (
              <div style={{ padding: 16, color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center' }}>No metrics match "{search}"</div>
            )}
          </div>
        </div>

        {/* Right: history chart */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {selectedItem ? (
            <ItemHistoryChart
              key={selectedItem.itemid}
              itemId={selectedItem.itemid}
              itemName={selectedItem.name}
              itemUnits={selectedItem.units}
              chartOpts={chartOpts}
              apiBase={apiBase}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 50, borderRadius: 10, border: '1px dashed var(--border)', background: 'var(--bg2)', color: 'var(--text3)', fontSize: 13, fontFamily: 'var(--mono)' }}>
              Select a metric from the sidebar to view its history
            </div>
          )}
        </div>
      </div>

      {/* Text items (if any) */}
      {grouped.textItems.length > 0 && (
        <div className="opm-widget" style={{ animation: 'fadeIn .2s ease' }}>
          <div className="opm-widget-hd" style={{ padding: '8px 14px' }}>
            <span className="opm-widget-title" style={{ fontSize: 10 }}>Text / State Items</span>
            <span className="badge badge-blue">{grouped.textItems.length}</span>
          </div>
          <div style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>
            {grouped.textItems.map((r) => (
              <div key={r.itemid} className="opm-row-hover" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ flex: 1, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name || r.key}>
                  {(r.name || r.key || '').replace(/^VMware:\s*/i, '')}
                </span>
                <span style={{ color: 'var(--text)', fontWeight: 600, textAlign: 'right', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.rawValue}</span>
                <span style={{ color: 'var(--text3)', fontSize: 10, whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtClock(r.lastclock)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Inline styles (injected once) ─── */
const INLINE_CSS = `
.opm-widget{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:box-shadow .25s,border-color .25s}
.opm-widget:hover{box-shadow:0 8px 28px rgba(0,0,0,.18);border-color:var(--border2)}
.opm-widget-hd{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,var(--bg3) 0%,var(--bg2) 100%)}
.opm-widget-title{font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text2);font-family:var(--mono);display:inline-flex;align-items:center;gap:8px}
.opm-widget-title::before{content:'';display:inline-block;width:3px;height:12px;background:var(--accent);border-radius:2px}
.opm-widget-body{padding:16px}
.opm-row-hover{transition:background .12s}
.opm-row-hover:hover{background:rgba(79,126,245,.07)!important}
.opm-status-strip{display:flex;gap:0;border-radius:6px;overflow:hidden;height:8px}
.opm-tabs{display:flex;align-items:center;gap:2px;padding:4px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow-x:auto}
.opm-tab{position:relative;padding:8px 16px;font-size:12px;font-weight:600;border:none;cursor:pointer;font-family:var(--mono);color:var(--text3);background:transparent;transition:all .18s;border-radius:7px;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.opm-tab:hover{color:var(--text2);background:rgba(79,126,245,.06)}
.opm-tab.active{color:#fff;background:var(--accent);box-shadow:0 2px 8px rgba(59,130,246,.35)}
.opm-tab .opm-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;padding:0 5px;border-radius:8px;font-size:9px;font-weight:700;background:rgba(255,255,255,.2);color:inherit}
.opm-tab:not(.active) .opm-tab-badge{background:var(--bg4);color:var(--text2)}
.opm-device-card{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:all .12s;border-left:3px solid transparent}
.opm-device-card:hover{background:rgba(79,126,245,.06)}
.opm-device-card.active{border-left-color:var(--accent);background:rgba(79,126,245,.10)}
.opm-graph-item{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:all .12s}
.opm-graph-item:hover{background:rgba(79,126,245,.05);padding-left:18px}
.opm-graph-item.active{background:rgba(79,126,245,.12);box-shadow:inset 3px 0 0 var(--accent)}
.opm-alarm-row{display:flex;align-items:stretch;border-bottom:1px solid var(--border);transition:background .1s;cursor:default}
.opm-alarm-row:hover{background:rgba(79,126,245,.04)}
.opm-sev-strip{width:4px;flex-shrink:0}
.opm-pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;font-family:var(--mono);letter-spacing:.3px}
.opm-counter-tile{position:relative;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;padding:14px 16px;border-radius:12px;border:1px solid var(--border);background:linear-gradient(135deg,var(--bg2) 0%,var(--bg3) 100%);min-width:130px;min-height:96px;cursor:pointer;transition:all .22s;overflow:hidden}
.opm-counter-tile::before{content:'';position:absolute;top:0;right:0;width:60px;height:60px;background:radial-gradient(circle at top right,var(--tile-glow,transparent) 0%,transparent 70%);opacity:.5;pointer-events:none}
.opm-counter-tile:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.18)}
.opm-counter-tile .ct-icon{position:absolute;top:10px;right:12px;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;background:var(--ct-icon-bg,rgba(59,130,246,.15));color:var(--ct-icon-color,#3b82f6)}
.opm-page-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-radius:12px;background:linear-gradient(135deg,var(--bg2) 0%,var(--bg3) 100%);border:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap}
.opm-page-title{display:flex;align-items:center;gap:12px}
.opm-page-title h1{margin:0;font-size:18px;font-weight:700;color:var(--text);font-family:var(--mono);letter-spacing:.3px}
.opm-page-subtitle{font-size:11px;color:var(--text3);font-family:var(--mono);font-weight:600;letter-spacing:.5px}
.opm-status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);animation:pulseDot 2s ease-in-out infinite}
.opm-refresh-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);cursor:pointer;font-size:12px;font-family:var(--mono);font-weight:600;transition:all .15s}
.opm-refresh-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent);background:rgba(79,126,245,.06)}
.opm-refresh-btn:disabled{cursor:wait;opacity:.6}
.opm-toolbar{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;background:linear-gradient(180deg,var(--bg2) 0%,var(--bg3) 100%);border:1px solid var(--border)}
.opm-toolbar-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.opm-toolbar-label{font-size:10px;color:var(--text3);font-family:var(--mono);font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-right:2px}
.opm-search{position:relative;flex:1 1 auto;max-width:480px}
.opm-search input{width:100%;padding:9px 14px 9px 36px;border-radius:9px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;font-family:var(--mono);outline:none;transition:all .18s}
.opm-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(59,130,246,.12);background:var(--bg2)}
.opm-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:14px;pointer-events:none}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes pulseDot{0%,100%{box-shadow:0 0 0 3px rgba(34,197,94,.18)}50%{box-shadow:0 0 0 6px rgba(34,197,94,.08)}}
.topmon-dashboard{display:flex;flex-direction:column;gap:18px}
.topmon-dash-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px;border-radius:14px;background:linear-gradient(135deg,rgba(59,130,246,.08) 0%,var(--bg2) 45%,var(--bg3) 100%);border:1px solid var(--border);flex-wrap:wrap}
.topmon-dash-header h2{margin:0;font-size:16px;font-weight:800;color:var(--text);letter-spacing:.2px}
.topmon-dash-header p{margin:4px 0 0;font-size:11px;color:var(--text3);font-family:var(--mono)}
.topmon-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.topmon-kpi{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:flex-start;gap:12px;min-height:88px;transition:transform .2s,box-shadow .2s,border-color .2s}
.topmon-kpi:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,0,0,.16);border-color:var(--border2)}
.topmon-kpi-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.topmon-kpi-body{min-width:0;flex:1}
.topmon-kpi-label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;font-family:var(--mono)}
.topmon-kpi-value{font-size:26px;font-weight:800;line-height:1.1;margin-top:4px;font-family:var(--mono)}
.topmon-kpi-sub{font-size:10px;color:var(--text3);margin-top:4px;font-family:var(--mono)}
.topmon-analytics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.topmon-donut-wrap{display:flex;align-items:center;gap:16px;padding:4px 0}
.topmon-donut-chart{width:120px;height:120px;flex-shrink:0}
.topmon-legend{display:flex;flex-direction:column;gap:8px;flex:1;min-width:0}
.topmon-legend-row{display:flex;align-items:center;gap:8px;font-size:11px;font-family:var(--mono)}
.topmon-legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.topmon-legend-label{flex:1;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topmon-legend-val{font-weight:800;color:var(--text);min-width:28px;text-align:right}
.topmon-hbar-list{display:flex;flex-direction:column;gap:10px;padding:4px 0}
.topmon-hbar-row{display:grid;grid-template-columns:minmax(100px,1fr) 1fr 36px;gap:10px;align-items:center;font-size:11px;font-family:var(--mono)}
.topmon-hbar-track{height:8px;border-radius:4px;background:var(--bg4);overflow:hidden}
.topmon-hbar-fill{height:100%;border-radius:4px;transition:width .4s ease}
.topmon-section{display:flex;align-items:center;gap:12px;margin:4px 0 0}
.topmon-section h3{margin:0;font-size:12px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.8px;font-family:var(--mono);white-space:nowrap}
.topmon-section-line{flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent)}
.topmon-widget-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px;align-items:start}
.topmon-rank-table{width:100%;border-collapse:collapse;font-size:11px;font-family:var(--mono)}
.topmon-rank-table thead th{padding:8px 10px;text-align:left;font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border);background:var(--bg3)}
.topmon-rank-table tbody tr{border-bottom:1px solid rgba(128,128,160,.06);cursor:pointer;transition:background .12s}
.topmon-rank-table tbody tr:hover{background:rgba(79,126,245,.07)}
.topmon-rank-table td{padding:9px 10px;vertical-align:middle}
.topmon-rank-num{width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;background:var(--bg4);color:var(--text3)}
.topmon-rank-num.top3{color:#fff}
.topmon-sev-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;letter-spacing:.03em}
.topmon-empty{padding:32px 16px;text-align:center;color:var(--text3);font-size:12px;font-family:var(--mono);line-height:1.6}
.topmon-empty-icon{font-size:28px;opacity:.35;display:block;margin-bottom:8px}
.topmon-val-bar{display:flex;align-items:center;gap:8px;min-width:120px}
.topmon-val-bar-track{flex:1;height:6px;border-radius:3px;background:var(--bg4);overflow:hidden;min-width:48px}
.topmon-val-bar-fill{height:100%;border-radius:3px}
.rop-toolbar{display:flex;flex-direction:column;gap:0;padding:0;border-radius:10px;background:var(--bg2);border:1px solid var(--border);overflow:hidden}
.rop-toolbar-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px}
.rop-toolbar-row--sub{border-top:1px solid var(--border);background:var(--bg3);padding:6px 12px}
.rop-field{display:inline-flex;align-items:center;gap:6px;min-width:0;flex-shrink:0}
.rop-field-divider{width:1px;height:22px;background:var(--border);flex-shrink:0}
.rop-field-label{font-size:10px;color:var(--text3);font-weight:600;letter-spacing:.3px;text-transform:uppercase;line-height:1;white-space:nowrap;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif)}
.rop-segment{display:inline-flex;height:26px;padding:2px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;gap:1px}
.rop-segment-btn{height:22px;padding:0 8px;border:none;background:transparent;color:var(--text2);font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;transition:all .15s;white-space:nowrap;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif)}
.rop-segment-btn:hover:not(.active){color:var(--text);background:rgba(255,255,255,.04)}
.rop-segment-btn.active{background:var(--bg);color:var(--accent);box-shadow:0 1px 2px rgba(0,0,0,.08),inset 0 0 0 1px rgba(59,130,246,.18)}
.rop-control{display:inline-flex;align-items:center;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;font-family:var(--mono);outline:none;transition:border-color .15s,box-shadow .15s;cursor:pointer}
.rop-control:hover{border-color:var(--border2,var(--border))}
.rop-control:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(59,130,246,.10)}
.rop-control--select{padding-right:6px;min-width:110px;max-width:140px}
.rop-control--time{width:68px;justify-content:center;text-align:center;padding:0 4px}
.rop-control--num{width:56px;text-align:right;padding:0 6px}
.rop-control--datetime{width:170px;font-size:10px}
.rop-action-btn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif)}
.rop-action-btn:hover:not(:disabled){filter:brightness(1.05)}
.rop-action-btn:disabled{opacity:.4;cursor:not-allowed}
.rop-action-btn--ghost{background:transparent;color:var(--text2);border-color:var(--border);font-size:10px;padding:0 8px}
.rop-action-btn--ghost:hover:not(:disabled){border-color:var(--accent);color:var(--accent);background:rgba(59,130,246,.06)}
.rop-day-row{display:inline-flex;height:26px;padding:2px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;gap:1px}
.rop-day-btn{height:22px;width:28px;border:none;background:transparent;color:var(--text3);font-size:10px;font-weight:600;border-radius:4px;cursor:pointer;transition:all .15s;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif)}
.rop-day-btn:hover:not(.active){color:var(--text2);background:rgba(255,255,255,.04)}
.rop-day-btn.active{background:var(--bg);color:var(--accent);box-shadow:0 1px 2px rgba(0,0,0,.08),inset 0 0 0 1px rgba(59,130,246,.18)}
.rop-meta{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:6px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.18);color:var(--accent);font-size:10px;font-family:var(--mono);font-weight:600;white-space:nowrap;margin-left:auto}
.rop-meta--muted{background:transparent;border-color:var(--border);color:var(--text3);font-weight:500}
.rop-toolbar-spacer{flex:1;min-width:8px}
.rop-subtabs{display:flex;align-items:center;gap:0;padding:0;background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.rop-subtab{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border:none;background:transparent;color:var(--text3);font-size:12px;font-weight:600;cursor:pointer;border-right:1px solid var(--border);transition:all .15s;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);position:relative}
.rop-subtab:last-child{border-right:none}
.rop-subtab:hover:not(.active){color:var(--text2);background:var(--bg3)}
.rop-subtab.active{color:var(--text);background:var(--bg3);font-weight:700}
.rop-subtab.active::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--accent)}
.rop-subtab-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:var(--bg);border:1px solid var(--border);color:var(--text3);font-size:10px;font-weight:700;font-family:var(--mono)}
.rop-subtab.active .rop-subtab-count{background:rgba(59,130,246,.10);border-color:rgba(59,130,246,.25);color:var(--accent)}
.rop-kpi-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
@media (max-width:1280px){.rop-kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.rop-hero{grid-column:span 3}}
@media (max-width:720px){.rop-kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.rop-hero{grid-column:span 2}}
.rop-hero{position:relative;display:flex;align-items:center;gap:14px;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:linear-gradient(135deg,var(--bg2) 0%,var(--bg3) 100%);overflow:hidden;grid-column:span 2;min-height:0}
.rop-hero::before{content:'';position:absolute;top:0;right:0;width:120px;height:120px;background:radial-gradient(circle at top right,rgba(59,130,246,.08),transparent 65%);pointer-events:none}
.rop-hero-main{flex-shrink:0;min-width:0}
.rop-hero-label{font-size:10px;color:var(--text3);font-weight:600;letter-spacing:.3px;text-transform:uppercase;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rop-hero-headline{display:flex;align-items:baseline;gap:4px;margin-top:2px}
.rop-hero-value{font-size:26px;font-weight:700;line-height:1;font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.rop-hero-unit{font-size:14px;color:var(--text2);font-weight:600;font-family:var(--mono)}
.rop-hero-side{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:6px}
.rop-hero-bar{position:relative;height:6px;background:var(--bg4);border-radius:3px;overflow:hidden}
.rop-hero-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;transition:width .4s ease}
.rop-hero-bar-target{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--text);opacity:.55}
.rop-hero-foot{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--text3);font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);gap:6px;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rop-hero-foot strong{color:var(--text2);font-weight:700}
.rop-stat{position:relative;display:flex;flex-direction:column;justify-content:center;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);min-height:0;transition:border-color .2s,box-shadow .2s;gap:2px}
.rop-stat:hover{border-color:var(--border2,var(--border));box-shadow:0 2px 8px rgba(0,0,0,.05)}
.rop-stat-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.rop-stat-label{font-size:10px;color:var(--text3);font-weight:600;letter-spacing:.2px;font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rop-stat-icon{width:20px;height:20px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;background:rgba(100,116,139,.10);color:var(--text3);flex-shrink:0}
.rop-stat-value{font-size:22px;font-weight:700;line-height:1.1;color:var(--text);font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.rop-stat-foot{font-size:10px;color:var(--text3);font-family:var(--sans,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rop-stat-foot--ok{color:#16a34a}
.rop-stat-foot--warn{color:#ea580c}
.rop-stat-foot--bad{color:#dc2626}
.rop-stat--ok .rop-stat-icon{background:rgba(34,197,94,.12);color:#16a34a}
.rop-stat--warn .rop-stat-icon{background:rgba(234,179,8,.14);color:#b45309}
.rop-stat--bad .rop-stat-icon{background:rgba(239,68,68,.12);color:#dc2626}
.rop-status-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}
`

/* ─── Shared components ─── */
function Widget({ title, badge, badgeColor, children, noPad, actions, style: sx }) {
  return (
    <div className="opm-widget" style={{ animation: 'fadeIn .25s ease', ...sx }}>
      <div className="opm-widget-hd">
        <span className="opm-widget-title">{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions}
          {badge != null && <span className={`badge badge-${badgeColor || 'blue'}`}>{badge}</span>}
        </div>
      </div>
      <div className={noPad ? '' : 'opm-widget-body'}>{children}</div>
    </div>
  )
}

function CounterTile({ label, value, sub, color, onClick, icon }) {
  const cMap = { green: '#22c55e', red: '#ef4444', amber: '#eab308', cyan: '#06b6d4', blue: '#3b82f6', purple: '#8b5cf6' }
  const c = cMap[color] || cMap.blue
  return (
    <div className="opm-counter-tile" onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick() } : undefined}
      style={{
        borderTop: `3px solid ${c}`,
        '--tile-glow': `${c}22`,
        '--ct-icon-bg': `${c}1f`,
        '--ct-icon-color': c,
      }}>
      {icon && <span className="ct-icon">{icon}</span>}
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: .6, textTransform: 'uppercase', fontFamily: 'var(--mono)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: c, fontFamily: 'var(--mono)' }}>{value ?? '—'}</span>
      </div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 4, fontFamily: 'var(--mono)', opacity: .8, fontWeight: 600 }}>{sub}</div>}
    </div>
  )
}

function DeviceSnapshotDonut({ available, unavailable, unknown, total }) {
  const data = {
    labels: ['Available', 'Unavailable', 'Unknown'],
    datasets: [{
      data: [available || 0, unavailable || 0, unknown || 0],
      backgroundColor: ['#22c55e', '#ef4444', '#64748b'],
      borderColor: ['#16a34a', '#dc2626', '#475569'],
      borderWidth: 2, hoverOffset: 6,
    }],
  }
  const opts = {
    cutout: '68%', responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: 'rgba(15,17,23,.95)', borderColor: 'rgba(79,126,245,.3)', borderWidth: 1, cornerRadius: 8, padding: 10, titleFont: { size: 12, weight: '600' }, bodyFont: { size: 11 } },
    },
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
      <div style={{ position: 'relative', width: 130, height: 130, flexShrink: 0 }}>
        <Doughnut data={data} options={opts} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', fontFamily: 'var(--mono)', lineHeight: 1 }}>{total}</span>
          <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: .5 }}>DEVICES</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[
          { label: 'Available', count: available, color: '#22c55e', icon: '●' },
          { label: 'Unavailable', count: unavailable, color: '#ef4444', icon: '●' },
          { label: 'Unknown', count: unknown, color: '#64748b', icon: '●' },
        ].map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--mono)' }}>
            <span style={{ color: r.color, fontSize: 10 }}>{r.icon}</span>
            <span style={{ color: 'var(--text2)', minWidth: 80 }}>{r.label}</span>
            <span style={{ fontWeight: 700, color: r.color, fontSize: 16 }}>{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AlarmSeverityStrip({ counts }) {
  if (!counts) return null
  const total = SEV_ORDER.reduce((s, k) => s + (Number(counts[k]) || 0), 0) || 1
  return (
    <div>
      <div className="opm-status-strip" style={{ marginBottom: 12 }}>
        {SEV_ORDER.map((k) => {
          const n = Number(counts[k]) || 0
          if (!n) return null
          return <div key={k} style={{ width: `${(n / total) * 100}%`, background: SEV_COLORS[k], transition: 'width .4s ease' }} title={`${SEV_LABELS[k]}: ${n}`} />
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {SEV_ORDER.map((k) => {
          const n = Number(counts[k]) || 0
          return (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--mono)' }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: SEV_COLORS[k], flexShrink: 0 }} />
              <span style={{ color: 'var(--text3)' }}>{SEV_LABELS[k]}</span>
              <span style={{ fontWeight: 700, color: SEV_COLORS[k], marginLeft: 'auto' }}>{n}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TopDevicesRanked({ items, onItemClick }) {
  if (!items?.length) return <div style={{ color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>No problematic devices.</div>
  const max = Math.max(...items.map((i) => i.count), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {items.map((h, i) => (
        <div key={h.hostid || i} className="opm-row-hover"
          onClick={onItemClick ? () => onItemClick(h) : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: onItemClick ? 'pointer' : 'default', fontSize: 11, fontFamily: 'var(--mono)' }}>
          <span style={{ width: 18, height: 18, borderRadius: 4, background: 'var(--bg4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'var(--text3)', flexShrink: 0 }}>{i + 1}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text2)' }}>{h.name || h.host}</span>
          <div style={{ width: 80, height: 6, borderRadius: 3, background: 'var(--bg4)', overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ width: `${(h.count / max) * 100}%`, height: '100%', borderRadius: 3, background: sevColor(h.maxSeverity), transition: 'width .3s' }} />
          </div>
          <span style={{ width: 28, textAlign: 'right', fontWeight: 700, color: sevColor(h.maxSeverity), flexShrink: 0 }}>{h.count}</span>
        </div>
      ))}
    </div>
  )
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = Math.max(0, n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(decimals)} ${units[i]}`
}

function TopUtilWidget({ rows, accent, unitSuffix = '%', emptyMsg = 'No data available.', onRowClick, showMount, showBytes, useValue }) {
  if (!rows?.length) {
    return <div style={{ color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', padding: '16px 4px' }}>{emptyMsg}</div>
  }
  const barColor = (pct, rawVal, isLatency) => {
    if (isLatency) {
      if (rawVal >= 150) return '#ef4444'
      if (rawVal >= 50) return '#f59e0b'
      return accent || '#22c55e'
    }
    if (pct >= 90) return '#ef4444'
    if (pct >= 75) return '#f59e0b'
    if (pct >= 50) return '#eab308'
    return accent || '#22c55e'
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map((r, i) => {
        const barPct = Number(r.percent) || 0
        const rawVal = r.value != null ? Number(r.value) : barPct
        const displayVal = r.value != null ? Number(r.value) : barPct
        const isLatency = unitSuffix.trim() === 'ms'
        const c = barColor(barPct, rawVal, isLatency)
        const used = fmtBytes(r.usedBytes)
        const total = fmtBytes(r.totalBytes)
        const free = fmtBytes(r.freeBytes)
        const showSpace = showBytes && (used || total)
        return (
          <div key={r.itemid || `${r.hostid}-${i}`} className="opm-row-hover"
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            role={onRowClick ? 'button' : undefined} tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r) } : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 7, cursor: onRowClick ? 'pointer' : 'default', fontSize: 11, fontFamily: 'var(--mono)' }}>
            <span style={{ width: 22, height: 22, borderRadius: 5, background: 'var(--bg4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: i < 3 ? c : 'var(--text3)', flexShrink: 0, border: i < 3 ? `1px solid ${c}55` : 'none' }}>
              {i + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name || r.host}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10, color: 'var(--text3)', marginTop: 1, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {showMount && r.mount && (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '40%' }}>{r.mount}</span>
                )}
                {showSpace && (
                  <>
                    {showMount && r.mount && <span style={{ opacity: .3 }}>·</span>}
                    <span title={free ? `Free: ${free}` : undefined}>
                      <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{used || '—'}</span>
                      <span style={{ opacity: .55 }}> / </span>
                      <span style={{ color: 'var(--text2)' }}>{total || '—'}</span>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div style={{ width: 90, height: 6, borderRadius: 3, background: 'var(--bg4)', overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ width: `${Math.max(2, Math.min(100, barPct))}%`, height: '100%', borderRadius: 3, background: c, transition: 'width .35s ease' }} />
            </div>
            <span style={{ minWidth: 52, textAlign: 'right', fontWeight: 800, color: c, flexShrink: 0, fontSize: 12 }}>
              {displayVal >= 100 ? Math.round(displayVal) : displayVal.toFixed(1)}{unitSuffix}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function topMonSeverity(pct, rawVal, unitSuffix) {
  const isLatency = unitSuffix.trim() === 'ms'
  const v = rawVal != null ? rawVal : pct
  if (isLatency) {
    if (v >= 150) return { label: 'Critical', color: '#ef4444', bg: 'rgba(239,68,68,.12)' }
    if (v >= 50) return { label: 'Warning', color: '#f59e0b', bg: 'rgba(245,158,11,.12)' }
    return { label: 'Normal', color: '#22c55e', bg: 'rgba(34,197,94,.12)' }
  }
  if (unitSuffix.includes('%') && v >= 90) return { label: 'Critical', color: '#ef4444', bg: 'rgba(239,68,68,.12)' }
  if (v >= 90) return { label: 'Critical', color: '#ef4444', bg: 'rgba(239,68,68,.12)' }
  if (v >= 75) return { label: 'High', color: '#f59e0b', bg: 'rgba(245,158,11,.12)' }
  if (v >= 50) return { label: 'Elevated', color: '#eab308', bg: 'rgba(234,179,8,.12)' }
  return { label: 'Normal', color: '#22c55e', bg: 'rgba(34,197,94,.12)' }
}

function TopMonKpi({ icon, label, value, sub, color, iconBg }) {
  return (
    <div className="topmon-kpi">
      <div className="topmon-kpi-icon" style={{ background: iconBg || `${color}18`, color }}>{icon}</div>
      <div className="topmon-kpi-body">
        <div className="topmon-kpi-label">{label}</div>
        <div className="topmon-kpi-value" style={{ color }}>{value ?? '—'}</div>
        {sub && <div className="topmon-kpi-sub">{sub}</div>}
      </div>
    </div>
  )
}

function TopMonDonutPanel({ buckets, total, centerLabel }) {
  const items = (buckets || []).filter((b) => b.count > 0)
  const sum = total || items.reduce((a, b) => a + b.count, 0) || 1
  if (!items.length) {
    return <div className="topmon-empty"><span className="topmon-empty-icon">◔</span>No data in this category</div>
  }
  const data = {
    labels: items.map((b) => b.label),
    datasets: [{ data: items.map((b) => b.count), backgroundColor: items.map((b) => b.color), borderWidth: 0, hoverOffset: 4 }],
  }
  const opts = {
    cutout: '72%', responsive: true, maintainAspectRatio: true,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15,17,23,.95)', padding: 8, titleFont: { size: 11 }, bodyFont: { size: 11 } } },
  }
  return (
    <div className="topmon-donut-wrap">
      <div className="topmon-donut-chart" style={{ position: 'relative' }}>
        <Doughnut data={data} options={opts} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', fontFamily: 'var(--mono)', lineHeight: 1 }}>{sum}</span>
          <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{centerLabel || 'hosts'}</span>
        </div>
      </div>
      <div className="topmon-legend">
        {items.map((b) => (
          <div key={b.label} className="topmon-legend-row">
            <span className="topmon-legend-dot" style={{ background: b.color }} />
            <span className="topmon-legend-label">{b.label}</span>
            <span className="topmon-legend-val">{b.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TopMonDistBars({ buckets, total }) {
  const items = buckets || []
  const max = Math.max(...items.map((b) => b.count), 1)
  const denom = total || items.reduce((a, b) => a + b.count, 0) || 1
  if (!items.some((b) => b.count > 0)) {
    return <div className="topmon-empty"><span className="topmon-empty-icon">▥</span>No distribution data</div>
  }
  return (
    <div className="topmon-hbar-list">
      {items.map((b) => (
        <div key={b.label} className="topmon-hbar-row">
          <span style={{ color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
          <div className="topmon-hbar-track">
            <div className="topmon-hbar-fill" style={{ width: `${Math.max(2, (b.count / max) * 100)}%`, background: b.color }} />
          </div>
          <span style={{ fontWeight: 800, color: b.color, textAlign: 'right' }}>{b.count}</span>
        </div>
      ))}
      <p style={{ margin: '6px 0 0', fontSize: 10, color: 'var(--text3)' }}>{denom} hosts with fresh sensor data</p>
    </div>
  )
}

function TopMonSection({ title }) {
  return (
    <div className="topmon-section">
      <h3>{title}</h3>
      <div className="topmon-section-line" />
    </div>
  )
}

function TopMonRankTable({ rows, accent, unitSuffix = '%', emptyMsg, onRowClick, showMount, showBytes }) {
  if (!rows?.length) {
    return (
      <div className="topmon-empty">
        <span className="topmon-empty-icon">◎</span>
        {emptyMsg || 'No data available.'}
      </div>
    )
  }
  return (
    <table className="topmon-rank-table">
      <thead>
        <tr>
          <th style={{ width: 36 }}>#</th>
          <th>Device</th>
          {showMount && <th>Volume</th>}
          <th style={{ width: 72 }}>Status</th>
          <th style={{ width: 140, textAlign: 'right' }}>Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const barPct = Number(r.percent) || 0
          const rawVal = r.value != null ? Number(r.value) : barPct
          const sev = topMonSeverity(barPct, rawVal, unitSuffix)
          const used = fmtBytes(r.usedBytes)
          const total = fmtBytes(r.totalBytes)
          const displayVal = r.value != null ? (rawVal >= 100 ? Math.round(rawVal) : rawVal.toFixed(1)) : barPct.toFixed(1)
          return (
            <tr key={r.itemid || `${r.hostid}-${i}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              <td>
                <span className={`topmon-rank-num ${i < 3 ? 'top3' : ''}`} style={i < 3 ? { background: sev.color, color: '#fff' } : undefined}>{i + 1}</span>
              </td>
              <td>
                <div style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{r.name || r.host}</div>
                {showBytes && (used || total) && (
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{used || '—'} / {total || '—'}</div>
                )}
              </td>
              {showMount && <td style={{ color: 'var(--text3)', fontSize: 10 }}>{r.mount || '—'}</td>}
              <td>
                <span className="topmon-sev-pill" style={{ color: sev.color, background: sev.bg, border: `1px solid ${sev.color}33` }}>{sev.label}</span>
              </td>
              <td>
                <div className="topmon-val-bar" style={{ justifyContent: 'flex-end' }}>
                  <div className="topmon-val-bar-track">
                    <div className="topmon-val-bar-fill" style={{ width: `${Math.max(2, Math.min(100, barPct))}%`, background: sev.color }} />
                  </div>
                  <span style={{ fontWeight: 800, color: sev.color, minWidth: 52, textAlign: 'right' }}>{displayVal}{unitSuffix}</span>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const TOP_MON_STORAGE_PREFIX = 'netpulse-topMon-custom'
const TOP_MON_HIDDEN_PREFIX = 'netpulse-topMon-hidden'
const TOP_MON_BUILTIN = [
  { id: 'cpu', title: 'Top CPU Utilization', dataKey: 'cpu', accent: '#3b82f6', badgeColor: 'blue', unitSuffix: '%', emptyMsg: 'No CPU utilization items found.', section: 'infra' },
  { id: 'memory', title: 'Top Memory Utilization', dataKey: 'memory', accent: '#8b5cf6', badgeColor: 'purple', unitSuffix: '%', emptyMsg: 'No memory utilization items found.', section: 'infra' },
  { id: 'disk', title: 'Top Disk Space Usage', dataKey: 'disk', accent: '#f59e0b', badgeColor: 'amber', unitSuffix: '%', showMount: true, showBytes: true, emptyMsg: 'No filesystem usage items found.', section: 'infra' },
  { id: 'packetLoss', title: 'Top Packet Loss', dataKey: 'packetLoss', accent: '#ef4444', badgeColor: 'red', unitSuffix: '%', emptyMsg: 'No packet loss sensors found.', section: 'network', useValue: true },
  { id: 'latency', title: 'Top Latency', dataKey: 'latency', accent: '#06b6d4', badgeColor: 'cyan', unitSuffix: ' ms', emptyMsg: 'No latency sensors found.', section: 'network', useValue: true },
]
const TOP_MON_ACCENT_PRESETS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#22c55e', '#ec4899', '#64748b']

function loadCustomTopWidgets(apiBase) {
  try {
    const raw = localStorage.getItem(`${TOP_MON_STORAGE_PREFIX}:${apiBase}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveCustomTopWidgets(apiBase, widgets) {
  try {
    localStorage.setItem(`${TOP_MON_STORAGE_PREFIX}:${apiBase}`, JSON.stringify(widgets))
  } catch { /* ignore quota */ }
}

function loadHiddenTopWidgets(apiBase) {
  try {
    const raw = localStorage.getItem(`${TOP_MON_HIDDEN_PREFIX}:${apiBase}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveHiddenTopWidgets(apiBase, ids) {
  try {
    localStorage.setItem(`${TOP_MON_HIDDEN_PREFIX}:${apiBase}`, JSON.stringify(ids))
  } catch { /* ignore */ }
}

function newTopWidgetId() {
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function TopMonLayoutModal({ open, onClose, hiddenIds, onSave }) {
  const [localHidden, setLocalHidden] = useState(hiddenIds || [])

  useEffect(() => {
    if (open) setLocalHidden(hiddenIds || [])
  }, [open, hiddenIds])

  if (!open) return null

  const toggle = (id) => {
    setLocalHidden((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Dashboard Layout</div>
        <p style={{ margin: '0 0 14px', fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>Choose which built-in panels appear on your monitoring dashboard.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
          {TOP_MON_BUILTIN.map((w) => {
            const visible = !localHidden.includes(w.id)
            return (
              <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: visible ? 'rgba(59,130,246,.06)' : 'var(--bg3)', cursor: 'pointer', fontSize: 12 }}>
                <input type="checkbox" checked={visible} onChange={() => toggle(w.id)} />
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{w.title}</span>
              </label>
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
          <button type="button" onClick={() => { onSave(localHidden); onClose() }} style={{ padding: '8px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Save Layout</button>
        </div>
      </div>
    </div>
  )
}

function TopMonAddWidgetModal({ open, onClose, onSave, initial }) {
  const [title, setTitle] = useState(initial?.title || '')
  const [keyPattern, setKeyPattern] = useState(initial?.keyPattern || 'custom.ping.ms')
  const [sort, setSort] = useState(initial?.sort || 'desc')
  const [unitSuffix, setUnitSuffix] = useState(initial?.unitSuffix ?? ' ms')
  const [accent, setAccent] = useState(initial?.accent || TOP_MON_ACCENT_PRESETS[0])

  useEffect(() => {
    if (!open) return
    setTitle(initial?.title || '')
    setKeyPattern(initial?.keyPattern || 'custom.ping.ms')
    setSort(initial?.sort || 'desc')
    setUnitSuffix(initial?.unitSuffix ?? ' ms')
    setAccent(initial?.accent || TOP_MON_ACCENT_PRESETS[0])
  }, [open, initial])

  if (!open) return null

  const submit = (e) => {
    e.preventDefault()
    const t = title.trim()
    const k = keyPattern.trim()
    if (!t || !k) return
    onSave({
      id: initial?.id || newTopWidgetId(),
      title: t,
      keyPattern: k,
      sort,
      unitSuffix: unitSuffix || '',
      accent,
    })
    onClose()
  }

  const inp = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', boxSizing: 'border-box' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
      onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 440, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{initial ? 'Edit Widget' : 'Add Custom Widget'}</div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
          Query Zabbix items by key pattern (wildcard added automatically). Example keys: <code style={{ color: 'var(--cyan)' }}>custom.ping.ms</code>, <code style={{ color: 'var(--cyan)' }}>system.cpu.util</code>, <code style={{ color: 'var(--cyan)' }}>vfs.fs.size</code>
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Top Network Errors" style={inp} required />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
          Item key pattern
          <input value={keyPattern} onChange={(e) => setKeyPattern(e.target.value)} placeholder="custom.ping.ms" style={inp} required />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)} style={inp}>
              <option value="desc">Highest first</option>
              <option value="asc">Lowest first</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
            Unit suffix
            <input value={unitSuffix} onChange={(e) => setUnitSuffix(e.target.value)} placeholder=" ms or %" style={inp} />
          </label>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>Accent color</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {TOP_MON_ACCENT_PRESETS.map((c) => (
              <button key={c} type="button" onClick={() => setAccent(c)}
                style={{ width: 28, height: 28, borderRadius: 6, background: c, border: accent === c ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" style={{ padding: '8px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{initial ? 'Save' : 'Add Widget'}</button>
        </div>
      </form>
    </div>
  )
}

function RopDisconnectModal({ open, store, events, loading, error, rangeLabel, bhLabel, onClose }) {
  if (!open || !store) return null

  const fmtTs = (v) => {
    if (v == null || v === '') return '—'
    const d = v instanceof Date ? v : new Date(v)
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—'
  }
  const fmtDur = (mins) => {
    if (mins == null || !Number.isFinite(mins)) return '—'
    if (mins < 1) return '< 1 m'
    if (mins < 60) return `${Math.round(mins)} m`
    if (mins < 1440) return `${(mins / 60).toFixed(1)} h`
    return `${(mins / 1440).toFixed(1)} d`
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 920, maxHeight: 'min(90vh, 720px)', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Disconnect events</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginTop: 4, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={store.hostname || store.storeTag}>
              {store.hostname || store.storeTag}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span>{store.storeTag}</span>
              {rangeLabel && <><span>·</span><span>{rangeLabel}</span></>}
              {bhLabel && (
                <span style={{ background: 'rgba(59,130,246,.10)', color: 'var(--accent)', border: '1px solid rgba(59,130,246,.20)', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>
                  BH {bhLabel}
                </span>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>
            ✕
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          {loading && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
              Loading disconnect events…
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: 16, color: '#ef4444', fontFamily: 'var(--mono)', fontSize: 12 }}>{error}</div>
          )}
          {!loading && !error && events.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
              No disconnect events overlap the business-hours window.
            </div>
          )}
          {!loading && !error && events.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['#', 'Disconnected at', 'Back up at', 'BH duration', 'Total duration', 'Status'].map((lbl, i) => (
                    <th key={lbl} style={{ padding: '8px 10px', textAlign: i === 0 ? 'center' : 'left', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>
                      {lbl}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((ev, idx) => (
                  <tr key={`${ev.disconnectAtMs}-${idx}`} style={{ borderBottom: '1px solid rgba(128,128,160,.08)' }}>
                    <td style={{ padding: '8px 10px', textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10 }}>{idx + 1}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtTs(ev.disconnectAt)}</td>
                    <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap', color: ev.stillOffline ? '#ef4444' : '#22c55e' }}>
                      {ev.stillOffline ? 'Still offline' : fmtTs(ev.backUpAt)}
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: ev.bhDurationMin > 0 ? '#f59e0b' : 'var(--text3)', whiteSpace: 'nowrap' }}
                      title="Time during configured business hours">
                      {fmtDur(ev.bhDurationMin)}
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}
                      title="Total wall-clock outage duration">
                      {fmtDur(ev.durationMin)}
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      {ev.stillOffline ? (
                        <span className="opm-pill" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)', fontSize: 10 }}>● OFFLINE</span>
                      ) : (
                        <span className="opm-pill" style={{ background: 'rgba(34,197,94,.10)', color: '#22c55e', border: '1px solid rgba(34,197,94,.20)', fontSize: 10 }}>✓ Reconnected</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px dashed var(--border)', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
          Source: StoreProblemHistory · {bhLabel ? 'events overlapping BH window' : 'offline sessions in selected range'}
        </div>
      </div>
    </div>
  )
}

function SeverityFilter({ counts, selected, onSelect }) {
  if (!counts) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {SEV_ORDER.map((k) => {
        const n = Number(counts[k]) || 0
        const active = selected === k
        return (
          <button key={k} type="button" onClick={() => onSelect?.(active ? null : k)}
            style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600,
              border: active ? `1px solid ${SEV_COLORS[k]}` : '1px solid var(--border)',
              background: active ? `${SEV_COLORS[k]}18` : 'transparent',
              color: active ? SEV_COLORS[k] : 'var(--text3)', cursor: 'pointer', transition: 'all .15s',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: SEV_COLORS[k] }} />
            {SEV_LABELS[k]} <span style={{ opacity: .6 }}>({n})</span>
          </button>
        )
      })}
      {selected != null && (
        <button type="button" onClick={() => onSelect?.(null)}
          style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)', border: '1px solid var(--border)', background: 'var(--bg4)', color: 'var(--cyan)', cursor: 'pointer' }}>
          Clear
        </button>
      )}
    </div>
  )
}

/** DataTable: set `stopRowClick: true` on a column to prevent row onRowClick. */
function DataTable({ columns, rows, empty, rowKey, onRowClick }) {
  const storageKey = `infra-${columns.map((c) => c.key).join('-')}`
  const defaults = columns.map(() => 128)
  const { widths, startResize, sumWidth } = useResizableColumns(storageKey, defaults)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)', tableLayout: 'fixed', minWidth: sumWidth }}>
        <ResizableColGroup widths={widths} />
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {columns.map((col, i) => (
              <ResizableTh key={col.key} columnIndex={i} columnCount={columns.length} startResize={startResize}
                style={{ padding: '10px 14px', fontWeight: 700, borderBottom: '1px solid var(--border)', color: 'var(--text3)', textAlign: 'left', fontSize: 10, letterSpacing: .5, textTransform: 'uppercase' }}>
                {col.label}
              </ResizableTh>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ color: 'var(--text3)', padding: '20px 14px' }}>{empty}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={rowKey(row, i)} className={onRowClick ? 'opm-row-hover' : ''}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{ borderBottom: '1px solid var(--border)', cursor: onRowClick ? 'pointer' : 'default' }}>
              {columns.map((col) => (
                <td key={col.key} style={{ padding: '10px 14px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  onClick={col.stopRowClick ? (ev) => ev.stopPropagation() : undefined}>{col.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─── Graph panel (OpManager style) ─── */
function GraphPanel({ graph, series, chartData, chartOpts, busy, graphDataMode, apiBase = '/api/zabbix' }) {
  const name = graph?.name || series?.graph?.name || 'Graph'
  const isLatest = series?.displayMode === 'latest'
  const latestItems = isLatest ? (series?.latest || []) : []
  const hasLatestItems = latestItems.some((r) => r.numeric || r.rawValue != null)
  return (
    <div className="opm-widget" style={{ animation: 'fadeIn .25s ease' }}>
      <div className="opm-widget-hd">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)' }} />
          <span className="opm-widget-title" style={{ textTransform: 'none', fontSize: 13, letterSpacing: 0 }}>{name}</span>
          {series?.aggregated && !isLatest && <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: '#3b82f6' }}>Trend</span>}
          {isLatest && <span className="opm-pill" style={{ background: 'rgba(6,182,212,.1)', color: '#06b6d4' }}>Live</span>}
        </div>
      </div>
      <div style={{ padding: 16 }}>
        {busy && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', padding: '50px 0', justifyContent: 'center' }}><span className="np-page-loading-dot" style={{ width: 16, height: 16 }} />Loading graph data…</div>}
        {!busy && series?.unsupported && <p style={{ margin: 0, color: 'var(--amber)', fontSize: 13 }}>{series.unsupported}</p>}
        {!busy && chartData && <div style={{ height: 360, position: 'relative' }}><Line data={chartData} options={chartOpts} /></div>}
        {!busy && isLatest && hasLatestItems && (
          <LatestMetricsView latestData={{ latest: latestItems }} chartOpts={chartOpts} apiBase={apiBase} />
        )}
        {!busy && series && !series.unsupported && !chartData && !hasLatestItems && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)', padding: '30px 0', textAlign: 'center' }}>
            {isLatest || graphDataMode === 'latest' ? 'No current values for this graph.' : 'No data in the selected time range.'}
          </p>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function StoreZabbixPage({
  apiBase = '/api/store-zabbix',
  pageTitle = 'Store Zabbix',
  connectedLabel = 'Connected to Store Zabbix',
  urlEnvVar = 'STORE_ZABBIX_URL',
  tokenEnvVar = 'STORE_ZABBIX_API_TOKEN',
  loadingLabel = 'Loading store infrastructure data…',
} = {}) {
  const [tab, setTab] = useUrlTab('overview', INFRA_TAB_IDS)
  const [config, setConfig] = useState(null)
  const [overview, setOverview] = useState(null)
  const [hosts, setHosts] = useState(null)
  const [problemsFull, setProblemsFull] = useState(null)
  const [events, setEvents] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tabBusy, setTabBusy] = useState(false)
  const [error, setError] = useState(null)
  const [errorHint, setErrorHint] = useState(null)
  const [hostSearch, setHostSearch] = useState('')
  const [inventorySearch, setInventorySearch] = useState('')
  const [hostsExplorer, setHostsExplorer] = useState(null)
  const [explorerBusy, setExplorerBusy] = useState(false)
  const [selectedHost, setSelectedHost] = useState(null)
  const [hostGraphs, setHostGraphs] = useState(null)
  const [graphsBusy, setGraphsBusy] = useState(false)
  const [selectedGraphId, setSelectedGraphId] = useState(null)
  const [graphSeries, setGraphSeries] = useState(null)
  const [graphRange, setGraphRange] = useState('12h')
  const [graphCustomRange, setGraphCustomRange] = useState(null)
  const [graphCustomFrom, setGraphCustomFrom] = useState('')
  const [graphCustomTo, setGraphCustomTo] = useState('')
  const [severityFilter, setSeverityFilter] = useState(null)
  const [graphSeriesBusy, setGraphSeriesBusy] = useState(false)
  const [graphDataMode, setGraphDataMode] = useState('auto')
  const [hostItemsLatest, setHostItemsLatest] = useState(null)
  const [itemsLatestBusy, setItemsLatestBusy] = useState(false)
  const [hostViewMode, setHostViewMode] = useState('latest')
  const [eventLimit, setEventLimit] = useState(500)
  const [groupFilter, setGroupFilter] = useState('') // active group filter for Snapshot tab
  const [dashboardGroupFilter, setDashboardGroupFilter] = useState('')
  const [dashboardSearch, setDashboardSearch] = useState('')
  const [inventoryGroupFilter, setInventoryGroupFilter] = useState('')
  /** '' = all, or Zabbix availability label: Available | Unavailable | Unknown */
  const [inventoryAvailFilter, setInventoryAvailFilter] = useState('')
  const [topUtil, setTopUtil] = useState(null)
  const [topUtilBusy, setTopUtilBusy] = useState(false)
  const [topLimit, setTopLimit] = useState(10)
  const [topMonGroup, setTopMonGroup] = useState('')
  const [customTopWidgets, setCustomTopWidgets] = useState(() => loadCustomTopWidgets('/api/zabbix'))
  const [customTopData, setCustomTopData] = useState({})
  const [topMonAddOpen, setTopMonAddOpen] = useState(false)
  const [topMonEditWidget, setTopMonEditWidget] = useState(null)
  const [topMonLayoutOpen, setTopMonLayoutOpen] = useState(false)
  const [hiddenTopWidgets, setHiddenTopWidgets] = useState(() => loadHiddenTopWidgets('/api/zabbix'))
  const [overviewBusy, setOverviewBusy] = useState(false)
  const [problemAckBusy, setProblemAckBusy] = useState(null)

  /* ── Network Health tab state ── */
  const [netHealth, setNetHealth] = useState(null)
  const [netHealthBusy, setNetHealthBusy] = useState(false)
  const [netHealthGroup, setNetHealthGroup] = useState('')
  const [netBizStart, setNetBizStart] = useState(9)
  const [netBizEnd, setNetBizEnd] = useState(18)
  const [netConnFilter, setNetConnFilter] = useState('all')
  const [netSearch, setNetSearch] = useState('')
  const hostListRef = useRef(null)
  const nhPktRef = useRef(null)
  const nhLatRef = useRef(null)

  /* ── ROP Dashboard tab state ── */
  const [ropUptime, setRopUptime] = useState(null)
  const [ropUptimeBusy, setRopUptimeBusy] = useState(false)
  const [ropRange, setRopRange] = useState('7d')
  const [ropCustomFrom, setRopCustomFrom] = useState('')
  const [ropCustomTo, setRopCustomTo] = useState('')
  const [ropCustomEpoch, setRopCustomEpoch] = useState(null)
  const [ropGroupKey, setRopGroupKey] = useState('rp')
  const [ropBhStart, setRopBhStart] = useState(9)
  const [ropBhEnd, setRopBhEnd] = useState(18)
  const [ropBhDays, setRopBhDays] = useState(() => new Set([0, 1, 2, 3, 4, 5, 6]))
  const [ropSla, setRopSla] = useState(99.5)
  const [ropSearch, setRopSearch] = useState('')
  const [ropSortKey, setRopSortKey] = useState('uptimePct')
  const [ropSortDir, setRopSortDir] = useState('asc')
  const [ropOutageFilter, setRopOutageFilter] = useState(null)
  const ropStoreTableRef = useRef(null)
  const manualCodesInitRef = useRef(false)
  const [manualRopCodesText, setManualRopCodesText] = useState('')
  const [manualRopCodesOpen, setManualRopCodesOpen] = useState(false)
  const [manualRopCodesSaving, setManualRopCodesSaving] = useState(false)
  const [manualRopCodesSaved, setManualRopCodesSaved] = useState(false)
  const [manualRopCodesUpdatedAt, setManualRopCodesUpdatedAt] = useState(null)
  const [manualRopCodesDraft, setManualRopCodesDraft] = useState('')
  const [ropDisconnectStore, setRopDisconnectStore] = useState(null)
  const [ropDisconnectEvents, setRopDisconnectEvents] = useState([])
  const [ropDisconnectBusy, setRopDisconnectBusy] = useState(false)
  const [ropDisconnectError, setRopDisconnectError] = useState(null)
  const [ropExportBusy, setRopExportBusy] = useState(false)

  const ropDisconnectRangeLabel = useMemo(() => {
    if (ropRange === 'custom' && ropCustomEpoch?.from && ropCustomEpoch?.to) {
      const from = new Date(ropCustomEpoch.from).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const to = new Date(ropCustomEpoch.to).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      return `${from} – ${to}`
    }
    const labels = { '24h': 'Last 24h', '7d': 'Last 7 days', '14d': 'Last 14 days', '30d': 'Last 30 days' }
    return labels[ropRange] || ropRange
  }, [ropRange, ropCustomEpoch])

  const ropBhLabel = useMemo(() => {
    const dayList = [...(ropBhDays || [])].sort((a, b) => a - b)
    const allDays = dayList.length === 7
    const weekdays = dayList.length === 5 && [1,2,3,4,5].every((d) => ropBhDays.has(d))
    const dayShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    const dayLabel = allDays ? 'Every day' : weekdays ? 'Mon–Fri' : dayList.map((d) => dayShort[d]).join(', ')
    const start = String(ropBhStart ?? 9).padStart(2, '0')
    const end = String(ropBhEnd ?? 18).padStart(2, '0')
    return `${start}:00–${end}:00 · ${dayLabel}`
  }, [ropBhStart, ropBhEnd, ropBhDays])

  const openRopDisconnect = useCallback((s) => {
    setRopDisconnectStore({ storeTag: s.storeTag, hostname: s.hostname || s.storeTag })
  }, [])

  /* ─── data loaders (unchanged logic) ─── */
  const parseErr = useCallback((e) => {
    const d = e.response?.data
    const msg = d?.error || d?.hint || e.message || 'Failed to load Zabbix'
    const hints = [d?.hint, d?.code && `code: ${d.code}`, d?.zabbixCode != null && `zabbix: ${d.zabbixCode}`].filter(Boolean)
    return { message: typeof msg === 'string' ? msg : JSON.stringify(msg), hint: hints.length ? hints.join(' · ') : null }
  }, [])
  const loadOverview = useCallback(async () => {
    const qs = new URLSearchParams()
    if (dashboardGroupFilter) qs.set('group', dashboardGroupFilter)
    if (dashboardSearch.trim()) qs.set('q', dashboardSearch.trim())
    const suf = qs.toString() ? `?${qs}` : ''
    setOverviewBusy(true)
    try {
      const { data: ov } = await api.get(`${apiBase}/overview${suf}`)
      setOverview(ov)
    } finally {
      setOverviewBusy(false)
    }
  }, [apiBase, dashboardGroupFilter, dashboardSearch])
  const loadHosts = useCallback(async () => { const { data } = await api.get(`${apiBase}/hosts?limit=10000`); setHosts(data.hosts || []) }, [apiBase])
  const loadAllHosts = useCallback(async () => {
    const { data } = await api.get(`${apiBase}/hosts?limit=10000`)
    setHostsExplorer(data.hosts || [])
  }, [apiBase])
  const loadHostGraphs = useCallback(async (hostid) => { const { data } = await api.get(`${apiBase}/hosts/${encodeURIComponent(hostid)}/graphs`); const g = data.graphs || []; setHostGraphs(g); return g }, [apiBase])
  const loadHostItemsLatest = useCallback(async (hostid) => {
    setItemsLatestBusy(true); setError(null); setErrorHint(null)
    try { const { data } = await api.get(`${apiBase}/hosts/${encodeURIComponent(hostid)}/items/latest?limit=100`); setHostItemsLatest(data) }
    catch (e) { const { message, hint } = parseErr(e); setError(message); setErrorHint(hint); setHostItemsLatest(null) }
    finally { setItemsLatestBusy(false) }
  }, [apiBase, parseErr])
  const fetchGraphSeries = useCallback(async (graphId, rangeKey, dataMode, customRange) => {
    let from, to
    if (customRange?.from && customRange?.to) {
      from = customRange.from; to = customRange.to
    } else {
      const sec = RANGE_SEC[rangeKey] || RANGE_SEC['12h']; to = Math.floor(Date.now() / 1000); from = to - sec
    }
    const qs = new URLSearchParams({ from: String(from), to: String(to) })
    if (dataMode === 'latest') qs.set('mode', 'latest')
    const { data } = await api.get(`${apiBase}/graphs/${encodeURIComponent(graphId)}/series?${qs}`); return data
  }, [apiBase])
  const loadEvents = useCallback(async (lim) => { const { data } = await api.get(`${apiBase}/events?limit=${lim || eventLimit}`); setEvents(data.events || []) }, [apiBase, eventLimit])
  const loadTopUtil = useCallback(async (lim, group) => {
    const qs = new URLSearchParams({ limit: String(lim || topLimit) })
    const g = group ?? topMonGroup
    if (g) qs.set('group', g)
    const { data } = await api.get(`${apiBase}/top-utilization?${qs}`)
    setTopUtil(data)
    const widgets = loadCustomTopWidgets(apiBase)
    if (widgets.length) {
      const pairs = await Promise.all(widgets.map(async (w) => {
        try {
          const wqs = new URLSearchParams({ key: w.keyPattern, limit: String(lim || topLimit), sort: w.sort || 'desc' })
          if (g) wqs.set('group', g)
          const { data: d } = await api.get(`${apiBase}/top-items?${wqs}`)
          return [w.id, d.rows || []]
        } catch {
          return [w.id, []]
        }
      }))
      setCustomTopData(Object.fromEntries(pairs))
    } else {
      setCustomTopData({})
    }
  }, [apiBase, topLimit, topMonGroup])

  useEffect(() => {
    setCustomTopWidgets(loadCustomTopWidgets(apiBase))
    setHiddenTopWidgets(loadHiddenTopWidgets(apiBase))
  }, [apiBase])

  const persistHiddenTopWidgets = useCallback((ids) => {
    setHiddenTopWidgets(ids)
    saveHiddenTopWidgets(apiBase, ids)
  }, [apiBase])

  const persistCustomTopWidgets = useCallback((next) => {
    setCustomTopWidgets(next)
    saveCustomTopWidgets(apiBase, next)
  }, [apiBase])

  const addCustomTopWidget = useCallback((widget) => {
    persistCustomTopWidgets([...customTopWidgets, widget])
  }, [customTopWidgets, persistCustomTopWidgets])

  const updateCustomTopWidget = useCallback((widget) => {
    persistCustomTopWidgets(customTopWidgets.map((w) => (w.id === widget.id ? widget : w)))
  }, [customTopWidgets, persistCustomTopWidgets])

  const removeCustomTopWidget = useCallback((id) => {
    persistCustomTopWidgets(customTopWidgets.filter((w) => w.id !== id))
    setCustomTopData((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [customTopWidgets, persistCustomTopWidgets])

  const loadNetHealth = useCallback(async (group, bizStart, bizEnd) => {
    const qs = new URLSearchParams()
    if (group) qs.set('group', group)
    if (bizStart != null) qs.set('bizStart', bizStart)
    if (bizEnd != null)   qs.set('bizEnd', bizEnd)
    setNetHealthBusy(true); setError(null); setErrorHint(null)
    try {
      const { data } = await api.get(`${apiBase}/network-health?${qs}`)
      setNetHealth(data)
    } catch (e) {
      const { message, hint } = parseErr(e); setError(message); setErrorHint(hint)
    } finally {
      setNetHealthBusy(false)
    }
  }, [apiBase, parseErr])

  const loadRopUptime = useCallback(async ({ range, customEpoch, groupKey, bhStart, bhEnd, bhDays, sla }) => {
    const qs = new URLSearchParams()
    qs.set('range', range || '7d')
    if (range === 'custom' && customEpoch?.from && customEpoch?.to) {
      qs.set('from', String(Math.floor(new Date(customEpoch.from).getTime() / 1000)))
      qs.set('to',   String(Math.floor(new Date(customEpoch.to).getTime() / 1000)))
    }
    qs.set('groupKey', groupKey || 'rp')
    qs.set('bizStart', String(bhStart ?? 9))
    qs.set('bizEnd',   String(bhEnd ?? 18))
    qs.set('bizDays',  [...(bhDays || [0,1,2,3,4,5,6])].sort((a,b)=>a-b).join(','))
    qs.set('sla',      String(sla ?? 99.5))
    qs.set('tzOffset', String(-new Date().getTimezoneOffset()))
    setRopUptimeBusy(true); setError(null); setErrorHint(null)
    try {
      const { data } = await api.get(`${apiBase}/rop-uptime?${qs}`)
      setRopUptime(data)
    } catch (e) {
      const { message, hint } = parseErr(e); setError(message); setErrorHint(hint)
    } finally {
      setRopUptimeBusy(false)
    }
  }, [apiBase, parseErr])

  const exportRopDisconnectExcel = useCallback(async () => {
    if (ropRange === 'custom' && !ropCustomEpoch) return
    const qs = new URLSearchParams()
    qs.set('range', ropRange || '7d')
    if (ropRange === 'custom' && ropCustomEpoch?.from && ropCustomEpoch?.to) {
      qs.set('from', String(Math.floor(new Date(ropCustomEpoch.from).getTime() / 1000)))
      qs.set('to',   String(Math.floor(new Date(ropCustomEpoch.to).getTime() / 1000)))
    }
    qs.set('groupKey', ropGroupKey || 'rp')
    qs.set('bizStart', String(ropBhStart ?? 9))
    qs.set('bizEnd',   String(ropBhEnd ?? 18))
    qs.set('bizDays',  [...(ropBhDays || [0,1,2,3,4,5,6])].sort((a,b)=>a-b).join(','))
    qs.set('tzOffset', String(-new Date().getTimezoneOffset()))
    setRopExportBusy(true)
    setError(null)
    setErrorHint(null)
    try {
      const res = await api.get(`${apiBase}/rop-disconnect-export?${qs}`, {
        responseType: 'blob',
        timeout: 300000,
      })
      const ct = String(res.headers['content-type'] || '')
      const disposition = String(res.headers['content-disposition'] || '')
      if (!/attachment/i.test(disposition) && ct.includes('application/json')) {
        const text = await res.data.text()
        let msg = 'Export failed'
        try { msg = JSON.parse(text)?.error || msg } catch { /* ignore */ }
        throw new Error(msg)
      }
      const match = disposition.match(/filename="?([^"]+)"?/)
      const safeGroup = String(ropGroupKey || 'rp').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)
      const filename = match?.[1] || `ROP_Disconnect_Events_${safeGroup}_${new Date().toISOString().slice(0, 10)}.xlsx`
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      let msg = e.message || 'Export failed'
      const blob = e.response?.data
      if (blob instanceof Blob) {
        try {
          const text = await blob.text()
          msg = JSON.parse(text)?.error || msg
        } catch { /* ignore */ }
      }
      setError(msg)
      setErrorHint(null)
    } finally {
      setRopExportBusy(false)
    }
  }, [apiBase, ropRange, ropCustomEpoch, ropGroupKey, ropBhStart, ropBhEnd, ropBhDays])

  const refetchProblems = useCallback(async () => {
    const qs = new URLSearchParams({ limit: '250' })
    if (severityFilter != null) qs.set('severity', String(severityFilter))
    const { data } = await api.get(`${apiBase}/problems?${qs}`)
    setProblemsFull(data.problems || [])
  }, [apiBase, severityFilter])

  const loadConfigAndOverview = useCallback(async () => {
    setError(null); setErrorHint(null)
    try {
      const { data: cfg } = await api.get(`${apiBase}/config`, { timeout: 20000 })
      setConfig(cfg)
      if (!cfg.configured) {
        setOverview(null)
        return
      }
      if (cfg.reachable === false) {
        setOverview(null)
        const probe = cfg.probe || {}
        const timedOut = probe.code === 'ZABBIX_TIMEOUT' || /timeout|aborted/i.test(String(probe.message || ''))
        setError(probe.message || 'Zabbix is configured but unreachable from the Netpulse server')
        setErrorHint(
          timedOut
            ? `${probe.hint || ''} URL looks set (${cfg.zabbixUrl || urlEnvVar}). Your PC can reach Zabbix, but the Netpulse Docker container cannot route to that LAN/VPN IP. Run the API on the host (cd server && npm run dev) or use host.docker.internal with a Windows port forward — see server/.env.example.`
            : (probe.hint || `Check ${urlEnvVar} in server .env — use http://172.20.11.197/zabbix/api_jsonrpc.php`)
        )
      }
    } catch (e) {
      const { message, hint } = parseErr(e); setError(message); setErrorHint(hint); setOverview(null)
    }
  }, [apiBase, parseErr, urlEnvVar])

  const loadTabData = useCallback(async (t) => {
    if (!config?.configured) return; setTabBusy(true); setError(null); setErrorHint(null)
    try { if (t === 'hosts') await loadHosts(); else if (t === 'events') await loadEvents(); else if (t === 'hostGraphs' && hostsExplorer === null) await loadAllHosts() }
    catch (e) { const { message, hint } = parseErr(e); setError(message); setErrorHint(hint) }
    finally { setTabBusy(false) }
  }, [config?.configured, loadHosts, loadEvents, parseErr, hostsExplorer, loadAllHosts])

  /* ─── effects ─── */
  useEffect(() => {
    let c = false
    ;(async () => { setLoading(true); await loadConfigAndOverview(); if (!c) setLoading(false) })()
    return () => { c = true }
  }, [loadConfigAndOverview])

  useEffect(() => {
    if (!config?.configured || config.reachable === false || tab !== 'overview') return
    let cancelled = false
    loadOverview()
      .catch((e) => {
        if (cancelled) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint)
      })
    return () => { cancelled = true }
  }, [config?.configured, config?.reachable, tab, dashboardGroupFilter, dashboardSearch, loadOverview, parseErr])

  // Background refresh of Zabbix config + overview. useSmartPolling pauses when the
  // tab is hidden (no point polling Zabbix while the user is on another browser tab).
  // skipImmediate — config and overview already load via dedicated effects on mount/tab-change.
  const infraRefresh = useCallback(async () => {
    try { await loadConfigAndOverview() } catch { /* ignore */ }
    if (tab === 'overview' && config?.reachable !== false) {
      try { await loadOverview() } catch { /* ignore */ }
    }
  }, [loadConfigAndOverview, loadOverview, tab, config?.reachable])
  useSmartPolling(
    infraRefresh,
    60_000,
    [infraRefresh],
    { enabled: !!config?.configured && config?.reachable !== false, skipImmediate: true },
  )

  useEffect(() => {
    if (!config?.configured || tab === 'overview') return
    if (tab === 'hosts' && hosts === null) loadTabData('hosts')
    if (tab === 'hostGraphs' && hostsExplorer === null) loadTabData('hostGraphs')
  }, [tab, config?.configured, hosts, hostsExplorer, loadTabData])

  useEffect(() => {
    if (!config?.configured || tab !== 'events') return; let c = false; setTabBusy(true); setError(null); setErrorHint(null)
    api.get(`${apiBase}/events?limit=${eventLimit}`)
      .then(({ data }) => { if (!c) setEvents(data.events || []) })
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setEvents([]) })
      .finally(() => { if (!c) setTabBusy(false) })
    return () => { c = true }
  }, [tab, config?.configured, eventLimit, parseErr, apiBase])

  useEffect(() => {
    if (!config?.configured || tab !== 'problems') return; let c = false; setTabBusy(true); setError(null); setErrorHint(null)
    refetchProblems()
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setProblemsFull([]) })
      .finally(() => { if (!c) setTabBusy(false) })
    return () => { c = true }
  }, [tab, config?.configured, severityFilter, parseErr, refetchProblems])

  useEffect(() => {
    if (tab !== 'hostGraphs' || !config?.configured || hostsExplorer !== null) return
    setExplorerBusy(true); setError(null); setErrorHint(null)
    loadAllHosts().catch((e) => { const r = parseErr(e); setError(r.message); setErrorHint(r.hint) }).finally(() => setExplorerBusy(false))
  }, [tab, config?.configured, hostsExplorer, loadAllHosts, parseErr])

  useEffect(() => {
    if (tab !== 'topMon' || !config?.configured) return
    let c = false; setTopUtilBusy(true); setError(null); setErrorHint(null)
    loadTopUtil(topLimit)
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setTopUtil(null) })
      .finally(() => { if (!c) setTopUtilBusy(false) })
    return () => { c = true }
  }, [tab, config?.configured, topLimit, topMonGroup, loadTopUtil, parseErr])

  useEffect(() => {
    if (tab !== 'netHealth' || !config?.configured) return
    loadNetHealth(netHealthGroup, netBizStart, netBizEnd)
  }, [tab, config?.configured, netHealthGroup, netBizStart, netBizEnd, loadNetHealth])

  useSmartPolling(
    () => loadNetHealth(netHealthGroup, netBizStart, netBizEnd),
    120_000,
    [netHealthGroup, netBizStart, netBizEnd, loadNetHealth],
    { enabled: tab === 'netHealth' && !!config?.configured && config?.reachable !== false, skipImmediate: true },
  )

  useEffect(() => {
    if (tab !== 'rop' || manualCodesInitRef.current) return
    manualCodesInitRef.current = true
    api.get('/api/store-monitor/settings')
      .then(({ data }) => {
        const raw = data?.manualRopSdwanCodes ?? ''
        setManualRopCodesText(raw)
        setManualRopCodesDraft(raw)
        setManualRopCodesUpdatedAt(data?.updatedAt ?? null)
      })
      .catch(() => {})
  }, [tab])

  useEffect(() => {
    if (!isRpGroupKey(ropGroupKey)) setRopOutageFilter(null)
  }, [ropGroupKey])

  useEffect(() => {
    if (!ropDisconnectStore) {
      setRopDisconnectEvents([])
      setRopDisconnectError(null)
      return
    }
    let cancelled = false
    const qs = new URLSearchParams()
    qs.set('storeTag', ropDisconnectStore.storeTag)
    qs.set('range', ropRange || '7d')
    if (ropRange === 'custom' && ropCustomEpoch?.from && ropCustomEpoch?.to) {
      qs.set('from', String(Math.floor(new Date(ropCustomEpoch.from).getTime() / 1000)))
      qs.set('to', String(Math.floor(new Date(ropCustomEpoch.to).getTime() / 1000)))
    }
    qs.set('bizStart', String(ropBhStart ?? 9))
    qs.set('bizEnd',   String(ropBhEnd ?? 18))
    qs.set('bizDays',  [...(ropBhDays || [0,1,2,3,4,5,6])].sort((a,b)=>a-b).join(','))
    qs.set('tzOffset', String(-new Date().getTimezoneOffset()))
    setRopDisconnectBusy(true)
    setRopDisconnectError(null)
    api.get(`${apiBase}/rop-store-disconnects?${qs}`)
      .then(({ data }) => { if (!cancelled) setRopDisconnectEvents(data.events || []) })
      .catch((e) => {
        if (cancelled) return
        const { message } = parseErr(e)
        setRopDisconnectError(message)
        setRopDisconnectEvents([])
      })
      .finally(() => { if (!cancelled) setRopDisconnectBusy(false) })
    return () => { cancelled = true }
  }, [ropDisconnectStore, ropRange, ropCustomEpoch, ropBhStart, ropBhEnd, ropBhDays, apiBase, parseErr])

  useEffect(() => {
    if (tab !== 'rop' || !config?.configured) return
    if (ropRange === 'custom' && !ropCustomEpoch) return
    loadRopUptime({
      range: ropRange,
      customEpoch: ropCustomEpoch,
      groupKey: ropGroupKey,
      bhStart: ropBhStart,
      bhEnd: ropBhEnd,
      bhDays: ropBhDays,
      sla: ropSla,
    })
  }, [tab, config?.configured, ropRange, ropCustomEpoch, ropGroupKey, ropBhStart, ropBhEnd, ropBhDays, ropSla, loadRopUptime])

  useSmartPolling(
    () => {
      if (ropRange === 'custom' && !ropCustomEpoch) return Promise.resolve()
      return loadRopUptime({
        range: ropRange,
        customEpoch: ropCustomEpoch,
        groupKey: ropGroupKey,
        bhStart: ropBhStart,
        bhEnd: ropBhEnd,
        bhDays: ropBhDays,
        sla: ropSla,
      })
    },
    120_000,
    [ropRange, ropCustomEpoch, ropGroupKey, ropBhStart, ropBhEnd, ropBhDays, ropSla, loadRopUptime],
    { enabled: tab === 'rop' && !!config?.configured && config?.reachable !== false, skipImmediate: true },
  )

  useEffect(() => {
    if (!selectedGraphId || tab !== 'hostGraphs') return; let c = false; setGraphSeriesBusy(true); setError(null); setErrorHint(null)
    fetchGraphSeries(selectedGraphId, graphRange, graphDataMode, graphCustomRange)
      .then((data) => { if (!c) setGraphSeries(data) })
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setGraphSeries(null) })
      .finally(() => { if (!c) setGraphSeriesBusy(false) })
    return () => { c = true }
  }, [graphRange, selectedGraphId, tab, graphDataMode, graphCustomRange, fetchGraphSeries, parseErr])

  /* ─── derived data ─── */
  const chartData = useMemo(() => graphSeries?.series?.length ? buildAlignedChart(graphSeries) : null, [graphSeries])
  const noGraphHost = Boolean(selectedHost && hostGraphs?.length === 0 && !graphsBusy)

  const scoreHosts = useCallback((list, q) => {
    if (!q) return list
    const scored = list.map((h) => {
      const fields = [h.name, h.host, h.ip, h.dns, ...(h.groups || [])].map((f) => (f || '').toLowerCase())
      let score = 0
      for (const f of fields) {
        if (f === q) { score += 100; break }
        if (f.startsWith(q)) { score = Math.max(score, 60) }
        else if (f.includes(q)) { score = Math.max(score, 40) }
      }
      const words = q.split(/[\s._-]+/).filter(Boolean)
      if (words.length > 1) {
        const all = words.every((w) => fields.some((f) => f.includes(w)))
        if (all) score = Math.max(score, 50)
      }
      return { h, score }
    }).filter((s) => s.score > 0)
    scored.sort((a, b) => b.score - a.score || (a.h.name || a.h.host).localeCompare(b.h.name || b.h.host))
    return scored.map((s) => s.h)
  }, [])

  const filteredHosts = useMemo(() => {
    const base = (hostsExplorer || []).filter((h) => !groupFilter || (h.groups || []).includes(groupFilter))
    return scoreHosts(base, (hostSearch || '').trim().toLowerCase())
  }, [hostsExplorer, hostSearch, groupFilter, scoreHosts])
  const availableInventoryGroups = useMemo(() => {
    const set = new Set()
    for (const h of hosts || []) for (const g of h.groups || []) if (g) set.add(g)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [hosts])
  const inventoryAvailCounts = useMemo(() => {
    const h = hosts || []
    return {
      all: h.length,
      Available: h.filter((x) => x.availability === 'Available').length,
      Unavailable: h.filter((x) => x.availability === 'Unavailable').length,
      Unknown: h.filter((x) => x.availability === 'Unknown').length,
    }
  }, [hosts])
  const filteredInventory = useMemo(() => {
    let base = hosts || []
    if (inventoryGroupFilter) base = base.filter((h) => (h.groups || []).includes(inventoryGroupFilter))
    if (inventoryAvailFilter) base = base.filter((h) => h.availability === inventoryAvailFilter)
    return scoreHosts(base, (inventorySearch || '').trim().toLowerCase())
  }, [hosts, inventorySearch, inventoryGroupFilter, inventoryAvailFilter, scoreHosts])
  const availableGroups = useMemo(() => {
    const set = new Set()
    for (const h of hostsExplorer || []) for (const g of h.groups || []) if (g) set.add(g)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [hostsExplorer])
  const ovProblemsFiltered = useMemo(() => { const l = overview?.problems || []; return severityFilter == null ? l : l.filter((p) => Number(p.severity) === Number(severityFilter)) }, [overview?.problems, severityFilter])

  const theme = useThemeStore((s) => s.theme)
  const tc = useMemo(() => getThemeCssColors(), [theme])

  const chartOpts = useMemo(() => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 600, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { color: tc.text2, font: { size: 11 }, boxWidth: 14, padding: 14, usePointStyle: true, pointStyle: 'circle' } },
      tooltip: { titleColor: '#fff', bodyColor: '#e5e7eb', backgroundColor: 'rgba(15,17,23,.95)', borderColor: 'rgba(59,130,246,.3)', borderWidth: 1, cornerRadius: 8, padding: 12, titleFont: { weight: '600', size: 12 }, bodyFont: { size: 11 }, displayColors: true, boxWidth: 8, boxHeight: 8, boxPadding: 4 },
    },
    scales: {
      x: { ticks: { color: tc.text3, maxRotation: 45, font: { size: 9 }, maxTicksLimit: 14 }, grid: { color: 'rgba(128,128,160,.05)' } },
      y: { ticks: { color: tc.text3, font: { size: 10 }, padding: 8 }, grid: { color: 'rgba(128,128,160,.07)' }, beginAtZero: false, grace: '10%' },
    },
  }), [tc])

  const barOpts = useMemo(() => ({
    indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15,17,23,.95)', borderColor: 'rgba(59,130,246,.3)', borderWidth: 1, cornerRadius: 8, padding: 10 } },
    scales: { x: { ticks: { color: tc.text3, font: { size: 10 } }, grid: { color: 'rgba(128,128,160,.05)' } }, y: { ticks: { color: tc.text2, font: { size: 9 }, autoSkip: false }, grid: { display: false } } },
  }), [tc])

  const configured = config?.configured
  const reachable = config?.reachable !== false

  /* Navigate to Host & Graphs tab */
  const goToHostGraphs = useCallback(async (host, opts = {}) => {
    setTab('hostGraphs')
    if (opts.group !== undefined) setGroupFilter(opts.group || '')
    if (host) {
      setSelectedHost(host); setGraphDataMode('auto'); setSelectedGraphId(null); setGraphSeries(null); setHostItemsLatest(null); setGraphsBusy(true); setError(null); setErrorHint(null); setHostViewMode('latest')
      try {
        if (hostsExplorer === null) await loadAllHosts()
        await loadHostItemsLatest(host.hostid)
        const g = await loadHostGraphs(host.hostid); if (g.length) setSelectedGraphId(g[0].graphid)
      }
      catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setHostGraphs(null); setHostItemsLatest(null) }
      finally { setGraphsBusy(false) }
    } else {
      // No host: just open Snapshot tab (group filter applied via opts.group)
      if (hostsExplorer === null) {
        setExplorerBusy(true)
        loadAllHosts().catch(() => {}).finally(() => setExplorerBusy(false))
      }
    }
  }, [hostsExplorer, loadAllHosts, loadHostGraphs, loadHostItemsLatest, parseErr])

  /* Navigate to Snapshot tab with a group filter (no host preselected) */
  const goToGroup = useCallback((groupName) => {
    setTab('hostGraphs')
    setGroupFilter(groupName || '')
    setSelectedHost(null); setSelectedGraphId(null); setGraphSeries(null); setHostItemsLatest(null); setHostGraphs(null)
    if (hostsExplorer === null) {
      setExplorerBusy(true)
      loadAllHosts().catch(() => {}).finally(() => setExplorerBusy(false))
    }
  }, [hostsExplorer, loadAllHosts])

  const pickHost = useCallback(async (h) => {
    setSelectedHost(h); setGraphDataMode('auto'); setSelectedGraphId(null); setGraphSeries(null); setHostItemsLatest(null); setGraphsBusy(true); setError(null); setErrorHint(null); setHostViewMode('latest')
    try {
      await loadHostItemsLatest(h.hostid)
      const g = await loadHostGraphs(h.hostid); if (g.length) setSelectedGraphId(g[0].graphid)
    }
    catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setHostGraphs(null); setHostItemsLatest(null) }
    finally { setGraphsBusy(false) }
  }, [loadHostGraphs, loadHostItemsLatest, parseErr])

  const switchHostView = useCallback(async (mode) => {
    setHostViewMode(mode)
    if (mode === 'latest' && selectedHost?.hostid && hostItemsLatest === null && !itemsLatestBusy) {
      await loadHostItemsLatest(selectedHost.hostid)
    }
  }, [selectedHost, hostItemsLatest, itemsLatestBusy, loadHostItemsLatest])

  const pickGraph = useCallback((gid) => { setSelectedGraphId(gid); setGraphSeries(null) }, [])

  const pickGraphRange = useCallback((r) => { setGraphRange(r); setGraphCustomRange(null) }, [])
  const applyGraphCustomRange = useCallback(() => {
    if (!graphCustomFrom || !graphCustomTo) return
    const fromTs = Math.floor(new Date(graphCustomFrom).getTime() / 1000)
    const toTs = Math.floor(new Date(graphCustomTo).getTime() / 1000)
    if (isNaN(fromTs) || isNaN(toTs) || fromTs >= toTs) return
    setGraphCustomRange({ from: fromTs, to: toTs })
  }, [graphCustomFrom, graphCustomTo])

  useEffect(() => {
    if (graphCustomRange || graphCustomFrom) return
    const sec = RANGE_SEC[graphRange] || RANGE_SEC['12h']
    const to = Math.floor(Date.now() / 1000)
    setGraphCustomFrom(toLocalInput(to - sec))
    setGraphCustomTo(toLocalInput(to))
  }, [graphRange, graphCustomRange, graphCustomFrom])

  const acknowledgeProblems = useCallback(async (eventids, { close = false, message = '' } = {}) => {
    if (!eventids?.length) return
    await api.post(`${apiBase}/problems/acknowledge`, { eventids, close, message: message || undefined, acknowledge: true })
  }, [apiBase])

  const runProblemAck = useCallback(async (p, { close }) => {
    setProblemAckBusy(p.eventid)
    setError(null); setErrorHint(null)
    try {
      let message = ''
      if (close) {
        if (!window.confirm('Manually close this problem in Zabbix? The trigger must allow manual close.')) {
          setProblemAckBusy(null); return
        }
        message = window.prompt('Close comment (optional):', '') ?? ''
      } else {
        message = window.prompt('Acknowledgement message (optional):', '') ?? ''
      }
      await acknowledgeProblems([p.eventid], { close, message })
      await loadOverview()
      if (tab === 'problems') await refetchProblems()
    } catch (e) {
      const r = parseErr(e); setError(r.message); setErrorHint(r.hint)
    } finally {
      setProblemAckBusy(null)
    }
  }, [acknowledgeProblems, loadOverview, refetchProblems, tab, parseErr])

  const refresh = useCallback(async () => {
    setLoading(true); setError(null); setErrorHint(null)
    try {
      const { data: cfg } = await api.get(`${apiBase}/config`, { timeout: 20000 }); setConfig(cfg)
      if (!cfg.configured) { setOverview(null); return }
      if (cfg.reachable === false) {
        setOverview(null)
        const probe = cfg.probe || {}
        const timedOut = probe.code === 'ZABBIX_TIMEOUT' || /timeout|aborted/i.test(String(probe.message || ''))
        setError(probe.message || 'Zabbix is configured but unreachable from the Netpulse server')
        setErrorHint(
          timedOut
            ? `${probe.hint || ''} URL looks set (${cfg.zabbixUrl || urlEnvVar}). Docker cannot reach that IP from the container — run server on the host (cd server && npm run dev) or use host.docker.internal with port forward.`
            : (probe.hint || `Check ${urlEnvVar} in server .env.`)
        )
        return
      }
      if (tab === 'overview') await loadOverview()
      if (tab === 'hosts') await loadHosts()
      if (tab === 'problems') await refetchProblems()
      if (tab === 'events') await loadEvents(eventLimit)
      if (tab === 'topMon') await loadTopUtil(topLimit, topMonGroup)
      if (tab === 'netHealth') await loadNetHealth(netHealthGroup, netBizStart, netBizEnd)
      if (tab === 'rop' && (ropRange !== 'custom' || ropCustomEpoch)) await loadRopUptime({
        range: ropRange,
        customEpoch: ropCustomEpoch,
        groupKey: ropGroupKey,
        bhStart: ropBhStart,
        bhEnd: ropBhEnd,
        bhDays: ropBhDays,
        sla: ropSla,
      })
      if (tab === 'hostGraphs') { await loadAllHosts(); if (selectedHost?.hostid) { const g = await loadHostGraphs(selectedHost.hostid); if (!g.length) await loadHostItemsLatest(selectedHost.hostid); else setHostItemsLatest(null); if (selectedGraphId) { const d = await fetchGraphSeries(selectedGraphId, graphRange, graphDataMode); setGraphSeries(d) } } }
    } catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint) }
    finally { setLoading(false) }
  }, [tab, loadOverview, loadHosts, loadEvents, eventLimit, severityFilter, parseErr, selectedHost, selectedGraphId, graphRange, graphDataMode, loadAllHosts, loadHostGraphs, loadHostItemsLatest, fetchGraphSeries, loadTopUtil, topLimit, topMonGroup, refetchProblems, apiBase, urlEnvVar, loadNetHealth, netHealthGroup, netBizStart, netBizEnd, loadRopUptime, ropRange, ropCustomEpoch, ropGroupKey, ropBhStart, ropBhEnd, ropBhDays, ropSla])

  /* ─── column definitions ─── */
  const hostCols = [
    { key: 'status', label: 'Status', render: (h) => {
      const color = h.availability === 'Available' ? '#22c55e' : h.availability === 'Unavailable' ? '#ef4444' : '#64748b'
      return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: h.availability === 'Available' ? '0 0 6px rgba(34,197,94,.5)' : 'none' }} /><span style={{ color, fontSize: 11, fontWeight: 600 }}>{h.availability}</span></span>
    }},
    { key: 'name', label: 'Device Name', render: (h) => <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{h.name || h.host}</span> },
    { key: 'ip', label: 'IP Address', render: (h) => <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11 }}>{h.ip || '—'}</span> },
    { key: 'host', label: 'Technical Name', render: (h) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{h.host}</span> },
    { key: 'groups', label: 'Category', render: (h) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{(h.groups || []).join(', ') || '—'}</span> },
    { key: 'mon', label: 'Monitoring', render: (h) => <span className="opm-pill" style={{ background: h.monitored ? 'rgba(34,197,94,.12)' : 'rgba(234,179,8,.1)', color: h.monitored ? '#22c55e' : '#eab308', border: `1px solid ${h.monitored ? 'rgba(34,197,94,.25)' : 'rgba(234,179,8,.2)'}` }}>{h.monitored ? 'Enabled' : 'Disabled'}</span> },
  ]
  const problemCols = useMemo(() => [
    { key: 'sev', label: 'Severity', render: (p) => <span className="opm-pill" style={{ color: sevColor(p.severity), background: `${sevColor(p.severity)}15`, border: `1px solid ${sevColor(p.severity)}30` }}>{p.severityLabel}</span> },
    { key: 'ackst', label: 'Ack', render: (p) => (
      <span className="opm-pill" style={{ background: p.acknowledged ? 'rgba(34,197,94,.12)' : 'rgba(148,163,184,.1)', color: p.acknowledged ? '#22c55e' : 'var(--text3)', border: `1px solid ${p.acknowledged ? 'rgba(34,197,94,.25)' : 'var(--border)'}` }}>
        {p.acknowledged ? 'Yes' : 'No'}
      </span>
    ) },
    { key: 'name', label: 'Problem', render: (p) => <span style={{ color: 'var(--text)' }}>{p.name}</span> },
    { key: 'hosts', label: 'Affected Device', render: (p) => <span style={{ color: 'var(--text2)', fontSize: 11 }}>{(p.hosts || []).map((h) => h.name || h.host).join(', ') || '—'}</span> },
    { key: 'dur', label: 'Duration', render: (p) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{relAge(p.clock)}</span> },
    { key: 'since', label: 'Since', render: (p) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{fmtClock(p.clock)}</span> },
    { key: 'actions', label: 'Actions', stopRowClick: true, render: (p) => {
      const busy = problemAckBusy === p.eventid
      const btn = { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600, border: '1px solid var(--border)', cursor: busy ? 'wait' : 'pointer', background: 'var(--bg3)', color: 'var(--text2)' }
      return (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
          <button type="button" disabled={busy || p.acknowledged} style={{ ...btn, opacity: p.acknowledged ? .45 : 1 }} onClick={() => runProblemAck(p, { close: false })}>Ack</button>
          <button type="button" disabled={busy} style={{ ...btn, borderColor: 'rgba(239,68,68,.35)', color: '#ef4444' }} onClick={() => runProblemAck(p, { close: true })}>Close</button>
        </div>
      )
    } },
  ], [problemAckBusy, runProblemAck])
  const eventCols = [
    { key: 'status', label: 'Status', render: (ev) => <span className="opm-pill" style={{ background: ev.status === 'PROBLEM' ? 'rgba(239,68,68,.12)' : 'rgba(34,197,94,.1)', color: ev.status === 'PROBLEM' ? '#ef4444' : '#22c55e', border: `1px solid ${ev.status === 'PROBLEM' ? 'rgba(239,68,68,.25)' : 'rgba(34,197,94,.2)'}` }}>{ev.status}</span> },
    { key: 'sev', label: 'Severity', render: (ev) => <span className="opm-pill" style={{ color: sevColor(ev.severity), background: `${sevColor(ev.severity)}15`, border: `1px solid ${sevColor(ev.severity)}30` }}>{ev.severityLabel}</span> },
    { key: 'name', label: 'Event', render: (ev) => <span style={{ color: 'var(--text)' }}>{ev.name || '(unnamed)'}</span> },
    { key: 'hosts', label: 'Device', render: (ev) => <span style={{ color: 'var(--text2)', fontSize: 11 }}>{(ev.hosts || []).map((h) => h.name || h.host).join(', ') || '—'}</span> },
    { key: 'age', label: 'Age', render: (ev) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{relAge(ev.clock)}</span> },
    { key: 'time', label: 'Time', render: (ev) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{fmtClock(ev.clock)}</span> },
    { key: 'ack', label: 'Ack', render: (ev) => <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: ev.acknowledged ? 'rgba(34,197,94,.12)' : 'transparent', border: `1px solid ${ev.acknowledged ? 'rgba(34,197,94,.35)' : 'var(--border)'}` }}>{ev.acknowledged ? <span style={{ color: '#22c55e', fontSize: 10 }}>✓</span> : null}</span> },
  ]

  /* ─── RENDER ─── */
  const avail = overview?.availability
  const healthPct = overview?.healthPercent
  const statusDotColor = !configured ? '#ef4444' : reachable ? '#22c55e' : '#f59e0b'
  const pageSubtitle = !configured
    ? 'Not configured'
    : !reachable
      ? 'Configured — unreachable from server'
      : healthPct != null
        ? `Health ${healthPct}% · ${avail?.available ?? 0}/${avail?.total ?? 0} devices online`
        : connectedLabel
  const tabDefs = [
    { id: 'overview', label: 'Dashboard', icon: '▤' },
    { id: 'hosts', label: 'Inventory', icon: '▦', badge: hosts?.length ?? avail?.total },
    { id: 'hostGraphs', label: 'Device Snapshot', icon: '▣' },
    { id: 'topMon', label: 'Top Monitoring', icon: '★' },
    { id: 'problems', label: 'Alarms', icon: '⚠', badge: overview?.activeProblems },
    { id: 'events', label: 'Events', icon: '◉' },
    { id: 'netHealth', label: 'Network Health', icon: '📶' },
    { id: 'rop', label: 'ROP Dashboard', icon: '🏪', badge: ropUptime?.summary?.totalStores },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 }}>
      <style>{INLINE_CSS}</style>

      {/* ──── Page header ──── */}
      <div className="opm-page-header">
        <div className="opm-page-title">
          <span className="opm-status-dot" style={{ background: statusDotColor }} />
          <div>
            <h1>{pageTitle}</h1>
            <div className="opm-page-subtitle">
              {pageSubtitle}
            </div>
          </div>
        </div>
        <button type="button" onClick={refresh} disabled={loading || tabBusy || overviewBusy} className="opm-refresh-btn">
          <span style={{ display: 'inline-block', animation: loading || tabBusy || overviewBusy ? 'pulse 1s ease-in-out infinite' : 'none' }}>↻</span>
          {loading || tabBusy || overviewBusy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ──── Tab bar ──── */}
      {configured && reachable && (
        <div className="opm-tabs" style={{ marginBottom: 16 }}>
          {tabDefs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`opm-tab ${tab === t.id ? 'active' : ''}`}>
              <span style={{ fontSize: 12, opacity: .9 }}>{t.icon}</span>
              {t.label}
              {t.badge != null && t.badge !== 0 && <span className="opm-tab-badge">{t.badge}</span>}
            </button>
          ))}
        </div>
      )}

      {!configured && !loading && (
        <Widget title="Configuration Required">
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
            Set <code style={{ color: 'var(--cyan)' }}>{urlEnvVar}</code> and <code style={{ color: 'var(--cyan)' }}>{tokenEnvVar}</code> in the server <code style={{ color: 'var(--cyan)' }}>.env</code>, then restart.
          </p>
        </Widget>
      )}

      {error && (
        <Widget title="Error" badge="!" badgeColor="red">
          <p style={{ margin: '0 0 6px', fontSize: 13, color: '#ef4444', fontFamily: 'var(--mono)' }}>{error}</p>
          {errorHint && <p style={{ margin: 0, fontSize: 12, color: 'var(--text2)', fontFamily: 'var(--mono)' }}>{errorHint}</p>}
        </Widget>
      )}

      {/* ═══════════ DASHBOARD (Overview) ═══════════ */}
      {configured && tab === 'overview' && overview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="opm-toolbar">
            <div className="opm-toolbar-row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="opm-toolbar-label">Dashboard scope</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Group</span>
                <select value={dashboardGroupFilter} onChange={(e) => setDashboardGroupFilter(e.target.value)}
                  style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', minWidth: 180, maxWidth: 280 }}>
                  <option value="">All groups</option>
                  {(overview.allHostGroups || overview.hostGroups || []).map((g) => (
                    <option key={g.name} value={g.name}>{g.name} ({g.count})</option>
                  ))}
                </select>
              </div>
              <div className="opm-search" style={{ maxWidth: 320, flex: '1 1 200px' }}>
                <input type="search" value={dashboardSearch} onChange={(e) => setDashboardSearch(e.target.value)} placeholder="Filter by host name…" />
                <span className="opm-search-icon">⌕</span>
              </div>
              {(dashboardGroupFilter || dashboardSearch.trim()) && (
                <button type="button" onClick={() => { setDashboardGroupFilter(''); setDashboardSearch('') }}
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--cyan)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 600 }}>
                  Clear filters
                </button>
              )}
              {overview.scopeFiltered && (
                <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: 'var(--accent)', fontSize: 10 }}>
                  Scoped view
                </span>
              )}
            </div>
          </div>

          {/* Row 1: Counter tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
            <CounterTile label="Devices" value={avail?.total ?? 0} sub="Monitored" color="blue" icon="▦" onClick={() => { setInventoryAvailFilter(''); setTab('hosts') }} />
            <CounterTile label="Available" value={avail?.available ?? 0} sub={healthPct != null ? `${healthPct}% health` : null} color="green" icon="●" onClick={() => { setInventoryAvailFilter('Available'); setTab('hosts') }} />
            <CounterTile label="Unavailable" value={avail?.unavailable ?? 0} sub="Down" color="red" icon="✕" onClick={() => { setInventoryAvailFilter('Unavailable'); setTab('hosts') }} />
            <CounterTile label="Unknown" value={avail?.unknown ?? 0} sub="Unchecked" color="cyan" icon="?" onClick={() => { setInventoryAvailFilter('Unknown'); setTab('hosts') }} />
            <CounterTile label="Active Alarms" value={overview.activeProblems} sub="Click to view" color="amber" icon="⚠" onClick={() => { setSeverityFilter(null); setTab('problems') }} />
            <CounterTile label="Zabbix" value={overview.version || '—'} sub="API version" color="purple" icon="◆" />
          </div>

          {/* Row 2: Device Snapshot + Alarm Summary + Top Problematic */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, alignItems: 'start' }}>
            <Widget title="Device Snapshot">
              <DeviceSnapshotDonut available={avail?.available ?? 0} unavailable={avail?.unavailable ?? 0} unknown={avail?.unknown ?? 0} total={avail?.total ?? 0} />
            </Widget>

            <Widget title="Alarm Summary">
              <AlarmSeverityStrip counts={overview.severityCounts} />
              <div style={{ marginTop: 14 }}>
                <SeverityFilter counts={overview.severityCounts} selected={severityFilter} onSelect={setSeverityFilter} />
              </div>
            </Widget>

            <Widget title="Top Problematic Devices" badge={overview.topProblemHosts?.length ?? 0} badgeColor="amber">
              <TopDevicesRanked items={overview.topProblemHosts || []}
                onItemClick={(h) => goToHostGraphs({ hostid: h.hostid, host: h.host, name: h.name })} />
            </Widget>
          </div>

          {/* Row 3: Host Groups + Recent Alarms */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, alignItems: 'start' }}>
            <Widget title="Device Groups" badge={overview.hostGroups?.length ?? 0} badgeColor="blue">
              {!(overview.hostGroups || []).length
                ? <div style={{ color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>No groups.</div>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {(overview.hostGroups || []).map((g) => (
                      <button key={g.name} type="button" onClick={() => goToGroup(g.name)}
                        title={`Show ${g.count} device(s) in “${g.name}”`}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, fontSize: 12, fontFamily: 'var(--mono)', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'all .12s' }}
                        className="opm-row-hover">
                        <span style={{ color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{g.name}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          <span style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13 }}>{g.count}</span>
                          <span style={{ color: 'var(--text3)', fontSize: 11 }}>›</span>
                        </span>
                      </button>
                    ))}
                  </div>
              }
            </Widget>

            <Widget title="Recent Alarms"
              badge={severityFilter != null ? `${ovProblemsFiltered.length} / ${(overview.problems || []).length}` : (overview.problems || []).length}
              badgeColor="amber" noPad>
              <DataTable columns={problemCols} rows={ovProblemsFiltered}
                empty={severityFilter != null ? 'No alarms at this severity.' : 'No active alarms.'} rowKey={(p) => p.eventid} />
            </Widget>
          </div>
        </div>
      )}

      {/* ═══════════ INVENTORY (Hosts) ═══════════ */}
      {configured && tab === 'hosts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="opm-search" style={{ flex: '1 1 280px', maxWidth: 520 }}>
              <input type="search" value={inventorySearch} onChange={(e) => setInventorySearch(e.target.value)} placeholder="Search by name, IP, host, group…" />
              <span className="opm-search-icon">⌕</span>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg3)' }}>
              <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase' }}>Group</span>
              <select value={inventoryGroupFilter} onChange={(e) => setInventoryGroupFilter(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none', minWidth: 160, maxWidth: 260 }}>
                <option value="">All ({hosts?.length ?? 0})</option>
                {availableInventoryGroups.map((g) => {
                  const n = (hosts || []).filter((h) => (h.groups || []).includes(g)).length
                  return <option key={g} value={g}>{g} ({n})</option>
                })}
              </select>
              {inventoryGroupFilter && (
                <button type="button" onClick={() => setInventoryGroupFilter('')} title="Clear group"
                  style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 700 }}>✕</button>
              )}
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg3)' }}>
              <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase' }}>Status</span>
              <select value={inventoryAvailFilter} onChange={(e) => setInventoryAvailFilter(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none', minWidth: 168, maxWidth: 220 }}>
                <option value="">All ({inventoryAvailCounts.all})</option>
                <option value="Available">Available ({inventoryAvailCounts.Available})</option>
                <option value="Unavailable">Unavailable ({inventoryAvailCounts.Unavailable})</option>
                <option value="Unknown">Unknown ({inventoryAvailCounts.Unknown})</option>
              </select>
              {inventoryAvailFilter && (
                <button type="button" onClick={() => setInventoryAvailFilter('')} title="Clear status"
                  style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 700 }}>✕</button>
              )}
            </div>
          </div>
          <Widget title="Device Inventory" badge={`${filteredInventory.length}${(inventorySearch || inventoryGroupFilter || inventoryAvailFilter) && hosts ? ` / ${hosts.length}` : ''}`} badgeColor="green" noPad
            actions={null}>
            {hosts === null || tabBusy
              ? <div style={{ padding: 24, color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading devices…</div>
              : <DataTable columns={hostCols} rows={filteredInventory} empty={(() => {
                  if (!hosts?.length) return 'No monitored devices.'
                  if (inventorySearch) return `No devices match "${inventorySearch}"${inventoryAvailFilter ? ` with status ${inventoryAvailFilter}` : ''}${inventoryGroupFilter ? ` in group “${inventoryGroupFilter}”` : ''}.`
                  if (inventoryAvailFilter || inventoryGroupFilter) return `No devices${inventoryAvailFilter ? ` with status “${inventoryAvailFilter}”` : ''}${inventoryGroupFilter ? ` in group “${inventoryGroupFilter}”` : ''}.`
                  return 'No monitored devices.'
                })()} rowKey={(h) => h.hostid} onRowClick={(h) => goToHostGraphs(h)} />
            }
          </Widget>
        </div>
      )}

      {/* ═══════════ DEVICE SNAPSHOT (Host & Graphs) ═══════════ */}
      {configured && tab === 'hostGraphs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search + group filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="opm-search">
              <input type="search" value={hostSearch} onChange={(e) => setHostSearch(e.target.value)} placeholder="Search devices…" />
              <span className="opm-search-icon">⌕</span>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg3)' }}>
              <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase' }}>Group</span>
              <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none', minWidth: 160, maxWidth: 260 }}>
                <option value="">All ({(hostsExplorer || []).length})</option>
                {availableGroups.map((g) => {
                  const count = (hostsExplorer || []).filter((h) => (h.groups || []).includes(g)).length
                  return <option key={g} value={g}>{g} ({count})</option>
                })}
              </select>
              {groupFilter && (
                <button type="button" onClick={() => setGroupFilter('')} title="Clear group filter"
                  style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 700 }}>✕</button>
              )}
            </div>
            {selectedHost && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px 6px 10px', borderRadius: 999, background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.25)', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: selectedHost.availability === 'Available' ? '#22c55e' : selectedHost.availability === 'Unavailable' ? '#ef4444' : '#64748b', boxShadow: selectedHost.availability === 'Available' ? '0 0 0 3px rgba(34,197,94,.18)' : 'none' }} />
                {selectedHost.name || selectedHost.host}
              </div>
            )}
          </div>

          {/* Layout: device list | graph area */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'start', minHeight: 520 }}>
            {/* Left: device sidebar */}
            <div ref={hostListRef} style={{ flex: '0 0 250px', maxHeight: 620, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)' }}>
              <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg3)', fontSize: 10, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: .8, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span>Devices {filteredHosts.length > 0 ? `(${filteredHosts.length}${hostsExplorer && filteredHosts.length !== hostsExplorer.length ? ` / ${hostsExplorer.length}` : ''})` : hostsExplorer ? `(${hostsExplorer.length})` : ''}</span>
                {groupFilter && (
                  <span title={`Filtered by group: ${groupFilter}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,.12)', color: 'var(--accent)', fontSize: 9, textTransform: 'none', letterSpacing: 0, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    ▦ {groupFilter}
                  </span>
                )}
              </div>
              {explorerBusy
                ? <div style={{ padding: 20, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 8 }}><span className="np-page-loading-dot" style={{ width: 12, height: 12 }} />Searching…</div>
                : filteredHosts.map((h) => {
                    const act = selectedHost?.hostid === h.hostid
                    const dotColor = h.availability === 'Available' ? '#22c55e' : h.availability === 'Unavailable' ? '#ef4444' : '#64748b'
                    return (
                      <button key={h.hostid} type="button" onClick={() => pickHost(h)} className={`opm-device-card ${act ? 'active' : ''}`} style={{ width: '100%', textAlign: 'left', border: 'none', fontSize: 12, fontFamily: 'var(--mono)', background: act ? 'rgba(59,130,246,.08)' : 'transparent', borderLeft: act ? '3px solid var(--accent)' : '3px solid transparent', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0, boxShadow: h.availability === 'Available' ? '0 0 5px rgba(34,197,94,.5)' : 'none' }} />
                        <div style={{ flex: 1, overflow: 'hidden' }}>
                          <div style={{ fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name || h.host}</div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: 'var(--text3)', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                            {h.ip && h.ip !== h.host && <span style={{ fontFamily: 'var(--mono)', color: 'var(--text2)' }}>{h.ip}</span>}
                            {h.ip && h.ip !== h.host && <span style={{ opacity: .3 }}>·</span>}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.host}</span>
                          </div>
                        </div>
                      </button>
                    )
                  })
              }
              {!explorerBusy && filteredHosts.length === 0 && hostsExplorer?.length === 0 && <div style={{ padding: 20, color: 'var(--text3)', fontSize: 12 }}>No devices found.</div>}
              {!explorerBusy && filteredHosts.length === 0 && (hostsExplorer?.length || 0) > 0 && (
                <div style={{ padding: 20, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                  {hostSearch ? <>No matches for &quot;{hostSearch}&quot;{groupFilter ? <> in group <strong>{groupFilter}</strong></> : ''}.</> : groupFilter ? <>No devices in group <strong>{groupFilter}</strong>.</> : 'No devices.'}
                </div>
              )}
            </div>

            {/* Right: snapshot + graphs */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              {!selectedHost && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, border: '1px dashed var(--border)', borderRadius: 10, background: 'var(--bg2)', padding: 50 }}>
                  <span style={{ fontSize: 40, opacity: .2 }}>📊</span>
                  <span style={{ fontSize: 14, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Select a device to view its snapshot</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', opacity: .5 }}>Or click any device from Inventory / Dashboard</span>
                </div>
              )}

              {selectedHost && (
                <>
                  {/* View mode toggle (only when host has graphs) */}
                  {!noGraphHost && hostGraphs?.length > 0 && (
                    <div className="opm-toolbar">
                      <div className="opm-toolbar-row">
                        <span className="opm-toolbar-label">View</span>
                        {[
                          { id: 'graphs', label: 'Graphs' },
                          { id: 'latest', label: 'Latest' },
                        ].map((m) => (
                          <button key={m.id} type="button" onClick={() => switchHostView(m.id)}
                            style={{ padding: '5px 14px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, border: hostViewMode === m.id ? '1px solid var(--accent)' : '1px solid var(--border)', background: hostViewMode === m.id ? 'rgba(59,130,246,.12)' : 'var(--bg3)', color: hostViewMode === m.id ? 'var(--accent)' : 'var(--text3)', cursor: 'pointer', transition: 'all .12s' }}>
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Device info card */}
                  <Widget title="Device Info">
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, fontFamily: 'var(--mono)' }}>
                      {[
                        { label: 'Device', value: selectedHost.name || selectedHost.host },
                        { label: 'IP Address', value: selectedHost.ip || '—' },
                        { label: 'Technical Name', value: selectedHost.host },
                        { label: 'Status', value: selectedHost.availability || '—', color: selectedHost.availability === 'Available' ? '#22c55e' : selectedHost.availability === 'Unavailable' ? '#ef4444' : '#64748b' },
                        { label: 'Groups', value: (selectedHost.groups || []).join(', ') || '—' },
                      ].map((f) => (
                        <div key={f.label} style={{ minWidth: 120 }}>
                          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', marginBottom: 2 }}>{f.label}</div>
                          <div style={{ color: f.color || 'var(--text)', fontWeight: 600 }}>{f.value}</div>
                        </div>
                      ))}
                    </div>
                  </Widget>

                  {/* Range + mode toolbar (graphs view only) */}
                  {hostViewMode === 'graphs' && !noGraphHost && (
                  <div className="opm-toolbar">
                    <div className="opm-toolbar-row">
                      <span className="opm-toolbar-label">Range</span>
                      {Object.keys(RANGE_SEC).map((r) => {
                        const active = graphRange === r && !graphCustomRange
                        return (
                          <button key={r} type="button" disabled={!selectedGraphId || graphDataMode === 'latest'} onClick={() => pickGraphRange(r)}
                            style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, border: active ? '1px solid var(--accent)' : '1px solid var(--border)', background: active ? 'rgba(59,130,246,.12)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text3)', cursor: selectedGraphId && graphDataMode !== 'latest' ? 'pointer' : 'not-allowed', opacity: selectedGraphId && graphDataMode !== 'latest' ? 1 : .35, transition: 'all .12s' }}>
                            {r}
                          </button>
                        )
                      })}
                      <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 4px' }} />
                      <span className="opm-toolbar-label">Mode</span>
                      {[{ id: 'auto', label: 'History' }, { id: 'latest', label: 'Live' }].map((m) => (
                        <button key={m.id} type="button" disabled={!selectedGraphId} onClick={() => setGraphDataMode(m.id)}
                          style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, border: graphDataMode === m.id ? '1px solid var(--accent)' : '1px solid var(--border)', background: graphDataMode === m.id ? 'rgba(59,130,246,.12)' : 'transparent', color: graphDataMode === m.id ? 'var(--accent)' : 'var(--text3)', cursor: selectedGraphId ? 'pointer' : 'not-allowed', opacity: selectedGraphId ? 1 : .35, transition: 'all .12s' }}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <div className="opm-toolbar-row">
                      <span className="opm-toolbar-label" style={{ color: graphCustomRange ? 'var(--accent)' : 'var(--text3)' }}>Custom</span>
                      <input type="datetime-local" value={graphCustomFrom} onChange={(e) => setGraphCustomFrom(e.target.value)}
                        disabled={!selectedGraphId || graphDataMode === 'latest'}
                        style={{ padding: '3px 8px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', outline: 'none', opacity: selectedGraphId && graphDataMode !== 'latest' ? 1 : .4 }} />
                      <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600 }}>to</span>
                      <input type="datetime-local" value={graphCustomTo} onChange={(e) => setGraphCustomTo(e.target.value)}
                        disabled={!selectedGraphId || graphDataMode === 'latest'}
                        style={{ padding: '3px 8px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', outline: 'none', opacity: selectedGraphId && graphDataMode !== 'latest' ? 1 : .4 }} />
                      <button type="button" onClick={applyGraphCustomRange}
                        disabled={!selectedGraphId || graphDataMode === 'latest' || !graphCustomFrom || !graphCustomTo}
                        style={{ padding: '4px 14px', borderRadius: 5, fontSize: 11, fontWeight: 700, fontFamily: 'var(--mono)', border: 'none', background: 'var(--accent)', color: '#fff', cursor: selectedGraphId && graphCustomFrom && graphCustomTo && graphDataMode !== 'latest' ? 'pointer' : 'not-allowed', opacity: selectedGraphId && graphCustomFrom && graphCustomTo && graphDataMode !== 'latest' ? 1 : .4, transition: 'opacity .12s' }}>
                        Apply
                      </button>
                      {graphCustomRange && <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: '#3b82f6', fontSize: 10 }}>Custom Range Active</span>}
                    </div>
                  </div>
                  )}

                  {/* GRAPHS VIEW: Graph list + chart */}
                  {hostViewMode === 'graphs' && !noGraphHost && (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'start' }}>
                      {/* Graph sidebar */}
                      <div style={{ flex: '0 0 200px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)', overflow: 'hidden', maxHeight: 440, overflowY: 'auto' }}>
                        <div style={{ padding: '8px 12px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: .8, textTransform: 'uppercase' }}>
                          Graphs {hostGraphs ? `(${hostGraphs.length})` : ''}
                        </div>
                        {graphsBusy
                          ? <div style={{ padding: 14, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 6 }}><span className="np-page-loading-dot" style={{ width: 10, height: 10 }} />Loading…</div>
                          : (hostGraphs || []).map((g, i) => (
                              <button key={g.graphid} type="button" onClick={() => pickGraph(g.graphid)}
                                className={`opm-graph-item ${selectedGraphId === g.graphid ? 'active' : ''}`}
                                style={{ width: '100%', textAlign: 'left', border: 'none', fontSize: 11, fontFamily: 'var(--mono)', color: g.drawable ? 'var(--text)' : 'var(--text3)', cursor: 'pointer', background: selectedGraphId === g.graphid ? 'rgba(59,130,246,.1)' : 'transparent' }}>
                                <span style={{ width: 6, height: 6, borderRadius: 1, background: DATASET_COLORS[i % DATASET_COLORS.length], flexShrink: 0, opacity: .8 }} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                              </button>
                            ))
                        }
                      </div>

                      {/* Chart area */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {selectedGraphId ? (
                          <GraphPanel graph={hostGraphs?.find((g) => g.graphid === selectedGraphId)} series={graphSeries} chartData={chartData} chartOpts={chartOpts} busy={graphSeriesBusy} graphDataMode={graphDataMode} apiBase={apiBase} />
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 50, borderRadius: 10, border: '1px dashed var(--border)', background: 'var(--bg2)', color: 'var(--text3)', fontSize: 13, fontFamily: 'var(--mono)' }}>
                            Select a graph to view performance data
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* LATEST METRICS VIEW: per-item history (also for no-graph hosts) */}
                  {(hostViewMode === 'latest' || noGraphHost) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                        <button type="button" onClick={() => selectedHost?.hostid && loadHostItemsLatest(selectedHost.hostid)}
                          style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 600 }}>↻ Refresh</button>
                      </div>
                      {itemsLatestBusy && <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', padding: '40px 0', justifyContent: 'center' }}><span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading metrics…</div>}
                      {!itemsLatestBusy && hostItemsLatest && <LatestMetricsView key={selectedHost?.hostid} latestData={hostItemsLatest} chartOpts={chartOpts} apiBase={apiBase} />}
                      {!itemsLatestBusy && !hostItemsLatest && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)' }}>No data loaded yet.</div>}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ TOP MONITORING ═══════════ */}
      {configured && tab === 'topMon' && (
        <div className="topmon-dashboard">
          <TopMonAddWidgetModal
            open={topMonAddOpen}
            initial={topMonEditWidget}
            onClose={() => { setTopMonAddOpen(false); setTopMonEditWidget(null) }}
            onSave={(w) => {
              if (topMonEditWidget) updateCustomTopWidget(w)
              else addCustomTopWidget(w)
              loadTopUtil(topLimit).catch(() => {})
            }}
          />
          <TopMonLayoutModal
            open={topMonLayoutOpen}
            hiddenIds={hiddenTopWidgets}
            onClose={() => setTopMonLayoutOpen(false)}
            onSave={persistHiddenTopWidgets}
          />

          <div className="opm-toolbar" style={{ marginBottom: 0 }}>
            <div className="opm-toolbar-row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <span className="opm-toolbar-label">Host group</span>
              <select value={topMonGroup} onChange={(e) => setTopMonGroup(e.target.value)}
                style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', minWidth: 200, maxWidth: 320 }}>
                <option value="">All groups</option>
                {(topUtil?.allGroups || netHealth?.allGroups || overview?.allHostGroups?.map((g) => g.name) || []).map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              {topMonGroup && (
                <>
                  <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: 'var(--accent)', fontSize: 10, border: '1px solid rgba(59,130,246,.25)' }}>
                    Scoped: {topMonGroup}
                  </span>
                  <button type="button" onClick={() => setTopMonGroup('')}
                    style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--cyan)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 600 }}>
                    Clear group
                  </button>
                </>
              )}
              {topUtil?.summary?.monitoredHosts != null && (
                <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>
                  {topUtil.summary.monitoredHosts} hosts in scope
                </span>
              )}
            </div>
          </div>

          <div className="topmon-dash-header">
            <div>
              <h2>Performance Dashboard</h2>
              <p>
                Enterprise top-N monitoring across infrastructure &amp; network
                {topMonGroup ? <> · Group: <strong style={{ color: 'var(--accent)' }}>{topMonGroup}</strong></> : null}
                {topUtil?.sampledAt && <> · Refreshed {relAge(topUtil.sampledAt)} ago</>}
                {topUtil?.staleAfterSec ? <> · Fresh data ≤{Math.round(topUtil.staleAfterSec / 60)}m</> : null}
              </p>
            </div>
            <div className="opm-toolbar-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="opm-toolbar-label">Show top</span>
              {[5, 10, 20].map((n) => (
                <button key={n} type="button" onClick={() => setTopLimit(n)}
                  style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, border: topLimit === n ? '1px solid var(--accent)' : '1px solid var(--border)', background: topLimit === n ? 'rgba(59,130,246,.12)' : 'var(--bg3)', color: topLimit === n ? 'var(--accent)' : 'var(--text3)', cursor: 'pointer' }}>
                  {n}
                </button>
              ))}
              <button type="button" onClick={() => setTopMonLayoutOpen(true)}
                style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 600 }}>
                ⊞ Layout
              </button>
              <button type="button" onClick={() => { setTopMonEditWidget(null); setTopMonAddOpen(true) }}
                style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--accent)', background: 'rgba(59,130,246,.1)', color: 'var(--accent)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 700 }}>
                + Add Widget
              </button>
              <button type="button" onClick={() => loadTopUtil(topLimit)} disabled={topUtilBusy}
                style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: topUtilBusy ? 'wait' : 'pointer', fontWeight: 600 }}>
                {topUtilBusy ? '↻ …' : '↻ Refresh'}
              </button>
            </div>
          </div>

          {topUtilBusy && !topUtil && (
            <div style={{ padding: 48, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading performance dashboard…
            </div>
          )}

          {topUtil && (() => {
            const s = topUtil.summary || {}
            const d = topUtil.distributions || {}
            const visibleBuiltin = TOP_MON_BUILTIN.filter((w) => !hiddenTopWidgets.includes(w.id))
            const infraWidgets = visibleBuiltin.filter((w) => w.section === 'infra')
            const netWidgets = visibleBuiltin.filter((w) => w.section === 'network')
            const goHost = (r) => goToHostGraphs({ hostid: r.hostid, host: r.host, name: r.name })

            return (
              <>
                {/* Executive KPI strip */}
                <div className="topmon-kpi-grid">
                  <TopMonKpi icon="▦" label="Monitored Hosts" value={s.monitoredHosts ?? '—'} sub={`${s.withCpu ?? 0} with CPU · ${s.withMemory ?? 0} memory`} color="#3b82f6" iconBg="rgba(59,130,246,.12)" />
                  <TopMonKpi icon="⚡" label="CPU Critical" value={s.cpuCritical ?? 0} sub={`${s.cpuHigh ?? 0} high (75–90%)`} color={s.cpuCritical > 0 ? '#ef4444' : '#22c55e'} iconBg={s.cpuCritical > 0 ? 'rgba(239,68,68,.12)' : 'rgba(34,197,94,.12)'} />
                  <TopMonKpi icon="◫" label="Disk Critical" value={s.diskCritical ?? 0} sub={`${s.diskHigh ?? 0} high (75–90%)`} color={s.diskCritical > 0 ? '#ef4444' : '#22c55e'} iconBg={s.diskCritical > 0 ? 'rgba(239,68,68,.12)' : 'rgba(34,197,94,.12)'} />
                  <TopMonKpi icon="◷" label="Avg Latency" value={s.avgLatency != null ? `${s.avgLatency} ms` : '—'} sub={`${s.latencyCritical ?? 0} critical · ${s.latencyWarning ?? 0} warning`} color="#06b6d4" iconBg="rgba(6,182,212,.12)" />
                  <TopMonKpi icon="📡" label="Packet Loss" value={s.packetLossIssues ?? 0} sub={`${s.withPacketLoss ?? 0} hosts reporting`} color={s.packetLossIssues > 0 ? '#f59e0b' : '#22c55e'} iconBg={s.packetLossIssues > 0 ? 'rgba(245,158,11,.12)' : 'rgba(34,197,94,.12)'} />
                  <TopMonKpi icon="◉" label="Memory Critical" value={s.memoryCritical ?? 0} sub={`${s.withMemory ?? 0} hosts with sensor`} color={s.memoryCritical > 0 ? '#ef4444' : '#8b5cf6'} iconBg="rgba(139,92,246,.12)" />
                </div>

                {/* Analytics row — donuts & distribution */}
                <div className="topmon-analytics-grid">
                  <Widget title="CPU Health Distribution" badge={d.cpu?.total ?? 0} badgeColor="blue" noPad>
                    <div style={{ padding: 16 }}>
                      <TopMonDonutPanel buckets={d.cpu?.buckets} total={d.cpu?.total} centerLabel="hosts" />
                    </div>
                  </Widget>
                  <Widget title="Disk Capacity Status" badge={d.disk?.total ?? 0} badgeColor="amber" noPad>
                    <div style={{ padding: 16 }}>
                      <TopMonDonutPanel buckets={d.disk?.buckets} total={d.disk?.total} centerLabel="hosts" />
                    </div>
                  </Widget>
                  <Widget title="Network Latency Distribution" badge={d.latency?.total ?? 0} badgeColor="cyan" noPad>
                    <div style={{ padding: 16 }}>
                      <TopMonDistBars buckets={d.latency?.buckets} total={d.latency?.total} />
                    </div>
                  </Widget>
                </div>

                {infraWidgets.length > 0 && (
                  <>
                    <TopMonSection title="Infrastructure Performance" />
                    <div className="topmon-widget-grid">
                      {infraWidgets.map((def) => (
                        <Widget key={def.id} title={def.title} badge={topUtil[def.dataKey]?.length ?? 0} badgeColor={def.badgeColor} noPad>
                          <TopMonRankTable
                            rows={topUtil[def.dataKey]}
                            accent={def.accent}
                            unitSuffix={def.unitSuffix}
                            emptyMsg={def.emptyMsg}
                            showMount={def.showMount}
                            showBytes={def.showBytes}
                            onRowClick={goHost}
                          />
                        </Widget>
                      ))}
                    </div>
                  </>
                )}

                {netWidgets.length > 0 && (
                  <>
                    <TopMonSection title="Network Performance" />
                    <div className="topmon-widget-grid">
                      {netWidgets.map((def) => (
                        <Widget key={def.id} title={def.title} badge={topUtil[def.dataKey]?.length ?? 0} badgeColor={def.badgeColor} noPad>
                          <TopMonRankTable
                            rows={topUtil[def.dataKey]}
                            accent={def.accent}
                            unitSuffix={def.unitSuffix}
                            emptyMsg={def.emptyMsg}
                            onRowClick={goHost}
                          />
                        </Widget>
                      ))}
                    </div>
                  </>
                )}

                {customTopWidgets.length > 0 && (
                  <>
                    <TopMonSection title="Custom Widgets" />
                    <div className="topmon-widget-grid">
                      {customTopWidgets.map((w) => (
                        <Widget key={w.id} title={w.title} badge={customTopData[w.id]?.length ?? 0} badgeColor="blue" noPad
                          actions={
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button type="button" title="Edit" onClick={() => { setTopMonEditWidget(w); setTopMonAddOpen(true) }}
                                style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text3)', fontSize: 10, cursor: 'pointer' }}>✎</button>
                              <button type="button" title="Remove" onClick={() => removeCustomTopWidget(w.id)}
                                style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(239,68,68,.3)', background: 'rgba(239,68,68,.08)', color: '#ef4444', fontSize: 10, cursor: 'pointer' }}>✕</button>
                            </div>
                          }>
                          <TopMonRankTable
                            rows={customTopData[w.id]}
                            accent={w.accent || '#3b82f6'}
                            unitSuffix={w.unitSuffix ?? ''}
                            emptyMsg={`No items matching ${w.keyPattern}*`}
                            onRowClick={goHost}
                          />
                          <p style={{ margin: 0, padding: '8px 12px 12px', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', borderTop: '1px solid var(--border)' }}>Key: {w.keyPattern}*</p>
                        </Widget>
                      ))}
                    </div>
                  </>
                )}
              </>
            )
          })()}
        </div>
      )}

      {/* ═══════════ ALARMS (Problems) ═══════════ */}
      {configured && tab === 'problems' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SeverityFilter counts={overview?.severityCounts} selected={severityFilter} onSelect={setSeverityFilter} />
          <Widget title="Active Alarms" badge={problemsFull?.length ?? '…'} badgeColor="amber" noPad>
            {problemsFull === null || tabBusy
              ? <div style={{ padding: 24, color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading alarms…</div>
              : <DataTable columns={problemCols} rows={problemsFull} empty="No active alarms." rowKey={(p) => p.eventid} />
            }
          </Widget>
        </div>
      )}

      {/* ═══════════ EVENTS ═══════════ */}
      {configured && tab === 'events' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {events?.length > 0 && !tabBusy && (() => {
            const prob = events.filter((e) => e.status === 'PROBLEM').length
            const res = events.filter((e) => e.status === 'RESOLVED').length
            const ack = events.filter((e) => e.acknowledged).length
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
                <CounterTile label="Total Events" value={events.length} color="blue" icon="◉" />
                <CounterTile label="Problems" value={prob} color="red" icon="⚠" />
                <CounterTile label="Resolved" value={res} color="green" icon="✓" />
                <CounterTile label="Acknowledged" value={ack} color="cyan" icon="◈" />
              </div>
            )
          })()}
          <Widget title="Event Log" badge={events?.length ?? '…'} badgeColor="blue" noPad
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 600 }}>SHOW:</span>
                {[500, 1000, 2000, 5000].map((n) => (
                  <button key={n} type="button" onClick={() => setEventLimit(n)}
                    style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 600, border: eventLimit === n ? '1px solid var(--accent)' : '1px solid var(--border)', background: eventLimit === n ? 'rgba(59,130,246,.12)' : 'transparent', color: eventLimit === n ? 'var(--accent)' : 'var(--text3)', cursor: 'pointer' }}>
                    {n}
                  </button>
                ))}
              </div>
            }>
            {tabBusy
              ? <div style={{ padding: 24, color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading events…</div>
              : <DataTable columns={eventCols} rows={events || []} empty="No events returned." rowKey={(ev) => ev.eventid} />
            }
          </Widget>
        </div>
      )}

      {(loading || overviewBusy) && !overview && configured && reachable && (        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 50, gap: 12, color: 'var(--text3)', fontSize: 14, fontFamily: 'var(--mono)' }}>
          <span className="np-page-loading-dot" /> {loadingLabel}
        </div>
      )}

      {/* ═══════════ NETWORK HEALTH TAB ═══════════ */}
      {configured && reachable && tab === 'netHealth' && (() => {
        const nh = netHealth
        const fmtUptime = (s) => {
          if (!s || !Number.isFinite(s)) return '—'
          if (s >= 86400) return `${(s / 86400).toFixed(1)} d`
          if (s >= 3600)  return `${(s / 3600).toFixed(1)} h`
          return `${Math.floor(s / 60)} m`
        }
        const pct = (v, t) => t > 0 ? Math.round(v / t * 100) : 0
        const connColor = { LAN: '#3b82f6', 'Wi-Fi': '#a855f7', Both: '#f59e0b', Unknown: '#64748b' }

        const worstFiltered = (nh?.worstHosts || []).filter((h) => {
          if (netConnFilter !== 'all' && h.connType !== netConnFilter) return false
          const q = netSearch.trim().toLowerCase()
          if (q && !h.name.toLowerCase().includes(q)) return false
          return true
        })

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Toolbar */}
            <div className="opm-toolbar">
              <div className="opm-toolbar-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                <span className="opm-toolbar-label">Group</span>
                <select value={netHealthGroup} onChange={(e) => setNetHealthGroup(e.target.value)}
                  style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', minWidth: 180, maxWidth: 260 }}>
                  <option value="">All groups</option>
                  {(nh?.allGroups || []).map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                <span className="opm-toolbar-label" style={{ marginLeft: 8 }}>Business hours</span>
                <select value={netBizStart} onChange={(e) => setNetBizStart(Number(e.target.value))}
                  style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', width: 70 }}>
                  {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}
                </select>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>–</span>
                <select value={netBizEnd} onChange={(e) => setNetBizEnd(Number(e.target.value))}
                  style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', width: 70 }}>
                  {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}
                </select>
                {nh?.bizHours && (
                  <span className="opm-pill" style={{ marginLeft: 4, background: nh.bizHours.inBizHours ? 'rgba(34,197,94,.12)' : 'rgba(100,116,139,.12)', color: nh.bizHours.inBizHours ? '#22c55e' : 'var(--text3)', border: `1px solid ${nh.bizHours.inBizHours ? 'rgba(34,197,94,.25)' : 'var(--border)'}` }}>
                    {nh.bizHours.inBizHours ? '● In business hours' : '○ Outside business hours'} (now {nh.bizHours.nowHour}:00)
                  </span>
                )}
                {nh?.freshness && (
                  <span className="opm-pill" style={{ marginLeft: 4, background: 'rgba(100,116,139,.1)', color: 'var(--text3)', border: '1px solid var(--border)', fontSize: 10 }}>
                    Zabbix poll ≤{Math.round((nh.freshness.staleAfterSec || 300) / 60)}m
                    {nh.freshness.latency?.newestPoll
                      ? ` · newest ${relAge(nh.freshness.latency.newestPoll)} ago`
                      : nh.sampledAt ? ` · queried ${relAge(nh.sampledAt)} ago` : ''}
                    {(nh.freshness.packetLoss?.stale > 0 || nh.freshness.latency?.stale > 0) && (
                      <span style={{ color: '#f59e0b', marginLeft: 6 }}>
                        · stale: loss {nh.freshness.packetLoss?.stale || 0} · lat {nh.freshness.latency?.stale || 0}
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>

            {netHealthBusy && !nh && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                <span className="np-page-loading-dot" /> Loading network health…
              </div>
            )}

            {nh && (() => {
              const { totals, connectivity, ping, packetLoss, pingMs, uptime, bizHours, freshness } = nh
              const totalWithLoss = packetLoss.p0 + packetLoss.p1 + packetLoss.p5 + packetLoss.p100
              const freshLoss = totalWithLoss
              const staleLoss = packetLoss.stale ?? freshness?.packetLoss?.stale ?? 0
              const staleMs = pingMs.stale ?? freshness?.latency?.stale ?? 0
              const avgLoss = freshLoss > 0
                ? Math.round((packetLoss.p1 * 2.5 + packetLoss.p5 * 50 + packetLoss.p100 * 100) / freshLoss * 10) / 10
                : null
              const maxUptimeBucket = Math.max(...(uptime.distribution || []).map((x) => x.count), 1)
              const fmtStalePoll = (pollClock) => (
                <span style={{ color: '#f59e0b', fontWeight: 600 }} title={pollClock ? fmtClock(pollClock) : undefined}>
                  Stale{pollClock ? ` (${relAge(pollClock)})` : ''}
                </span>
              )
              return (
                <>
                  {/* KPI row — Packet Loss & Latency first */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
                    <CounterTile
                      label="Packet Loss"
                      value={packetLoss.noData < totals.total
                        ? (packetLoss.p0 === freshLoss && packetLoss.p100 === 0 && packetLoss.p5 === 0 && packetLoss.p1 === 0
                          ? `${avgLoss ?? 0} %`
                          : avgLoss != null ? `${avgLoss}% avg` : '—')
                        : 'No sensor'}
                      color={packetLoss.p100 > 0 ? 'red' : packetLoss.p5 > 0 ? 'amber' : 'green'}
                      icon="📡"
                      sub={freshLoss > 0 ? `${packetLoss.p100} dead · ${packetLoss.p5} critical` : undefined}
                      onClick={() => nhPktRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    />
                    <CounterTile
                      label="Latency"
                      value={pingMs.avg != null ? `${pingMs.avg} ms` : 'No sensor'}
                      color={pingMs.avg == null ? 'amber' : pingMs.avg < 50 ? 'green' : pingMs.avg < 150 ? 'amber' : 'red'}
                      icon="◷"
                      sub={pingMs.p95 != null ? `p95: ${pingMs.p95} ms` : pingMs.count > 0 ? `${pingMs.count} hosts` : undefined}
                      onClick={() => nhLatRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    />
                    <CounterTile label="Total Devices"   value={totals.total}       color="blue"  icon="▦" />
                    <CounterTile label="Online"          value={totals.online}      color="green" icon="●" sub={`${pct(totals.online, totals.total)}%`} />
                    <CounterTile label="Offline"         value={totals.offline}     color="red"   icon="✕" sub={`${pct(totals.offline, totals.total)}%`} />
                    <CounterTile label="Unknown"         value={totals.unknown}     color="amber" icon="?" sub={`${pct(totals.unknown, totals.total)}%`} />
                    <CounterTile label="Agent Reachable" value={ping.reachable}     color="green" icon="⬤" sub={ping.noData > 0 ? `${ping.noData} no data` : undefined} />
                    <CounterTile label="Unreachable"     value={ping.unreachable}   color="red"   icon="◯" />
                  </div>

                  {/* Four-panel row */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
                    {/* Connectivity */}
                    <Widget title="Network Connectivity" badge={totals.total} badgeColor="blue"
                      actions={<span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>active traffic only</span>}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
                        {[
                          { k: 'LAN (Ethernet)',   v: connectivity.lan,     icon: '🖧', color: '#3b82f6', label: 'LAN' },
                          { k: 'Wi-Fi (Wireless)', v: connectivity.wifi,    icon: '📶', color: '#a855f7', label: 'Wi-Fi' },
                          { k: 'Both active',      v: connectivity.both,    icon: '⇌',  color: '#22c55e', label: 'Both' },
                          { k: 'No data / idle',   v: connectivity.unknown, icon: '—',  color: '#64748b', label: 'Unknown' },
                        ].map(({ k, v, icon, color, label }) => (
                          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ width: 22, textAlign: 'center', fontSize: 14 }}>{icon}</span>
                            <span style={{ flex: 1, fontSize: 12, color: 'var(--text2)', fontWeight: 600 }}>{k}</span>
                            <div style={{ flex: 2, background: 'var(--bg3)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct(v, totals.total)}%`, background: color, borderRadius: 4, transition: 'width .4s' }} />
                            </div>
                            <span style={{ width: 40, textAlign: 'right', fontSize: 12, color, fontWeight: 700, fontFamily: 'var(--mono)' }}>{v}</span>
                          </div>
                        ))}
                        <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
                          Based on active traffic (lastvalue &gt; 0) on Ethernet/Wi-Fi adapters.<br/>Bluetooth, VPN &amp; virtual adapters excluded.
                        </p>
                      </div>
                    </Widget>

                    {/* Packet Loss */}
                    <div ref={nhPktRef}>
                    <Widget title="Packet Loss" badge={`${freshLoss} fresh / ${totals.total}`} badgeColor={staleLoss > 0 ? 'amber' : packetLoss.noData > 0 ? 'amber' : 'green'}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
                        {[
                          { label: '0% — Perfect',   v: packetLoss.p0,   color: '#22c55e' },
                          { label: '< 5% — Warning', v: packetLoss.p1,   color: '#f59e0b' },
                          { label: '5–99% — Critical',v: packetLoss.p5,  color: '#f97316' },
                          { label: '100% — Dead',    v: packetLoss.p100, color: '#ef4444' },
                          ...(staleLoss > 0 ? [{ label: `Stale poll (>${Math.round((freshness?.staleAfterSec || 300) / 60)}m)`, v: staleLoss, color: '#f59e0b' }] : []),
                          ...(packetLoss.noData > 0 ? [{ label: 'No sensor', v: packetLoss.noData, color: '#64748b' }] : []),
                        ].map(({ label, v, color }) => (
                            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ flex: 1, fontSize: 11, color: 'var(--text2)' }}>{label}</span>
                              <div style={{ flex: 2, background: 'var(--bg3)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct(v, totals.total)}%`, background: color, borderRadius: 4 }} />
                              </div>
                              <span style={{ width: 40, textAlign: 'right', fontSize: 12, color, fontWeight: 700, fontFamily: 'var(--mono)' }}>{v}</span>
                            </div>
                          ))}
                        <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                          Fresh polls only (≤{Math.round((freshness?.staleAfterSec || 300) / 60)}m) · {totals.total} hosts in scope · custom.ping.loss*
                          {freshness?.packetLoss?.newestPoll != null && <> · newest poll {relAge(freshness.packetLoss.newestPoll)} ago</>}
                        </p>
                      </div>
                    </Widget>
                    </div>

                    {/* Latency */}
                    <div ref={nhLatRef}>
                    <Widget title="Latency" badge={`${pingMs.count || 0} fresh / ${totals.total}`} badgeColor={staleMs > 0 ? 'amber' : pingMs.noData > 0 ? 'amber' : 'green'}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
                        {[
                          { label: '< 50 ms — Good',     v: pingMs.good ?? 0,     color: '#22c55e' },
                          { label: '50–150 ms — Warning', v: pingMs.warn ?? 0,     color: '#f59e0b' },
                          { label: '> 150 ms — Critical', v: pingMs.critical ?? 0, color: '#ef4444' },
                          ...(staleMs > 0 ? [{ label: `Stale poll (>${Math.round((freshness?.staleAfterSec || 300) / 60)}m)`, v: staleMs, color: '#f59e0b' }] : []),
                          ...(pingMs.noData > 0 ? [{ label: 'No sensor', v: pingMs.noData, color: '#64748b' }] : []),
                        ].map(({ label, v, color }) => (
                            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ flex: 1, fontSize: 11, color: 'var(--text2)' }}>{label}</span>
                              <div style={{ flex: 2, background: 'var(--bg3)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct(v, totals.total)}%`, background: color, borderRadius: 4 }} />
                              </div>
                              <span style={{ width: 40, textAlign: 'right', fontSize: 12, color, fontWeight: 700, fontFamily: 'var(--mono)' }}>{v}</span>
                            </div>
                          ))}
                        <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                          Fresh polls only (≤{Math.round((freshness?.staleAfterSec || 300) / 60)}m) · {totals.total} hosts in scope · custom.ping.ms*
                          {pingMs.avg != null && <> · avg {pingMs.avg} ms{pingMs.p95 != null ? ` · p95 ${pingMs.p95} ms` : ''}</>}
                          {freshness?.latency?.newestPoll != null && <> · newest poll {relAge(freshness.latency.newestPoll)} ago</>}
                        </p>
                      </div>
                    </Widget>
                    </div>

                    {/* Business Hours */}
                    <Widget title="Business Hours Status" badge={`${String(bizHours.bizStart).padStart(2,'0')}:00 – ${String(bizHours.bizEnd).padStart(2,'0')}:00`} badgeColor={bizHours.inBizHours ? 'green' : 'amber'}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
                        <div style={{ display: 'flex', gap: 10 }}>
                          <div style={{ flex: 1, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)', borderRadius: 8, padding: '10px 14px', textAlign: 'center' }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: '#22c55e', fontFamily: 'var(--mono)' }}>{bizHours.online}</div>
                            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Agent Online</div>
                          </div>
                          <div style={{ flex: 1, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 8, padding: '10px 14px', textAlign: 'center' }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: '#ef4444', fontFamily: 'var(--mono)' }}>{bizHours.offline}</div>
                            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Offline</div>
                          </div>
                        </div>
                        <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '6px 10px', display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: 'var(--mono)' }}>
                          <span style={{ color: 'var(--text3)' }}>Availability</span>
                          <span style={{ color: pct(bizHours.online, bizHours.totalHosts) > 90 ? '#22c55e' : '#f59e0b', fontWeight: 700 }}>{pct(bizHours.online, bizHours.totalHosts)}%</span>
                        </div>
                        {bizHours.noData > 0 && <p style={{ margin: 0, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{bizHours.noData} hosts: no agent.ping item</p>}
                        {bizHours.stale > 0 && <p style={{ margin: 0, fontSize: 10, color: '#f59e0b', fontFamily: 'var(--mono)' }}>{bizHours.stale} hosts: agent.ping poll older than {Math.round((freshness?.staleAfterSec || 300) / 60)}m</p>}
                      </div>
                    </Widget>
                  </div>

                  {/* Uptime distribution */}
                  {uptime.count > 0 && (
                    <Widget title="System Uptime Distribution" badge={`${uptime.count} hosts`} badgeColor="cyan">
                      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', padding: '8px 0', flexWrap: 'wrap' }}>
                        {(uptime.distribution || []).map((d) => {
                          const barH = Math.max(8, Math.round((d.count / maxUptimeBucket) * 110))
                          return (
                            <div key={d.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1, minWidth: 80 }}>
                              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, fontFamily: 'var(--mono)' }}>{d.count}</span>
                              <div style={{ width: '70%', height: barH, background: 'var(--accent)', borderRadius: '4px 4px 0 0', opacity: 0.8 }} />
                              <span style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.2 }}>{d.label}</span>
                            </div>
                          )
                        })}
                        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 130, background: 'var(--bg3)', padding: '10px 14px', borderRadius: 8 }}>
                          {[['Avg', fmtUptime(uptime.avg)], ['Median', fmtUptime(uptime.median)], ['Min', fmtUptime(uptime.min)], ['Max', fmtUptime(uptime.max)]].map(([l, v]) => (
                            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11, fontFamily: 'var(--mono)' }}>
                              <span style={{ color: 'var(--text3)' }}>{l}</span>
                              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </Widget>
                  )}

                  {/* Worst hosts table */}
                  <Widget title="Hosts Needing Attention" badge={String(nh.worstHosts.length || 0)} badgeColor="red"
                    actions={
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input placeholder="Search host…" value={netSearch} onChange={(e) => setNetSearch(e.target.value)}
                          style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', width: 160 }} />
                        <select value={netConnFilter} onChange={(e) => setNetConnFilter(e.target.value)}
                          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                          <option value="all">All types</option>
                          <option value="LAN">LAN (Ethernet)</option>
                          <option value="Wi-Fi">Wi-Fi</option>
                          <option value="Both">Both active</option>
                          <option value="Unknown">No data / idle</option>
                        </select>
                      </div>
                    }
                    noPad>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                            {['Status', 'Host', 'Connection', 'Agent Ping', 'Packet Loss', 'Ping (ms)', 'Uptime'].map((h) => (
                              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {worstFiltered.length === 0 && (
                            <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No hosts needing attention</td></tr>
                          )}
                          {worstFiltered.slice(0, 200).map((h) => (
                            <tr key={h.hostid} style={{ borderBottom: '1px solid rgba(128,128,160,.06)' }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg3)' }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = '' }}>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                <span className="opm-pill" style={{
                                  background: h.availability === 'Available' ? 'rgba(34,197,94,.12)' : h.availability === 'Unavailable' ? 'rgba(239,68,68,.12)' : 'rgba(100,116,139,.12)',
                                  color: h.availability === 'Available' ? '#22c55e' : h.availability === 'Unavailable' ? '#ef4444' : '#94a3b8',
                                  border: `1px solid ${h.availability === 'Available' ? 'rgba(34,197,94,.25)' : h.availability === 'Unavailable' ? 'rgba(239,68,68,.25)' : 'var(--border)'}`,
                                }}>{h.availability}</span>
                              </td>
                              <td style={{ padding: '7px 12px', color: 'var(--text)', fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</td>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                {h.connType !== 'Unknown' ? (
                                  <span className="opm-pill" style={{ background: `${connColor[h.connType] || '#64748b'}18`, color: connColor[h.connType] || '#64748b', border: `1px solid ${connColor[h.connType] || '#64748b'}30` }}>
                                    {h.connType === 'Wi-Fi' ? '📶 ' : h.connType === 'LAN' ? '🖧 ' : '⇌ '}{h.connType}
                                  </span>
                                ) : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}
                              </td>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                {h.agentPingStale ? fmtStalePoll(h.agentPingPoll)
                                  : h.agentPing == null ? <span style={{ color: 'var(--text3)' }}>—</span>
                                  : <span style={{ color: h.agentPing === 1 ? '#22c55e' : '#ef4444', fontFamily: 'var(--mono)', fontWeight: 600 }}>{h.agentPing === 1 ? '▲ Up' : '▼ Down'}</span>}
                              </td>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>
                                {h.packetLossStale ? fmtStalePoll(h.packetLossPoll)
                                  : h.packetLoss == null ? <span style={{ color: 'var(--text3)' }}>—</span>
                                  : <span style={{ color: h.packetLoss === 0 ? '#22c55e' : h.packetLoss < 5 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>{h.packetLoss}%</span>}
                              </td>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', color: h.pingMsStale ? '#f59e0b' : h.pingMs != null ? (h.pingMs < 50 ? '#22c55e' : h.pingMs < 150 ? '#f59e0b' : '#ef4444') : 'var(--text3)' }}>
                                {h.pingMsStale ? fmtStalePoll(h.pingMsPoll) : h.pingMs != null ? `${h.pingMs} ms` : '—'}
                              </td>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', color: 'var(--text2)', fontSize: 11 }}>{fmtUptime(h.uptime)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Widget>
                </>
              )
            })()}
          </div>
        )
      })()}

      {/* ═══════════ ROP DASHBOARD TAB (BH UPTIME) ═══════════ */}
      {configured && reachable && tab === 'rop' && (() => {
        const ru = ropUptime
        const summary = ru?.summary || { totalStores: 0, reportingStores: 0, avgUptimePct: null, slaTarget: ropSla, storesAboveSla: 0, storesBelowSla: 0, storesCurrentlyOffline: 0, totalDowntimeMin: 0, avgDowntimeMin: null, totalDisconnects: 0, mttrMin: null, bhMinutesPerStore: 0 }
        const trend = ru?.trend || []
        const perStore = ru?.perStore || []
        const days = ru?.days || []
        const segmentBhSummary = ru?.segmentBhSummary || {}
        const manualSdwanBh = segmentBhSummary.manualSdwan || { label: 'Manual ROP + SD-WAN', totalDowntimeMin: 0, totalDisconnects: 0, totalStores: 0, storeTags: [] }
        const rpNoSdwanBh = segmentBhSummary.rpNoSdwan || { label: 'ROP without SD-WAN', totalDowntimeMin: 0, totalDisconnects: 0, totalStores: 0, storeTags: [] }
        const segmentRows = [
          { ...manualSdwanBh, segment: manualSdwanBh.segment || 'manual_sdwan' },
          { ...rpNoSdwanBh, segment: rpNoSdwanBh.segment || 'rp_no_sdwan' },
        ]
        const segmentFilterTags = ropOutageFilter
          ? new Set(segmentRows.find((r) => r.segment === ropOutageFilter)?.storeTags || [])
          : null

        const scrollToStoreTable = () => {
          requestAnimationFrame(() => {
            ropStoreTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          })
        }
        const selectSegmentFilter = (segment) => {
          setRopOutageFilter((prev) => {
            const next = prev === segment ? null : segment
            if (next) scrollToStoreTable()
            return next
          })
        }

        const fmtMins = (m) => {
          if (m == null || !Number.isFinite(m)) return '—'
          if (m < 1) return '< 1 m'
          if (m < 60) return `${Math.round(m)} m`
          if (m < 1440) return `${(m / 60).toFixed(1)} h`
          return `${(m / 1440).toFixed(1)} d`
        }
        const fmtAge = (ms) => {
          if (!ms) return '—'
          const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
          if (sec < 60) return `${sec}s ago`
          if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
          if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
          return `${Math.floor(sec / 86400)}d ago`
        }
        const uptimeColor = (p) => {
          if (p == null) return '#1f2937'
          if (p >= 99.9) return '#16a34a'
          if (p >= 99.0) return '#65a30d'
          if (p >= 95.0) return '#ca8a04'
          if (p >= 90.0) return '#ea580c'
          return '#dc2626'
        }
        const uptimePill = (p) => {
          if (p == null) return { bg: 'rgba(100,116,139,.12)', color: '#94a3b8', border: 'var(--border)' }
          const c = uptimeColor(p)
          return { bg: `${c}22`, color: c, border: `${c}55` }
        }
        const slaTarget = summary.slaTarget ?? ropSla
        const slaMet = summary.avgUptimePct != null && summary.avgUptimePct >= slaTarget

        const filteredStore = perStore.filter((r) => {
          if (segmentFilterTags?.size && !segmentFilterTags.has(r.storeTag)) return false
          const q = ropSearch.trim().toLowerCase()
          if (!q) return true
          return (r.hostname || '').toLowerCase().includes(q) || (r.storeTag || '').toLowerCase().includes(q)
        })
        const sortedStore = [...filteredStore].sort((a, b) => {
          const dir = ropSortDir === 'desc' ? -1 : 1
          const va = a[ropSortKey]
          const vb = b[ropSortKey]
          if (va == null && vb == null) return 0
          if (va == null) return 1
          if (vb == null) return -1
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
          return String(va).localeCompare(String(vb)) * dir
        })
        const onSort = (k) => {
          if (ropSortKey === k) setRopSortDir((d) => d === 'asc' ? 'desc' : 'asc')
          else { setRopSortKey(k); setRopSortDir(k === 'hostname' || k === 'storeTag' ? 'asc' : 'desc') }
        }
        const sortArrow = (k) => ropSortKey === k ? (ropSortDir === 'asc' ? ' ▲' : ' ▼') : ''
        const dayOfWeekLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const groupKeyToLabel = {
          rp: 'All ROP',
          rp_sdwan: 'ROP + SD-WAN',
          rp_no_sdwan: 'ROP without SD-WAN',
          manual_sdwan: 'Manual ROP + SD-WAN',
          pos: 'POS Systems (LK)',
          sdwan: 'SD-WAN Stores',
        }
        const groupCounts = ru?.meta?.groupCounts || {}
        const manualRopCodeList = parseManualStoreCodes(manualRopCodesText)
        const manualMatched = groupCounts.manualMatched ?? 0
        const manualMissing = Math.max(0, (groupCounts.manualCodesConfigured ?? manualRopCodeList.length) - manualMatched)
        const ropSubCount = (key) => {
          if (key === 'rp') return groupCounts.rp
          if (key === 'rp_sdwan') return groupCounts.rp_sdwan
          if (key === 'rp_no_sdwan') return groupCounts.rp_no_sdwan
          if (key === 'manual_sdwan') return groupCounts.manual_sdwan
          return null
        }
        const selectRopGroup = (key) => {
          setRopGroupKey(key)
          setRopSearch('')
          setRopOutageFilter(null)
          if (key === 'manual_sdwan') setManualRopCodesOpen(true)
        }
        const saveManualRopCodes = async () => {
          setManualRopCodesSaving(true)
          setManualRopCodesSaved(false)
          try {
            const { data } = await api.put('/api/store-monitor/settings', { manualRopSdwanCodes: manualRopCodesDraft })
            setManualRopCodesText(data.manualRopSdwanCodes ?? manualRopCodesDraft)
            setManualRopCodesUpdatedAt(data.updatedAt ?? new Date().toISOString())
            setManualRopCodesSaved(true)
            await loadRopUptime({
              range: ropRange,
              customEpoch: ropCustomEpoch,
              groupKey: ropGroupKey,
              bhStart: ropBhStart,
              bhEnd: ropBhEnd,
              bhDays: ropBhDays,
              sla: ropSla,
            })
          } catch (e) {
            const { message } = parseErr(e)
            setError(message)
          } finally {
            setManualRopCodesSaving(false)
          }
        }
        const rangeChips = [
          { id: '24h', label: '24h' },
          { id: '7d',  label: '7d' },
          { id: '14d', label: '14d' },
          { id: '30d', label: '30d' },
          { id: 'custom', label: 'Custom' },
        ]
        const rangeSummaryLabel = (() => {
          if (ropRange === 'custom' && ropCustomEpoch) {
            const from = new Date(ropCustomEpoch.from).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const to = new Date(ropCustomEpoch.to).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            return `${from} – ${to}`
          }
          const rangeDisplay = { '24h': 'Last 24h', '7d': 'Last 7 days', '14d': 'Last 14 days', '30d': 'Last 30 days', custom: 'Custom' }
          return rangeDisplay[ropRange] || ropRange
        })()
        const toggleBhDay = (d) => {
          const next = new Set(ropBhDays)
          if (next.has(d)) next.delete(d); else next.add(d)
          if (next.size === 0) return
          setRopBhDays(next)
        }
        const presetWeekdays = () => setRopBhDays(new Set([1, 2, 3, 4, 5]))
        const presetEveryday = () => setRopBhDays(new Set([0, 1, 2, 3, 4, 5, 6]))
        const seedCustomRange = (daysBack = 7) => {
          const to = Math.floor(Date.now() / 1000)
          const from = to - daysBack * 86400
          const fromStr = toLocalInput(from)
          const toStr = toLocalInput(to)
          setRopCustomFrom(fromStr)
          setRopCustomTo(toStr)
          setRopCustomEpoch({ from: fromStr, to: toStr })
        }
        const selectRopRange = (id) => {
          setRopRange(id)
          if (id === 'custom') {
            if (!ropCustomEpoch) seedCustomRange(7)
            else {
              setRopCustomFrom(ropCustomEpoch.from)
              setRopCustomTo(ropCustomEpoch.to)
            }
          } else {
            setRopCustomEpoch(null)
          }
        }
        const applyRopCustomRange = () => {
          if (!ropCustomFrom || !ropCustomTo) return
          const fromTs = Math.floor(new Date(ropCustomFrom).getTime() / 1000)
          const toTs = Math.floor(new Date(ropCustomTo).getTime() / 1000)
          if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || fromTs >= toTs) return
          setRopCustomEpoch({ from: ropCustomFrom, to: ropCustomTo })
        }
        const bhSummary = (() => {
          const allDays = ropBhDays.size === 7
          const weekdays = ropBhDays.size === 5 && [1,2,3,4,5].every((d) => ropBhDays.has(d))
          const dayLabel = allDays ? 'Every day' : weekdays ? 'Mon–Fri' : [...ropBhDays].sort().map((d) => dayOfWeekLabels[d]).join(', ')
          return `${String(ropBhStart).padStart(2,'0')}:00 – ${String(ropBhEnd).padStart(2,'0')}:00 · ${dayLabel}`
        })()
        const customRangeValid = ropCustomFrom && ropCustomTo
          && Number.isFinite(new Date(ropCustomFrom).getTime())
          && Number.isFinite(new Date(ropCustomTo).getTime())
          && new Date(ropCustomFrom) < new Date(ropCustomTo)

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* ── Toolbar: range + group + business hours + SLA ── */}
            <div className="rop-toolbar">
              <div className="rop-toolbar-row">
                <div className="rop-field">
                  <span className="rop-field-label">Range</span>
                  <div className="rop-segment">
                    {rangeChips.map((c) => (
                      <button key={c.id} type="button"
                        className={`rop-segment-btn${ropRange === c.id ? ' active' : ''}`}
                        onClick={() => selectRopRange(c.id)}
                        title={c.id === '24h' ? 'Last 24 hours' : c.id === '7d' ? 'Last 7 days' : c.id === '14d' ? 'Last 14 days' : c.id === '30d' ? 'Last 30 days' : 'Custom range'}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rop-field-divider" />

                <div className="rop-field">
                  <span className="rop-field-label">Group</span>
                  <select value={isRpGroupKey(ropGroupKey) ? '' : ropGroupKey}
                    onChange={(e) => { if (e.target.value) selectRopGroup(e.target.value) }}
                    className="rop-control rop-control--select">
                    <option value="">{isRpGroupKey(ropGroupKey) ? 'ROP groups…' : groupKeyToLabel[ropGroupKey]}</option>
                    <option value="pos">{groupKeyToLabel.pos}</option>
                    <option value="sdwan">{groupKeyToLabel.sdwan}</option>
                  </select>
                </div>

                <div className="rop-field-divider" />

                <div className="rop-field">
                  <span className="rop-field-label">BH</span>
                  <select value={ropBhStart} onChange={(e) => setRopBhStart(Number(e.target.value))}
                    className="rop-control rop-control--time">
                    {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
                  </select>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>–</span>
                  <select value={ropBhEnd} onChange={(e) => setRopBhEnd(Number(e.target.value))}
                    className="rop-control rop-control--time">
                    {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
                  </select>
                </div>

                <div className="rop-field-divider" />

                <div className="rop-field">
                  <div className="rop-day-row">
                    {dayOfWeekLabels.map((lbl, idx) => {
                      const on = ropBhDays.has(idx)
                      return (
                        <button key={idx} type="button" onClick={() => toggleBhDay(idx)}
                          className={`rop-day-btn${on ? ' active' : ''}`}
                          title={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][idx]}>
                          {lbl}
                        </button>
                      )
                    })}
                  </div>
                  <button type="button" onClick={presetWeekdays} className="rop-action-btn rop-action-btn--ghost">Mon–Fri</button>
                  <button type="button" onClick={presetEveryday} className="rop-action-btn rop-action-btn--ghost">All</button>
                </div>

                <div className="rop-field-divider" />

                <div className="rop-field">
                  <span className="rop-field-label">SLA</span>
                  <input type="number" min={0} max={100} step={0.1} value={ropSla}
                    onChange={(e) => setRopSla(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    className="rop-control rop-control--num" />
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>%</span>
                </div>

                {ru?.rangeFromIso && (
                  <span className="rop-meta rop-meta--muted" title="Data source and active BH window">
                    StoreProblemHistory · {bhSummary}
                  </span>
                )}

                <div className="rop-toolbar-spacer" />

                <button type="button" onClick={exportRopDisconnectExcel}
                  disabled={ropExportBusy || (ropRange === 'custom' && !ropCustomEpoch)}
                  className="rop-action-btn"
                  title="Export all disconnect and reconnect events per store (Excel)">
                  {ropExportBusy ? 'Exporting…' : 'Export Excel'}
                </button>
              </div>

              {ropRange === 'custom' && (
                <div className="rop-toolbar-row rop-toolbar-row--sub">
                  <div className="rop-field">
                    <span className="rop-field-label">Custom</span>
                    <input type="datetime-local" value={ropCustomFrom} onChange={(e) => setRopCustomFrom(e.target.value)}
                      className="rop-control rop-control--datetime" />
                    <span style={{ fontSize: 10, color: 'var(--text3)' }}>–</span>
                    <input type="datetime-local" value={ropCustomTo} onChange={(e) => setRopCustomTo(e.target.value)}
                      className="rop-control rop-control--datetime" />
                    <button type="button" onClick={applyRopCustomRange} disabled={!customRangeValid}
                      className="rop-action-btn">Apply</button>
                    {ropCustomEpoch && (
                      <span className="rop-meta">
                        {new Date(ropCustomEpoch.from).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {' – '}
                        {new Date(ropCustomEpoch.to).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {!ropCustomEpoch && (
                      <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                        Pick dates and click Apply
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── ROP group sub-tabs (Store Monitor parity) ── */}
            <div className="rop-subtabs">
              {ROP_SUBTABS.map((st) => {
                const count = ropSubCount(st.id)
                const active = ropGroupKey === st.id
                return (
                  <button key={st.id} type="button" onClick={() => selectRopGroup(st.id)}
                    className={`rop-subtab${active ? ' active' : ''}`}>
                    <span style={{ opacity: 0.7 }}>{st.icon}</span>
                    <span>{st.label}</span>
                    {count != null && <span className="rop-subtab-count">{count}</span>}
                  </button>
                )
              })}
              {!isRpGroupKey(ropGroupKey) && (
                <span style={{ marginLeft: 'auto', marginRight: 14, fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
                  Viewing: {groupKeyToLabel[ropGroupKey]}
                </span>
              )}
            </div>

            {ropGroupKey === 'manual_sdwan' && (
              <div style={{ borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg2)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', borderBottom: manualRopCodesOpen ? '1px solid var(--border)' : 'none' }}
                  onClick={() => setManualRopCodesOpen((v) => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>⚙ Manual ROP + SD-WAN — Store Code Settings</span>
                  <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                    {manualRopCodeList.length} configured · {manualMatched} matched · {manualMissing} no data
                    {manualRopCodesUpdatedAt && ` · saved ${relAge(Math.floor(new Date(manualRopCodesUpdatedAt).getTime() / 1000))} ago`}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>{manualRopCodesOpen ? '▲' : '▼'}</span>
                </div>
                {manualRopCodesOpen && (
                  <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
                      Paste store codes — one per line, or comma / semicolon separated. Matches by store tag, hostname, or serial.
                      {' '}<strong style={{ color: 'var(--text2)' }}>Saved to the server and shared with Store Monitor.</strong>
                    </div>
                    <textarea
                      rows={8}
                      placeholder={'S001\nS002\nRP1234\n1234'}
                      value={manualRopCodesDraft}
                      onChange={(e) => { setManualRopCodesDraft(e.target.value); setManualRopCodesSaved(false) }}
                      style={{ width: '100%', minHeight: 140, fontFamily: 'var(--mono)', fontSize: 11.5, resize: 'vertical', lineHeight: 1.7, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)' }}
                    />
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button type="button" onClick={saveManualRopCodes} disabled={manualRopCodesSaving}
                        style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: manualRopCodesSaving ? 'wait' : 'pointer', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 700, fontFamily: 'var(--mono)', opacity: manualRopCodesSaving ? 0.7 : 1 }}>
                        {manualRopCodesSaving ? 'Saving…' : '💾 Save to server'}
                      </button>
                      <button type="button" disabled={manualRopCodesSaving}
                        onClick={() => { setManualRopCodesDraft(manualRopCodesText); setManualRopCodesSaved(false) }}
                        style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                        ✕ Cancel
                      </button>
                      {manualRopCodesSaved && (
                        <span style={{ fontSize: 11, color: '#22c55e', fontFamily: 'var(--mono)' }}>✓ Saved — dashboard refreshed</span>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                        {parseManualStoreCodes(manualRopCodesDraft).length} codes
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {ropUptimeBusy && !ru && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                <span className="np-page-loading-dot" /> Computing business-hours uptime…
              </div>
            )}

            {ru && (
              <>
                {/* ── Executive KPI strip: hero availability + 5 secondary tiles ── */}
                {(() => {
                  const offlineTone = summary.storesCurrentlyOffline > 0 ? 'bad' : 'ok'
                  const belowSlaTone = summary.storesBelowSla > 0 ? 'warn' : 'ok'
                  const downtimeTone = (summary.avgDowntimeMin || 0) > 60 ? 'warn' : 'ok'
                  const disconnectAvg = summary.totalStores
                    ? summary.totalDisconnects / Math.max(summary.totalStores, 1)
                    : 0
                  const discTone = disconnectAvg > 2 ? 'warn' : 'ok'
                  const slaDelta = summary.avgUptimePct != null
                    ? (summary.avgUptimePct - slaTarget)
                    : null
                  return (
                    <div className="rop-kpi-grid">
                      <div className="rop-hero">
                        <div className="rop-hero-main">
                          <div className="rop-hero-label">
                            BH availability
                            {summary.bhMinutesPerStore > 0 ? ` · ${(summary.bhMinutesPerStore / 60).toFixed(1)}h` : ''}
                          </div>
                          <div className="rop-hero-headline">
                            <span className="rop-hero-value" style={{ color: uptimeColor(summary.avgUptimePct) }}>
                              {summary.avgUptimePct != null ? summary.avgUptimePct.toFixed(2) : '—'}
                            </span>
                            <span className="rop-hero-unit">%</span>
                          </div>
                        </div>
                        <div className="rop-hero-side">
                          <div className="rop-hero-bar">
                            <div className="rop-hero-bar-fill" style={{
                              width: `${Math.max(0, Math.min(100, summary.avgUptimePct ?? 0))}%`,
                              background: slaMet
                                ? 'linear-gradient(90deg,#22c55e,#16a34a)'
                                : 'linear-gradient(90deg,#f97316,#dc2626)',
                            }} />
                            <div className="rop-hero-bar-target" style={{ left: `${slaTarget}%` }} title={`SLA target ${slaTarget}%`} />
                          </div>
                          <div className="rop-hero-foot">
                            <span>
                              <span className="rop-status-dot" style={{ background: slaMet ? '#16a34a' : '#dc2626', marginRight: 4 }} />
                              <strong style={{ color: slaMet ? '#16a34a' : '#dc2626' }}>{slaMet ? 'Meeting SLA' : 'Below SLA'}</strong>
                              {slaDelta != null && (
                                <span style={{ marginLeft: 4, color: 'var(--text3)' }}>
                                  ({slaDelta >= 0 ? '+' : ''}{slaDelta.toFixed(2)}%)
                                </span>
                              )}
                            </span>
                            <span>
                              <strong>{summary.reportingStores}</strong>/{summary.totalStores}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className={`rop-stat rop-stat--${belowSlaTone}`}>
                        <div className="rop-stat-head">
                          <span className="rop-stat-label">Below SLA</span>
                          <span className="rop-stat-icon">⚠</span>
                        </div>
                        <div className="rop-stat-value">{summary.storesBelowSla}</div>
                        <div className={`rop-stat-foot ${summary.storesBelowSla > 0 ? 'rop-stat-foot--warn' : 'rop-stat-foot--ok'}`}>
                          {summary.storesAboveSla} above
                        </div>
                      </div>

                      <div className={`rop-stat rop-stat--${offlineTone}`}>
                        <div className="rop-stat-head">
                          <span className="rop-stat-label">Offline now</span>
                          <span className="rop-stat-icon">●</span>
                        </div>
                        <div className="rop-stat-value">{summary.storesCurrentlyOffline}</div>
                        <div className={`rop-stat-foot ${summary.storesCurrentlyOffline > 0 ? 'rop-stat-foot--bad' : 'rop-stat-foot--ok'}`}>
                          {summary.storesCurrentlyOffline > 0
                            ? `${((summary.storesCurrentlyOffline / Math.max(summary.totalStores, 1)) * 100).toFixed(1)}% fleet`
                            : 'All online'}
                        </div>
                      </div>

                      <div className={`rop-stat rop-stat--${downtimeTone}`}>
                        <div className="rop-stat-head">
                          <span className="rop-stat-label">Avg downtime</span>
                          <span className="rop-stat-icon">⏱</span>
                        </div>
                        <div className="rop-stat-value">{fmtMins(summary.avgDowntimeMin)}</div>
                        <div className="rop-stat-foot">
                          per store · BH
                        </div>
                      </div>

                      <div className={`rop-stat rop-stat--${discTone}`}>
                        <div className="rop-stat-head">
                          <span className="rop-stat-label">Disconnects</span>
                          <span className="rop-stat-icon">↯</span>
                        </div>
                        <div className="rop-stat-value">{summary.totalDisconnects.toLocaleString()}</div>
                        <div className="rop-stat-foot">
                          {summary.totalStores ? `${disconnectAvg.toFixed(2)}/store` : '—'}
                        </div>
                      </div>

                      <div className="rop-stat">
                        <div className="rop-stat-head">
                          <span className="rop-stat-label">MTTR</span>
                          <span className="rop-stat-icon">↺</span>
                        </div>
                        <div className="rop-stat-value">
                          {summary.mttrMin != null ? fmtMins(summary.mttrMin) : '—'}
                        </div>
                        <div className="rop-stat-foot">
                          resolved outages
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {isRpGroupKey(ropGroupKey) && (
                  <Widget
                    title="ROP outage summary"
                    badge="BH · range"
                    badgeColor="amber"
                    noPad
                    actions={
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="opm-pill" style={{ background: 'rgba(100,116,139,.1)', color: 'var(--text3)', border: '1px solid var(--border)', fontSize: 10, fontFamily: 'var(--mono)' }}>
                          BH: {bhSummary}
                        </span>
                        <span className="opm-pill" style={{ background: 'rgba(59,130,246,.1)', color: 'var(--accent)', border: '1px solid rgba(59,130,246,.25)', fontSize: 10, fontFamily: 'var(--mono)' }}>
                          Range: {rangeSummaryLabel}
                        </span>
                        {ropOutageFilter && (
                          <button type="button" onClick={() => setRopOutageFilter(null)}
                            className="opm-pill"
                            style={{ background: 'rgba(239,68,68,.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)', fontSize: 10, cursor: 'pointer', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                            ✕ Clear {RP_OUTAGE_LABELS[ropOutageFilter]} filter
                          </button>
                        )}
                      </div>
                    }
                  >
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                            {['Group', 'Avg downtime (BH)', 'Disconnect events (avg / store)', 'Stores'].map((lbl) => (
                              <th key={lbl} style={{ padding: '10px 14px', textAlign: lbl === 'Group' ? 'left' : 'right', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>
                                {lbl}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {segmentRows.map((row) => {
                            const active = ropOutageFilter === row.segment
                            const stores = row.totalStores || 0
                            const totalDown = row.totalDowntimeMin || 0
                            const avgDownMin = stores > 0 ? totalDown / stores : 0
                            const bhWindowMin = summary.bhMinutesPerStore || 0
                            const avgDownPct = bhWindowMin > 0 ? (avgDownMin / bhWindowMin) * 100 : null
                            const totalDisc = row.totalDisconnects || 0
                            const avgDisc = stores > 0 ? totalDisc / stores : 0
                            const hasIssue = totalDown > 0 || totalDisc > 0
                            return (
                              <tr key={row.segment}
                                onClick={() => selectSegmentFilter(row.segment)}
                                style={{
                                  borderBottom: '1px solid rgba(128,128,160,.08)',
                                  cursor: 'pointer',
                                  background: active ? 'rgba(59,130,246,.08)' : undefined,
                                }}
                                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
                                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? 'rgba(59,130,246,.08)' : '' }}>
                                <td style={{ padding: '12px 14px', fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                                  {row.label || RP_OUTAGE_LABELS[row.segment]}
                                </td>
                                <td style={{ padding: '12px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color: hasIssue ? '#ef4444' : 'var(--text2)' }}>
                                    {avgDownPct != null ? `${avgDownPct.toFixed(2)}%` : '—'}
                                  </div>
                                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                                    {fmtMins(avgDownMin)} / store · {fmtMins(totalDown)} total
                                  </div>
                                </td>
                                <td style={{ padding: '12px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color: totalDisc > 0 ? '#f97316' : 'var(--text2)' }}>
                                    {stores > 0 ? avgDisc.toFixed(2) : '—'}
                                  </div>
                                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                                    {totalDisc.toLocaleString()} total
                                  </div>
                                </td>
                                <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text3)', fontSize: 11 }}>
                                  {stores}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ padding: '8px 14px', borderTop: '1px dashed var(--border)', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                      Click a row to filter the store list below · averages are per store within the configured business-hours window
                    </div>
                  </Widget>
                )}

                {/* ── Trend chart (auto hourly for short ranges) ── */}
                {trend.length > 0 && (() => {
                  const isHourly = ru?.granularity === 'hour'
                  const pts = trend.map((t) => t.avgUptimePct)
                  const labels = trend.map((t) => t.displayLabel ?? (t.label || '').slice(5))
                  const validPts = pts.filter((p) => p != null)
                  const minPct = validPts.length
                    ? Math.min(slaTarget - 1, ...validPts)
                    : slaTarget - 1
                  const yMin = Math.max(0, Math.floor((minPct - 0.5) * 10) / 10)
                  const showAsBar = isHourly || trend.length <= 3
                  const ChartComp = showAsBar ? Bar : Line
                  const data = {
                    labels,
                    datasets: showAsBar
                      ? [
                          {
                            type: 'bar',
                            label: 'BH uptime %',
                            data: pts,
                            backgroundColor: pts.map((p) => p == null ? 'rgba(148,163,184,.25)' : `${uptimeColor(p)}cc`),
                            borderColor: pts.map((p) => p == null ? 'rgba(148,163,184,.4)' : uptimeColor(p)),
                            borderWidth: 1,
                            borderRadius: 4,
                            maxBarThickness: 28,
                          },
                          {
                            type: 'line',
                            label: `SLA ${slaTarget}%`,
                            data: trend.map(() => slaTarget),
                            borderColor: 'rgba(239,68,68,.85)',
                            borderDash: [6, 4],
                            borderWidth: 2,
                            pointRadius: 0,
                            fill: false,
                            tension: 0,
                          },
                        ]
                      : [
                          {
                            label: 'BH uptime %',
                            data: pts,
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59,130,246,.12)',
                            fill: true,
                            tension: 0.35,
                            spanGaps: true,
                            pointRadius: 3,
                            pointHoverRadius: 6,
                            pointBackgroundColor: pts.map((p) => uptimeColor(p)),
                            pointBorderColor: '#fff',
                            pointBorderWidth: 1,
                            borderWidth: 2,
                          },
                          {
                            label: `SLA ${slaTarget}%`,
                            data: trend.map(() => slaTarget),
                            borderColor: 'rgba(239,68,68,.85)',
                            borderDash: [6, 4],
                            borderWidth: 2,
                            pointRadius: 0,
                            fill: false,
                            tension: 0,
                          },
                        ],
                  }
                  const opts = {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                      legend: { display: true, position: 'top', labels: { color: 'var(--text3)', font: { family: 'var(--mono)', size: 11 }, usePointStyle: true, boxWidth: 8 } },
                      tooltip: {
                        backgroundColor: 'rgba(15,17,23,.95)', borderColor: 'rgba(79,126,245,.3)', borderWidth: 1, cornerRadius: 8,
                        callbacks: {
                          label: (ctx) => {
                            const point = trend[ctx.dataIndex]
                            if (ctx.dataset.label?.startsWith('SLA')) return ` ${ctx.dataset.label}`
                            const lines = [
                              ` Uptime: ${point.avgUptimePct != null ? point.avgUptimePct.toFixed(2) + '%' : '— (outside BH)'}`,
                              ` Downtime: ${fmtMins(point.totalDowntimeMin)}`,
                            ]
                            if (point.totalDisconnects != null) lines.push(` Disconnects: ${point.totalDisconnects}`)
                            if (point.storesImpacted != null) lines.push(` Stores impacted: ${point.storesImpacted}`)
                            return lines
                          },
                        },
                      },
                    },
                    scales: {
                      x: { ticks: { color: 'var(--text3)', font: { family: 'var(--mono)', size: 10 }, autoSkip: true, maxRotation: 0 }, grid: { display: false } },
                      y: { min: yMin, max: 100, ticks: { color: 'var(--text3)', font: { family: 'var(--mono)', size: 10 }, callback: (v) => `${v}%` }, grid: { color: 'rgba(128,128,160,.06)' } },
                    },
                  }
                  const granularityLabel = isHourly
                    ? `${trend.length} hour${trend.length === 1 ? '' : 's'} · BH-only`
                    : `${trend.length} day${trend.length === 1 ? '' : 's'}`
                  return (
                    <Widget
                      title={isHourly ? 'Hourly availability trend' : 'Daily availability trend'}
                      badge={granularityLabel}
                      badgeColor="blue">
                      <div style={{ height: 240 }}>
                        <ChartComp data={data} options={opts} />
                      </div>
                    </Widget>
                  )
                })()}

                {/* ── Store uptime / downtime with inline graph per row ── */}
                <Widget
                  title="Store uptime & downtime"
                  badge={`${sortedStore.length} in ${groupKeyToLabel[ropGroupKey] || ropGroupKey}`}
                  badgeColor="blue"
                  noPad
                  actions={
                    <div className="opm-search" style={{ maxWidth: 220 }}>
                      <span className="opm-search-icon">⌕</span>
                      <input placeholder="Filter hostname…" value={ropSearch} onChange={(e) => setRopSearch(e.target.value)} />
                    </div>
                  }
                >
                  <div style={{ overflowX: 'auto', maxHeight: 640, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: '22%' }} />
                        <col style={{ width: '10%' }} />
                        <col style={{ width: '11%' }} />
                        <col style={{ width: '9%' }} />
                        <col />
                      </colgroup>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                          {[
                            ['Hostname', 'left'],
                            ['BH uptime %', 'right'],
                            ['BH downtime', 'right'],
                            ['Live', 'right'],
                            ['Uptime graph', 'left'],
                          ].map(([lbl, align]) => (
                            <th key={lbl} style={{ padding: '9px 12px', textAlign: align, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>
                              {lbl}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedStore.length === 0 && (
                          <tr><td colSpan={5} style={{ padding: 28, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No stores in this group.</td></tr>
                        )}
                        {sortedStore.slice(0, 800).map((s) => {
                          const pill = uptimePill(s.uptimePct)
                          const barColor = uptimeColor(s.uptimePct)
                          return (
                            <tr key={s.storeTag}
                              style={{ borderBottom: '1px solid rgba(128,128,160,.06)' }}>
                              <td
                                onClick={() => openRopDisconnect(s)}
                                style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                                title={`${s.hostname || s.storeTag} (${s.storeTag}) — click for disconnect events`}
                                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
                                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}>
                                {s.hostname || s.storeTag}
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <span className="opm-pill" style={{ background: pill.bg, color: pill.color, border: `1px solid ${pill.border}`, fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11 }}>
                                  {s.uptimePct != null ? `${s.uptimePct.toFixed(2)}%` : '—'}
                                </span>
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: s.bizDownMin > 0 ? '#f59e0b' : 'var(--text3)', fontSize: 11, whiteSpace: 'nowrap' }}>
                                {fmtMins(s.bizDownMin)}
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {s.currentlyOffline
                                  ? <span className="opm-pill" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)', fontSize: 10 }}>OFFLINE</span>
                                  : <span className="opm-pill" style={{ background: 'rgba(34,197,94,.10)', color: '#22c55e', border: '1px solid rgba(34,197,94,.20)', fontSize: 10 }}>Online</span>}
                              </td>
                              <td style={{ padding: '8px 12px', verticalAlign: 'middle' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
                                  <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'var(--bg4)', overflow: 'hidden', position: 'relative' }}
                                    title={s.uptimePct != null ? `${s.uptimePct.toFixed(2)}% BH uptime · ${fmtMins(s.bizDownMin)} down · ${s.disconnects} disconnects` : 'No data'}>
                                    <div style={{ width: `${Math.max(0, Math.min(100, s.uptimePct ?? 0))}%`, height: '100%', background: barColor, borderRadius: 5, transition: 'width .25s ease' }} />
                                  </div>
                                  {s.dailyUptimePcts?.length > 0 && (
                                    <div style={{ display: 'flex', gap: 1, height: 18, alignItems: 'flex-end', flexShrink: 0 }}>
                                      {s.dailyUptimePcts.map((p, i) => {
                                        const c = uptimeColor(p)
                                        const h = p == null ? 3 : Math.max(2, Math.round((p / 100) * 18))
                                        return (
                                          <div key={i} title={`${days[i]?.label}: ${p != null ? p.toFixed(2) + '%' : 'no data'}`}
                                            style={{ width: 4, height: h, background: c, opacity: p == null ? 0.25 : 1, borderRadius: 1 }} />
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {sortedStore.length > 800 && (
                      <div style={{ padding: '10px 12px', textAlign: 'center', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', borderTop: '1px solid var(--border)' }}>
                        Showing first 800 of {sortedStore.length} — use search to narrow.
                      </div>
                    )}
                  </div>
                </Widget>

                {/* ── Per-store table ── */}
                <div ref={ropStoreTableRef}>
                <Widget
                  title={ropOutageFilter ? `${RP_OUTAGE_LABELS[ropOutageFilter]} stores` : 'All stores'}
                  badge={`${sortedStore.length}${sortedStore.length !== perStore.length ? ` / ${perStore.length}` : ''}`}
                  badgeColor="blue"
                  noPad
                  actions={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {ropOutageFilter && (
                        <button type="button" onClick={() => setRopOutageFilter(null)}
                          className="opm-pill"
                          style={{ background: 'rgba(239,68,68,.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)', fontSize: 10, cursor: 'pointer', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                          ✕ {RP_OUTAGE_LABELS[ropOutageFilter]}
                        </button>
                      )}
                      <div className="opm-search" style={{ maxWidth: 260 }}>
                        <span className="opm-search-icon">⌕</span>
                        <input placeholder="Search hostname or store tag…" value={ropSearch} onChange={(e) => setRopSearch(e.target.value)} />
                      </div>
                    </div>
                  }
                >
                  <div style={{ overflowX: 'auto', maxHeight: 540, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                          {[
                            ['hostname',         'Store / Hostname',    'left'],
                            ['storeTag',         'Tag',                 'left'],
                            ['currentlyOffline', 'Live',                'left'],
                            ['uptimePct',        'BH uptime %',         'right'],
                            ['bizDownMin',       'BH downtime',         'right'],
                            ['disconnects',      'Disconnects',         'right'],
                            ['longestOutageMin', 'Longest outage',      'right'],
                            ['lastOfflineMs',    'Last offline',        'left'],
                            [null,               'Daily trend (7-30d)', 'left'],
                          ].map(([k, lbl, align]) => (
                            <th key={lbl}
                              onClick={() => k && onSort(k)}
                              style={{ padding: '9px 12px', textAlign: align, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap', cursor: k ? 'pointer' : 'default', userSelect: 'none' }}>
                              {lbl}{k ? sortArrow(k) : ''}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedStore.length === 0 && (
                          <tr><td colSpan={9} style={{ padding: 28, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                            {perStore.length === 0
                              ? (ropGroupKey === 'manual_sdwan' && manualRopCodeList.length === 0
                                ? 'Add store codes in Manual ROP + SD-WAN settings above to build this dashboard.'
                                : 'No stores in this group.')
                              : ropOutageFilter
                                ? `No stores in ${RP_OUTAGE_LABELS[ropOutageFilter]}.`
                                : ropSearch.trim()
                                  ? `No stores match "${ropSearch}".`
                                  : 'No stores match the current filters.'}
                          </td></tr>
                        )}
                        {sortedStore.slice(0, 800).map((s) => {
                          const pillStyle = uptimePill(s.uptimePct)
                          const belowSla = s.uptimePct != null && s.uptimePct < slaTarget
                          return (
                            <tr key={s.storeTag}
                              style={{ borderBottom: '1px solid rgba(128,128,160,.06)' }}>
                              <td
                                onClick={() => openRopDisconnect(s)}
                                style={{ padding: '7px 12px', color: 'var(--accent)', fontWeight: 600, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                                title={`${s.hostname || s.storeTag} — click for disconnect events`}
                                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
                                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}>
                                {s.hostname || s.storeTag}
                                {belowSla && <span className="opm-pill" style={{ marginLeft: 8, background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)' }}>SLA</span>}
                              </td>
                              <td style={{ padding: '7px 12px', color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap' }}>{s.storeTag}</td>
                              <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                                {s.currentlyOffline
                                  ? <span className="opm-pill" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,.25)' }}>● OFFLINE</span>
                                  : <span className="opm-pill" style={{ background: 'rgba(34,197,94,.10)', color: '#22c55e', border: '1px solid rgba(34,197,94,.20)' }}>● Online</span>}
                              </td>
                              <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <span className="opm-pill" style={{ background: pillStyle.bg, color: pillStyle.color, border: `1px solid ${pillStyle.border}`, fontFamily: 'var(--mono)', fontWeight: 700 }}>
                                  {s.uptimePct != null ? `${s.uptimePct.toFixed(2)}%` : '—'}
                                </span>
                              </td>
                              <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: s.bizDownMin > 0 ? '#f59e0b' : 'var(--text3)' }}>{fmtMins(s.bizDownMin)}</td>
                              <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: s.disconnects > 0 ? 'var(--text)' : 'var(--text3)' }}>{s.disconnects}</td>
                              <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: s.longestOutageMin > 0 ? '#ef4444' : 'var(--text3)' }}>{fmtMins(s.longestOutageMin)}</td>
                              <td style={{ padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }} title={s.lastOfflineMs ? new Date(s.lastOfflineMs).toLocaleString() : undefined}>{fmtAge(s.lastOfflineMs)}</td>
                              <td style={{ padding: '7px 12px' }}>
                                <div style={{ display: 'flex', gap: 1, height: 18, alignItems: 'flex-end' }}>
                                  {s.dailyUptimePcts.map((p, i) => {
                                    const c = uptimeColor(p)
                                    const h = p == null ? 4 : Math.max(2, Math.round((p / 100) * 18))
                                    const op = p == null ? 0.25 : 1
                                    return <div key={i} title={`${days[i]?.label}: ${p != null ? p.toFixed(2) + '%' : 'no data'}`}
                                      style={{ width: 4, height: h, background: c, opacity: op, borderRadius: 1 }} />
                                  })}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {sortedStore.length > 800 && (
                      <div style={{ padding: '10px 12px', textAlign: 'center', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', borderTop: '1px solid var(--border)' }}>
                        Showing first 800 of {sortedStore.length} stores — refine the search above to narrow.
                      </div>
                    )}
                  </div>
                </Widget>
                </div>
              </>
            )}
          </div>
        )
      })()}

      <RopDisconnectModal
        open={!!ropDisconnectStore}
        store={ropDisconnectStore}
        events={ropDisconnectEvents}
        loading={ropDisconnectBusy}
        error={ropDisconnectError}
        rangeLabel={ropDisconnectRangeLabel}
        bhLabel={ropBhLabel}
        onClose={() => setRopDisconnectStore(null)}
      />
    </div>
  )
}

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

function ItemHistoryChart({ itemId, itemName, itemUnits, chartOpts }) {
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
    api.get(`/api/zabbix/items/${encodeURIComponent(itemId)}/history?from=${from}&to=${to}&maxPoints=500`)
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
  }, [itemId, range, customEpoch])

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

function LatestMetricsView({ latestData, chartOpts }) {
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

function TopUtilWidget({ rows, accent, unitSuffix = '%', emptyMsg = 'No data available.', onRowClick, showMount, showBytes }) {
  if (!rows?.length) {
    return <div style={{ color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', padding: '16px 4px' }}>{emptyMsg}</div>
  }
  const barColor = (pct) => {
    if (pct >= 90) return '#ef4444'
    if (pct >= 75) return '#f59e0b'
    if (pct >= 50) return '#eab308'
    return accent || '#22c55e'
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map((r, i) => {
        const pct = Number(r.percent) || 0
        const c = barColor(pct)
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
              <div style={{ width: `${Math.max(2, Math.min(100, pct))}%`, height: '100%', borderRadius: 3, background: c, transition: 'width .35s ease' }} />
            </div>
            <span style={{ minWidth: 52, textAlign: 'right', fontWeight: 800, color: c, flexShrink: 0, fontSize: 12 }}>
              {pct.toFixed(1)}{unitSuffix}
            </span>
          </div>
        )
      })}
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
function GraphPanel({ graph, series, chartData, chartOpts, busy, graphDataMode }) {
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
          <LatestMetricsView latestData={{ latest: latestItems }} chartOpts={chartOpts} />
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
export default function InfraMonitoringPage() {
  const [tab, setTab] = useState('overview')
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
  const [problemAckBusy, setProblemAckBusy] = useState(null)
  const hostListRef = useRef(null)

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
    const { data: ov } = await api.get(`/api/zabbix/overview${suf}`)
    setOverview(ov)
  }, [dashboardGroupFilter, dashboardSearch])
  const loadHosts = useCallback(async () => { const { data } = await api.get('/api/zabbix/hosts'); setHosts(data.hosts || []) }, [])
  const loadAllHosts = useCallback(async () => {
    const { data } = await api.get('/api/zabbix/hosts?limit=500')
    setHostsExplorer(data.hosts || [])
  }, [])
  const loadHostGraphs = useCallback(async (hostid) => { const { data } = await api.get(`/api/zabbix/hosts/${encodeURIComponent(hostid)}/graphs`); const g = data.graphs || []; setHostGraphs(g); return g }, [])
  const loadHostItemsLatest = useCallback(async (hostid) => {
    setItemsLatestBusy(true); setError(null); setErrorHint(null)
    try { const { data } = await api.get(`/api/zabbix/hosts/${encodeURIComponent(hostid)}/items/latest?limit=100`); setHostItemsLatest(data) }
    catch (e) { const { message, hint } = parseErr(e); setError(message); setErrorHint(hint); setHostItemsLatest(null) }
    finally { setItemsLatestBusy(false) }
  }, [parseErr])
  const fetchGraphSeries = useCallback(async (graphId, rangeKey, dataMode, customRange) => {
    let from, to
    if (customRange?.from && customRange?.to) {
      from = customRange.from; to = customRange.to
    } else {
      const sec = RANGE_SEC[rangeKey] || RANGE_SEC['12h']; to = Math.floor(Date.now() / 1000); from = to - sec
    }
    const qs = new URLSearchParams({ from: String(from), to: String(to) })
    if (dataMode === 'latest') qs.set('mode', 'latest')
    const { data } = await api.get(`/api/zabbix/graphs/${encodeURIComponent(graphId)}/series?${qs}`); return data
  }, [])
  const loadEvents = useCallback(async (lim) => { const { data } = await api.get(`/api/zabbix/events?limit=${lim || eventLimit}`); setEvents(data.events || []) }, [eventLimit])
  const loadTopUtil = useCallback(async (lim) => {
    const { data } = await api.get(`/api/zabbix/top-utilization?limit=${lim || topLimit}`)
    setTopUtil(data)
  }, [topLimit])

  const refetchProblems = useCallback(async () => {
    const qs = new URLSearchParams({ limit: '250' })
    if (severityFilter != null) qs.set('severity', String(severityFilter))
    const { data } = await api.get(`/api/zabbix/problems?${qs}`)
    setProblemsFull(data.problems || [])
  }, [severityFilter])

  const loadConfigAndOverview = useCallback(async () => {
    setError(null); setErrorHint(null)
    try {
      const { data: cfg } = await api.get('/api/zabbix/config')
      setConfig(cfg)
      if (!cfg.configured) setOverview(null)
    } catch (e) {
      const { message, hint } = parseErr(e); setError(message); setErrorHint(hint); setOverview(null)
    }
  }, [parseErr])

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
    if (!config?.configured || tab !== 'overview') return
    let cancelled = false
    loadOverview()
      .catch((e) => {
        if (cancelled) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint)
      })
    return () => { cancelled = true }
  }, [config?.configured, tab, dashboardGroupFilter, dashboardSearch, loadOverview, parseErr])

  useEffect(() => {
    if (!config?.configured) return
    const t = setInterval(() => {
      loadConfigAndOverview().catch(() => {})
      if (tab === 'overview') loadOverview().catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [config?.configured, tab, loadConfigAndOverview, loadOverview])

  useEffect(() => {
    if (!config?.configured || tab === 'overview') return
    if (tab === 'hosts' && hosts === null) loadTabData('hosts')
    if (tab === 'hostGraphs' && hostsExplorer === null) loadTabData('hostGraphs')
  }, [tab, config?.configured, hosts, hostsExplorer, loadTabData])

  useEffect(() => {
    if (!config?.configured || tab !== 'events') return; let c = false; setTabBusy(true); setError(null); setErrorHint(null)
    api.get(`/api/zabbix/events?limit=${eventLimit}`)
      .then(({ data }) => { if (!c) setEvents(data.events || []) })
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setEvents([]) })
      .finally(() => { if (!c) setTabBusy(false) })
    return () => { c = true }
  }, [tab, config?.configured, eventLimit, parseErr])

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
  }, [tab, config?.configured, topLimit, loadTopUtil, parseErr])

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
    await api.post('/api/zabbix/problems/acknowledge', { eventids, close, message: message || undefined, acknowledge: true })
  }, [])

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
      const { data: cfg } = await api.get('/api/zabbix/config'); setConfig(cfg); if (!cfg.configured) { setOverview(null); return }
      if (tab === 'overview') await loadOverview()
      if (tab === 'hosts') await loadHosts()
      if (tab === 'problems') await refetchProblems()
      if (tab === 'events') await loadEvents(eventLimit)
      if (tab === 'topMon') await loadTopUtil(topLimit)
      if (tab === 'hostGraphs') { await loadAllHosts(); if (selectedHost?.hostid) { const g = await loadHostGraphs(selectedHost.hostid); if (!g.length) await loadHostItemsLatest(selectedHost.hostid); else setHostItemsLatest(null); if (selectedGraphId) { const d = await fetchGraphSeries(selectedGraphId, graphRange, graphDataMode); setGraphSeries(d) } } }
    } catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint) }
    finally { setLoading(false) }
  }, [tab, loadOverview, loadHosts, loadEvents, eventLimit, severityFilter, parseErr, selectedHost, selectedGraphId, graphRange, graphDataMode, loadAllHosts, loadHostGraphs, loadHostItemsLatest, fetchGraphSeries, loadTopUtil, topLimit, refetchProblems])

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
  const tabDefs = [
    { id: 'overview', label: 'Dashboard', icon: '▤' },
    { id: 'hosts', label: 'Inventory', icon: '▦', badge: hosts?.length ?? avail?.total },
    { id: 'hostGraphs', label: 'Device Snapshot', icon: '▣' },
    { id: 'topMon', label: 'Top Monitoring', icon: '★' },
    { id: 'problems', label: 'Alarms', icon: '⚠', badge: overview?.activeProblems },
    { id: 'events', label: 'Events', icon: '◉' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 }}>
      <style>{INLINE_CSS}</style>

      {/* ──── Page header ──── */}
      <div className="opm-page-header">
        <div className="opm-page-title">
          <span className="opm-status-dot" style={{ background: configured ? '#22c55e' : '#ef4444' }} />
          <div>
            <h1>Infrastructure Monitoring</h1>
            <div className="opm-page-subtitle">
              {!configured ? 'Not configured' :
                healthPct != null ? `Health ${healthPct}% · ${avail?.available ?? 0}/${avail?.total ?? 0} devices online` :
                'Connected to Zabbix'}
            </div>
          </div>
        </div>
        <button type="button" onClick={refresh} disabled={loading || tabBusy} className="opm-refresh-btn">
          <span style={{ display: 'inline-block', animation: loading || tabBusy ? 'pulse 1s ease-in-out infinite' : 'none' }}>↻</span>
          {loading || tabBusy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ──── Tab bar ──── */}
      {configured && (
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
            Set <code style={{ color: 'var(--cyan)' }}>ZABBIX_URL</code> and <code style={{ color: 'var(--cyan)' }}>ZABBIX_API_TOKEN</code> in the server <code style={{ color: 'var(--cyan)' }}>.env</code>, then restart.
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
                          <GraphPanel graph={hostGraphs?.find((g) => g.graphid === selectedGraphId)} series={graphSeries} chartData={chartData} chartOpts={chartOpts} busy={graphSeriesBusy} graphDataMode={graphDataMode} />
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
                      {!itemsLatestBusy && hostItemsLatest && <LatestMetricsView key={selectedHost?.hostid} latestData={hostItemsLatest} chartOpts={chartOpts} />}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Toolbar: Top-N selector */}
          <div className="opm-toolbar">
            <div className="opm-toolbar-row" style={{ justifyContent: 'space-between' }}>
              <div className="opm-toolbar-row" style={{ gap: 6 }}>
                <span className="opm-toolbar-label">Show Top</span>
                {[5, 10, 20].map((n) => (
                  <button key={n} type="button" onClick={() => setTopLimit(n)}
                    style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, border: topLimit === n ? '1px solid var(--accent)' : '1px solid var(--border)', background: topLimit === n ? 'rgba(59,130,246,.12)' : 'var(--bg3)', color: topLimit === n ? 'var(--accent)' : 'var(--text3)', cursor: 'pointer', transition: 'all .12s' }}>
                    {n}
                  </button>
                ))}
              </div>
              <div className="opm-toolbar-row" style={{ gap: 8 }}>
                {topUtil?.sampledAt && (
                  <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                    Updated {relAge(topUtil.sampledAt)}
                  </span>
                )}
                <button type="button" onClick={() => loadTopUtil(topLimit)} disabled={topUtilBusy}
                  style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: topUtilBusy ? 'wait' : 'pointer', fontWeight: 600 }}>
                  {topUtilBusy ? '↻ Refreshing…' : '↻ Refresh'}
                </button>
              </div>
            </div>
          </div>

          {topUtilBusy && !topUtil && (
            <div style={{ padding: 40, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading utilization metrics…
            </div>
          )}

          {topUtil && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
              <Widget title="Top CPU Utilization" badge={topUtil.cpu?.length ?? 0} badgeColor="blue">
                <TopUtilWidget rows={topUtil.cpu} accent="#3b82f6"
                  emptyMsg="No CPU utilization items found in Zabbix."
                  onRowClick={(r) => goToHostGraphs({ hostid: r.hostid, host: r.host, name: r.name })} />
              </Widget>
              <Widget title="Top Memory Utilization" badge={topUtil.memory?.length ?? 0} badgeColor="purple">
                <TopUtilWidget rows={topUtil.memory} accent="#8b5cf6"
                  emptyMsg="No memory utilization items found in Zabbix."
                  onRowClick={(r) => goToHostGraphs({ hostid: r.hostid, host: r.host, name: r.name })} />
              </Widget>
              <Widget title="Top Disk Space Usage" badge={topUtil.disk?.length ?? 0} badgeColor="amber">
                <TopUtilWidget rows={topUtil.disk} accent="#f59e0b" showMount showBytes
                  emptyMsg="No filesystem usage items found in Zabbix."
                  onRowClick={(r) => goToHostGraphs({ hostid: r.hostid, host: r.host, name: r.name })} />
              </Widget>
            </div>
          )}
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

      {loading && !overview && configured && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 50, gap: 12, color: 'var(--text3)', fontSize: 14, fontFamily: 'var(--mono)' }}>
          <span className="np-page-loading-dot" /> Loading infrastructure data…
        </div>
      )}
    </div>
  )
}

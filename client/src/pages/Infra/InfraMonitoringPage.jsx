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

function MetricRow({ r, i, effectiveMax, isPercentage, isActive, onSelect }) {
  const v = Number(r.value)
  const pct = Math.min(Math.abs(v) / effectiveMax * 100, 100)
  const color = DATASET_COLORS[i % DATASET_COLORS.length]
  const barColor = isPercentage && v > 90 ? '#ef4444' : isPercentage && v > 75 ? '#eab308' : color
  return (
    <div onClick={() => onSelect?.(r)} className="opm-row-hover"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
        borderBottom: '1px solid var(--border)', fontSize: 11, fontFamily: 'var(--mono)',
        cursor: onSelect ? 'pointer' : 'default',
        background: isActive ? 'rgba(59,130,246,.08)' : undefined,
        borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
      }}>
      <span style={{ width: 14, textAlign: 'center', color: 'var(--text3)', fontSize: 9, flexShrink: 0, opacity: .6 }}>📈</span>
      <span style={{ flex: '1 1 auto', color: isActive ? 'var(--accent)' : 'var(--text2)', fontWeight: isActive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={r.name || r.key}>
        {(r.name || r.key || '').replace(/^VMware:\s*/i, '')}
      </span>
      <div style={{ width: 100, height: 6, borderRadius: 3, background: 'var(--bg4)', overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${Math.max(pct, v > 0 ? 2 : 0)}%`, height: '100%', borderRadius: 3, background: barColor, transition: 'width .3s' }} />
      </div>
      <span style={{ width: 90, textAlign: 'right', fontWeight: 700, color: 'var(--text)', flexShrink: 0, fontSize: 11 }}>
        {fmtValue(v, r.units)}
      </span>
    </div>
  )
}

function MetricGroup({ group, selectedItemId, onSelectItem }) {
  const max = Math.max(...group.items.map((r) => Math.abs(Number(r.value))), 1)
  const isPercentage = group.key === 'percentage'
  const effectiveMax = isPercentage ? 100 : max
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {group.items.map((r, i) => (
        <MetricRow key={r.itemid} r={r} i={i} effectiveMax={effectiveMax} isPercentage={isPercentage}
          isActive={selectedItemId === r.itemid} onSelect={r.numeric ? onSelectItem : undefined} />
      ))}
    </div>
  )
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

function LatestMetricsView({ latestData, chartOpts }) {
  const [selectedItem, setSelectedItem] = useState(null)
  const grouped = useMemo(() => groupLatestMetrics(latestData?.latest), [latestData])

  const handleSelect = useCallback((item) => {
    setSelectedItem((prev) => prev?.itemid === item.itemid ? null : item)
  }, [])

  if (!grouped.groups.length && !grouped.textItems.length) {
    return <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)', textAlign: 'center', padding: '20px 0' }}>No metrics available for this device.</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Summary */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', alignItems: 'center' }}>
        <span>{grouped.totalNumeric} numeric</span>
        <span>{grouped.textItems.length} text</span>
        <span style={{ opacity: .5 }}>·</span>
        <span style={{ color: 'var(--accent)', fontSize: 10 }}>Click any numeric metric to view its history graph</span>
      </div>

      {/* History chart for selected item */}
      {selectedItem && (
        <ItemHistoryChart
          key={selectedItem.itemid}
          itemId={selectedItem.itemid}
          itemName={selectedItem.name}
          itemUnits={selectedItem.units}
          chartOpts={chartOpts}
        />
      )}

      {/* Metric groups */}
      {grouped.groups.map((g) => (
        <div key={g.key} className="opm-widget" style={{ animation: 'fadeIn .2s ease' }}>
          <div className="opm-widget-hd" style={{ padding: '8px 14px' }}>
            <span className="opm-widget-title" style={{ fontSize: 10 }}>{g.label}</span>
            <span className="badge badge-blue">{g.items.length}</span>
          </div>
          <MetricGroup group={g} selectedItemId={selectedItem?.itemid} onSelectItem={handleSelect} />
        </div>
      ))}

      {/* Text items */}
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
.opm-widget{background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden;transition:box-shadow .2s}
.opm-widget:hover{box-shadow:0 4px 20px rgba(0,0,0,.12)}
.opm-widget-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg3)}
.opm-widget-title{font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text2);font-family:var(--mono)}
.opm-widget-body{padding:14px 16px}
.opm-row-hover{transition:background .1s}
.opm-row-hover:hover{background:rgba(79,126,245,.06)!important}
.opm-status-strip{display:flex;gap:0;border-radius:6px;overflow:hidden;height:8px}
.opm-tab{position:relative;padding:10px 20px;font-size:12px;font-weight:600;border:none;cursor:pointer;font-family:var(--mono);color:var(--text3);background:transparent;transition:all .15s;border-bottom:2px solid transparent}
.opm-tab:hover{color:var(--text2)}
.opm-tab.active{color:var(--accent);border-bottom-color:var(--accent);background:rgba(79,126,245,.06)}
.opm-device-card{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:all .12s;border-left:3px solid transparent}
.opm-device-card:hover{background:rgba(79,126,245,.06)}
.opm-device-card.active{border-left-color:var(--accent);background:rgba(79,126,245,.08)}
.opm-graph-item{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:all .12s}
.opm-graph-item:hover{background:rgba(79,126,245,.05);padding-left:18px}
.opm-graph-item.active{background:rgba(79,126,245,.10)}
.opm-alarm-row{display:flex;align-items:stretch;border-bottom:1px solid var(--border);transition:background .1s;cursor:default}
.opm-alarm-row:hover{background:rgba(79,126,245,.04)}
.opm-sev-strip{width:4px;flex-shrink:0}
.opm-pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;font-family:var(--mono);letter-spacing:.3px}
.opm-counter-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px 8px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);min-width:100px;cursor:pointer;transition:all .2s}
.opm-counter-tile:hover{border-color:var(--border2);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.1)}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
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

function CounterTile({ label, value, sub, color, onClick }) {
  const cMap = { green: '#22c55e', red: '#ef4444', amber: '#eab308', cyan: '#06b6d4', blue: '#3b82f6', purple: '#8b5cf6' }
  return (
    <div className="opm-counter-tile" onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick() } : undefined}
      style={{ borderTop: `3px solid ${cMap[color] || cMap.blue}` }}>
      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: cMap[color] || cMap.blue, fontFamily: 'var(--mono)' }}>{value ?? '—'}</div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', marginTop: 6, letterSpacing: .5, textTransform: 'uppercase', fontFamily: 'var(--mono)', textAlign: 'center' }}>{label}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 2, fontFamily: 'var(--mono)', opacity: .7 }}>{sub}</div>}
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
                <td key={col.key} style={{ padding: '10px 14px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.render(row)}</td>
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
  const [severityFilter, setSeverityFilter] = useState(null)
  const [graphSeriesBusy, setGraphSeriesBusy] = useState(false)
  const [graphDataMode, setGraphDataMode] = useState('auto')
  const [hostItemsLatest, setHostItemsLatest] = useState(null)
  const [itemsLatestBusy, setItemsLatestBusy] = useState(false)
  const [eventLimit, setEventLimit] = useState(500)
  const hostListRef = useRef(null)

  /* ─── data loaders (unchanged logic) ─── */
  const parseErr = useCallback((e) => {
    const d = e.response?.data
    const msg = d?.error || d?.hint || e.message || 'Failed to load Zabbix'
    const hints = [d?.hint, d?.code && `code: ${d.code}`, d?.zabbixCode != null && `zabbix: ${d.zabbixCode}`].filter(Boolean)
    return { message: typeof msg === 'string' ? msg : JSON.stringify(msg), hint: hints.length ? hints.join(' · ') : null }
  }, [])
  const loadOverview = useCallback(async () => { const { data: ov } = await api.get('/api/zabbix/overview'); setOverview(ov) }, [])
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
  const fetchGraphSeries = useCallback(async (graphId, rangeKey, dataMode) => {
    const sec = RANGE_SEC[rangeKey] || RANGE_SEC['12h']; const now = Math.floor(Date.now() / 1000)
    const qs = new URLSearchParams({ from: String(now - sec), to: String(now) })
    if (dataMode === 'latest') qs.set('mode', 'latest')
    const { data } = await api.get(`/api/zabbix/graphs/${encodeURIComponent(graphId)}/series?${qs}`); return data
  }, [])
  const loadEvents = useCallback(async (lim) => { const { data } = await api.get(`/api/zabbix/events?limit=${lim || eventLimit}`); setEvents(data.events || []) }, [eventLimit])

  const loadConfigAndOverview = useCallback(async () => {
    setError(null); setErrorHint(null)
    try { const { data: cfg } = await api.get('/api/zabbix/config'); setConfig(cfg); if (!cfg.configured) { setOverview(null); return }; await loadOverview() }
    catch (e) { const { message, hint } = parseErr(e); setError(message); setErrorHint(hint); setOverview(null) }
  }, [loadOverview, parseErr])

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
    const t = setInterval(() => { loadConfigAndOverview().catch(() => {}) }, 60_000)
    return () => { c = true; clearInterval(t) }
  }, [loadConfigAndOverview])

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
    const qs = new URLSearchParams({ limit: '250' })
    if (severityFilter != null) qs.set('severity', String(severityFilter))
    api.get(`/api/zabbix/problems?${qs}`)
      .then(({ data }) => { if (!c) setProblemsFull(data.problems || []) })
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setProblemsFull([]) })
      .finally(() => { if (!c) setTabBusy(false) })
    return () => { c = true }
  }, [tab, config?.configured, severityFilter, parseErr])

  useEffect(() => {
    if (tab !== 'hostGraphs' || !config?.configured || hostsExplorer !== null) return
    setExplorerBusy(true); setError(null); setErrorHint(null)
    loadAllHosts().catch((e) => { const r = parseErr(e); setError(r.message); setErrorHint(r.hint) }).finally(() => setExplorerBusy(false))
  }, [tab, config?.configured, hostsExplorer, loadAllHosts, parseErr])

  useEffect(() => {
    if (!selectedGraphId || tab !== 'hostGraphs') return; let c = false; setGraphSeriesBusy(true); setError(null); setErrorHint(null)
    fetchGraphSeries(selectedGraphId, graphRange, graphDataMode)
      .then((data) => { if (!c) setGraphSeries(data) })
      .catch((e) => { if (c) return; const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setGraphSeries(null) })
      .finally(() => { if (!c) setGraphSeriesBusy(false) })
    return () => { c = true }
  }, [graphRange, selectedGraphId, tab, graphDataMode, fetchGraphSeries, parseErr])

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

  const filteredHosts = useMemo(() => scoreHosts(hostsExplorer || [], (hostSearch || '').trim().toLowerCase()), [hostsExplorer, hostSearch, scoreHosts])
  const filteredInventory = useMemo(() => scoreHosts(hosts || [], (inventorySearch || '').trim().toLowerCase()), [hosts, inventorySearch, scoreHosts])
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
  const baseUrl = config?.zabbixUrl

  /* Navigate to Host & Graphs tab */
  const goToHostGraphs = useCallback(async (host) => {
    setTab('hostGraphs'); setSelectedHost(host); setGraphDataMode('auto'); setSelectedGraphId(null); setGraphSeries(null); setHostItemsLatest(null); setGraphsBusy(true); setError(null); setErrorHint(null)
    try { if (hostsExplorer === null) await loadAllHosts(); const g = await loadHostGraphs(host.hostid); if (!g.length) await loadHostItemsLatest(host.hostid); else setSelectedGraphId(g[0].graphid) }
    catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setHostGraphs(null); setHostItemsLatest(null) }
    finally { setGraphsBusy(false) }
  }, [hostsExplorer, loadAllHosts, loadHostGraphs, loadHostItemsLatest, parseErr])

  const pickHost = useCallback(async (h) => {
    setSelectedHost(h); setGraphDataMode('auto'); setSelectedGraphId(null); setGraphSeries(null); setHostItemsLatest(null); setGraphsBusy(true); setError(null); setErrorHint(null)
    try { const g = await loadHostGraphs(h.hostid); if (!g.length) await loadHostItemsLatest(h.hostid); else setSelectedGraphId(g[0].graphid) }
    catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint); setHostGraphs(null); setHostItemsLatest(null) }
    finally { setGraphsBusy(false) }
  }, [loadHostGraphs, loadHostItemsLatest, parseErr])

  const pickGraph = useCallback((gid) => { setSelectedGraphId(gid); setGraphSeries(null) }, [])

  const refresh = useCallback(async () => {
    setLoading(true); setError(null); setErrorHint(null)
    try {
      const { data: cfg } = await api.get('/api/zabbix/config'); setConfig(cfg); if (!cfg.configured) { setOverview(null); return }
      await loadOverview()
      if (tab === 'hosts') await loadHosts()
      if (tab === 'problems') { const qs = new URLSearchParams({ limit: '250' }); if (severityFilter != null) qs.set('severity', String(severityFilter)); const { data } = await api.get(`/api/zabbix/problems?${qs}`); setProblemsFull(data.problems || []) }
      if (tab === 'events') await loadEvents(eventLimit)
      if (tab === 'hostGraphs') { await loadAllHosts(); if (selectedHost?.hostid) { const g = await loadHostGraphs(selectedHost.hostid); if (!g.length) await loadHostItemsLatest(selectedHost.hostid); else setHostItemsLatest(null); if (selectedGraphId) { const d = await fetchGraphSeries(selectedGraphId, graphRange, graphDataMode); setGraphSeries(d) } } }
    } catch (e) { const r = parseErr(e); setError(r.message); setErrorHint(r.hint) }
    finally { setLoading(false) }
  }, [tab, loadOverview, loadHosts, loadEvents, eventLimit, severityFilter, parseErr, selectedHost, selectedGraphId, graphRange, graphDataMode, loadAllHosts, loadHostGraphs, loadHostItemsLatest, fetchGraphSeries])

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
  const problemCols = [
    { key: 'sev', label: 'Severity', render: (p) => <span className="opm-pill" style={{ color: sevColor(p.severity), background: `${sevColor(p.severity)}15`, border: `1px solid ${sevColor(p.severity)}30` }}>{p.severityLabel}</span> },
    { key: 'name', label: 'Problem', render: (p) => <span style={{ color: 'var(--text)' }}>{p.name}</span> },
    { key: 'hosts', label: 'Affected Device', render: (p) => <span style={{ color: 'var(--text2)', fontSize: 11 }}>{(p.hosts || []).map((h) => h.name || h.host).join(', ') || '—'}</span> },
    { key: 'dur', label: 'Duration', render: (p) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{relAge(p.clock)}</span> },
    { key: 'since', label: 'Since', render: (p) => <span style={{ color: 'var(--text3)', fontSize: 11 }}>{fmtClock(p.clock)}</span> },
  ]
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 }}>
      <style>{INLINE_CSS}</style>

      {/* ──── Header bar ──── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {baseUrl && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)' }}>{baseUrl}</span>}
        </div>
        <button type="button" onClick={refresh} disabled={loading || tabBusy}
          style={{ padding: '7px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: loading || tabBusy ? 'wait' : 'pointer', fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600, transition: 'all .15s' }}>
          {loading ? '↻ Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* ──── Tab bar (OpManager horizontal tabs) ──── */}
      {configured && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16, gap: 0, overflowX: 'auto' }}>
          {[
            { id: 'overview', label: 'Dashboard' },
            { id: 'hosts', label: 'Inventory' },
            { id: 'hostGraphs', label: 'Device Snapshot' },
            { id: 'problems', label: 'Alarms' },
            { id: 'events', label: 'Events' },
          ].map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`opm-tab ${tab === t.id ? 'active' : ''}`}>{t.label}</button>
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
          {/* Row 1: Counter tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
            <CounterTile label="Devices" value={avail?.total ?? 0} sub="Monitored" color="blue" onClick={() => setTab('hosts')} />
            <CounterTile label="Available" value={avail?.available ?? 0} color="green" />
            <CounterTile label="Unavailable" value={avail?.unavailable ?? 0} color="red" />
            <CounterTile label="Unknown" value={avail?.unknown ?? 0} sub="Agent unchecked" color="cyan" />
            <CounterTile label="Active Alarms" value={overview.activeProblems} color="amber" onClick={() => { setSeverityFilter(null); setTab('problems') }} />
            <CounterTile label="Zabbix" value={overview.version || '—'} sub="API version" color="purple" />
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
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(overview.hostGroups || []).map((g) => (
                      <div key={g.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 6px', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)' }} className="opm-row-hover">
                        <span style={{ color: 'var(--text2)' }}>{g.name}</span>
                        <span style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13 }}>{g.count}</span>
                      </div>
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
          {/* Search bar */}
          <div style={{ position: 'relative', maxWidth: 480 }}>
            <input type="search" value={inventorySearch} onChange={(e) => setInventorySearch(e.target.value)} placeholder="Search by name, IP, host, group…"
              style={{ width: '100%', padding: '9px 14px 9px 34px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none', transition: 'border-color .2s' }}
              onFocus={(e) => e.target.style.borderColor = 'var(--accent)'} onBlur={(e) => e.target.style.borderColor = ''} />
            <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', fontSize: 13, pointerEvents: 'none' }}>⌕</span>
          </div>
          <Widget title="Device Inventory" badge={`${filteredInventory.length}${inventorySearch && hosts ? ` / ${hosts.length}` : ''}`} badgeColor="green" noPad
            actions={<span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Click a device to view snapshot</span>}>
            {hosts === null || tabBusy
              ? <div style={{ padding: 24, color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading devices…</div>
              : <DataTable columns={hostCols} rows={filteredInventory} empty={inventorySearch ? `No devices match "${inventorySearch}".` : 'No monitored devices.'} rowKey={(h) => h.hostid} onRowClick={(h) => goToHostGraphs(h)} />
            }
          </Widget>
        </div>
      )}

      {/* ═══════════ DEVICE SNAPSHOT (Host & Graphs) ═══════════ */}
      {configured && tab === 'hostGraphs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 auto', maxWidth: 440 }}>
              <input type="search" value={hostSearch} onChange={(e) => setHostSearch(e.target.value)} placeholder="Search devices…"
                style={{ width: '100%', padding: '9px 14px 9px 34px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none', transition: 'border-color .2s' }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent)'} onBlur={(e) => e.target.style.borderColor = ''} />
              <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', fontSize: 13, pointerEvents: 'none' }}>⌕</span>
            </div>
            {selectedHost && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.2)', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 700 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: selectedHost.availability === 'Available' ? '#22c55e' : selectedHost.availability === 'Unavailable' ? '#ef4444' : '#64748b' }} />
                {selectedHost.name || selectedHost.host}
              </div>
            )}
          </div>

          {/* Layout: device list | graph area */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'start', minHeight: 520 }}>
            {/* Left: device sidebar */}
            <div ref={hostListRef} style={{ flex: '0 0 250px', maxHeight: 620, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)' }}>
              <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg3)', fontSize: 10, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: .8, textTransform: 'uppercase' }}>
                Devices {filteredHosts.length > 0 ? `(${filteredHosts.length}${hostsExplorer && filteredHosts.length !== hostsExplorer.length ? ` / ${hostsExplorer.length}` : ''})` : hostsExplorer ? `(${hostsExplorer.length})` : ''}
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
              {!explorerBusy && filteredHosts.length === 0 && (hostsExplorer?.length || 0) > 0 && <div style={{ padding: 20, color: 'var(--text3)', fontSize: 12 }}>No matches for "{hostSearch}". Try a different search.</div>}
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

                  {/* Range + mode toolbar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 10px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, marginRight: 2 }}>RANGE</span>
                    {Object.keys(RANGE_SEC).map((r) => (
                      <button key={r} type="button" disabled={!selectedGraphId || graphDataMode === 'latest'} onClick={() => setGraphRange(r)}
                        style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, border: graphRange === r ? '1px solid var(--accent)' : '1px solid var(--border)', background: graphRange === r ? 'rgba(59,130,246,.12)' : 'transparent', color: graphRange === r ? 'var(--accent)' : 'var(--text3)', cursor: selectedGraphId && graphDataMode !== 'latest' ? 'pointer' : 'not-allowed', opacity: selectedGraphId && graphDataMode !== 'latest' ? 1 : .35, transition: 'all .12s' }}>
                        {r}
                      </button>
                    ))}
                    <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 4px' }} />
                    <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', fontWeight: 700, marginRight: 2 }}>MODE</span>
                    {[{ id: 'auto', label: 'History' }, { id: 'latest', label: 'Live' }].map((m) => (
                      <button key={m.id} type="button" disabled={!selectedGraphId} onClick={() => setGraphDataMode(m.id)}
                        style={{ padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, border: graphDataMode === m.id ? '1px solid var(--accent)' : '1px solid var(--border)', background: graphDataMode === m.id ? 'rgba(59,130,246,.12)' : 'transparent', color: graphDataMode === m.id ? 'var(--accent)' : 'var(--text3)', cursor: selectedGraphId ? 'pointer' : 'not-allowed', opacity: selectedGraphId ? 1 : .35, transition: 'all .12s' }}>
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {/* Graph list + chart */}
                  {!noGraphHost && (
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

                  {/* No-graph host: latest metrics */}
                  {noGraphHost && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
                          No Zabbix graphs defined — showing latest monitored item values
                        </div>
                        <button type="button" onClick={() => selectedHost?.hostid && loadHostItemsLatest(selectedHost.hostid)}
                          style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 600 }}>↻ Refresh</button>
                      </div>
                      {itemsLatestBusy && <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 12, fontFamily: 'var(--mono)', padding: '40px 0', justifyContent: 'center' }}><span className="np-page-loading-dot" style={{ width: 14, height: 14 }} />Loading metrics…</div>}
                      {!itemsLatestBusy && hostItemsLatest && <LatestMetricsView latestData={hostItemsLatest} chartOpts={chartOpts} />}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
                <CounterTile label="Total Events" value={events.length} color="blue" />
                <CounterTile label="Problems" value={prob} color="red" />
                <CounterTile label="Resolved" value={res} color="green" />
                <CounterTile label="Acknowledged" value={ack} color="cyan" />
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

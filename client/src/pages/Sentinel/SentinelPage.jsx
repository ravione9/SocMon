import RangePicker from '../../components/ui/RangePicker.jsx'
import SentinelLogSearch from '../../components/sentinel/SentinelLogSearch.jsx'
import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Line, Bar, Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import api from '../../api/client'
import { DEFAULT_RANGE_PRESET, DEFAULT_RANGE_VALUE } from '../../constants/timeRange.js'
import { useSentinelHostGroups } from '../../hooks/useSentinelHostGroups.js'
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../../components/ui/ResizableTable.jsx'
import { useThemeStore } from '../../store/themeStore.js'
import { getThemeCssColors } from '../../utils/themeCssColors.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler)

const C = {
  accent: '#14b8a6',
  accent2: '#06b6d4',
  green: '#22d3a0',
  red: '#f5534f',
  amber: '#f5a623',
  cyan: '#22d3ee',
  blue: '#4f7ef5',
  purple: '#7c5cfc',
  orange: '#f97316',
  indigo: '#818cf8',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'active', label: 'Active & detection' },
  { id: 'usb', label: 'USB device connection' },
  { id: 'usb_dash', label: 'USB custom Dashboard' },
  { id: 'bluetooth', label: 'Bluetooth device connection' },
  { id: 'feed', label: 'Event feed' },
  { id: 'custom', label: 'Custom log' },
]

function buildChartOpts(tc) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: tc.text3, font: { size: 9 }, maxTicksLimit: 10 },
        grid: { color: 'rgba(128,128,160,0.1)' },
      },
      y: {
        ticks: { color: tc.text3, font: { size: 9 } },
        grid: { color: 'rgba(128,128,160,0.1)' },
      },
    },
  }
}

/** Chart.js canvas ignores CSS — set explicit legend/tooltip colors (fixes black text on dark themes). */
function dashChartPlugins(tc, legendPosition) {
  return {
    legend: {
      display: true,
      position: legendPosition,
      labels: {
        color: tc.text2,
        font: { size: 10 },
        boxWidth: 10,
        padding: 10,
      },
    },
    tooltip: {
      titleColor: tc.text,
      bodyColor: tc.text2,
      backgroundColor: tc.bg2,
      borderColor: 'rgba(128,128,160,0.22)',
      borderWidth: 1,
    },
  }
}

/** Non-empty filter keys (excluding internal _*) so empty {} drills can clear the log. */
function drillPatchHasFilters(patch) {
  if (!patch || typeof patch !== 'object') return false
  return Object.entries(patch).some(([k, v]) => !k.startsWith('_') && String(v ?? '').trim() !== '')
}

function scopeForTab(tab) {
  if (tab === 'overview') return 'all'
  if (tab === 'active') return 'no_usb'
  if (tab === 'usb' || tab === 'usb_dash') return 'usb_only'
  if (tab === 'bluetooth') return 'bt_only'
  return 'all'
}

function KPI({ label, value, sub, color, onClick, title }) {
  return (
    <div
      className={`kpi ${color}${onClick ? ' kpi-clickable' : ''}`}
      style={{ minWidth: 0 }}
      onClick={onClick}
      title={title || (onClick ? 'Open in Custom log' : undefined)}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: C.text3,
          letterSpacing: 1,
          textTransform: 'uppercase',
          marginBottom: 6,
          fontFamily: 'var(--mono)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          lineHeight: 1,
          marginBottom: 4,
          color:
            color === 'blue'
              ? C.blue
              : color === 'red'
                ? C.red
                : color === 'cyan'
                  ? C.cyan
                  : color === 'orange'
                    ? C.orange
                    : color === 'green'
                      ? C.green
                      : color === 'purple'
                        ? C.purple
                        : color === 'teal'
                        ? C.accent
                        : color === 'indigo'
                          ? C.indigo
                          : C.accent,
        }}
      >
        {value ?? '—'}
      </div>
      {sub && <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>{sub}</div>}
    </div>
  )
}

function Card({ title, badge, children, noPad, onClick, titleHint }) {
  return (
    <div className="card" onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }} title={titleHint}>
      <div className="card-header">
        <span className="card-title">{title}</span>
        {badge != null && <span className="badge badge-teal">{badge}</span>}
      </div>
      <div style={noPad ? {} : { padding: '12px 14px' }}>{children}</div>
    </div>
  )
}

function HBarChart({ rows, color, onBarClick, tc }) {
  const labels = (rows || []).map(r => String(r.key).slice(0, 32))
  const data = (rows || []).map(r => r.count)
  const t = tc || {}
  return (
    <div style={{ height: Math.max(180, rows?.length * 28 || 0) }}>
      <Bar
        data={{
          labels,
          datasets: [{ data, backgroundColor: color || C.accent, borderWidth: 0, borderRadius: 4 }],
        }}
        options={{
          color: t.text2,
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              titleColor: t.text,
              bodyColor: t.text2,
              backgroundColor: t.bg2,
              borderColor: 'rgba(128,128,160,0.22)',
              borderWidth: 1,
            },
          },
          scales: {
            x: { ticks: { color: t.text3 || '#555a72', font: { size: 9 } }, grid: { color: 'rgba(128,128,160,0.1)' } },
            y: { ticks: { color: t.text2 || '#8b90aa', font: { size: 9 } }, grid: { display: false } },
          },
          interaction: { mode: 'nearest', intersect: false },
          onClick: (evt, els) => {
            evt?.stopPropagation?.()
            if (!els.length || !onBarClick) return
            const i = els[0].index
            const row = rows[i]
            if (row) onBarClick(row)
          },
        }}
      />
    </div>
  )
}

export default function SentinelPage() {
  const [tab, setTab] = useState('overview')
  const [range, setRange] = useState(() => ({ ...DEFAULT_RANGE_PRESET }))
  const [hostGroupFilter, setHostGroupFilter] = useState('')
  const [dash, setDash] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeHits, setActiveHits] = useState([])
  const [resolvedHits, setResolvedHits] = useState([])
  const [activeThreatTotal, setActiveThreatTotal] = useState(null)
  const [resolvedThreatTotal, setResolvedThreatTotal] = useState(null)
  const [threatsLoading, setThreatsLoading] = useState(false)
  const [sentinelDrill, setSentinelDrill] = useState(null)
  const [usbDrill, setUsbDrill] = useState(null)
  const [bluetoothDrill, setBluetoothDrill] = useState(null)
  const [usbDashSelectedHosts, setUsbDashSelectedHosts] = useState([])
  const [usbDashDrill, setUsbDashDrill] = useState(null)
  const [usbDashPasteText, setUsbDashPasteText] = useState('')
  const [usbDashSearchText, setUsbDashSearchText] = useState('')
  const [usbDashSearchResults, setUsbDashSearchResults] = useState([])
  const [usbDashSearching, setUsbDashSearching] = useState(false)
  const usbDashLogAnchorRef = useRef(null)
  const usbLogAnchorRef = useRef(null)
  const bluetoothLogAnchorRef = useRef(null)

  const { groups: hostGroupOptions, loading: hostGroupsLoading } = useSentinelHostGroups(range, scopeForTab(tab))

  const theme = useThemeStore((s) => s.theme)
  const tc = useMemo(() => getThemeCssColors(), [theme])
  const co = useMemo(() => buildChartOpts(tc), [tc])

  const drillForLog = useMemo(() => {
    if (!sentinelDrill) return null
    const { _ts, ...rest } = sentinelDrill
    return Object.keys(rest).length ? rest : null
  }, [sentinelDrill])

  const drillForUsb = useMemo(() => {
    if (!usbDrill) return null
    const { _ts, ...rest } = usbDrill
    return Object.keys(rest).length ? rest : null
  }, [usbDrill])

  const drillForBluetooth = useMemo(() => {
    if (!bluetoothDrill) return null
    const { _ts, ...rest } = bluetoothDrill
    return Object.keys(rest).length ? rest : null
  }, [bluetoothDrill])

  const drillForUsbDash = useMemo(() => {
    if (!usbDashDrill) return null
    const { _ts, ...rest } = usbDashDrill
    return Object.keys(rest).length ? rest : null
  }, [usbDashDrill])

  const usbDashEndpointsParam = useMemo(
    () => usbDashSelectedHosts.join(','),
    [usbDashSelectedHosts],
  )

  const usbGoDrill = useCallback(patch => {
    const p = patch && typeof patch === 'object' ? patch : {}
    if (!drillPatchHasFilters(p)) setUsbDrill({ _clear: true, _ts: Date.now() })
    else setUsbDrill({ ...p, _ts: Date.now() })
  }, [])

  const bluetoothGoDrill = useCallback(patch => {
    const p = patch && typeof patch === 'object' ? patch : {}
    if (!drillPatchHasFilters(p)) setBluetoothDrill({ _clear: true, _ts: Date.now() })
    else setBluetoothDrill({ ...p, _ts: Date.now() })
  }, [])

  const usbDashGoDrill = useCallback(patch => {
    const p = patch && typeof patch === 'object' ? patch : {}
    if (!drillPatchHasFilters(p)) setUsbDashDrill({ _clear: true, _ts: Date.now() })
    else setUsbDashDrill({ ...p, _ts: Date.now() })
  }, [])

  const usbDashAddPasted = useCallback(() => {
    const parsed = usbDashPasteText
      .split(/[\n\r,;\t]+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (!parsed.length) return
    setUsbDashSelectedHosts(prev => {
      const set = new Set(prev)
      for (const h of parsed) set.add(h)
      return [...set]
    })
    setUsbDashPasteText('')
  }, [usbDashPasteText])

  const hostGroupQuery = useMemo(() => {
    const h = hostGroupFilter.trim()
    return h ? `&hostGroup=${encodeURIComponent(h)}` : ''
  }, [hostGroupFilter])

  useEffect(() => {
    if (tab !== 'usb_dash') return
    const q = usbDashSearchText.trim()
    if (q.length < 2) { setUsbDashSearchResults([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      setUsbDashSearching(true)
      try {
        const rp = `range=${range?.value || ''}&from=${range?.from || ''}&to=${range?.to || ''}`
        const { data } = await api.get(
          `/api/sentinel/hostname-search?${rp}&scope=usb_only&prefix=${encodeURIComponent(q)}${hostGroupQuery}`,
        )
        if (!cancelled) setUsbDashSearchResults(data.hostnames || [])
      } catch {
        if (!cancelled) setUsbDashSearchResults([])
      } finally {
        if (!cancelled) setUsbDashSearching(false)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [usbDashSearchText, tab, range, hostGroupQuery])

  /** After a drill, scroll the embedded log into view so KPI / chart clicks feel connected. */
  useEffect(() => {
    if (tab !== 'usb' || !usbDrill) return
    const { _ts, ...rest } = usbDrill
    if (!Object.keys(rest).length) return
    requestAnimationFrame(() => usbLogAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }, [tab, usbDrill])

  useEffect(() => {
    if (tab !== 'bluetooth' || !bluetoothDrill) return
    const { _ts, ...rest } = bluetoothDrill
    if (!Object.keys(rest).length) return
    requestAnimationFrame(() => bluetoothLogAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }, [tab, bluetoothDrill])

  useEffect(() => {
    if (tab !== 'usb') setUsbDrill(null)
  }, [tab])

  useEffect(() => {
    if (tab !== 'bluetooth') setBluetoothDrill(null)
  }, [tab])

  useEffect(() => {
    if (tab !== 'usb_dash') setUsbDashDrill(null)
  }, [tab])

  useEffect(() => {
    if (tab !== 'usb_dash' || !usbDashDrill) return
    const { _ts, ...rest } = usbDashDrill
    if (!Object.keys(rest).length) return
    requestAnimationFrame(() => usbDashLogAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }, [tab, usbDashDrill])

  const goDrill = useCallback(
    patch => {
      setSentinelDrill({ scope: scopeForTab(tab), ...patch, _ts: Date.now() })
      setTab('custom')
    },
    [tab],
  )

  const usbDashEndpointsQuery = useMemo(() => {
    if (tab !== 'usb_dash' || !usbDashEndpointsParam) return ''
    return `&endpoints=${encodeURIComponent(usbDashEndpointsParam)}`
  }, [tab, usbDashEndpointsParam])

  useEffect(() => {
    if (!['overview', 'active', 'usb', 'usb_dash', 'bluetooth'].includes(tab)) return
    if (tab === 'usb_dash' && usbDashSelectedHosts.length === 0) {
      setDash(null)
      setLoading(false)
      return
    }
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const rp = `range=${range?.value || ''}&from=${range?.from || ''}&to=${range?.to || ''}`
        const sc = scopeForTab(tab)
        const { data } = await api.get(`/api/sentinel/dashboard?${rp}&scope=${sc}${hostGroupQuery}${usbDashEndpointsQuery}`)
        if (!cancelled) setDash(data)
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.error || e.message || 'Failed to load')
          setDash(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const iv = setInterval(load, 45000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [range, tab, hostGroupQuery, usbDashEndpointsQuery, usbDashSelectedHosts.length])

  useEffect(() => {
    if (tab !== 'active') return
    let cancelled = false
    async function loadT() {
      setThreatsLoading(true)
      try {
        const rp = `range=${range?.value || ''}&from=${range?.from || ''}&to=${range?.to || ''}`
        const [a, r] = await Promise.all([
          api.get(`/api/sentinel/threats?status=active&excludeUsb=1&size=120&${rp}${hostGroupQuery}`),
          api.get(`/api/sentinel/threats?status=resolved&excludeUsb=1&size=120&${rp}${hostGroupQuery}`),
        ])
        if (!cancelled) {
          setActiveHits(a.data?.hits || [])
          setResolvedHits(r.data?.hits || [])
          setActiveThreatTotal(typeof a.data?.total === 'number' ? a.data.total : null)
          setResolvedThreatTotal(typeof r.data?.total === 'number' ? r.data.total : null)
        }
      } catch {
        if (!cancelled) {
          setActiveHits([])
          setResolvedHits([])
          setActiveThreatTotal(null)
          setResolvedThreatTotal(null)
        }
      } finally {
        if (!cancelled) setThreatsLoading(false)
      }
    }
    loadT()
    const iv = setInterval(loadT, 60000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [range, tab, hostGroupQuery])

  const sentActiveTbl = useResizableColumns('sentinel-active-threats', [160, 240, 120, 88, 88])
  const sentResolvedTbl = useResizableColumns('sentinel-resolved-threats', [160, 260, 120, 100])
  const sentTableTh = {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left',
    color: C.text3,
    fontFamily: 'var(--mono)',
    fontSize: 11,
  }

  const lineDual = useMemo(() => {
    const tl = dash?.timeline || []
    return {
      labels: tl.map(x => {
        try {
          return new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        } catch {
          return x.t
        }
      }),
      datasets: [
        {
          label: 'Total',
          data: tl.map(x => x.total ?? 0),
          borderColor: C.blue,
          backgroundColor: 'rgba(79,126,245,0.08)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: 'Threats',
          data: tl.map(x => x.threats ?? 0),
          borderColor: C.red,
          backgroundColor: 'rgba(245,83,79,0.06)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    }
  }, [dash])

  const eventTypeDonut = useMemo(
    () => ({
      labels: ['connected', 'disconnected', 'blocked'],
      datasets: [
        {
          data: [dash?.eventTypes?.connected ?? 0, dash?.eventTypes?.disconnected ?? 0, dash?.eventTypes?.blocked ?? 0],
          backgroundColor: [C.blue, C.cyan, C.green],
          borderWidth: 0,
        },
      ],
    }),
    [dash],
  )

  const usbLineData = useMemo(() => {
    const tl = dash?.timeline || []
    return {
      labels: tl.map(x => {
        try {
          return new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        } catch {
          return x.t
        }
      }),
      datasets: [
        {
          label: 'USB events',
          data: tl.map(x => x.total ?? 0),
          borderColor: C.orange,
          backgroundColor: 'rgba(249,115,22,0.1)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    }
  }, [dash])

  const usbActionDonut = useMemo(
    () => ({
      labels: ['Connected', 'Disconnected', 'Other'],
      datasets: [
        {
          data: [
            dash?.usbActionSplit?.connected ?? 0,
            dash?.usbActionSplit?.disconnected ?? 0,
            dash?.usbActionSplit?.other ?? 0,
          ],
          backgroundColor: [C.blue, C.cyan, C.text3],
          borderWidth: 0,
        },
      ],
    }),
    [dash],
  )

  const bluetoothLineData = useMemo(() => {
    const tl = dash?.timeline || []
    return {
      labels: tl.map(x => {
        try {
          return new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        } catch {
          return x.t
        }
      }),
      datasets: [
        {
          label: 'Bluetooth events',
          data: tl.map(x => x.total ?? 0),
          borderColor: C.indigo,
          backgroundColor: 'rgba(129,140,248,0.12)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
        },
      ],
    }
  }, [dash])

  const bluetoothActionDonut = useMemo(
    () => ({
      labels: ['Connected', 'Disconnected', 'Other'],
      datasets: [
        {
          data: [
            dash?.bluetoothActionSplit?.connected ?? 0,
            dash?.bluetoothActionSplit?.disconnected ?? 0,
            dash?.bluetoothActionSplit?.other ?? 0,
          ],
          backgroundColor: [C.blue, C.cyan, C.text3],
          borderWidth: 0,
        },
      ],
    }),
    [dash],
  )

  const showOverviewDash = tab === 'overview' || tab === 'active'
  const showUsbDash = tab === 'usb'
  const showUsbMultiDash = tab === 'usb_dash'
  const showBluetoothDash = tab === 'bluetooth'
  const showDashPanel = showOverviewDash || showUsbDash || showUsbMultiDash || showBluetoothDash

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: '100%',
        maxWidth: 1680,
        margin: '0 auto',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          rowGap: 14,
        }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: C.accent,
              fontFamily: 'var(--mono)',
              letterSpacing: 1,
              lineHeight: 1.35,
            }}
          >
            SENTINELONE XDR
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end', flex: '0 1 auto' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', letterSpacing: 0.5 }}>
            HOST GROUP
            <select
              value={hostGroupFilter}
              onChange={e => setHostGroupFilter(e.target.value)}
              title={
                hostGroupsLoading
                  ? 'Loading host groups from logs…'
                  : 'Filter dashboard metrics and the Custom log to this Sentinel host group (values from logs in the selected range)'
              }
              style={{
                minWidth: 200,
                maxWidth: 320,
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg3)',
                color: C.text,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="">All groups</option>
              {hostGroupOptions.map(g => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          {showDashPanel && <RangePicker range={range} onChange={setRange} accentColor={C.accent} />}
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: `${C.red}18`,
            border: `1px solid ${C.red}55`,
            color: C.red,
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 2, background: 'var(--bg3)', borderRadius: 10, padding: 3, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 16px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 7,
              cursor: 'pointer',
              border: 'none',
              fontFamily: 'var(--sans)',
              background: tab === t.id ? 'var(--accent)' : 'transparent',
              color: tab === t.id ? 'var(--on-accent)' : C.text2,
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {showOverviewDash && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
            <KPI
              label="Total events"
              value={loading ? '…' : dash?.total?.toLocaleString()}
              sub="last range"
              color="blue"
              onClick={() => goDrill({})}
              title="All events (current tab scope)"
            />
            <KPI
              label="Threats"
              value={loading ? '…' : dash?.threats?.toLocaleString()}
              sub="detected"
              color="red"
              onClick={() => goDrill({ q: 'threat' })}
              title="Threat signals in scope"
            />
            <KPI
              label="Active endpoints"
              value={loading ? '…' : dash?.activeEndpoints?.toLocaleString()}
              sub="unique computers"
              color="cyan"
              onClick={() => goDrill({})}
              title="Unique hosts (approx.)"
            />
            <KPI
              label="USB events"
              value={loading ? '…' : dash?.usbEvents?.toLocaleString()}
              sub="peripheral activity"
              color="orange"
              onClick={() => goDrill({ q: 'USB' })}
              title="USB / device-control style events"
            />
            <KPI
              label="Bluetooth events"
              value={loading ? '…' : dash?.bluetoothEvents?.toLocaleString()}
              sub="radio / pairing"
              color="indigo"
              onClick={() => goDrill({ q: 'Bluetooth' })}
              title="Bluetooth device style events"
            />
            <KPI
              label="Host groups"
              value={loading ? '…' : dash?.sites?.toLocaleString()}
              sub="distinct in scope"
              color="green"
              onClick={() => goDrill({})}
            />
            <KPI
              label="Unique users"
              value={loading ? '…' : dash?.uniqueUsers?.toLocaleString()}
              sub="active accounts"
              color="purple"
              onClick={() => goDrill({})}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Card
              title="Activity timeline"
              badge={(range?.label || range?.value || DEFAULT_RANGE_VALUE).toUpperCase()}
              onClick={() => goDrill({})}
              titleHint="Click chart or card to open Custom log"
            >
              <div
                style={{ height: 240, cursor: 'pointer' }}
                onClick={e => {
                  e.stopPropagation()
                  goDrill({})
                }}
                title="Click to open Custom log (this scope and range)"
              >
                {dash?.timeline?.length ? (
                  <Line
                    data={lineDual}
                    options={{
                      color: tc.text2,
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: dashChartPlugins(tc, 'top'),
                      scales: { ...co.scales, x: { ...co.scales.x, ticks: { ...co.scales.x.ticks, maxTicksLimit: 10 } } },
                    }}
                  />
                ) : (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', paddingTop: 100 }}>
                    {loading ? 'Loading…' : 'No timeline data'}
                  </div>
                )}
              </div>
            </Card>
            <Card title="Event types" badge="breakdown" onClick={() => goDrill({})} titleHint="Click a slice for event kind, or card for all events">
              <div style={{ height: 220, position: 'relative', cursor: 'pointer' }}>
                <Doughnut
                  data={eventTypeDonut}
                  options={{
                    color: tc.text2,
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '58%',
                    plugins: dashChartPlugins(tc, 'bottom'),
                    onClick: (evt, els) => {
                      evt?.stopPropagation?.()
                      if (!els.length) return
                      const labels = ['connected', 'disconnected', 'blocked']
                      const kind = labels[els[0].index]
                      if (kind) goDrill({ eventKind: kind })
                    },
                  }}
                />
              </div>
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <Card title="Top hostname" badge="HOSTNAME" noPad onClick={() => goDrill({})} titleHint="Click a bar to filter">
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topEndpoints}
                  color={C.blue}
                  onBarClick={row => goDrill({ endpoint: row.key })}
                  tc={tc}
                />
                {!loading && !(dash?.topEndpoints?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                )}
              </div>
            </Card>
            <Card title="Top USB devices" badge="USB" noPad onClick={() => goDrill({})} titleHint="Click a bar to filter">
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topUsb}
                  color={C.orange}
                  onBarClick={row => goDrill({ usbDevice: row.key })}
                  tc={tc}
                />
                {!loading && !(dash?.topUsb?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No USB aggregation</div>
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      {showUsbDash && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
            <KPI
              label="USB events"
              value={loading ? '…' : dash?.total?.toLocaleString()}
              sub="peripheral / device control"
              color="orange"
              onClick={() => usbGoDrill({})}
              title="All USB-scoped events"
            />
            <KPI
              label="Connected"
              value={loading ? '…' : dash?.usbActionSplit?.connected?.toLocaleString() ?? '—'}
              sub="event.action"
              color="blue"
              onClick={() => usbGoDrill({ eventAction: 'connected' })}
            />
            <KPI
              label="Disconnected"
              value={loading ? '…' : dash?.usbActionSplit?.disconnected?.toLocaleString() ?? '—'}
              sub="event.action"
              color="cyan"
              onClick={() => usbGoDrill({ eventAction: 'disconnected' })}
            />
            <KPI
              label="USB hostnames"
              value={loading ? '…' : dash?.activeEndpoints?.toLocaleString()}
              sub="unique computers"
              color="teal"
              onClick={() => usbGoDrill({})}
            />
            <KPI
              label="Host groups"
              value={loading ? '…' : dash?.sites?.toLocaleString()}
              sub="distinct in scope"
              color="green"
              onClick={() => usbGoDrill({})}
            />
            <KPI
              label="Unique users"
              value={loading ? '…' : dash?.uniqueUsers?.toLocaleString()}
              sub="active accounts"
              color="purple"
              onClick={() => usbGoDrill({})}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Card
              title="USB activity timeline"
              badge={(range?.label || range?.value || DEFAULT_RANGE_VALUE).toUpperCase()}
              onClick={() => usbGoDrill({})}
              titleHint="Click chart or card to filter the USB log below"
            >
              <div
                style={{ height: 240, cursor: 'pointer' }}
                onClick={e => {
                  e.stopPropagation()
                  usbGoDrill({})
                }}
                title="Click to filter the USB activity log below"
              >
                {dash?.timeline?.length ? (
                  <Line
                    data={usbLineData}
                    options={{
                      color: tc.text2,
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: dashChartPlugins(tc, 'top'),
                      scales: { ...co.scales, x: { ...co.scales.x, ticks: { ...co.scales.x.ticks, maxTicksLimit: 10 } } },
                    }}
                  />
                ) : (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', paddingTop: 100 }}>
                    {loading ? 'Loading…' : 'No timeline data'}
                  </div>
                )}
              </div>
            </Card>
            <Card
              title="USB event.action"
              badge="split"
              onClick={() => usbGoDrill({})}
              titleHint="Click a slice for event.action, or card for all USB events"
            >
              <div style={{ height: 220, position: 'relative', cursor: 'pointer' }}>
                <Doughnut
                  data={usbActionDonut}
                  options={{
                    color: tc.text2,
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '58%',
                    plugins: dashChartPlugins(tc, 'bottom'),
                    onClick: (evt, els) => {
                      evt?.stopPropagation?.()
                      if (!els.length) return
                      const keys = ['connected', 'disconnected', 'other']
                      const k = keys[els[0].index]
                      if (k === 'connected') usbGoDrill({ eventAction: 'connected' })
                      else if (k === 'disconnected') usbGoDrill({ eventAction: 'disconnected' })
                      else usbGoDrill({})
                    },
                  }}
                />
              </div>
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            <Card title="Top hostname" badge="HOSTNAME" noPad onClick={() => usbGoDrill({})} titleHint="Click a bar">
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topEndpoints}
                  color={C.blue}
                  onBarClick={row => usbGoDrill({ endpoint: row.key })}
                  tc={tc}
                />
                {!loading && !(dash?.topEndpoints?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                )}
              </div>
            </Card>
            <Card title="Top USB devices" badge="USB" noPad onClick={() => usbGoDrill({})} titleHint="Click a bar">
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topUsb}
                  color={C.orange}
                  onBarClick={row => usbGoDrill({ usbDevice: row.key })}
                  tc={tc}
                />
                {!loading && !(dash?.topUsb?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No USB aggregation</div>
                )}
              </div>
            </Card>
            <Card
              title="Top host (USB disconnect)"
              badge={loading ? '…' : `${dash?.topUsbDisconnectHosts?.length ?? 0}`}
              noPad
              onClick={() => usbGoDrill({})}
              titleHint="Top 10 hosts by USB disconnect-style events — click a bar"
            >
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topUsbDisconnectHosts}
                  color={C.cyan}
                  onBarClick={row => usbGoDrill({ endpoint: row.key, eventAction: 'disconnected' })}
                  tc={tc}
                />
                {!loading && !(dash?.topUsbDisconnectHosts?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No disconnect data</div>
                )}
              </div>
            </Card>
          </div>

          <div ref={usbLogAnchorRef} className="card" style={{ overflow: 'hidden', scrollMarginTop: 12 }}>
            <div className="card-header">
              <span className="card-title">USB activity log</span>
              <span className="badge badge-teal">CUSTOM LOG</span>
            </div>
            <div style={{ padding: '12px 14px' }}>
              <SentinelLogSearch
                key="usb-embedded-log"
                scope="usb_only"
                range={range}
                onRangeChange={setRange}
                drill={drillForUsb}
                showAnalyze
                hideRangePicker
                accentColor={C.accent}
                hostGroupSync={hostGroupFilter.trim()}
                onDrillClear={() => setUsbDrill(null)}
              />
            </div>
          </div>
        </>
      )}

      {showUsbMultiDash && (
        <>
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.amber, fontFamily: 'var(--mono)', letterSpacing: 1 }}>
                HOSTNAMES ({usbDashSelectedHosts.length} selected)
              </span>
              {usbDashSelectedHosts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setUsbDashSelectedHosts([])}
                  style={{
                    fontSize: 10, fontFamily: 'var(--mono)', padding: '4px 10px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'transparent', color: C.text2, cursor: 'pointer',
                  }}
                >
                  Remove all
                </button>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: 0.5 }}>
                  SEARCH HOSTNAME
                </div>
                <div style={{ position: 'relative' }}>
                  <input
                    value={usbDashSearchText}
                    onChange={e => setUsbDashSearchText(e.target.value)}
                    placeholder="Type at least 2 characters to search…"
                    style={{
                      width: '100%', padding: '8px 10px', background: 'var(--bg3)',
                      border: '1px solid var(--border)', borderRadius: 7, color: C.text,
                      fontSize: 11, fontFamily: 'var(--mono)', outline: 'none',
                    }}
                  />
                  {usbDashSearchText.trim().length >= 2 && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
                      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7,
                      marginTop: 4, maxHeight: 220, overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
                    }}>
                      {usbDashSearching && (
                        <div style={{ padding: '8px 12px', fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
                          Searching…
                        </div>
                      )}
                      {!usbDashSearching && usbDashSearchResults.length === 0 && (
                        <div style={{ padding: '8px 12px', fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
                          No hostnames found
                        </div>
                      )}
                      {!usbDashSearching && usbDashSearchResults.map(h => {
                        const already = usbDashSelectedHosts.includes(h)
                        return (
                          <div
                            key={h}
                            onClick={() => {
                              if (!already) setUsbDashSelectedHosts(prev => [...prev, h])
                              setUsbDashSearchText('')
                              setUsbDashSearchResults([])
                            }}
                            style={{
                              padding: '6px 12px', fontSize: 11, fontFamily: 'var(--mono)',
                              cursor: already ? 'default' : 'pointer',
                              color: already ? C.text3 : C.text,
                              background: already ? 'transparent' : 'transparent',
                              borderBottom: '1px solid var(--border)',
                            }}
                            onMouseEnter={e => { if (!already) e.currentTarget.style.background = `${C.amber}18` }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            {already ? `✓ ${h}` : h}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: 0.5 }}>
                  PASTE HOSTNAMES (one per line, comma / semicolon / tab separated)
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <textarea
                    value={usbDashPasteText}
                    onChange={e => setUsbDashPasteText(e.target.value)}
                    placeholder={'RP1234-ABC567XY\nRP5678-DEF890ZW'}
                    rows={2}
                    style={{
                      flex: 1, padding: '8px 10px', background: 'var(--bg3)',
                      border: '1px solid var(--border)', borderRadius: 7, color: C.text,
                      fontSize: 11, fontFamily: 'var(--mono)', outline: 'none', resize: 'vertical',
                    }}
                  />
                  <button
                    type="button"
                    onClick={usbDashAddPasted}
                    disabled={!usbDashPasteText.trim()}
                    style={{
                      padding: '8px 14px', borderRadius: 7, border: 'none', whiteSpace: 'nowrap',
                      background: usbDashPasteText.trim() ? C.amber : 'var(--bg4)',
                      color: usbDashPasteText.trim() ? '#000' : C.text3,
                      fontSize: 11, fontWeight: 600, fontFamily: 'var(--mono)',
                      cursor: usbDashPasteText.trim() ? 'pointer' : 'default',
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            {usbDashSelectedHosts.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {usbDashSelectedHosts.map(h => (
                  <span
                    key={h}
                    style={{
                      fontSize: 10, fontFamily: 'var(--mono)', padding: '4px 10px', borderRadius: 6,
                      border: `1px solid ${C.amber}`, background: `${C.amber}22`, color: C.amber,
                      fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {h}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => setUsbDashSelectedHosts(prev => prev.filter(x => x !== h))}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setUsbDashSelectedHosts(prev => prev.filter(x => x !== h)) } }}
                      style={{ cursor: 'pointer', opacity: 0.7, fontWeight: 400, fontSize: 12, lineHeight: 1 }}
                      title={`Remove ${h}`}
                    >
                      ✕
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {usbDashSelectedHosts.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: C.text3, fontFamily: 'var(--mono)', fontSize: 12 }}>
              Search or paste hostnames above to view the dashboard
            </div>
          )}

          {usbDashSelectedHosts.length > 0 && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                <KPI
                  label="USB events"
                  value={loading ? '…' : dash?.total?.toLocaleString()}
                  sub="peripheral / device control"
                  color="orange"
                  onClick={() => usbDashGoDrill({})}
                  title="All USB-scoped events for selected hosts"
                />
                <KPI
                  label="Connected"
                  value={loading ? '…' : dash?.usbActionSplit?.connected?.toLocaleString() ?? '—'}
                  sub="event.action"
                  color="blue"
                  onClick={() => usbDashGoDrill({ eventAction: 'connected' })}
                />
                <KPI
                  label="Disconnected"
                  value={loading ? '…' : dash?.usbActionSplit?.disconnected?.toLocaleString() ?? '—'}
                  sub="event.action"
                  color="cyan"
                  onClick={() => usbDashGoDrill({ eventAction: 'disconnected' })}
                />
                <KPI
                  label="USB hostnames"
                  value={loading ? '…' : dash?.activeEndpoints?.toLocaleString()}
                  sub="unique computers"
                  color="teal"
                  onClick={() => usbDashGoDrill({})}
                />
                <KPI
                  label="Host groups"
                  value={loading ? '…' : dash?.sites?.toLocaleString()}
                  sub="distinct in scope"
                  color="green"
                  onClick={() => usbDashGoDrill({})}
                />
                <KPI
                  label="Unique users"
                  value={loading ? '…' : dash?.uniqueUsers?.toLocaleString()}
                  sub="active accounts"
                  color="purple"
                  onClick={() => usbDashGoDrill({})}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                <Card
                  title="USB activity timeline"
                  badge={(range?.label || range?.value || DEFAULT_RANGE_VALUE).toUpperCase()}
                  onClick={() => usbDashGoDrill({})}
                  titleHint="Click chart or card to filter the USB log below"
                >
                  <div
                    style={{ height: 240, cursor: 'pointer' }}
                    onClick={e => {
                      e.stopPropagation()
                      usbDashGoDrill({})
                    }}
                    title="Click to filter the USB activity log below"
                  >
                    {dash?.timeline?.length ? (
                      <Line
                        data={usbLineData}
                        options={{
                          color: tc.text2,
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: dashChartPlugins(tc, 'top'),
                          scales: { ...co.scales, x: { ...co.scales.x, ticks: { ...co.scales.x.ticks, maxTicksLimit: 10 } } },
                        }}
                      />
                    ) : (
                      <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', paddingTop: 100 }}>
                        {loading ? 'Loading…' : 'No timeline data'}
                      </div>
                    )}
                  </div>
                </Card>
                <Card
                  title="USB event.action"
                  badge="split"
                  onClick={() => usbDashGoDrill({})}
                  titleHint="Click a slice for event.action, or card for all USB events"
                >
                  <div style={{ height: 220, position: 'relative', cursor: 'pointer' }}>
                    <Doughnut
                      data={usbActionDonut}
                      options={{
                        color: tc.text2,
                        responsive: true,
                        maintainAspectRatio: false,
                        cutout: '58%',
                        plugins: dashChartPlugins(tc, 'bottom'),
                        onClick: (evt, els) => {
                          evt?.stopPropagation?.()
                          if (!els.length) return
                          const keys = ['connected', 'disconnected', 'other']
                          const k = keys[els[0].index]
                          if (k === 'connected') usbDashGoDrill({ eventAction: 'connected' })
                          else if (k === 'disconnected') usbDashGoDrill({ eventAction: 'disconnected' })
                          else usbDashGoDrill({})
                        },
                      }}
                    />
                  </div>
                </Card>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
                <Card title="Top hostname" badge="HOSTNAME" noPad onClick={() => usbDashGoDrill({})} titleHint="Click a bar">
                  <div style={{ padding: '12px 14px' }}>
                    <HBarChart
                      rows={dash?.topEndpoints}
                      color={C.blue}
                      onBarClick={row => usbDashGoDrill({ endpoint: row.key })}
                      tc={tc}
                    />
                    {!loading && !(dash?.topEndpoints?.length > 0) && (
                      <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                    )}
                  </div>
                </Card>
                <Card title="Top USB devices" badge="USB" noPad onClick={() => usbDashGoDrill({})} titleHint="Click a bar">
                  <div style={{ padding: '12px 14px' }}>
                    <HBarChart
                      rows={dash?.topUsb}
                      color={C.orange}
                      onBarClick={row => usbDashGoDrill({ usbDevice: row.key })}
                      tc={tc}
                    />
                    {!loading && !(dash?.topUsb?.length > 0) && (
                      <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No USB aggregation</div>
                    )}
                  </div>
                </Card>
                <Card
                  title="Top host (USB disconnect)"
                  badge={loading ? '…' : `${dash?.topUsbDisconnectHosts?.length ?? 0}`}
                  noPad
                  onClick={() => usbDashGoDrill({})}
                  titleHint="Top 10 hosts by USB disconnect-style events — click a bar"
                >
                  <div style={{ padding: '12px 14px' }}>
                    <HBarChart
                      rows={dash?.topUsbDisconnectHosts}
                      color={C.cyan}
                      onBarClick={row => usbDashGoDrill({ endpoint: row.key, eventAction: 'disconnected' })}
                      tc={tc}
                    />
                    {!loading && !(dash?.topUsbDisconnectHosts?.length > 0) && (
                      <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No disconnect data</div>
                    )}
                  </div>
                </Card>
              </div>

              <div ref={usbDashLogAnchorRef} className="card" style={{ overflow: 'hidden', scrollMarginTop: 12 }}>
                <div className="card-header">
                  <span className="card-title">USB activity log</span>
                  <span className="badge badge-teal">MULTI-HOST</span>
                </div>
                <div style={{ padding: '12px 14px' }}>
                  <SentinelLogSearch
                    key="usb-dash-embedded-log"
                    scope="usb_only"
                    range={range}
                    onRangeChange={setRange}
                    drill={drillForUsbDash}
                    showAnalyze
                    hideRangePicker
                    accentColor={C.amber}
                    hostGroupSync={hostGroupFilter.trim()}
                    endpointsSync={usbDashEndpointsParam}
                    onDrillClear={() => setUsbDashDrill(null)}
                  />
                </div>
              </div>
            </>
          )}
        </>
      )}

      {showBluetoothDash && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
            <KPI
              label="Bluetooth events"
              value={loading ? '…' : dash?.total?.toLocaleString()}
              sub="Bluetooth-scoped"
              color="indigo"
              onClick={() => bluetoothGoDrill({})}
              title="All Bluetooth-scoped events"
            />
            <KPI
              label="Connected"
              value={loading ? '…' : dash?.bluetoothActionSplit?.connected?.toLocaleString() ?? '—'}
              sub="event.action"
              color="blue"
              onClick={() => bluetoothGoDrill({ eventAction: 'connected' })}
            />
            <KPI
              label="Disconnected"
              value={loading ? '…' : dash?.bluetoothActionSplit?.disconnected?.toLocaleString() ?? '—'}
              sub="event.action"
              color="cyan"
              onClick={() => bluetoothGoDrill({ eventAction: 'disconnected' })}
            />
            <KPI
              label="Bluetooth hostnames"
              value={loading ? '…' : dash?.activeEndpoints?.toLocaleString()}
              sub="unique computers"
              color="teal"
              onClick={() => bluetoothGoDrill({})}
            />
            <KPI
              label="Host groups"
              value={loading ? '…' : dash?.sites?.toLocaleString()}
              sub="distinct in scope"
              color="green"
              onClick={() => bluetoothGoDrill({})}
            />
            <KPI
              label="Unique users"
              value={loading ? '…' : dash?.uniqueUsers?.toLocaleString()}
              sub="active accounts"
              color="purple"
              onClick={() => bluetoothGoDrill({})}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Card
              title="Bluetooth activity timeline"
              badge={(range?.label || range?.value || DEFAULT_RANGE_VALUE).toUpperCase()}
              onClick={() => bluetoothGoDrill({})}
              titleHint="Click chart or card to filter the Bluetooth log below"
            >
              <div
                style={{ height: 240, cursor: 'pointer' }}
                onClick={e => {
                  e.stopPropagation()
                  bluetoothGoDrill({})
                }}
                title="Click to filter the Bluetooth activity log below"
              >
                {dash?.timeline?.length ? (
                  <Line
                    data={bluetoothLineData}
                    options={{
                      color: tc.text2,
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: dashChartPlugins(tc, 'top'),
                      scales: { ...co.scales, x: { ...co.scales.x, ticks: { ...co.scales.x.ticks, maxTicksLimit: 10 } } },
                    }}
                  />
                ) : (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', paddingTop: 100 }}>
                    {loading ? 'Loading…' : 'No timeline data'}
                  </div>
                )}
              </div>
            </Card>
            <Card
              title="Bluetooth event.action"
              badge="split"
              onClick={() => bluetoothGoDrill({})}
              titleHint="Click a slice for event.action, or card for all Bluetooth events"
            >
              <div style={{ height: 220, position: 'relative', cursor: 'pointer' }}>
                <Doughnut
                  data={bluetoothActionDonut}
                  options={{
                    color: tc.text2,
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '58%',
                    plugins: dashChartPlugins(tc, 'bottom'),
                    onClick: (evt, els) => {
                      evt?.stopPropagation?.()
                      if (!els.length) return
                      const keys = ['connected', 'disconnected', 'other']
                      const k = keys[els[0].index]
                      if (k === 'connected') bluetoothGoDrill({ eventAction: 'connected' })
                      else if (k === 'disconnected') bluetoothGoDrill({ eventAction: 'disconnected' })
                      else bluetoothGoDrill({})
                    },
                  }}
                />
              </div>
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <Card title="Top hostname" badge="HOSTNAME" noPad onClick={() => bluetoothGoDrill({})} titleHint="Click a bar">
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topEndpoints}
                  color={C.blue}
                  onBarClick={row => bluetoothGoDrill({ endpoint: row.key })}
                  tc={tc}
                />
                {!loading && !(dash?.topEndpoints?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                )}
              </div>
            </Card>
            <Card title="Top Bluetooth devices" badge="BT" noPad onClick={() => bluetoothGoDrill({})} titleHint="Click a bar">
              <div style={{ padding: '12px 14px' }}>
                <HBarChart
                  rows={dash?.topBluetooth}
                  color={C.indigo}
                  onBarClick={row => bluetoothGoDrill({ bluetoothDevice: row.key })}
                  tc={tc}
                />
                {!loading && !(dash?.topBluetooth?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No Bluetooth aggregation</div>
                )}
              </div>
            </Card>
          </div>

          <div ref={bluetoothLogAnchorRef} className="card" style={{ overflow: 'hidden', scrollMarginTop: 12 }}>
            <div className="card-header">
              <span className="card-title">Bluetooth activity log</span>
              <span className="badge badge-teal">CUSTOM LOG</span>
            </div>
            <div style={{ padding: '12px 14px' }}>
              <SentinelLogSearch
                key="bluetooth-embedded-log"
                scope="bt_only"
                range={range}
                onRangeChange={setRange}
                drill={drillForBluetooth}
                showAnalyze
                hideRangePicker
                accentColor={C.indigo}
                hostGroupSync={hostGroupFilter.trim()}
                onDrillClear={() => setBluetoothDrill(null)}
              />
            </div>
          </div>
        </>
      )}

      {tab === 'active' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <KPI
              label="Detected threats"
              value={threatsLoading ? '…' : activeThreatTotal != null ? activeThreatTotal.toLocaleString() : '—'}
              sub="active (range, no USB)"
              color="red"
              onClick={() => goDrill({ q: 'threat' })}
              title="Open Custom log — threat-related events in this scope"
            />
            <KPI
              label="Resolved threats"
              value={threatsLoading ? '…' : resolvedThreatTotal != null ? resolvedThreatTotal.toLocaleString() : '—'}
              sub="mitigated / quarantined / removed"
              color="green"
              onClick={() => goDrill({ q: 'mitigated' })}
              title="Open Custom log — resolved / mitigated signals"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Card
            title="Active threats"
            badge={activeThreatTotal != null ? activeThreatTotal : activeHits.length}
            noPad
          >
            <div style={{ overflowX: 'auto', maxHeight: 360 }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  tableLayout: 'fixed',
                  minWidth: sentActiveTbl.sumWidth,
                }}
              >
                <ResizableColGroup widths={sentActiveTbl.widths} />
                <thead>
                  <tr style={{ color: C.text3, textAlign: 'left' }}>
                    {['Time', 'Threat', 'Agent', 'State', 'Severity'].map((h, i) => (
                      <ResizableTh key={h} columnIndex={i} columnCount={5} startResize={sentActiveTbl.startResize} style={sentTableTh}>
                        {h}
                      </ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeHits.map(row => (
                    <tr
                      key={row._id}
                      style={{ color: C.text2, cursor: 'pointer' }}
                      onClick={() => goDrill({ q: row.threatName, endpoint: row.agent !== '—' ? row.agent : undefined })}
                    >
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {row['@timestamp'] ? new Date(row['@timestamp']).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', maxWidth: 260 }}>{row.threatName}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>{row.agent}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', color: C.red }}>{row.state}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>{row.severity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && !threatsLoading && activeHits.length === 0 && (
                <div style={{ textAlign: 'center', color: C.text3, padding: 28, fontFamily: 'var(--mono)' }}>No active threats (USB logs excluded)</div>
              )}
            </div>
          </Card>
          <Card
            title="Resolved threats"
            badge={resolvedThreatTotal != null ? resolvedThreatTotal : resolvedHits.length}
            noPad
          >
            <div style={{ overflowX: 'auto', maxHeight: 360 }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  tableLayout: 'fixed',
                  minWidth: sentResolvedTbl.sumWidth,
                }}
              >
                <ResizableColGroup widths={sentResolvedTbl.widths} />
                <thead>
                  <tr style={{ color: C.text3, textAlign: 'left' }}>
                    {['Time', 'Threat', 'Agent', 'State'].map((h, i) => (
                      <ResizableTh key={h} columnIndex={i} columnCount={4} startResize={sentResolvedTbl.startResize} style={sentTableTh}>
                        {h}
                      </ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resolvedHits.map(row => (
                    <tr
                      key={row._id}
                      style={{ color: C.text2, cursor: 'pointer' }}
                      onClick={() => goDrill({ q: row.threatName, endpoint: row.agent !== '—' ? row.agent : undefined })}
                    >
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {row['@timestamp'] ? new Date(row['@timestamp']).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', maxWidth: 260 }}>{row.threatName}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>{row.agent}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', color: C.green }}>{row.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && !threatsLoading && resolvedHits.length === 0 && (
                <div style={{ textAlign: 'center', color: C.text3, padding: 28, fontFamily: 'var(--mono)' }}>No resolved threats</div>
              )}
            </div>
          </Card>
          </div>
        </div>
      )}

      {tab === 'feed' && (
        <SentinelLogSearch
          key="xdr-feed-log"
          scope={drillForLog?.scope || 'all'}
          range={range}
          onRangeChange={setRange}
          drill={drillForLog}
          showAnalyze={false}
          accentColor={C.accent}
          hostGroupSync={hostGroupFilter.trim()}
          onDrillClear={() => setSentinelDrill(null)}
        />
      )}

      {tab === 'custom' && (
        <SentinelLogSearch
          key="xdr-custom-log"
          scope={drillForLog?.scope || 'all'}
          range={range}
          onRangeChange={setRange}
          drill={drillForLog}
          showAnalyze
          accentColor={C.accent}
          hostGroupSync={hostGroupFilter.trim()}
          onDrillClear={() => setSentinelDrill(null)}
        />
      )}

      {tab === 'feed' && (
        <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
          Tip: open <strong style={{ color: C.text2 }}>Custom log</strong> for the full analyze filter panel (scope, message, endpoint, user, USB or Bluetooth device, event kind).
        </div>
      )}
    </div>
  )
}

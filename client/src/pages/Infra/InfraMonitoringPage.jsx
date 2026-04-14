import { useCallback, useEffect, useState, useMemo } from 'react'
import { Line, Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import api from '../../api/client'
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../../components/ui/ResizableTable.jsx'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  BarController,
  Tooltip,
  Legend,
  Filler,
)

const C = {
  accent: '#4f7ef5',
  accent2: '#7c5cfc',
  green: '#22d3a0',
  red: '#f5534f',
  amber: '#f5a623',
  cyan: '#22d3ee',
  text: '#e8eaf2',
  text2: '#8b90aa',
  text3: '#555a72',
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'hosts', label: 'Hosts' },
  { id: 'hostGraphs', label: 'Host & graphs' },
  { id: 'problems', label: 'Problems' },
  { id: 'events', label: 'Events' },
]

const RANGE_SEC = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400 }

const DATASET_COLORS = ['#4f7ef5', '#22d3a0', '#f5a623', '#f5534f', '#7c5cfc', '#22d3ee', '#f97316']

function buildAlignedChart(seriesPayload) {
  const series = (seriesPayload?.series || []).filter((s) => (s.points || []).length > 0)
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
  if (!clocks.length && series[0]?.points?.length) {
    clocks = series[0].points.map((p) => Number(p.clock)).filter(Number.isFinite)
  }

  const labels = clocks.map((c) =>
    new Date(c * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  )

  const datasets = series.map((s, i) => {
    const hex =
      s.color && (String(s.color).startsWith('#') || /^[0-9a-fA-F]{6}$/.test(String(s.color)))
        ? String(s.color).startsWith('#')
          ? s.color
          : `#${s.color}`
        : DATASET_COLORS[i % DATASET_COLORS.length]
    const by = Object.fromEntries(
      (s.points || [])
        .map((p) => [Number(p.clock), Number(p.value)])
        .filter(([c, v]) => Number.isFinite(c) && Number.isFinite(v)),
    )
    const data = clocks.map((t) => {
      if (by[t] != null) return by[t]
      let best = null
      let bd = 300
      for (const p of s.points || []) {
        const c = Number(p.clock)
        const v = Number(p.value)
        if (!Number.isFinite(c) || !Number.isFinite(v)) continue
        const d = Math.abs(c - t)
        if (d < bd) {
          bd = d
          best = v
        }
      }
      return best
    })
    const unit = s.units ? ` (${s.units})` : ''
    return {
      label: `${s.name || s.key || s.itemid}${unit}`,
      data,
      borderColor: hex,
      backgroundColor: `${hex}22`,
      tension: 0.12,
      spanGaps: true,
      pointRadius: 0,
      borderWidth: 2,
      fill: false,
    }
  })
  return { labels, datasets }
}

function hexForLatestRow(row, i) {
  const c = row.color
  if (c && (String(c).startsWith('#') || /^[0-9a-fA-F]{6}$/.test(String(c))))
    return String(c).startsWith('#') ? c : `#${c}`
  return DATASET_COLORS[i % DATASET_COLORS.length]
}

/** Horizontal bar chart from API `latest` rows (numeric only). */
function buildLatestBarChart(latest) {
  const rows = (latest || []).filter((r) => r.numeric && r.value != null && Number.isFinite(Number(r.value)))
  if (!rows.length) return null
  const labels = rows.map((r) => {
    const u = r.units ? ` (${r.units})` : ''
    const short = (r.name || r.key || r.itemid || '').length > 48
      ? `${String(r.name || r.key || r.itemid).slice(0, 46)}…`
      : r.name || r.key || r.itemid
    return `${short}${u}`
  })
  const data = rows.map((r) => Number(r.value))
  const backgroundColor = rows.map((r, i) => `${hexForLatestRow(r, i)}44`)
  const borderColor = rows.map((r, i) => hexForLatestRow(r, i))
  return {
    labels,
    datasets: [
      {
        label: 'Latest',
        data,
        backgroundColor,
        borderColor,
        borderWidth: 1,
      },
    ],
  }
}

const SEV_ORDER = [
  { key: 5, label: 'Disaster' },
  { key: 4, label: 'High' },
  { key: 3, label: 'Average' },
  { key: 2, label: 'Warning' },
  { key: 1, label: 'Information' },
  { key: 0, label: 'Not classified' },
]

function sevColor(sev) {
  const n = Number(sev)
  if (n >= 5) return C.red
  if (n === 4) return '#f97316'
  if (n === 3) return C.amber
  if (n === 2) return C.cyan
  return C.text2
}

function Card({ title, badge, badgeClass = 'blue', children, noPad }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{title}</span>
        {badge !== undefined && badge !== null && (
          <span className={`badge badge-${badgeClass}`}>{badge}</span>
        )}
      </div>
      <div style={noPad ? {} : { padding: '12px 14px' }}>{children}</div>
    </div>
  )
}

function KPI({ label, value, sub, color, onClick, title }) {
  const colors = { blue: C.accent, red: C.red, green: C.green, amber: C.amber, cyan: C.cyan, purple: C.accent2 }
  const interactive = typeof onClick === 'function'
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      className={`kpi ${color}`}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      title={title || (interactive ? 'Click to filter / navigate' : undefined)}
      style={
        interactive
          ? { cursor: 'pointer', outline: 'none', borderRadius: 10, transition: 'background 0.15s' }
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
      <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1, marginBottom: 4, color: colors[color] || C.accent }}>
        {value ?? '—'}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>{sub}</div>
      )}
    </div>
  )
}

function fmtClock(ts) {
  if (ts == null || ts === '') return '—'
  const n = Number(ts)
  if (!Number.isFinite(n)) return String(ts)
  return new Date(n * 1000).toLocaleString()
}

function SeverityDistribution({ counts, selectedKey, onSelect }) {
  if (!counts) return null
  const total = SEV_ORDER.reduce((s, { key }) => s + (Number(counts[key]) || 0), 0) || 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {SEV_ORDER.map(({ key, label }) => {
        const n = Number(counts[key]) || 0
        const pct = Math.round((n / total) * 1000) / 10
        const w = `${Math.max((n / total) * 100, n > 0 ? 2 : 0)}%`
        const active = selectedKey === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect?.(key)}
            title="Filter latest problems and Problems tab by this severity (click again to clear)"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '6px 8px',
              margin: 0,
              border: active ? `1px solid ${sevColor(key)}` : '1px solid transparent',
              borderRadius: 8,
              background: active ? 'rgba(79,126,245,0.08)' : 'transparent',
              cursor: onSelect ? 'pointer' : 'default',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                width: 110,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                color: sevColor(key),
                flexShrink: 0,
              }}
            >
              {label}
            </span>
            <div
              style={{
                flex: 1,
                height: 8,
                borderRadius: 4,
                background: 'var(--bg3)',
                overflow: 'hidden',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ width: w, height: '100%', background: sevColor(key), opacity: 0.85, transition: 'width 0.2s' }} />
            </div>
            <span style={{ width: 56, textAlign: 'right', fontSize: 11, fontFamily: 'var(--mono)', color: C.text3 }}>
              {n} ({pct}%)
            </span>
          </button>
        )
      })}
      <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', marginTop: 4 }}>
        Click a severity to filter. Distribution from up to 3k recent problems (Zabbix sample).
      </div>
    </div>
  )
}

function DataTable({ columns, rows, empty, rowKey }) {
  const storageKey = `infra-${columns.map((c) => c.key).join('-')}`
  const defaults = columns.map(() => 128)
  const { widths, startResize, sumWidth } = useResizableColumns(storageKey, defaults)
  const thBase = {
    padding: '10px 14px',
    fontWeight: 600,
    borderBottom: '1px solid var(--border)',
    color: C.text3,
    textAlign: 'left',
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          margin: 0,
          fontSize: 12,
          fontFamily: 'var(--mono)',
          tableLayout: 'fixed',
          minWidth: sumWidth,
        }}
      >
        <ResizableColGroup widths={widths} />
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', color: C.text3, textAlign: 'left' }}>
            {columns.map((col, i) => (
              <ResizableTh key={col.key} columnIndex={i} columnCount={columns.length} startResize={startResize} style={thBase}>
                {col.label}
              </ResizableTh>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ color: C.text3, padding: '16px 14px', borderBottom: '1px solid var(--border)' }}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={rowKey(row, i)} style={{ borderBottom: '1px solid var(--border)' }}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={{ padding: '10px 14px', overflow: 'hidden', textOverflow: 'ellipsis', ...col.cellStyle?.(row) }}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

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
  const [hostsExplorer, setHostsExplorer] = useState(null)
  const [explorerBusy, setExplorerBusy] = useState(false)
  const [selectedHost, setSelectedHost] = useState(null)
  const [hostGraphs, setHostGraphs] = useState(null)
  const [graphsBusy, setGraphsBusy] = useState(false)
  const [selectedGraphId, setSelectedGraphId] = useState(null)
  const [graphSeries, setGraphSeries] = useState(null)
  const [graphRange, setGraphRange] = useState('24h')
  const [severityFilter, setSeverityFilter] = useState(null)
  const [graphSeriesBusy, setGraphSeriesBusy] = useState(false)
  /** `auto` = history/trends then fallback to last values; `latest` = VMware-friendly, no history API calls */
  const [graphDataMode, setGraphDataMode] = useState('auto')

  const parseErr = useCallback((e) => {
    const d = e.response?.data
    const msg = d?.error || d?.hint || e.message || 'Failed to load Zabbix'
    const hints = [d?.hint, d?.code && `code: ${d.code}`, d?.zabbixCode != null && `zabbix: ${d.zabbixCode}`].filter(Boolean)
    return {
      message: typeof msg === 'string' ? msg : JSON.stringify(msg),
      hint: hints.length ? hints.join(' · ') : null,
    }
  }, [])

  const loadOverview = useCallback(async () => {
    const { data: ov } = await api.get('/api/zabbix/overview')
    setOverview(ov)
  }, [])

  const loadHosts = useCallback(async () => {
    const { data } = await api.get('/api/zabbix/hosts')
    setHosts(data.hosts || [])
  }, [])

  const searchHosts = useCallback(async (q) => {
    const qs = new URLSearchParams()
    if (q != null && String(q).trim()) qs.set('q', String(q).trim())
    qs.set('limit', '400')
    const { data } = await api.get(`/api/zabbix/hosts?${qs}`)
    setHostsExplorer(data.hosts || [])
  }, [])

  const loadHostGraphs = useCallback(async (hostid) => {
    const { data } = await api.get(`/api/zabbix/hosts/${encodeURIComponent(hostid)}/graphs`)
    setHostGraphs(data.graphs || [])
  }, [])

  const fetchGraphSeriesPayload = useCallback(async (graphId, rangeKey, dataMode) => {
    const sec = RANGE_SEC[rangeKey] || RANGE_SEC['6h']
    const now = Math.floor(Date.now() / 1000)
    const from = now - sec
    const qs = new URLSearchParams({ from: String(from), to: String(now) })
    if (dataMode === 'latest') qs.set('mode', 'latest')
    const { data } = await api.get(
      `/api/zabbix/graphs/${encodeURIComponent(graphId)}/series?${qs}`,
    )
    return data
  }, [])

  const loadEvents = useCallback(async () => {
    const { data } = await api.get('/api/zabbix/events?limit=150')
    setEvents(data.events || [])
  }, [])

  const loadConfigAndOverview = useCallback(async () => {
    setError(null)
    setErrorHint(null)
    try {
      const { data: cfg } = await api.get('/api/zabbix/config')
      setConfig(cfg)
      if (!cfg.configured) {
        setOverview(null)
        return
      }
      await loadOverview()
    } catch (e) {
      const { message, hint } = parseErr(e)
      setError(message)
      setErrorHint(hint)
      setOverview(null)
    }
  }, [loadOverview, parseErr])

  const loadTabData = useCallback(
    async (t) => {
      if (!config?.configured) return
      setTabBusy(true)
      setError(null)
      setErrorHint(null)
      try {
        if (t === 'hosts') await loadHosts()
        else if (t === 'events') await loadEvents()
        else if (t === 'hostGraphs' && hostsExplorer === null) await searchHosts('')
      } catch (e) {
        const { message, hint } = parseErr(e)
        setError(message)
        setErrorHint(hint)
      } finally {
        setTabBusy(false)
      }
    },
    [config?.configured, loadHosts, loadEvents, parseErr, hostsExplorer, searchHosts],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      await loadConfigAndOverview()
      if (!cancelled) setLoading(false)
    })()
    const t = setInterval(() => {
      loadConfigAndOverview().catch(() => {})
    }, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [loadConfigAndOverview])

  useEffect(() => {
    if (!config?.configured || tab === 'overview') return
    if (tab === 'hosts' && hosts === null) loadTabData('hosts')
    if (tab === 'hostGraphs' && hostsExplorer === null) loadTabData('hostGraphs')
    if (tab === 'events' && events === null) loadTabData('events')
  }, [tab, config?.configured, hosts, hostsExplorer, events, loadTabData])

  useEffect(() => {
    if (!config?.configured || tab !== 'problems') return
    let cancelled = false
    setTabBusy(true)
    setError(null)
    setErrorHint(null)
    const qs = new URLSearchParams({ limit: '250' })
    if (severityFilter != null && severityFilter !== '') qs.set('severity', String(severityFilter))
    api
      .get(`/api/zabbix/problems?${qs}`)
      .then(({ data }) => {
        if (!cancelled) setProblemsFull(data.problems || [])
      })
      .catch((e) => {
        if (cancelled) return
        const { message, hint } = parseErr(e)
        setError(message)
        setErrorHint(hint)
        setProblemsFull([])
      })
      .finally(() => {
        if (!cancelled) setTabBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, config?.configured, severityFilter, parseErr])

  useEffect(() => {
    if (tab !== 'hostGraphs' || !config?.configured) return
    const timer = setTimeout(() => {
      setExplorerBusy(true)
      setError(null)
      setErrorHint(null)
      searchHosts(hostSearch)
        .catch((e) => {
          const { message, hint } = parseErr(e)
          setError(message)
          setErrorHint(hint)
        })
        .finally(() => setExplorerBusy(false))
    }, 320)
    return () => clearTimeout(timer)
  }, [hostSearch, tab, config?.configured, searchHosts, parseErr])

  useEffect(() => {
    if (!selectedGraphId || tab !== 'hostGraphs') return
    let cancelled = false
    setGraphSeriesBusy(true)
    setError(null)
    setErrorHint(null)
    fetchGraphSeriesPayload(selectedGraphId, graphRange, graphDataMode)
      .then((data) => {
        if (!cancelled) setGraphSeries(data)
      })
      .catch((e) => {
        if (cancelled) return
        const { message, hint } = parseErr(e)
        setError(message)
        setErrorHint(hint)
        setGraphSeries(null)
      })
      .finally(() => {
        if (!cancelled) setGraphSeriesBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [graphRange, selectedGraphId, tab, graphDataMode, fetchGraphSeriesPayload, parseErr])

  const chartData = useMemo(() => {
    const s = graphSeries?.series
    if (!s?.length) return null
    return buildAlignedChart(graphSeries)
  }, [graphSeries])

  const latestBarData = useMemo(() => {
    if (graphSeries?.displayMode !== 'latest' || !graphSeries?.latest?.length) return null
    return buildLatestBarChart(graphSeries.latest)
  }, [graphSeries])

  const latestNonNumeric = useMemo(() => {
    if (graphSeries?.displayMode !== 'latest' || !graphSeries?.latest?.length) return []
    return graphSeries.latest.filter((r) => !r.numeric && r.rawValue != null)
  }, [graphSeries])

  const overviewProblemsFiltered = useMemo(() => {
    const list = overview?.problems || []
    if (severityFilter == null) return list
    return list.filter((p) => Number(p.severity) === Number(severityFilter))
  }, [overview?.problems, severityFilter])

  const onSeverityBarClick = useCallback((key) => {
    setSeverityFilter((prev) => (prev === key ? null : key))
  }, [])

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: C.text2, font: { size: 10 }, boxWidth: 12 },
        },
        tooltip: {
          titleColor: C.text,
          bodyColor: C.text2,
          backgroundColor: 'rgba(20,22,30,0.95)',
          borderColor: 'rgba(99,120,200,0.25)',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: C.text3, maxRotation: 50, font: { size: 9 }, maxTicksLimit: 12 },
          grid: { color: 'rgba(99,120,200,0.07)' },
        },
        y: {
          ticks: { color: C.text3, font: { size: 9 } },
          grid: { color: 'rgba(99,120,200,0.07)' },
          beginAtZero: false,
          grace: '12%',
        },
      },
    }),
    [],
  )

  const latestBarOptions = useMemo(
    () => ({
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          titleColor: C.text,
          bodyColor: C.text2,
          backgroundColor: 'rgba(20,22,30,0.95)',
          borderColor: 'rgba(99,120,200,0.25)',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          ticks: { color: C.text3, font: { size: 10 } },
          grid: { color: 'rgba(99,120,200,0.07)' },
        },
        y: {
          ticks: { color: C.text2, font: { size: 9 }, autoSkip: false },
          grid: { display: false },
        },
      },
    }),
    [],
  )

  const configured = config?.configured
  const baseUrl = config?.zabbixUrl

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setErrorHint(null)
    try {
      const { data: cfg } = await api.get('/api/zabbix/config')
      setConfig(cfg)
      if (!cfg.configured) {
        setOverview(null)
        return
      }
      await loadOverview()
      if (tab === 'hosts') await loadHosts()
      if (tab === 'problems') {
        const qs = new URLSearchParams({ limit: '250' })
        if (severityFilter != null && severityFilter !== '') qs.set('severity', String(severityFilter))
        const { data } = await api.get(`/api/zabbix/problems?${qs}`)
        setProblemsFull(data.problems || [])
      }
      if (tab === 'events') await loadEvents()
      if (tab === 'hostGraphs') {
        await searchHosts(hostSearch)
        if (selectedHost?.hostid) {
          await loadHostGraphs(selectedHost.hostid)
          if (selectedGraphId) {
            const data = await fetchGraphSeriesPayload(selectedGraphId, graphRange, graphDataMode)
            setGraphSeries(data)
          }
        }
      }
    } catch (e) {
      const { message, hint } = parseErr(e)
      setError(message)
      setErrorHint(hint)
    } finally {
      setLoading(false)
    }
  }, [
    tab,
    loadOverview,
    loadHosts,
    loadEvents,
    severityFilter,
    parseErr,
    hostSearch,
    selectedHost,
    selectedGraphId,
    graphRange,
    graphDataMode,
    searchHosts,
    loadHostGraphs,
    fetchGraphSeriesPayload,
  ])

  const problemColumns = [
    {
      key: 'sev',
      label: 'Severity',
      render: (p) => <span style={{ color: sevColor(p.severity), whiteSpace: 'nowrap' }}>{p.severityLabel}</span>,
    },
    {
      key: 'name',
      label: 'Problem',
      render: (p) => <span style={{ color: 'var(--text)', maxWidth: 420 }}>{p.name}</span>,
    },
    {
      key: 'hosts',
      label: 'Hosts',
      render: (p) => (
        <span style={{ color: C.text2, fontSize: 11 }}>{(p.hosts || []).map((h) => h.name || h.host).join(', ') || '—'}</span>
      ),
    },
    {
      key: 'since',
      label: 'Since',
      render: (p) => <span style={{ color: C.text3, whiteSpace: 'nowrap' }}>{fmtClock(p.clock)}</span>,
    },
  ]

  const hostColumns = [
    {
      key: 'name',
      label: 'Display name',
      render: (h) => <span style={{ color: 'var(--text)' }}>{h.name || h.host}</span>,
    },
    {
      key: 'host',
      label: 'Technical',
      render: (h) => <span style={{ color: C.text2 }}>{h.host}</span>,
    },
    {
      key: 'groups',
      label: 'Groups',
      render: (h) => <span style={{ color: C.text2, fontSize: 11 }}>{(h.groups || []).join(', ') || '—'}</span>,
    },
    {
      key: 'mon',
      label: 'Monitoring',
      render: (h) => (
        <span style={{ color: h.monitored ? C.green : C.amber }}>{h.monitored ? 'Enabled' : 'Disabled'}</span>
      ),
    },
    {
      key: 'avail',
      label: 'Agent',
      render: (h) => {
        const ok = h.availability === 'Available'
        const bad = h.availability === 'Unavailable'
        return (
          <span style={{ color: ok ? C.green : bad ? C.red : C.text3 }}>
            {h.availability}
          </span>
        )
      },
    },
  ]

  const pickExplorerHost = useCallback(
    async (h) => {
      setSelectedHost(h)
      setGraphDataMode('auto')
      setSelectedGraphId(null)
      setGraphSeries(null)
      setGraphsBusy(true)
      setError(null)
      setErrorHint(null)
      try {
        await loadHostGraphs(h.hostid)
      } catch (e) {
        const { message, hint } = parseErr(e)
        setError(message)
        setErrorHint(hint)
        setHostGraphs(null)
      } finally {
        setGraphsBusy(false)
      }
    },
    [loadHostGraphs, parseErr],
  )

  const pickGraph = useCallback((graphid) => {
    setSelectedGraphId(graphid)
    setGraphSeries(null)
  }, [])

  const eventColumns = [
    {
      key: 'sev',
      label: 'Severity',
      render: (ev) => (
        <span style={{ color: sevColor(ev.severity), whiteSpace: 'nowrap' }}>{ev.severityLabel}</span>
      ),
    },
    {
      key: 'name',
      label: 'Event',
      render: (ev) => <span style={{ color: 'var(--text)', maxWidth: 400 }}>{ev.name}</span>,
    },
    {
      key: 'hosts',
      label: 'Hosts',
      render: (ev) => (
        <span style={{ color: C.text2, fontSize: 11 }}>
          {(ev.hosts || []).map((h) => h.name || h.host).join(', ') || '—'}
        </span>
      ),
    },
    {
      key: 'time',
      label: 'Time',
      render: (ev) => <span style={{ color: C.text3, whiteSpace: 'nowrap' }}>{fmtClock(ev.clock)}</span>,
    },
    {
      key: 'src',
      label: 'Src',
      render: (ev) => <span style={{ color: C.text3, fontSize: 10 }}>{ev.source}</span>,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 13, color: C.text2, maxWidth: 680 }}>
          Zabbix: overview, hosts, searchable host inventory with in-app performance graphs (history/trends), problems, and
          events — all via the Netpulse API.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {baseUrl && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: C.text3 }} title="Zabbix base URL">
              {baseUrl}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              refresh()
            }}
            disabled={loading || tabBusy}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg4)',
              color: C.text2,
              cursor: loading || tabBusy ? 'wait' : 'pointer',
              fontSize: 12,
              fontFamily: 'var(--mono)',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {configured && (
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg3)', borderRadius: 10, padding: 3, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 7,
                cursor: 'pointer',
                border: 'none',
                fontFamily: 'var(--sans)',
                letterSpacing: 0.3,
                background: tab === t.id ? C.accent : 'transparent',
                color: tab === t.id ? '#fff' : C.text2,
                transition: 'all 0.15s',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {!configured && !loading && (
        <Card title="Configuration" badge="Required" badgeClass="amber">
          <p style={{ margin: 0, fontSize: 13, color: C.text2, lineHeight: 1.5 }}>
            Set <code style={{ color: C.cyan }}>ZABBIX_URL</code> and{' '}
            <code style={{ color: C.cyan }}>ZABBIX_API_TOKEN</code> in the server <code style={{ color: C.cyan }}>.env</code>{' '}
            (see <code style={{ color: C.cyan }}>server/.env.example</code>), then restart the API.
          </p>
        </Card>
      )}

      {error && (
        <Card title="Zabbix error" badge="Fix" badgeClass="amber">
          <p style={{ margin: '0 0 10px', fontSize: 13, color: C.red, fontFamily: 'var(--mono)' }}>{error}</p>
          {errorHint && (
            <p style={{ margin: '0 0 10px', fontSize: 12, color: C.text2, fontFamily: 'var(--mono)' }}>{errorHint}</p>
          )}
          <p style={{ margin: 0, fontSize: 12, color: C.text2, lineHeight: 1.5 }}>
            Diagnostic:{' '}
            <code style={{ color: C.cyan }}>{api.defaults.baseURL || ''}/api/zabbix/diagnostic</code>
          </p>
        </Card>
      )}

      {configured && tab === 'overview' && overview && (
        <>
          {severityFilter != null && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg3)',
                fontSize: 12,
                fontFamily: 'var(--mono)',
                color: C.text2,
              }}
            >
              <span>
                Severity filter:{' '}
                <strong style={{ color: sevColor(severityFilter) }}>
                  {SEV_ORDER.find((x) => x.key === severityFilter)?.label || severityFilter}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => setSeverityFilter(null)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg4)',
                  color: C.cyan,
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                }}
              >
                Clear filter
              </button>
              <button
                type="button"
                onClick={() => setTab('problems')}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: 'none',
                  background: C.accent,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                }}
              >
                Open Problems tab
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            <KPI label="Zabbix version" value={overview.version || '—'} sub="API" color="blue" />
            <KPI
              label="Monitored hosts"
              value={overview.monitoredHosts}
              sub="Open Hosts tab"
              color="green"
              onClick={() => setTab('hosts')}
              title="Go to Hosts"
            />
            <KPI
              label="Active problems"
              value={overview.activeProblems}
              sub="Open Problems tab"
              color="amber"
              onClick={() => {
                setSeverityFilter(null)
                setTab('problems')
              }}
              title="Show all problems"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, alignItems: 'start' }}>
            <Card title="Severity distribution" badgeClass="blue">
              <SeverityDistribution
                counts={overview.severityCounts}
                selectedKey={severityFilter}
                onSelect={onSeverityBarClick}
              />
            </Card>
            <Card
              title="Latest problems"
              badge={
                severityFilter != null
                  ? `${overviewProblemsFiltered.length} / ${(overview.problems || []).length}`
                  : (overview.problems || []).length
              }
              badgeClass="blue"
              noPad
            >
              <DataTable
                columns={problemColumns}
                rows={overviewProblemsFiltered}
                empty={severityFilter != null ? 'No problems at this severity in the latest sample.' : 'No open problems.'}
                rowKey={(p) => p.eventid}
              />
            </Card>
          </div>
        </>
      )}

      {configured && tab === 'hostGraphs' && (
        <Card title="Search host & view graphs" badge={selectedHost ? selectedHost.name || selectedHost.host : '—'} badgeClass="blue">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="search"
              value={hostSearch}
              onChange={(e) => setHostSearch(e.target.value)}
              placeholder="Filter by display name or technical host (wildcards * allowed)…"
              style={{
                width: '100%',
                maxWidth: 560,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg3)',
                color: 'var(--text)',
                fontSize: 13,
                fontFamily: 'var(--mono)',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch', minHeight: 420 }}>
              <div
                style={{
                  flex: '0 0 260px',
                  minWidth: 220,
                  maxHeight: 480,
                  overflowY: 'auto',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  background: 'var(--bg3)',
                }}
              >
                {explorerBusy ? (
                  <div style={{ padding: 16, color: C.text3, fontSize: 12, fontFamily: 'var(--mono)' }}>Searching…</div>
                ) : (
                  (hostsExplorer || []).map((h) => (
                    <button
                      key={h.hostid}
                      type="button"
                      onClick={() => pickExplorerHost(h)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        border: 'none',
                        borderBottom: '1px solid var(--border)',
                        background: selectedHost?.hostid === h.hostid ? 'rgba(79,126,245,0.12)' : 'transparent',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontFamily: 'var(--mono)',
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{h.name || h.host}</div>
                      <div style={{ fontSize: 10, color: C.text3 }}>{h.host}</div>
                    </button>
                  ))
                )}
                {!explorerBusy && hostsExplorer?.length === 0 && (
                  <div style={{ padding: 16, color: C.text3, fontSize: 12 }}>No hosts match.</div>
                )}
              </div>

              <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {!selectedHost && (
                  <p style={{ margin: 0, fontSize: 13, color: C.text2 }}>Select a host to list its Zabbix graphs.</p>
                )}
                {selectedHost && (
                  <>
                    <div style={{ fontSize: 12, color: C.text2, fontFamily: 'var(--mono)' }}>
                      <span style={{ color: C.text3 }}>Graphs for </span>
                      {selectedHost.name || selectedHost.host}
                      <span style={{ color: C.text3 }}> ({selectedHost.host})</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {(['1h', '6h', '24h', '7d']).map((r) => (
                        <button
                          key={r}
                          type="button"
                          disabled={!selectedGraphId || graphDataMode === 'latest'}
                          onClick={() => setGraphRange(r)}
                          style={{
                            padding: '5px 12px',
                            borderRadius: 7,
                            border: graphRange === r ? `1px solid ${C.accent}` : '1px solid var(--border)',
                            background: graphRange === r ? 'rgba(79,126,245,0.15)' : 'var(--bg4)',
                            color: graphRange === r ? C.accent : C.text2,
                            fontSize: 11,
                            fontFamily: 'var(--mono)',
                            cursor: selectedGraphId && graphDataMode !== 'latest' ? 'pointer' : 'not-allowed',
                            opacity: selectedGraphId && graphDataMode !== 'latest' ? 1 : 0.45,
                          }}
                        >
                          {r}
                        </button>
                      ))}
                      <span
                        style={{
                          display: 'inline-block',
                          width: 1,
                          height: 18,
                          background: 'var(--border)',
                          margin: '0 6px',
                        }}
                        aria-hidden
                      />
                      <span style={{ fontSize: 10, color: C.text3 }}>Source:</span>
                      {[
                        { id: 'auto', label: 'History' },
                        { id: 'latest', label: 'Latest only' },
                      ].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          disabled={!selectedGraphId}
                          onClick={() => setGraphDataMode(m.id)}
                          title={
                            m.id === 'latest'
                              ? 'Uses Zabbix lastvalue only (VMware / integrations with thin history)'
                              : 'History and trends for the range, then last values if empty'
                          }
                          style={{
                            padding: '5px 10px',
                            borderRadius: 7,
                            border:
                              graphDataMode === m.id ? `1px solid ${C.accent}` : '1px solid var(--border)',
                            background: graphDataMode === m.id ? 'rgba(79,126,245,0.15)' : 'var(--bg4)',
                            color: graphDataMode === m.id ? C.accent : C.text2,
                            fontSize: 11,
                            fontFamily: 'var(--mono)',
                            cursor: selectedGraphId ? 'pointer' : 'not-allowed',
                            opacity: selectedGraphId ? 1 : 0.45,
                          }}
                        >
                          {m.label}
                        </button>
                      ))}
                      <span style={{ fontSize: 10, color: C.text3, marginLeft: 4 }}>
                        {graphDataMode === 'latest'
                          ? 'Current values from Zabbix (no time range).'
                          : 'Long ranges prefer Zabbix trends (averages).'}
                      </span>
                    </div>
                    <div
                      style={{
                        maxHeight: 200,
                        overflowY: 'auto',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        background: 'var(--bg3)',
                      }}
                    >
                      {graphsBusy ? (
                        <div style={{ padding: 12, color: C.text3, fontSize: 12 }}>Loading graphs…</div>
                      ) : (
                        (hostGraphs || []).map((g) => (
                          <button
                            key={g.graphid}
                            type="button"
                            onClick={() => pickGraph(g.graphid)}
                            style={{
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              padding: '8px 12px',
                              border: 'none',
                              borderBottom: '1px solid var(--border)',
                              background: selectedGraphId === g.graphid ? 'rgba(79,126,245,0.12)' : 'transparent',
                              color: g.drawable ? 'var(--text)' : C.text3,
                              cursor: 'pointer',
                              fontSize: 12,
                              fontFamily: 'var(--mono)',
                            }}
                          >
                            {g.name}
                            {!g.drawable && <span style={{ color: C.amber, marginLeft: 6, fontSize: 10 }}>pie</span>}
                          </button>
                        ))
                      )}
                      {!graphsBusy && selectedHost && (hostGraphs || []).length === 0 && (
                        <div style={{ padding: 12, color: C.text3, fontSize: 12 }}>No graphs on this host.</div>
                      )}
                    </div>

                    <div
                      style={{
                        flex: 1,
                        minHeight: 280,
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: '12px 14px',
                        background: 'var(--bg2)',
                      }}
                    >
                      {graphSeriesBusy && (
                        <div style={{ color: C.text3, fontSize: 12, fontFamily: 'var(--mono)' }}>Loading series…</div>
                      )}
                      {!graphSeriesBusy && graphSeries?.unsupported && (
                        <p style={{ margin: 0, fontSize: 13, color: C.amber }}>{graphSeries.unsupported}</p>
                      )}
                      {!graphSeriesBusy && graphSeries?.message && !graphSeries.unsupported && (
                        <p style={{ margin: 0, fontSize: 13, color: C.text3 }}>{graphSeries.message}</p>
                      )}
                      {!graphSeriesBusy &&
                        graphSeries?.skipped?.length > 0 &&
                        graphSeries.displayMode !== 'latest' &&
                        (!graphSeries?.series?.length || graphSeries.series.every((s) => !(s.points || []).length)) && (
                          <div
                            style={{
                              marginBottom: 10,
                              padding: 10,
                              borderRadius: 8,
                              background: 'rgba(245,166,35,0.08)',
                              border: '1px solid rgba(245,166,35,0.25)',
                              fontSize: 11,
                              fontFamily: 'var(--mono)',
                              color: C.text2,
                              maxHeight: 140,
                              overflowY: 'auto',
                            }}
                          >
                            <div style={{ fontWeight: 600, marginBottom: 6, color: C.amber }}>No plot data — item details</div>
                            {graphSeries.skipped.slice(0, 12).map((sk) => (
                              <div key={sk.itemid} style={{ marginBottom: 4 }}>
                                {sk.itemid}: {sk.reason}
                              </div>
                            ))}
                            {graphSeries.skipped.length > 12 && (
                              <div style={{ color: C.text3 }}>…and {graphSeries.skipped.length - 12} more</div>
                            )}
                          </div>
                        )}
                      {!graphSeriesBusy &&
                        selectedGraphId &&
                        graphSeries &&
                        !graphSeries.unsupported &&
                        graphSeries.displayMode === 'latest' &&
                        (latestBarData || latestNonNumeric.length > 0) && (
                          <>
                            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>
                              {graphSeries.graph?.name}
                              <span style={{ fontWeight: 400, fontSize: 10, color: C.text3, marginLeft: 8 }}>
                                Current values (Zabbix lastvalue)
                              </span>
                            </div>
                            {graphSeries.note && (
                              <p
                                style={{
                                  margin: '0 0 10px',
                                  fontSize: 11,
                                  color: C.text3,
                                  fontFamily: 'var(--mono)',
                                }}
                              >
                                {graphSeries.note}
                              </p>
                            )}
                            {latestBarData && (
                              <div
                                style={{
                                  height: Math.min(480, 48 + latestBarData.labels.length * 32),
                                  position: 'relative',
                                  marginBottom: latestNonNumeric.length ? 14 : 0,
                                }}
                              >
                                <Bar data={latestBarData} options={latestBarOptions} />
                              </div>
                            )}
                            {latestNonNumeric.length > 0 && (
                              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: C.text2 }}>
                                <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>
                                  Text / state items
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <tbody>
                                    {latestNonNumeric.map((r) => (
                                      <tr key={r.itemid}>
                                        <td
                                          style={{
                                            padding: '4px 10px 4px 0',
                                            color: C.text3,
                                            verticalAlign: 'top',
                                            maxWidth: 200,
                                          }}
                                        >
                                          {r.name || r.key}
                                        </td>
                                        <td style={{ padding: '4px 0', color: 'var(--text)' }}>{r.rawValue}</td>
                                        <td
                                          style={{
                                            padding: '4px 0 4px 10px',
                                            color: C.text3,
                                            whiteSpace: 'nowrap',
                                          }}
                                        >
                                          {fmtClock(r.lastclock)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </>
                        )}
                      {!graphSeriesBusy &&
                        selectedGraphId &&
                        graphSeries &&
                        !graphSeries.unsupported &&
                        chartData && (
                          <>
                            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>
                              {graphSeries.graph?.name}
                              {graphSeries.aggregated && (
                                <span style={{ fontWeight: 400, fontSize: 10, color: C.text3, marginLeft: 8 }}>
                                  (trend / averaged)
                                </span>
                              )}
                            </div>
                            <div style={{ height: 300, position: 'relative' }}>
                              <Line data={chartData} options={chartOptions} />
                            </div>
                          </>
                        )}
                      {!graphSeriesBusy &&
                        selectedGraphId &&
                        graphSeries &&
                        !graphSeries.unsupported &&
                        !chartData &&
                        !latestBarData &&
                        latestNonNumeric.length === 0 &&
                        (graphSeries.displayMode === 'latest' || graphDataMode === 'latest') && (
                          <p style={{ margin: 0, fontSize: 13, color: C.text3 }}>
                            No last values returned for items on this graph (check permissions / item status in Zabbix).
                          </p>
                        )}
                      {!graphSeriesBusy &&
                        selectedGraphId &&
                        graphSeries &&
                        !graphSeries.unsupported &&
                        graphSeries.displayMode !== 'latest' &&
                        graphDataMode !== 'latest' &&
                        !chartData && (
                          <p style={{ margin: 0, fontSize: 13, color: C.text3 }}>
                            No numeric series for this graph (check item types / permissions).
                          </p>
                        )}
                      {!selectedGraphId && selectedHost && !graphsBusy && (
                        <p style={{ margin: 0, fontSize: 13, color: C.text3 }}>Choose a graph above to load data.</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {configured && tab === 'hosts' && (
        <Card title="Monitored hosts" badge={hosts?.length ?? '…'} badgeClass="green" noPad>
          {hosts === null || tabBusy ? (
            <div style={{ padding: 20, color: C.text3, fontFamily: 'var(--mono)', fontSize: 13 }}>Loading hosts…</div>
          ) : (
            <DataTable
              columns={hostColumns}
              rows={hosts}
              empty="No monitored hosts returned."
              rowKey={(h) => h.hostid}
            />
          )}
        </Card>
      )}

      {configured && tab === 'problems' && (
        <Card title="Open problems" badge={problemsFull?.length ?? '…'} badgeClass="amber" noPad>
          {severityFilter != null && (
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                fontSize: 12,
                fontFamily: 'var(--mono)',
                color: C.text2,
              }}
            >
              <span>
                Filter:{' '}
                <strong style={{ color: sevColor(severityFilter) }}>
                  {SEV_ORDER.find((x) => x.key === severityFilter)?.label || severityFilter}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => setSeverityFilter(null)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg4)',
                  color: C.cyan,
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                Clear
              </button>
            </div>
          )}
          {problemsFull === null || tabBusy ? (
            <div style={{ padding: 20, color: C.text3, fontFamily: 'var(--mono)', fontSize: 13 }}>Loading problems…</div>
          ) : (
            <DataTable
              columns={problemColumns}
              rows={problemsFull}
              empty="No problems in this window."
              rowKey={(p) => p.eventid}
            />
          )}
        </Card>
      )}

      {configured && tab === 'events' && (
        <Card title="Recent events" badge={events?.length ?? '…'} badgeClass="blue" noPad>
          {events === null || tabBusy ? (
            <div style={{ padding: 20, color: C.text3, fontFamily: 'var(--mono)', fontSize: 13 }}>Loading events…</div>
          ) : (
            <DataTable
              columns={eventColumns}
              rows={events}
              empty="No events returned (check API token permissions for event.get)."
              rowKey={(ev) => ev.eventid}
            />
          )}
        </Card>
      )}

      {loading && !overview && configured && (
        <div style={{ color: C.text3, fontSize: 13, fontFamily: 'var(--mono)' }}>Loading Zabbix…</div>
      )}
    </div>
  )
}

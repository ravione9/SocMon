import RangePicker from '../../components/ui/RangePicker.jsx'
import SentinelLogSearch from '../../components/sentinel/SentinelLogSearch.jsx'
import { useEffect, useState, useMemo, useCallback } from 'react'
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
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../../components/ui/ResizableTable.jsx'

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
  { id: 'bluetooth', label: 'Bluetooth device connection' },
  { id: 'feed', label: 'Event feed' },
  { id: 'custom', label: 'Custom log' },
]

const co = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: {
      ticks: { color: C.text3, font: { size: 9 }, maxTicksLimit: 10 },
      grid: { color: 'rgba(99,120,200,0.07)' },
    },
    y: {
      ticks: { color: C.text3, font: { size: 9 } },
      grid: { color: 'rgba(99,120,200,0.07)' },
    },
  },
}

function scopeForTab(tab) {
  if (tab === 'overview') return 'all'
  if (tab === 'active') return 'no_usb'
  if (tab === 'usb') return 'usb_only'
  if (tab === 'bluetooth') return 'bt_only'
  return 'all'
}

function KPI({ label, value, sub, color, onClick, title }) {
  return (
    <div
      className={`kpi ${color}`}
      style={{ minWidth: 0, cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
      title={title || (onClick ? 'Open in Custom log' : undefined)}
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

function HBarChart({ rows, color, onBarClick }) {
  const labels = (rows || []).map(r => String(r.key).slice(0, 32))
  const data = (rows || []).map(r => r.count)
  return (
    <div style={{ height: Math.max(180, rows?.length * 28 || 0) }}>
      <Bar
        data={{
          labels,
          datasets: [{ data, backgroundColor: color || C.accent, borderWidth: 0, borderRadius: 4 }],
        }}
        options={{
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: true },
          },
          scales: {
            x: { ticks: { color: C.text3, font: { size: 9 } }, grid: { color: 'rgba(99,120,200,0.07)' } },
            y: { ticks: { color: C.text2, font: { size: 9 } }, grid: { display: false } },
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
  const [range, setRange] = useState({ type: 'preset', value: '24h', label: '24h' })
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

  const usbGoDrill = useCallback(patch => {
    setUsbDrill({ ...patch, _ts: Date.now() })
  }, [])

  const bluetoothGoDrill = useCallback(patch => {
    setBluetoothDrill({ ...patch, _ts: Date.now() })
  }, [])

  useEffect(() => {
    if (tab !== 'usb') setUsbDrill(null)
  }, [tab])

  useEffect(() => {
    if (tab !== 'bluetooth') setBluetoothDrill(null)
  }, [tab])

  const goDrill = useCallback(
    patch => {
      setSentinelDrill({ scope: scopeForTab(tab), ...patch, _ts: Date.now() })
      setTab('custom')
    },
    [tab],
  )

  const hostGroupQuery = useMemo(() => {
    const h = hostGroupFilter.trim()
    return h ? `&hostGroup=${encodeURIComponent(h)}` : ''
  }, [hostGroupFilter])

  useEffect(() => {
    if (!['overview', 'active', 'usb', 'bluetooth'].includes(tab)) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const rp = `range=${range?.value || ''}&from=${range?.from || ''}&to=${range?.to || ''}`
        const sc = scopeForTab(tab)
        const { data } = await api.get(`/api/sentinel/dashboard?${rp}&scope=${sc}${hostGroupQuery}`)
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
  }, [range, tab, hostGroupQuery])

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
    borderBottom: '1px solid rgba(99,120,200,0.15)',
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
  const showBluetoothDash = tab === 'bluetooth'
  const showDashPanel = showOverviewDash || showUsbDash || showBluetoothDash

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.accent, fontFamily: 'var(--mono)', letterSpacing: 1, marginBottom: 4 }}>
            SENTINELONE XDR
          </div>
          {(tab === 'usb' || tab === 'bluetooth') && (
            <p style={{ margin: 0, fontSize: 12, color: C.text2, maxWidth: 820 }}>
              {tab === 'usb' ? (
                <>
                  USB device connection dashboard — <span style={{ fontFamily: 'var(--mono)', color: C.text }}>{dash?.index || 'sentinel-*'}</span>.
                  Peripheral / device-control events only. Charts and the log below use the same time range; filters match Custom log (event.action, message, hostname, USB device).
                </>
              ) : (
                <>
                  Bluetooth device connection dashboard — <span style={{ fontFamily: 'var(--mono)', color: C.text }}>{dash?.index || 'sentinel-*'}</span>.
                  Bluetooth radio / pairing / connect style events only. Charts and the log below use the same time range; filters match Custom log (event.action, message, hostname, Bluetooth device).
                </>
              )}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', letterSpacing: 0.5 }}>
            HOST GROUP
            <input
              type="text"
              value={hostGroupFilter}
              onChange={e => setHostGroupFilter(e.target.value)}
              placeholder="Host group (optional)"
              title="Filter dashboard metrics and the Custom log to this Sentinel host group when set"
              style={{
                minWidth: 160,
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg3)',
                color: C.text,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                outline: 'none',
              }}
            />
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
              background: tab === t.id ? C.accent : 'transparent',
              color: tab === t.id ? '#0a0c10' : C.text2,
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
              badge={(range?.label || range?.value || '24h').toUpperCase()}
              onClick={() => goDrill({})}
              titleHint="Open Custom log for this scope"
            >
              <div style={{ height: 240 }} onClick={e => e.stopPropagation()}>
                {dash?.timeline?.length ? (
                  <Line
                    data={lineDual}
                    options={{
                      ...co,
                      plugins: {
                        legend: { display: true, position: 'top', labels: { color: C.text2, font: { size: 10 }, boxWidth: 10 } },
                      },
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
            <Card title="Event types" badge="breakdown" onClick={() => goDrill({})} titleHint="Open Custom log">
              <div style={{ height: 220, position: 'relative' }} onClick={e => e.stopPropagation()}>
                <Doughnut
                  data={eventTypeDonut}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '58%',
                    plugins: {
                      legend: { display: true, position: 'bottom', labels: { color: C.text2, font: { size: 10 }, boxWidth: 10 } },
                    },
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
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topEndpoints}
                  color={C.blue}
                  onBarClick={row => goDrill({ endpoint: row.key })}
                />
                {!loading && !(dash?.topEndpoints?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                )}
              </div>
            </Card>
            <Card title="Top USB devices" badge="USB" noPad onClick={() => goDrill({})} titleHint="Click a bar to filter">
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topUsb}
                  color={C.orange}
                  onBarClick={row => goDrill({ usbDevice: row.key })}
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
              badge={(range?.label || range?.value || '24h').toUpperCase()}
              onClick={() => usbGoDrill({})}
              titleHint="Filter log below"
            >
              <div style={{ height: 240 }} onClick={e => e.stopPropagation()}>
                {dash?.timeline?.length ? (
                  <Line
                    data={usbLineData}
                    options={{
                      ...co,
                      plugins: {
                        legend: { display: true, position: 'top', labels: { color: C.text2, font: { size: 10 }, boxWidth: 10 } },
                      },
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
              titleHint="Click a slice to filter log by event.action"
            >
              <div style={{ height: 220, position: 'relative' }} onClick={e => e.stopPropagation()}>
                <Doughnut
                  data={usbActionDonut}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '58%',
                    plugins: {
                      legend: { display: true, position: 'bottom', labels: { color: C.text2, font: { size: 10 }, boxWidth: 10 } },
                    },
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
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topEndpoints}
                  color={C.blue}
                  onBarClick={row => usbGoDrill({ endpoint: row.key })}
                />
                {!loading && !(dash?.topEndpoints?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                )}
              </div>
            </Card>
            <Card title="Top USB devices" badge="USB" noPad onClick={() => usbGoDrill({})} titleHint="Click a bar">
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topUsb}
                  color={C.orange}
                  onBarClick={row => usbGoDrill({ usbDevice: row.key })}
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
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topUsbDisconnectHosts}
                  color={C.cyan}
                  onBarClick={row => usbGoDrill({ endpoint: row.key, eventAction: 'disconnected' })}
                />
                {!loading && !(dash?.topUsbDisconnectHosts?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No disconnect data</div>
                )}
              </div>
            </Card>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
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
              badge={(range?.label || range?.value || '24h').toUpperCase()}
              onClick={() => bluetoothGoDrill({})}
              titleHint="Filter log below"
            >
              <div style={{ height: 240 }} onClick={e => e.stopPropagation()}>
                {dash?.timeline?.length ? (
                  <Line
                    data={bluetoothLineData}
                    options={{
                      ...co,
                      plugins: {
                        legend: { display: true, position: 'top', labels: { color: C.text2, font: { size: 10 }, boxWidth: 10 } },
                      },
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
              titleHint="Click a slice to filter log by event.action"
            >
              <div style={{ height: 220, position: 'relative' }} onClick={e => e.stopPropagation()}>
                <Doughnut
                  data={bluetoothActionDonut}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '58%',
                    plugins: {
                      legend: { display: true, position: 'bottom', labels: { color: C.text2, font: { size: 10 }, boxWidth: 10 } },
                    },
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
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topEndpoints}
                  color={C.blue}
                  onBarClick={row => bluetoothGoDrill({ endpoint: row.key })}
                />
                {!loading && !(dash?.topEndpoints?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No data</div>
                )}
              </div>
            </Card>
            <Card title="Top Bluetooth devices" badge="BT" noPad onClick={() => bluetoothGoDrill({})} titleHint="Click a bar">
              <div style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
                <HBarChart
                  rows={dash?.topBluetooth}
                  color={C.indigo}
                  onBarClick={row => bluetoothGoDrill({ bluetoothDevice: row.key })}
                />
                {!loading && !(dash?.topBluetooth?.length > 0) && (
                  <div style={{ color: C.text3, fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center', padding: 24 }}>No Bluetooth aggregation</div>
                )}
              </div>
            </Card>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
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
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)', whiteSpace: 'nowrap' }}>
                        {row['@timestamp'] ? new Date(row['@timestamp']).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)', maxWidth: 260 }}>{row.threatName}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)' }}>{row.agent}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)', color: C.red }}>{row.state}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)' }}>{row.severity}</td>
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
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)', whiteSpace: 'nowrap' }}>
                        {row['@timestamp'] ? new Date(row['@timestamp']).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)', maxWidth: 260 }}>{row.threatName}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)' }}>{row.agent}</td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(99,120,200,0.06)', color: C.green }}>{row.state}</td>
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

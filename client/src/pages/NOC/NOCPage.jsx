import RangePicker from '../../components/ui/RangePicker.jsx'
import LogSearch from '../../components/ui/LogSearch.jsx'
import { useEffect, useState, useRef, useMemo } from 'react'
import { Line, Bar, Doughnut } from 'react-chartjs-2'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler } from 'chart.js'
import api from '../../api/client'
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../../components/ui/ResizableTable.jsx'
import { io } from 'socket.io-client'
import { resolvedWsUrl } from '../../utils/backendOrigin.js'
import { useThemeStore } from '../../store/themeStore.js'
import { DEFAULT_RANGE_PRESET, DEFAULT_RANGE_VALUE } from '../../constants/timeRange.js'
import { getThemeCssColors } from '../../utils/themeCssColors.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler)

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'var(--text)', text2:'var(--text2)', text3:'var(--text3)' }

const TABS = [
  { id:'overview',   label:'Overview' },
  { id:'interfaces', label:'Interfaces' },
  { id:'devices',    label:'Devices' },
  { id:'macflap',    label:'MAC Flapping' },
  { id:'sites',      label:'Site Comparison' },
  { id:'config',     label:'Switch config' },
  { id:'events',     label:'Event Feed' },
  { id:'search',     label:'Custom log search' },
]

const DEFAULT_NOC_FILTERS = { q:'', device:'', site:'', mnemonic:'all', logtype:'all', severity:'all', iface:'', vlan:'' }

function nocDrillToLogSearch(p) {
  return {
    q: p.q ?? '',
    device: p.device ?? '',
    site: p.site ?? '',
    mnemonic: p.mnemonic ?? 'all',
    logtype: p.logtype ?? 'all',
    severity: p.severity ?? 'all',
    iface: p.iface ?? '',
    vlan: p.vlan != null && p.vlan !== '' ? String(p.vlan) : '',
  }
}

function getNocSevCategory(e) {
  const raw = (e.cisco_severity_label || '').toLowerCase()
  if (!raw) return 'info'
  if (['critical', 'emergency', 'alert'].some(x => raw.includes(x))) return 'critical'
  if (raw.includes('error')) return 'high'
  if (['warning', 'warn'].some(x => raw.includes(x))) return 'medium'
  if (['notice', 'notification'].some(x => raw.includes(x))) return 'low'
  return 'info'
}

const NOC_LOGIN_FAIL_MNEMONICS = new Set([
  'LOGIN_FAILED',
  'AUTHENTICATION_FAILED',
  'DOT1X_AUTH_FAIL',
  'SSH2_AUTHFAIL',
  'USER_LOGIN_FAILURE',
  'AAA_LOGIN_FAILED',
  'LOGIN_AUTHENTICATION_FAILED',
])

function isNocLoginFailureEvent(e) {
  const msg = `${e.cisco_message || ''} ${e.message || ''}`.toLowerCase()
  if (msg.includes('dns lookup') || msg.includes('dns query')) return false
  const m = String(e.cisco_mnemonic || '').toUpperCase()
  if (NOC_LOGIN_FAIL_MNEMONICS.has(m)) return true
  if (msg.includes('login failed') || msg.includes('authentication failed') || msg.includes('authentication failure') || msg.includes('bad secrets'))
    return true
  return false
}

function eventMatchesNocFilters(e, f) {
  if (f.q) {
    const q = f.q.toLowerCase()
    const hay = [e.cisco_message, e.message, e.cisco_mnemonic, e.device_name, e.site_name, e.cisco_interface_full].filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(q)) return false
  }
  if (f.device && (e.device_name || '') !== f.device) return false
  if (f.site && (e.site_name || '') !== f.site) return false
  if (f.mnemonic && f.mnemonic !== 'all' && e.cisco_mnemonic !== f.mnemonic) return false
  if (f.logtype === 'login_fail' && !isNocLoginFailureEvent(e)) return false
  if (f.severity && f.severity !== 'all' && getNocSevCategory(e) !== f.severity) return false
  if (f.iface) {
    const iface = (e.cisco_interface_full || '').toLowerCase()
    if (!iface.includes(String(f.iface).toLowerCase())) return false
  }
  if (f.vlan && String(e.cisco_vlan_id ?? '') !== String(f.vlan)) return false
  return true
}

function KPI({ label, value, sub, color, onClick, title }) {
  const colors = { blue:C.accent, red:C.red, green:C.green, amber:C.amber, cyan:C.cyan, purple:C.accent2 }
  return (
    <div className={`kpi ${color}`} onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }} title={title || (onClick ? 'Open in Custom log search' : undefined)}>
      <div style={{ fontSize:10, fontWeight:600, color:C.text3, letterSpacing:1, textTransform:'uppercase', marginBottom:6, fontFamily:'var(--mono)' }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:700, lineHeight:1, marginBottom:4, color: colors[color]||C.accent }}>{value??'�'}</div>
      <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>{sub}</div>
    </div>
  )
}

function Card({ title, badge, badgeClass='blue', height, children, noPad }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{title}</span>
        {badge !== undefined && <span className={`badge badge-${badgeClass}`}>{badge}</span>}
      </div>
      <div style={noPad ? {} : { padding:'12px 14px', height }}>{children}</div>
    </div>
  )
}

function BarRows({ items, colorFn, onRowClick }) {
  const max = Math.max(...items.map(i=>i.count||0), 1)
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {items.map((item,i) => {
        const val = item.count||0
        const color = colorFn ? colorFn(i) : [C.red,C.amber,C.accent,C.cyan,C.green,C.accent2][i%6]
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:8, cursor: onRowClick ? 'pointer' : undefined }} onClick={onRowClick ? () => onRowClick(item, i) : undefined} title={onRowClick ? 'Open in Custom log search' : undefined}>
            <span style={{ fontSize:11, fontFamily:'var(--mono)', color:C.text2, width:130, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.label||item.key||'�'}</span>
            <div style={{ flex:1, height:6, background:'var(--bg4)', borderRadius:3, overflow:'hidden' }}>
              <div style={{ width:`${(val/max*100).toFixed(0)}%`, height:'100%', background:color, borderRadius:3 }} />
            </div>
            <span style={{ fontSize:10, fontFamily:'var(--mono)', color:C.text3, width:60, textAlign:'right', flexShrink:0 }}>{val?.toLocaleString()}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function NOCPage() {
  const [tab, setTab]         = useState('overview')
  const [range, setRange] = useState(() => ({ ...DEFAULT_RANGE_PRESET }))
  const [stats, setStats]     = useState(null)
  const [events, setEvents]   = useState([])
  const [ifaceData, setIfaceData] = useState({ timeline:[], top_interfaces:[], top_devices:[] })
  const [macData, setMacData]     = useState({ events:[], by_device:[], by_vlan:[], total:0 })
  const [liveEvents, setLiveEvents] = useState([])
  const [nocFilters, setNocFilters] = useState(DEFAULT_NOC_FILTERS)
  const [nocLogSearchSeed, setNocLogSearchSeed] = useState(null)
  const [configChanges, setConfigChanges] = useState(null)
  const [configErr, setConfigErr] = useState(null)
  const socketRef = useRef(null)
  const setNocF = key => val => setNocFilters(p => ({ ...p, [key]: val }))
  const goToNocSearch = partial => {
    const merged = { ...DEFAULT_NOC_FILTERS, ...partial }
    setNocFilters(merged)
    setNocLogSearchSeed({ id: Date.now(), filters: nocDrillToLogSearch(merged) })
    setTab('search')
  }

  useEffect(() => {
    const ws = resolvedWsUrl()
    socketRef.current =
      ws !== '' ? io(ws) : io()
    socketRef.current.on('live:events', evs => {
      const cisco = evs.filter(e => e._index?.includes('cisco') || e.cisco_mnemonic)
      if (cisco.length) setLiveEvents(p => [...cisco,...p].slice(0,100))
    })
    return () => socketRef.current?.disconnect()
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const rp = `range=${range?.value||''}&from=${range?.from||''}&to=${range?.to||''}`
        const [s, e, iface, mac] = await Promise.all([
          api.get(`/api/stats/noc?${rp}`),
          api.get(`/api/logs/search?type=cisco&size=500&page=0&${rp}`, { timeout: 120000 }),
          api.get(`/api/logs/interfaces?${rp}`),
          api.get(`/api/logs/macflap?${rp}`),
        ])
        setStats(s.data)
        setEvents(e.data?.hits || [])
        setIfaceData(iface.data)
        setMacData(mac.data)
      } catch(err) { console.error(err) }
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [range])

  useEffect(() => {
    if (tab !== 'config') return
    let cancelled = false
    async function loadCfg() {
      try {
        setConfigErr(null)
        const rp = `range=${range?.value || ''}&from=${range?.from || ''}&to=${range?.to || ''}`
        const { data } = await api.get(`/api/logs/config/changes?${rp}&size=250&scope=cisco`)
        if (!cancelled) setConfigChanges(data)
      } catch (err) {
        if (!cancelled) {
          setConfigErr(err.response?.data?.error || err.message || 'Failed to load')
          setConfigChanges({ cisco: { hits: [], total: 0, by_device: [] }, firewall: { hits: [], total: 0 } })
        }
      }
    }
    loadCfg()
    const iv = setInterval(loadCfg, 60000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [range, tab])

  const nocDeviceTbl = useResizableColumns('noc-device-activity', [160, 120, 100, 88, 88, 88, 88, 120])
  const nocMacTbl = useResizableColumns('noc-macflap-events', [88, 140, 88, 88, 88, 160, 120])
  const nocDeviceTh = {
    padding: '8px 10px',
    textAlign: 'left',
    borderBottom: '1px solid var(--border)',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    color: C.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  }
  const nocMacTh = { ...nocDeviceTh, padding: '7px 10px', fontSize: 10 }

  const theme = useThemeStore((s) => s.theme)
  const tc = useMemo(() => getThemeCssColors(), [theme])
  const co = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: tc.text3, font: { size: 9 }, maxTicksLimit: 8 },
          grid: { color: 'rgba(128,128,160,0.08)' },
        },
        y: {
          ticks: { color: tc.text3, font: { size: 9 } },
          grid: { color: 'rgba(128,128,160,0.08)' },
        },
      },
    }),
    [tc],
  )

  const rawMerged = useMemo(() => [...liveEvents, ...events].slice(0, 500), [liveEvents, events])
  const filteredEvents = useMemo(() => rawMerged.filter(e => eventMatchesNocFilters(e, nocFilters)), [rawMerged, nocFilters])

  const uniqueDevices = useMemo(() => {
    const s = new Set()
    for (const e of [...liveEvents, ...events]) { if (e.device_name) s.add(e.device_name) }
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [liveEvents, events])
  const uniqueSites = useMemo(() => {
    const s = new Set()
    for (const e of [...liveEvents, ...events]) { if (e.site_name) s.add(e.site_name) }
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [liveEvents, events])

  const filteredMacEvents = useMemo(
    () => (macData.events || []).filter(e => eventMatchesNocFilters(e, nocFilters)),
    [macData.events, nocFilters],
  )
  const macByDeviceFiltered = useMemo(() => {
    const acc = {}
    for (const e of filteredMacEvents) {
      const d = e.device_name || 'Unknown'
      acc[d] = (acc[d] || 0) + 1
    }
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([key, doc_count]) => ({ key, doc_count }))
  }, [filteredMacEvents])
  const macByVlanFiltered = useMemo(() => {
    const acc = {}
    for (const e of filteredMacEvents) {
      const v = e.cisco_vlan_id != null ? String(e.cisco_vlan_id) : '?'
      acc[v] = (acc[v] || 0) + 1
    }
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([key, doc_count]) => ({ key, doc_count }))
  }, [filteredMacEvents])

  const nocFiltersActive = Boolean(
    nocFilters.q ||
      nocFilters.device ||
      nocFilters.site ||
      nocFilters.mnemonic !== 'all' ||
      nocFilters.logtype !== 'all' ||
      nocFilters.severity !== 'all' ||
      nocFilters.iface ||
      nocFilters.vlan,
  )

  const updownEvents  = filteredEvents.filter(e => e.cisco_mnemonic === 'UPDOWN')
  const macflapEvents = filteredEvents.filter(e => e.cisco_mnemonic === 'MACFLAP_NOTIF')
  const vlanEvents    = filteredEvents.filter(e => e.cisco_mnemonic === 'NATIVE_VLAN_MISMATCH')
  const authEvents    = filteredEvents.filter(e => ['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION'].includes(e.cisco_mnemonic))
  const configEvents  = filteredEvents.filter(e => e.cisco_mnemonic === 'CONFIG_I')

  const deviceCounts = filteredEvents.reduce((acc,e) => { const d=e.device_name||'Unknown'; acc[d]=(acc[d]||0)+1; return acc },{})
  const siteCounts   = filteredEvents.reduce((acc,e) => { const s=e.site_name||'Unknown'; acc[s]=(acc[s]||0)+1; return acc },{})
  const mnemonicCounts = filteredEvents.reduce((acc,e) => { const m=e.cisco_mnemonic||'Unknown'; acc[m]=(acc[m]||0)+1; return acc },{})
  const topDevices   = Object.entries(deviceCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>({ label:k, count:v }))

  const interfaceTimeline = {
    labels: ifaceData.timeline.map(d => new Date(d.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})),
    datasets: [
      { label:'Up',   data:ifaceData.timeline.map(d=>d.up),   borderColor:C.green, backgroundColor:'rgba(34,211,160,0.08)', fill:true, tension:0.4, borderWidth:1.5, pointRadius:0 },
      { label:'Down', data:ifaceData.timeline.map(d=>d.down), borderColor:C.red,   backgroundColor:'rgba(245,83,79,0.08)',   fill:true, tension:0.4, borderWidth:1.5, pointRadius:0 },
    ]
  }

  const eventTypeData = {
    labels: Object.keys(mnemonicCounts).slice(0,6),
    datasets:[{ data:Object.values(mnemonicCounts).slice(0,6), backgroundColor:[C.accent,C.red,C.amber,C.green,C.cyan,C.accent2], borderWidth:0 }]
  }

  const siteData = {
    labels: Object.keys(siteCounts),
    datasets:[{ label:'Events', data:Object.values(siteCounts), backgroundColor:[C.accent,C.cyan,C.accent2,C.green,C.amber], borderRadius:4 }]
  }

  const doughnutMnemonicKeys = useMemo(() => Object.keys(mnemonicCounts).slice(0, 6), [mnemonicCounts])
  const siteBarLabels = useMemo(() => Object.keys(siteCounts), [siteCounts])

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:8 }}>
        <div style={{ display:'flex', gap:2, background:'var(--bg3)', borderRadius:10, padding:3, flexWrap:'wrap' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => { if (t.id === 'search') setNocLogSearchSeed(null); setTab(t.id) }} style={{
              padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:7,
              cursor:'pointer', border:'none', fontFamily:'var(--sans)', letterSpacing:0.3,
              background: tab===t.id ? 'var(--cyan)' : 'transparent',
              color: tab===t.id ? 'var(--on-cyan)' : C.text2,
              transition:'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>
        {tab !== 'search' && <RangePicker range={range} onChange={setRange} accentColor='#22d3ee' />}
      </div>

      {tab !== 'search' && (
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, alignItems:'center', marginBottom:12, padding:'10px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--border)' }}>
        <span style={{ fontSize:10, fontWeight:600, color:C.text3, fontFamily:'var(--mono)', letterSpacing:1 }}>FILTERS</span>
        <input
          value={nocFilters.q}
          onChange={e => setNocF('q')(e.target.value)}
          placeholder="Search message, device…"
          style={{ width:200, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }}
        />
        <select
          value={nocFilters.device}
          onChange={e => setNocF('device')(e.target.value)}
          style={{ minWidth:140, maxWidth:220, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer' }}
        >
          <option value="">All devices</option>
          {uniqueDevices.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select
          value={nocFilters.site}
          onChange={e => setNocF('site')(e.target.value)}
          style={{ minWidth:120, maxWidth:200, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer' }}
        >
          <option value="">All sites</option>
          {uniqueSites.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={nocFilters.mnemonic}
          onChange={e => setNocF('mnemonic')(e.target.value)}
          style={{ padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer', maxWidth:200 }}
        >
          <option value="all">Mnemonic: All</option>
          <option value="UPDOWN">UPDOWN</option>
          <option value="MACFLAP_NOTIF">MACFLAP</option>
          <option value="CONFIG_I">CONFIG</option>
          <option value="NATIVE_VLAN_MISMATCH">VLAN MISMATCH</option>
          <option value="LINK_UPDOWN">LINK_UPDOWN</option>
          <option value="LINEPROTO_UPDOWN">LINEPROTO_UPDOWN</option>
          <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
          <option value="LOGOUT">LOGOUT</option>
          <option value="SSH2_USERAUTH">SSH2_USERAUTH</option>
          <option value="SSH2_SESSION">SSH2_SESSION</option>
          <option value="STORM_CONTROL">STORM_CONTROL</option>
          <option value="SPANTREE">SPANTREE</option>
        </select>
        <select
          value={nocFilters.logtype}
          onChange={e => setNocF('logtype')(e.target.value)}
          style={{ padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer', minWidth:160 }}
        >
          <option value="all">Focus: All events</option>
          <option value="login_fail">Focus: Login failures</option>
        </select>
        <input
          value={nocFilters.iface}
          onChange={e => setNocF('iface')(e.target.value)}
          placeholder="Interface contains…"
          style={{ width:150, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }}
        />
        <input
          value={nocFilters.vlan}
          onChange={e => setNocF('vlan')(e.target.value)}
          placeholder="VLAN ID"
          style={{ width:80, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }}
        />
        <select
          value={nocFilters.severity}
          onChange={e => setNocF('severity')(e.target.value)}
          style={{ padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer' }}
        >
          <option value="all">Severity: All</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
        <button type="button" onClick={() => goToNocSearch(nocFilters)} style={{ padding:'5px 12px', borderRadius:7, border:'none', background:'var(--cyan)', color:'var(--on-cyan)', fontSize:10, fontFamily:'var(--mono)', cursor:'pointer', fontWeight:600 }}>Search in Custom log search</button>
        {nocFiltersActive && (
          <span style={{ fontSize:10, color:C.cyan, fontFamily:'var(--mono)' }}>{filteredEvents.length} / {rawMerged.length} events</span>
        )}
        <button
          type="button"
          onClick={() => setNocFilters(DEFAULT_NOC_FILTERS)}
          style={{ background:'none', border:'1px solid var(--border)', borderRadius:7, color:C.text3, fontSize:10, fontFamily:'var(--mono)', padding:'5px 10px', cursor:'pointer' }}
        >
          Clear
        </button>
      </div>
      )}

      {/* -- OVERVIEW -- */}
      {tab==='overview' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(118px, 1fr))', gap:10 }}>
            <KPI label="Total Events"     value={stats?.total?.toLocaleString()}         sub={`last ${range?.label||range?.value||DEFAULT_RANGE_VALUE}`}       color="blue"   onClick={() => goToNocSearch({})} />
            <KPI label="Interface Events" value={stats?.updown?.toLocaleString()}        sub="up/down changes"       color="cyan"   onClick={() => goToNocSearch({ mnemonic: 'UPDOWN' })} />
            <KPI label="MAC Flapping"     value={stats?.macflap?.toLocaleString()}       sub="flap events"           color="red"    onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="VLAN Mismatches"  value={stats?.vlanmismatch?.toLocaleString()}  sub="native vlan issues"    color="amber"  onClick={() => goToNocSearch({ mnemonic: 'NATIVE_VLAN_MISMATCH' })} />
            <KPI label="Login failures"   value={stats?.loginFailed?.toLocaleString()}   sub="user auth failed"    color="red"    onClick={() => goToNocSearch({ logtype: 'login_fail', mnemonic: 'all' })} title="Open login-failure-filtered logs in Custom log search" />
            <KPI label="Active Devices"   value={Object.keys(deviceCounts).length}       sub="reporting switches"    color="green"  onClick={() => goToNocSearch({})} />
            <KPI label="Sites"            value={stats?.sites?.length||0}                sub="active locations"      color="purple" onClick={() => goToNocSearch({})} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12 }}>
            <Card title="INTERFACE UP/DOWN TIMELINE" badge={(range && range.label ? range.label : range || DEFAULT_RANGE_VALUE).toUpperCase()} badgeClass="cyan" height={200}>
              {ifaceData.timeline.length > 0
                ? <Line data={interfaceTimeline} options={{ ...co, onClick: (_, els) => { if (els.length) goToNocSearch({ mnemonic: 'UPDOWN' }) }, plugins:{ legend:{ display:true, labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:80 }}>No interface events</div>
              }
            </Card>
            <Card title="EVENT TYPE BREAKDOWN" badge="CISCO" height={200}>
              {Object.keys(mnemonicCounts).length > 0
                ? <Doughnut data={eventTypeData} options={{ responsive:true, maintainAspectRatio:false, cutout:'55%', plugins:{ legend:{ display:true, position:'right', labels:{ color:tc.text2, font:{ size:9 }, boxWidth:8 } } }, onClick: (_, els) => { if (!els.length) return; const m = doughnutMnemonicKeys[els[0].index]; if (m) goToNocSearch({ mnemonic: m }) } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:80 }}>No data</div>
              }
            </Card>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            <Card title="MOST ACTIVE SWITCHES" badge={`${topDevices.length} devices`} badgeClass="blue" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={topDevices.slice(0,6)} colorFn={i=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.red][i%6]} onRowClick={item => item.label && goToNocSearch({ device: item.label })} />
              </div>
            </Card>
            <Card title="MAC FLAPPING — TOP DEVICES" badge={macByDeviceFiltered.length} badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                {macByDeviceFiltered.length > 0
                  ? <BarRows items={macByDeviceFiltered.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={()=>C.red} onRowClick={item => item.label && goToNocSearch({ device: item.label, mnemonic: 'MACFLAP_NOTIF' })} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No MAC flapping</div>
                }
              </div>
            </Card>
            <Card title="VLAN MISMATCHES — TOP DEVICES" badge={vlanEvents.length} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px' }}>
                {(() => {
                  const v = vlanEvents.reduce((acc,e)=>{ const d=e.device_name||'Unknown'; acc[d]=(acc[d]||0)+1; return acc },{})
                  const items = Object.entries(v).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>({ label:k, count:v }))
                  return items.length > 0
                    ? <BarRows items={items} colorFn={()=>C.amber} onRowClick={item => item.label && goToNocSearch({ device: item.label, mnemonic: 'NATIVE_VLAN_MISMATCH' })} />
                    : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No VLAN mismatches</div>
                })()}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* -- INTERFACES -- */}
      {tab==='interfaces' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Changes"     value={ifaceData.timeline.reduce((a,b)=>a+b.total,0)?.toLocaleString()} sub="up/down events"     color="blue"   onClick={() => goToNocSearch({ mnemonic: 'UPDOWN' })} />
            <KPI label="Port Up"           value={ifaceData.timeline.reduce((a,b)=>a+b.up,0)?.toLocaleString()}    sub="came online"        color="green"  onClick={() => goToNocSearch({ mnemonic: 'UPDOWN', q: 'up' })} />
            <KPI label="Port Down"         value={ifaceData.timeline.reduce((a,b)=>a+b.down,0)?.toLocaleString()}  sub="went offline"       color="red"    onClick={() => goToNocSearch({ mnemonic: 'UPDOWN', q: 'down' })} />
            <KPI label="Affected Ports"    value={ifaceData.top_interfaces.length}                                  sub="unique interfaces"  color="amber"  onClick={() => goToNocSearch({ mnemonic: 'UPDOWN' })} />
            <KPI label="Affected Switches" value={ifaceData.top_devices.length}                                     sub="devices"            color="cyan"   onClick={() => goToNocSearch({ mnemonic: 'UPDOWN' })} />
            <KPI label="Line Protocol"     value={updownEvents.filter(e=>e.cisco_facility==='%LINEPROTO').length}   sub="proto changes"      color="purple" onClick={() => goToNocSearch({ mnemonic: 'UPDOWN', q: 'LINEPROTO' })} />
          </div>
          <Card title="INTERFACE UP/DOWN TIMELINE" badge={(range && range.label ? range.label : range || DEFAULT_RANGE_VALUE).toUpperCase()} badgeClass="cyan" height={220}>
            {ifaceData.timeline.length > 0
              ? <Line data={interfaceTimeline} options={{ ...co, onClick: (_, els) => { if (els.length) goToNocSearch({ mnemonic: 'UPDOWN' }) }, plugins:{ legend:{ display:true, labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } } }} />
              : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:90 }}>No interface events</div>
            }
          </Card>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="TOP FLAPPING INTERFACES" badge="UPDOWN" badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                {ifaceData.top_interfaces.length > 0
                  ? <BarRows items={ifaceData.top_interfaces.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={i=>i<3?C.red:i<5?C.amber:C.accent} onRowClick={item => item.label && goToNocSearch({ mnemonic: 'UPDOWN', iface: item.label })} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No data</div>
                }
              </div>
            </Card>
            <Card title="INTERFACE EVENTS PER SWITCH" badge="DEVICES" noPad>
              <div style={{ padding:'12px 14px' }}>
                {ifaceData.top_devices.length > 0
                  ? <BarRows items={ifaceData.top_devices.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={i=>[C.cyan,C.accent,C.accent2,C.green,C.amber][i%5]} onRowClick={item => item.label && goToNocSearch({ device: item.label, mnemonic: 'UPDOWN' })} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No data</div>
                }
              </div>
            </Card>
          </div>
          <Card title="INTERFACE EVENT LOG" badge="LIVE" badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:300 }}>
              {updownEvents.length > 0 ? updownEvents.slice(0,50).map((e,i) => {
                const isUp = e.cisco_message?.includes('state to up')
                const stateColor = isUp ? C.green : C.red
                const state = isUp ? 'UP' : 'DOWN'
                return (
                  <div key={i} style={{ display:'flex', gap:10, padding:'7px 14px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:11, cursor:'pointer' }} onClick={() => goToNocSearch({ device: e.device_name || '', site: e.site_name || '', mnemonic: 'UPDOWN', iface: e.cisco_interface_full || '' })} title="Open in Custom log search">
                    <span style={{ color:C.text3, width:70, flexShrink:0 }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString() : ''}</span>
                    <span style={{ color:stateColor, width:40, flexShrink:0, fontWeight:600 }}>{state}</span>
                    <span style={{ color:C.cyan, width:160, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis' }}>{e.cisco_interface_full||'�'}</span>
                    <span style={{ color:C.text2, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.cisco_message||'�'}</span>
                    <span style={{ color:C.text3, flexShrink:0 }}>{e.device_name||''}</span>
                    <span style={{ color:C.text3, flexShrink:0, fontSize:10 }}>{e.site_name||''}</span>
                  </div>
                )
              }) : <div style={{ color:C.text3, fontSize:11, textAlign:'center', padding:40, fontFamily:'var(--mono)' }}>No interface events</div>}
            </div>
          </Card>
        </div>
      )}

      {/* -- DEVICES -- */}
      {tab==='devices' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Switches"  value={Object.keys(deviceCounts).length}  sub="reporting devices"  color="blue"   onClick={() => goToNocSearch({})} />
            <KPI label="Total Events"    value={stats?.total?.toLocaleString()}     sub={`last ${range?.label||range?.value||DEFAULT_RANGE_VALUE}`}    color="cyan"   onClick={() => goToNocSearch({})} />
            <KPI label="Config Changes"  value={configEvents.length}               sub="switch configs"     color="amber"  onClick={() => setTab('config')} title="Open Switch config tab" />
            <KPI label="Auth Events"     value={authEvents.length}                 sub="login/ssh"          color="green"  onClick={() => goToNocSearch({ q: 'SSH' })} />
            <KPI label="MAC Flaps"       value={filteredMacEvents.length}                  sub={nocFiltersActive ? 'after filters' : 'flap events'}        color="red"    onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="VLAN Issues"     value={vlanEvents.length}                 sub="mismatches"         color="purple" onClick={() => goToNocSearch({ mnemonic: 'NATIVE_VLAN_MISMATCH' })} />
          </div>
          <Card title="DEVICE ACTIVITY" badge={`${Object.keys(deviceCounts).length} switches`} badgeClass="blue" noPad>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11, fontFamily:'var(--mono)', tableLayout:'fixed', minWidth: nocDeviceTbl.sumWidth }}>
                <ResizableColGroup widths={nocDeviceTbl.widths} />
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Device','Site','Total Events','Interface','MAC Flaps','VLAN Issues','Auth','Config'].map((h, i) => (
                      <ResizableTh key={h} columnIndex={i} columnCount={8} startResize={nocDeviceTbl.startResize} style={nocDeviceTh}>{h}</ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(deviceCounts).sort((a,b)=>b[1]-a[1]).map(([device,total],i) => {
                    const site  = (filteredEvents.find(e=>e.device_name===device)||{}).site_name||'�'
                    const iface = updownEvents.filter(e=>e.device_name===device).length
                    const macf  = macByDeviceFiltered.find(b=>b.key===device)?.doc_count||0
                    const vlan  = vlanEvents.filter(e=>e.device_name===device).length
                    const auth  = authEvents.filter(e=>e.device_name===device).length
                    const conf  = configEvents.filter(e=>e.device_name===device).length
                    return (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                        onClick={() => goToNocSearch({ device })}
                        onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'}
                        onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                        <td style={{ padding:'7px 10px', color:C.cyan, fontWeight:600 }}>{device}</td>
                        <td style={{ padding:'7px 10px', color:C.text3 }}>{site}</td>
                        <td style={{ padding:'7px 10px', color:C.text }}>{total?.toLocaleString()}</td>
                        <td style={{ padding:'7px 10px', color:iface>0?C.amber:C.text3 }}>{iface}</td>
                        <td style={{ padding:'7px 10px', color:macf>0?C.red:C.text3, fontWeight:macf>5?600:400 }}>{macf}</td>
                        <td style={{ padding:'7px 10px', color:vlan>0?C.amber:C.text3 }}>{vlan}</td>
                        <td style={{ padding:'7px 10px', color:auth>0?C.green:C.text3 }}>{auth}</td>
                        <td style={{ padding:'7px 10px', color:conf>0?C.accent2:C.text3 }}>{conf}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="TOP EVENTS PER DEVICE" badge="BAR" badgeClass="blue" height={220}>
            <Bar data={{
              labels: topDevices.map(d=>d.label),
              datasets:[{ label:'Events', data:topDevices.map(d=>d.count), backgroundColor:topDevices.map((_,i)=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.red,C.accent,C.cyan,C.accent2,C.green][i%10]), borderRadius:4 }]
            }} options={{ ...co, indexAxis:'y', onClick: (_, els) => { if (!els.length) return; const d = topDevices[els[0].index]?.label; if (d) goToNocSearch({ device: d }) } }} />
          </Card>
        </div>
      )}

      {/* -- MAC FLAPPING -- */}
      {tab==='macflap' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Flaps"     value={filteredMacEvents.length}                          sub={nocFiltersActive ? 'after filters' : 'flap events'}       color="red"    onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="Affected MACs"   value={new Set(filteredMacEvents.map(e=>e.cisco_mac_address).filter(Boolean)).size} sub="unique MACs" color="amber" onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="Affected VLANs"  value={macByVlanFiltered.length}                    sub="VLANs affected"    color="blue"   onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="Switches"        value={macByDeviceFiltered.length}                  sub="reporting devices" color="cyan"   onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="Top VLAN"        value={macByVlanFiltered[0]?.key ? `VLAN ${macByVlanFiltered[0].key}` : '�'} sub="most affected" color="purple" onClick={() => macByVlanFiltered[0]?.key != null && goToNocSearch({ mnemonic: 'MACFLAP_NOTIF', q: String(macByVlanFiltered[0].key) })} />
            <KPI label="Top Switch"      value={macByDeviceFiltered[0]?.key?.slice(0,12)||'�'} sub="most flaps"     color="red"    onClick={() => macByDeviceFiltered[0]?.key && goToNocSearch({ device: macByDeviceFiltered[0].key, mnemonic: 'MACFLAP_NOTIF' })} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="MAC FLAPPING PER SWITCH" badge={macByDeviceFiltered.length} badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                {macByDeviceFiltered.length > 0
                  ? <BarRows items={macByDeviceFiltered.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={()=>C.red} onRowClick={item => item.label && goToNocSearch({ device: item.label, mnemonic: 'MACFLAP_NOTIF' })} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No MAC flapping detected</div>
                }
              </div>
            </Card>
            <Card title="MAC FLAPPING PER VLAN" badge={macByVlanFiltered.length} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px' }}>
                {macByVlanFiltered.length > 0
                  ? <BarRows items={macByVlanFiltered.map(b=>({ label:`VLAN ${b.key||'?'}`, count:b.doc_count }))} colorFn={()=>C.amber} onRowClick={item => { const m = String(item.label || '').match(/(\d+)/); goToNocSearch({ mnemonic: 'MACFLAP_NOTIF', ...(m ? { q: m[1] } : { q: item.label || '' }) }) }} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No data</div>
                }
              </div>
            </Card>
          </div>
          <Card title="MAC FLAPPING EVENTS — DETAILED" badge="LIVE" badgeClass="red" noPad>
            <div style={{ overflowY:'auto', maxHeight:350 }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, fontFamily:'var(--mono)', tableLayout:'fixed', minWidth: nocMacTbl.sumWidth }}>
                <ResizableColGroup widths={nocMacTbl.widths} />
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Time','MAC Address','VLAN','Port From','Port To','Switch','Site'].map((h, i) => (
                      <ResizableTh key={h} columnIndex={i} columnCount={7} startResize={nocMacTbl.startResize} style={nocMacTh}>{h}</ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMacEvents.map((e,i) => (
                    <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }} onClick={() => goToNocSearch({ device: e.device_name || '', site: e.site_name || '', mnemonic: 'MACFLAP_NOTIF', q: e.cisco_mac_address || String(e.cisco_vlan_id || '') })} title="Open in Custom log search">
                      <td style={{ padding:'5px 10px', color:C.text3, whiteSpace:'nowrap' }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString() : '�'}</td>
                      <td style={{ padding:'5px 10px', color:C.cyan }}>{e.cisco_mac_address||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.amber }}>{e.cisco_vlan_id ? `VLAN ${e.cisco_vlan_id}` : '�'}</td>
                      <td style={{ padding:'5px 10px', color:C.text2 }}>{e.cisco_port_from||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.text2 }}>{e.cisco_port_to||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.accent }}>{e.device_name||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.text3 }}>{e.site_name||'�'}</td>
                    </tr>
                  ))}
                  {filteredMacEvents.length===0 && <tr><td colSpan={7} style={{ padding:30, textAlign:'center', color:C.text3 }}>No MAC flapping events</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* -- SITE COMPARISON -- */}
      {tab==='sites' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10 }}>
            {(stats?.sites||[]).slice(0,5).map((site,i) => (
              <KPI key={i} label={site.key} value={site.doc_count?.toLocaleString()} sub="total events" color={['blue','cyan','green','amber','red'][i%5]} onClick={() => site.key && goToNocSearch({ site: site.key })} />
            ))}
          </div>
          <Card title="LOG VOLUME PER SITE" badge="COMPARISON" badgeClass="cyan" height={220}>
            {Object.keys(siteCounts).length > 0
              ? <Bar data={siteData} options={{ ...co, onClick: (_, els) => { if (!els.length) return; const s = siteBarLabels[els[0].index]; if (s) goToNocSearch({ site: s }) } }} />
              : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:90 }}>No site data</div>
            }
          </Card>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {Object.keys(siteCounts).slice(0,4).map((site,si) => (
              <Card key={site} title={`${site} — EVENT BREAKDOWN`} badge={siteCounts[site]?.toLocaleString()} badgeClass={['blue','cyan','green','amber'][si%4]} noPad>
                <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
                  {[
                    { label:'Interface Events', count:updownEvents.filter(e=>e.site_name===site).length, color:C.cyan },
                    { label:'MAC Flapping',     count:filteredMacEvents.filter(e=>e.site_name===site).length, color:C.red },
                    { label:'VLAN Mismatches',  count:vlanEvents.filter(e=>e.site_name===site).length, color:C.amber },
                    { label:'Auth Events',      count:authEvents.filter(e=>e.site_name===site).length, color:C.green },
                    { label:'Config Changes',   count:configEvents.filter(e=>e.site_name===site).length, color:C.accent2 },
                  ].map((item,i) => (
                    <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid var(--border)', cursor:'pointer' }} onClick={() => {
                      const base = { site }
                      if (item.label.startsWith('Interface')) goToNocSearch({ ...base, mnemonic: 'UPDOWN' })
                      else if (item.label.startsWith('MAC')) goToNocSearch({ ...base, mnemonic: 'MACFLAP_NOTIF' })
                      else if (item.label.startsWith('VLAN')) goToNocSearch({ ...base, mnemonic: 'NATIVE_VLAN_MISMATCH' })
                      else if (item.label.startsWith('Auth')) goToNocSearch({ ...base, q: 'SSH' })
                      else if (item.label.startsWith('Config')) setTab('config')
                    }} title="Open in Custom log search">
                      <span style={{ fontSize:11, color:C.text2, fontFamily:'var(--mono)' }}>{item.label}</span>
                      <span style={{ fontSize:13, fontWeight:600, color:item.color, fontFamily:'var(--mono)' }}>{item.count?.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* -- SWITCH CONFIG (Cisco IOS/XE/etc.) -- */}
      {tab === 'config' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)', maxWidth:720 }}>
            Switch and router configuration changes: CONFIG_I, “Configured from…”, and related syslog for the selected time range.
          </div>
          {configErr && (
            <div style={{ padding:'10px 14px', borderRadius:8, background:'rgba(245,83,79,0.12)', border:'1px solid rgba(245,83,79,0.35)', color:C.red, fontSize:11, fontFamily:'var(--mono)' }}>{configErr}</div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
            <KPI label="Switch config events" value={configChanges?.cisco?.total?.toLocaleString() ?? '—'} sub="in range (ES)" color="amber" onClick={() => goToNocSearch({ mnemonic: 'CONFIG_I' })} />
            <KPI label="In this view" value={configChanges?.cisco?.hits?.length ?? '—'} sub="rows loaded" color="blue" onClick={() => goToNocSearch({ mnemonic: 'CONFIG_I' })} />
            <KPI label="Switches" value={configChanges?.cisco?.by_device?.length ?? '—'} sub="with changes" color="cyan" onClick={() => goToNocSearch({ mnemonic: 'CONFIG_I' })} />
            <KPI label="Custom search" value="→" sub="refine filters" color="purple" onClick={() => goToNocSearch({ mnemonic: 'CONFIG_I' })} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:12 }}>
            <Card title="TOP SWITCHES" badge={configChanges?.cisco?.by_device?.length ?? 0} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px' }}>
                {(configChanges?.cisco?.by_device || []).length > 0 ? (
                  <BarRows
                    items={(configChanges.cisco.by_device || []).map(b => ({ label: b.key || 'Unknown', count: b.count }))}
                    colorFn={() => C.amber}
                    onRowClick={item => item.label && goToNocSearch({ device: item.label, mnemonic: 'CONFIG_I' })}
                  />
                ) : (
                  <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'28px 0' }}>{configChanges ? 'No switch config changes in range' : 'Loading…'}</div>
                )}
              </div>
            </Card>
            <Card title="SWITCH CONFIGURATION LOG" badge="CISCO" badgeClass="amber" noPad>
              <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:480 }}>
                <div style={{ display:'grid', gridTemplateColumns:'minmax(72px,0.7fr) minmax(72px,0.55fr) minmax(88px,0.65fr) minmax(140px,1.4fr) minmax(100px,0.9fr) minmax(56px,0.5fr)', gap:6, padding:'6px 12px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:9, fontWeight:600, color:C.text3, textTransform:'uppercase', letterSpacing:0.4 }}>
                  <span>Time</span><span>Mnemonic</span><span>Changed by</span><span>What changed</span><span>Switch</span><span>Site</span>
                </div>
                {(configChanges?.cisco?.hits || []).length > 0 ? configChanges.cisco.hits.map((e, i) => (
                  <div
                    key={e._id || i}
                    style={{ display:'grid', gridTemplateColumns:'minmax(72px,0.7fr) minmax(72px,0.55fr) minmax(88px,0.65fr) minmax(140px,1.4fr) minmax(100px,0.9fr) minmax(56px,0.5fr)', gap:6, alignItems:'center', padding:'8px 12px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:10, cursor:'pointer' }}
                    onClick={() => goToNocSearch({
                      device: e.device_name || '',
                      site: e.site_name || '',
                      mnemonic: e.cisco_mnemonic && e.cisco_mnemonic !== 'Unknown' ? e.cisco_mnemonic : 'CONFIG_I',
                      q: String(e.change_what || e.cisco_message || '').slice(0, 120),
                    })}
                    title={String(e.change_what || e.cisco_message || '')}
                    onMouseEnter={el => { el.currentTarget.style.background = 'var(--bg3)' }}
                    onMouseLeave={el => { el.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ color:C.text3, whiteSpace:'nowrap' }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}</span>
                    <span style={{ color:C.accent2, overflow:'hidden', textOverflow:'ellipsis' }}>{e.cisco_mnemonic || '—'}</span>
                    <span style={{ color:C.green, overflow:'hidden', textOverflow:'ellipsis', fontWeight:600 }} title={e.change_by}>{e.change_by || '—'}</span>
                    <span style={{ color:C.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={e.change_what}>{e.change_what || e.cisco_message || '—'}</span>
                    <span style={{ color:C.cyan, overflow:'hidden', textOverflow:'ellipsis' }} title={e.device_name}>{e.device_name || ''}</span>
                    <span style={{ color:C.text3, overflow:'hidden', textOverflow:'ellipsis', fontSize:9 }} title={e.site_name}>{e.site_name || ''}</span>
                  </div>
                )) : (
                  <div style={{ color:C.text3, fontSize:11, textAlign:'center', padding:48, fontFamily:'var(--mono)' }}>{configChanges ? 'No switch configuration changes found for this range.' : 'Loading…'}</div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* -- EVENT FEED -- */}
      {tab==='events' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Events"  value={filteredEvents.length}       sub={nocFiltersActive ? 'after filters' : 'loaded'}          color="blue"   onClick={() => goToNocSearch({})} />
            <KPI label="Interface"     value={updownEvents.length}    sub="up/down"         color="cyan"   onClick={() => goToNocSearch({ mnemonic: 'UPDOWN' })} />
            <KPI label="MAC Flapping"  value={macflapEvents.length}       sub="flap alerts"     color="red"    onClick={() => goToNocSearch({ mnemonic: 'MACFLAP_NOTIF' })} />
            <KPI label="VLAN Issues"   value={vlanEvents.length}      sub="mismatches"      color="amber"  onClick={() => goToNocSearch({ mnemonic: 'NATIVE_VLAN_MISMATCH' })} />
            <KPI label="Auth"          value={authEvents.length}      sub="login/ssh"       color="green"  onClick={() => goToNocSearch({ q: 'SSH' })} />
            <KPI label="Config"        value={configEvents.length}    sub="config changes"  color="purple" onClick={() => setTab('config')} title="Open Switch config tab" />
          </div>
          <Card title="LIVE CISCO EVENT FEED" badge="LIVE" badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:580 }}>
              {filteredEvents.length > 0 ? filteredEvents.map((e,i) => {
                const sev = e.cisco_severity_label||'info'
                const sevColor = ['critical','error','emergency'].includes(sev) ? C.red : ['warning','high'].includes(sev) ? C.amber : C.text3
                const mnemonicColor = e.cisco_mnemonic==='MACFLAP_NOTIF'?C.red : e.cisco_mnemonic==='UPDOWN'?C.cyan : e.cisco_mnemonic==='NATIVE_VLAN_MISMATCH'?C.amber : e.cisco_mnemonic==='CONFIG_I'?C.accent2 : e.cisco_mnemonic?.startsWith('SSH')?C.green : C.text2
                return (
                  <div key={i} style={{ display:'flex', gap:10, padding:'8px 14px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:11, cursor:'pointer' }}
                    onClick={() => goToNocSearch({
                      device: e.device_name || '',
                      site: e.site_name || '',
                      mnemonic: e.cisco_mnemonic && e.cisco_mnemonic !== 'Unknown' ? e.cisco_mnemonic : 'all',
                      q: (e.cisco_message || e.message || '').slice(0, 80),
                    })}
                    title="Refine filters to this event"
                    onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'}
                    onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                    <span style={{ color:C.text3, width:70, flexShrink:0 }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString() : ''}</span>
                    <span style={{ color:sevColor, width:52, flexShrink:0, fontWeight:600, textTransform:'uppercase', fontSize:10 }}>{sev?.slice(0,4)}</span>
                    <span style={{ color:mnemonicColor, width:130, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis' }}>{e.cisco_mnemonic||'�'}</span>
                    <span style={{ color:C.text2, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.cisco_message||e.message||'�'}</span>
                    <span style={{ color:C.accent, flexShrink:0, width:100, textAlign:'right', overflow:'hidden', textOverflow:'ellipsis' }}>{e.device_name||''}</span>
                    <span style={{ color:C.text3, flexShrink:0, width:80, textAlign:'right', fontSize:10 }}>{e.site_name||''}</span>
                  </div>
                )
              }) : <div style={{ color:C.text3, fontSize:11, textAlign:'center', padding:60, fontFamily:'var(--mono)' }}>No events loaded</div>}
            </div>
          </Card>
        </div>
      )}

      {tab === 'search' && (
        <LogSearch
          key={nocLogSearchSeed?.id ?? 'noc-search'}
          type="cisco"
          accentColor="#22d3ee"
          dashboardRange={range}
          initialFilters={nocLogSearchSeed?.filters}
        />
      )}

    </div>
  )
}



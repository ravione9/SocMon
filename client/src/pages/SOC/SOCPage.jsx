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
import { getThemeCssColors } from '../../utils/themeCssColors.js'
import { DEFAULT_RANGE_PRESET, DEFAULT_RANGE_VALUE } from '../../constants/timeRange.js'
import { getSevCategory } from '../../utils/logSeverity.js'
import { firewallIdentityFromEvent, fortigateVpnUserLabel, logSearchDeviceLabel } from '../../utils/firewallIdentity.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler)

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'var(--text)', text2:'var(--text2)', text3:'var(--text3)' }

const TABS = [
  { id:'overview',  label:'Overview' },
  { id:'traffic',   label:'Traffic' },
  { id:'threats',   label:'Threats & UTM' },
  { id:'vpn',       label:'VPN & Auth' },
  { id:'geo',       label:'Geo Intel' },
  { id:'config',    label:'Firewall config' },
  { id:'events',    label:'Event Log' },
  { id:'search',    label:'Custom log search' },
]

function KPI({ label, value, sub, delta, color, onClick, title }) {
  const colors = { blue:C.accent, red:C.red, green:C.green, amber:C.amber, cyan:C.cyan, purple:C.accent2 }
  return (
    <div className={`kpi ${color}`} style={{ minWidth:0, cursor: onClick ? 'pointer' : undefined }} onClick={onClick} title={title || (onClick ? 'Open in Custom log search' : undefined)}>
      <div style={{ fontSize:10, fontWeight:600, color:C.text3, letterSpacing:1, textTransform:'uppercase', marginBottom:6, fontFamily:'var(--mono)' }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:700, lineHeight:1, marginBottom:4, color: colors[color] || C.accent }}>{value ?? '�'}</div>
      <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>{sub}</div>
      {delta && <div style={{ fontSize:10, fontFamily:'var(--mono)', color: delta.startsWith('+') ? C.red : C.green }}>{delta}</div>}
    </div>
  )
}

function Card({ title, badge, badgeClass='blue', height, children, noPad }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{title}</span>
        {badge && <span className={`badge badge-${badgeClass}`}>{badge}</span>}
      </div>
      <div style={ noPad ? {} : { padding:'12px 14px', height }}>
        {children}
      </div>
    </div>
  )
}

function BarRows({ items, colorFn, onRowClick }) {
  const max = Math.max(...items.map(i => i.count || i.value || 0), 1)
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {items.map((item, i) => {
        const val = item.count || item.value || 0
        const pct = (val/max*100).toFixed(0)
        const color = colorFn ? colorFn(i) : [C.red,C.red,C.amber,C.amber,C.accent,C.accent][i] || C.text3
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:8, cursor: onRowClick ? 'pointer' : undefined }} onClick={onRowClick ? () => onRowClick(item, i) : undefined} title={onRowClick ? 'Open in Custom log search' : undefined}>
            <span style={{ fontSize:11, fontFamily:'var(--mono)', color:C.text2, width:120, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.label || item.name || item.ip || item.country || item.key}</span>
            <div style={{ flex:1, height:6, background:'var(--bg4)', borderRadius:3, overflow:'hidden' }}>
              <div style={{ width:`${pct}%`, height:'100%', background:color, borderRadius:3 }} />
            </div>
            <span style={{ fontSize:10, fontFamily:'var(--mono)', color:C.text3, width:50, textAlign:'right', flexShrink:0 }}>{val?.toLocaleString()}</span>
          </div>
        )
      })}
    </div>
  )
}

function sevClass(s) {
  const m = { critical:'red', high:'amber', medium:'blue', low:'green', info:'cyan', notice:'cyan', warning:'amber', error:'red', emergency:'red', alert:'red' }
  return m[(s||'').toLowerCase()] || 'blue'
}

function sevCategoryBadgeClass(cat) {
  const m = { critical: 'red', high: 'amber', medium: 'blue', low: 'green', info: 'cyan' }
  return m[cat] || 'blue'
}

const DEFAULT_SOC_FILTERS = { sev:'all', action:'all', logtype:'all', srcip:'', dstip:'', q:'', country:'', dstcountry:'' }

/** Keep in sync with server/src/utils/fortigateVpnQuery.js */
const FORTIGATE_VPN_SUBTYPES = new Set([
  'ssl-login',
  'sslvpn-login',
  'vpn-login',
  'sslvpn',
  'ssl-connection',
  'ssl-web',
  'radius-auth',
  'sslvpn-auth',
  'ftgd-auth',
])

const SSL_VPN_LOGIN_SUBTYPES = new Set(['ssl-login', 'sslvpn-login', 'vpn-login'])

function fortigateType(e) {
  return String(fgt(e, 'type') || e['fortinet.firewall.type'] || e.fortinet?.firewall?.type || '').toLowerCase()
}

function fortigateSubtype(e) {
  return String(fgt(e, 'subtype') || e['fortinet.firewall.subtype'] || e.fortinet?.firewall?.subtype || '').toLowerCase()
}

function eventActionLower(e) {
  const a = e['event.action'] ?? e.event?.action
  return typeof a === 'string' ? a.toLowerCase() : ''
}

/** Prefer VPN-tagged docs in the sample so the VPN tab is not empty when traffic dominates the latest N docs. */
function mergeFirewallEventSamples(vpnHits, generalHits, maxTotal = 500, vpnCap = 250) {
  const byId = new Map()
  let vpnAdded = 0
  for (const h of vpnHits || []) {
    if (vpnAdded >= vpnCap) break
    if (h?._id != null) {
      byId.set(h._id, h)
      vpnAdded += 1
    }
  }
  for (const h of generalHits || []) {
    if (byId.size >= maxTotal) break
    if (h?._id != null && !byId.has(h._id)) byId.set(h._id, h)
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b['@timestamp'] || 0) - new Date(a['@timestamp'] || 0),
  )
}

function socDrillToLogSearch(p) {
  return {
    q: p.q ?? '',
    srcip: p.srcip ?? '',
    dstip: p.dstip ?? '',
    srccountry: p.srccountry ?? p.country ?? '',
    dstcountry: p.dstcountry ?? '',
    action: p.action ?? 'all',
    severity: p.severity ?? p.sev ?? 'all',
    logtype: p.logtype ?? 'all',
  }
}

function fgt(e, k) {
  return e.fgt?.[k] ?? e[`fgt.${k}`]
}

function isFirewallEvent(e) {
  return Boolean(
    e._index?.includes('firewall') || e.fgt || e['fgt.type'] || e.fortinet?.firewall || e['fortinet.firewall.type'],
  )
}

/** FortiGate SSL-VPN user auth failures (aligned with login-failure signals, VPN-focused). */
const SSL_VPN_FAIL_SUBTYPES = new Set([
  'ssl-login-fail',
  'sslvpn-login-fail',
  'auth-fail',
  'login-fail',
  'radius-auth-fail',
  'ftgd-auth-fail',
])

function isFortigateSslVpnAuthFailureEvent(e) {
  if (!isFirewallEvent(e)) return false
  const sub = fortigateSubtype(e)
  const act = String(fgt(e, 'action') || '').toLowerCase()
  if (SSL_VPN_FAIL_SUBTYPES.has(sub)) return true
  if (act === 'login-fail') return true
  if (!SSL_VPN_LOGIN_SUBTYPES.has(sub)) return false
  const msg = `${fgt(e, 'msg') || ''} ${e.message || ''}`.toLowerCase()
  if (msg.includes('login failed') || msg.includes('user login failed') || msg.includes('authentication failure')) return true
  const oc = String(e['event.outcome'] ?? e.event?.outcome ?? '').toLowerCase()
  return oc === 'failure'
}

/** Successful SSL VPN user logins — omit from "recent critical alerts" strip (not actionable vs failures). */
function isFortigateSslVpnRoutineSuccessEvent(e) {
  if (!isFirewallEvent(e)) return false
  const sub = fortigateSubtype(e)
  if (!SSL_VPN_LOGIN_SUBTYPES.has(sub)) return false
  return !isFortigateSslVpnAuthFailureEvent(e)
}

function isFortiVpnEvent(e) {
  if (!isFirewallEvent(e)) return false
  const typ = fortigateType(e)
  const sub = fortigateSubtype(e)
  const act = eventActionLower(e)
  if (typ === 'vpn') return true
  if (FORTIGATE_VPN_SUBTYPES.has(sub)) return true
  if (FORTIGATE_VPN_SUBTYPES.has(act)) return true
  if (sub.startsWith('ssl-') || sub.startsWith('vpn')) return true
  const raw = `${e.message || ''} ${fgt(e, 'msg') || ''}`.toLowerCase()
  if (raw.includes('type=vpn') || raw.includes('type="vpn"') || raw.includes('ssl-vpn') || raw.includes('ssl vpn')) return true
  return false
}

/** SOC Event Log + widgets: FortiGate only (no Cisco / switch syslog). */
function eventMatchesSocFilters(e, f) {
  if (!isFirewallEvent(e)) return false
  if (f.sev && f.sev !== 'all' && getSevCategory(e) !== f.sev) return false
  if (f.srcip && String(fgt(e, 'srcip') || '') !== f.srcip) return false
  if (f.dstip && String(fgt(e, 'dstip') || '') !== f.dstip) return false
  const action = String(fgt(e, 'action') || '').toLowerCase()
  if (f.action && f.action !== 'all' && action !== f.action) return false
  const typ = fortigateType(e)
  const sub = fortigateSubtype(e)
  const act = eventActionLower(e)
  if (f.logtype && f.logtype !== 'all' && f.logtype !== 'cisco') {
    if (f.logtype === 'ips' && sub !== 'ips') return false
    if (f.logtype === 'traffic' && typ !== 'traffic') return false
    if (f.logtype === 'utm' && typ !== 'utm') return false
    if (f.logtype === 'vpn') {
      if (!isFortiVpnEvent(e)) return false
    }
    if (f.logtype === 'login_fail') {
      const msg = `${fgt(e, 'msg') || ''} ${e.message || ''}`.toLowerCase()
      const app = String(fgt(e, 'app') || '').toLowerCase()
      // Exclude SSL inspection / WAD — not user authentication (e.g. "SSL decryption failure", status=failure on traffic)
      if (
        msg.includes('ssl decryption') ||
        msg.includes('decryption failure') ||
        msg.includes('certificate verification failed') ||
        msg.includes('certificate verify failed') ||
        (app === 'wad' && (msg.includes('decrypt') || msg.includes('ssl') || msg.includes('certificate')))
      )
        return false
      // DNS filter / resolution — not authentication (e.g. "DNS lookup of host.local from client")
      if (
        msg.includes('dns lookup') ||
        msg.includes('dns query') ||
        typ === 'dns' ||
        sub === 'dns-query'
      )
        return false
      const failSubs = new Set([
        'ssl-login-fail',
        'sslvpn-login-fail',
        'auth-fail',
        'login-fail',
        'radius-auth-fail',
        'ftgd-auth-fail',
      ])
      const outcomeFail = String(e['event.outcome'] || '').toLowerCase() === 'failure'
      const cat = e['event.category']
      const catAuth = Array.isArray(cat) ? cat.includes('authentication') : String(cat || '').includes('authentication')
      const actFail = String(fgt(e, 'action') || '').toLowerCase() === 'login-fail'
      if (
        !failSubs.has(sub) &&
        !actFail &&
        !(outcomeFail && catAuth) &&
        !msg.includes('login failed') &&
        !msg.includes('user login failed') &&
        !msg.includes('authentication failure')
      )
        return false
    }
  }
  if (f.country) {
    const c = String(fgt(e, 'srccountry') || '').toLowerCase()
    if (c !== String(f.country).toLowerCase()) return false
  }
  if (f.dstcountry) {
    const c = String(fgt(e, 'dstcountry') || '').toLowerCase()
    if (c !== String(f.dstcountry).toLowerCase()) return false
  }
  if (f.q) {
    const q = f.q.toLowerCase()
    const hay = [
      fgt(e, 'srcip'),
      fgt(e, 'dstip'),
      fgt(e, 'app'),
      fgt(e, 'attack'),
      String(fgt(e, 'msg') || ''),
      String(fgt(e, 'srccountry') || ''),
      String(e.message || ''),
      logSearchDeviceLabel(e),
    ]
      .join(' ')
      .toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

function socRangeMeta(range) {
  if (range?.type === 'custom' && range.from && range.to) {
    const ms = new Date(range.to) - new Date(range.from)
    const isShort = ms <= 6 * 3600000
    const long = ms > 7 * 86400000
    return { isShort, long, tickLimit: long ? 8 : isShort ? 14 : 10 }
  }
  const rv = range?.value || DEFAULT_RANGE_VALUE
  const isShort = rv === '15m' || rv === '1h'
  const long = rv === '3d' || rv === '7d' || rv === '30d'
  const tickLimit = rv === '15m' ? 15 : rv === '1h' ? 12 : rv === '6h' ? 12 : 8
  return { isShort, long, tickLimit }
}

export default function SOCPage() {
  const [tab, setTab]           = useState('overview')
  const [range, setRange] = useState(() => ({ ...DEFAULT_RANGE_PRESET }))
  const [stats, setStats]       = useState(null)
  const [timeline, setTimeline] = useState([])
  const [threats, setThreats]   = useState([])
  const [denied, setDenied]     = useState({ by_src:[], by_country:[] })
  const [events, setEvents]     = useState([])
  const [sessions, setSessions] = useState([])
  const [liveEvents, setLiveEvents] = useState([])
  const [socFilters, setSocFilters] = useState(DEFAULT_SOC_FILTERS)
  const [socLogSearchSeed, setSocLogSearchSeed] = useState(null)
  const [configChanges, setConfigChanges] = useState(null)
  const [configErr, setConfigErr] = useState(null)
  const socketRef = useRef(null)
  const setSocF = key => val => setSocFilters(p => ({ ...p, [key]: val }))

  const goToSocSearch = partial => {
    const merged = { ...DEFAULT_SOC_FILTERS, ...partial }
    setSocFilters(merged)
    setSocLogSearchSeed({ id: Date.now(), filters: socDrillToLogSearch(merged) })
    setTab('search')
  }

  useEffect(() => {
    const ws = resolvedWsUrl()
    socketRef.current =
      ws !== '' ? io(ws) : io()
    socketRef.current.on('live:events', evs =>
      setLiveEvents(p => [...(Array.isArray(evs) ? evs.filter(isFirewallEvent) : []), ...p].slice(0, 100)),
    )
    return () => socketRef.current?.disconnect()
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const rp = `range=${range?.value || ''}&from=${range?.from || ''}&to=${range?.to || ''}`
        const [s, t, th, d, e, evpn, se] = await Promise.all([
          api.get(`/api/stats/soc?${rp}`),
          api.get(`/api/logs/traffic/timeline?${rp}`),
          api.get(`/api/logs/threats/top?${rp}`),
          api.get(`/api/logs/denied?${rp}`),
          api.get(`/api/logs/search?type=firewall&size=500&page=0&${rp}`),
          api.get(`/api/logs/search?type=firewall&logtype=vpn&size=250&page=0&${rp}`),
          api.get(`/api/logs/sessions?${rp}`),
        ])
        setStats(s.data); setTimeline(t.data); setThreats(th.data)
        setDenied(d.data)
        setEvents(mergeFirewallEventSamples(evpn.data?.hits || [], e.data?.hits || []))
        setSessions(se.data)
      } catch(err){ console.error(err) }
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
        const { data } = await api.get(`/api/logs/config/changes?${rp}&size=250&scope=firewall`)
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

  const socSessionTbl = useResizableColumns('soc-session-log', [72, 110, 52, 110, 52, 56, 72, 100, 56, 56, 80, 88])
  const socDeniedSrcTbl = useResizableColumns('soc-blocked-src', [52, 140, 100, 220])
  const socSessTh = {
    padding: '7px 8px',
    textAlign: 'left',
    borderBottom: '1px solid var(--border)',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    color: C.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 10,
  }
  const socDeniedTh = { ...socSessTh, padding: '7px 10px' }

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

  const { socConfigRows, socConfigSlaOmitted, socConfigKindCounts } = useMemo(() => {
    const hits = configChanges?.firewall?.hits
    if (!hits?.length) {
      return { socConfigRows: [], socConfigSlaOmitted: 0, socConfigKindCounts: { policy: 0, vpn: 0, system: 0, other: 0 } }
    }
    let slaOmitted = 0
    const rows = []
    const counts = { policy: 0, vpn: 0, system: 0, other: 0 }
    for (const e of hits) {
      const kind = e.change_kind || 'other'
      if (kind === 'sla_auto') {
        slaOmitted += 1
        continue
      }
      rows.push(e)
      if (counts[kind] != null) counts[kind] += 1
      else counts.other += 1
    }
    return { socConfigRows: rows, socConfigSlaOmitted: slaOmitted, socConfigKindCounts: counts }
  }, [configChanges])

  const socConfigFwByHost = useMemo(() => {
    if (!socConfigRows.length) return []
    const acc = {}
    for (const e of socConfigRows) {
      const { name, ip } = firewallIdentityFromEvent(e)
      const key = (name && name !== '—' ? name : '') || (ip && String(ip).trim()) || 'FortiGate'
      acc[key] = (acc[key] || 0) + 1
    }
    return Object.entries(acc)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }))
  }, [socConfigRows])

  const allEvents = useMemo(
    () => [...liveEvents, ...events].filter(isFirewallEvent).slice(0, 500),
    [liveEvents, events],
  )
  /** High/critical strip: hide successful SSL VPN logins; merge repeated SSL VPN login failures (same src + subtype + msg). */
  const socCriticalAlertEntries = useMemo(() => {
    const sorted = [...allEvents]
      .filter(e => ['critical', 'high'].includes(getSevCategory(e)) && !isFortigateSslVpnRoutineSuccessEvent(e))
      .sort((a, b) => new Date(b['@timestamp'] || 0) - new Date(a['@timestamp'] || 0))
    const seenFail = new Map()
    const out = []
    for (const e of sorted) {
      if (isFortigateSslVpnAuthFailureEvent(e)) {
        const sip = String(fgt(e, 'srcip') || '')
        const sub = fortigateSubtype(e)
        const msg = String(fgt(e, 'msg') || e.message || '').slice(0, 80).trim()
        const key = `${sip}|${sub}|${msg}`
        const prev = seenFail.get(key)
        if (prev) {
          prev.count += 1
          continue
        }
        const entry = { e, count: 1 }
        seenFail.set(key, entry)
        out.push(entry)
      } else {
        out.push({ e, count: 1 })
      }
    }
    return out.slice(0, 5)
  }, [allEvents])
  const filteredEvents = useMemo(() => allEvents.filter(e => eventMatchesSocFilters(e, socFilters)), [allEvents, socFilters])
  const socViewFiltersActive = useMemo(() => {
    const f = socFilters
    return f.sev !== 'all' || f.action !== 'all' || f.logtype !== 'all' || Boolean(f.srcip) || Boolean(f.dstip) || Boolean(f.q) || Boolean(f.country) || Boolean(f.dstcountry)
  }, [socFilters])

  const { isShort, long, tickLimit } = socRangeMeta(range)
  const timeFmt = isShort
    ? { hour:'2-digit', minute:'2-digit' }
    : long
      ? { month:'short', day:'numeric', hour:'2-digit' }
      : { hour:'2-digit', minute:'2-digit' }

  const timelineData = {
    labels: timeline.map(d => new Date(d.time).toLocaleTimeString([], timeFmt)),
    datasets: [
      { label:'Allowed', data:timeline.map(d=>d.allowed), borderColor:C.green, backgroundColor:'rgba(34,211,160,0.08)', fill:true, tension:0.4, borderWidth:1.5, pointRadius: isShort ? 2 : 0 },
      { label:'Denied',  data:timeline.map(d=>d.denied),  borderColor:C.red,   backgroundColor:'rgba(245,83,79,0.08)',   fill:true, tension:0.4, borderWidth:1.5, pointRadius: isShort ? 2 : 0 },
    ],
  }

  const sevData = {
    labels:['Critical','High','Medium','Low'],
    datasets:[{ data:[
      allEvents.filter(e=>getSevCategory(e)==='critical').length,
      allEvents.filter(e=>getSevCategory(e)==='high').length,
      allEvents.filter(e=>getSevCategory(e)==='medium').length,
      allEvents.filter(e=>getSevCategory(e)==='low').length,
    ], backgroundColor:[C.red,C.amber,C.accent,C.green], borderWidth:0, hoverOffset:4 }]
  }

  const threatsData = {
    labels: threats.map(t=>t.name||'Unknown'),
    datasets:[{ data:threats.map(t=>t.count), backgroundColor:[C.red,C.red,C.amber,C.amber,C.accent,C.accent,C.cyan,C.green], borderRadius:4 }]
  }

  const countryData = {
    labels: denied.by_country.map(c=>c.country),
    datasets:[{ data:denied.by_country.map(c=>c.count), backgroundColor:[C.red,C.amber,C.accent,C.accent2,C.cyan,C.green,C.red,C.amber,C.accent,C.cyan], borderWidth:0 }]
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:8 }}>
        <div style={{ display:'flex', gap:2, background:'var(--bg3)', borderRadius:10, padding:3, flexWrap:'wrap' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => { if (t.id === 'search') setSocLogSearchSeed(null); setTab(t.id) }} style={{
              padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:7,
              cursor:'pointer', border:'none', fontFamily:'var(--sans)', letterSpacing:0.3,
              background: tab===t.id ? 'var(--accent)' : 'transparent',
              color: tab===t.id ? 'var(--on-accent)' : C.text2,
              transition:'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>
        {tab !== 'search' && <RangePicker range={range} onChange={setRange} />}
      </div>

      {tab !== 'search' && (
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, alignItems:'center', marginBottom:12, padding:'10px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--border)' }}>
        <span style={{ fontSize:10, fontWeight:600, color:C.text3, fontFamily:'var(--mono)', letterSpacing:1 }}>FILTERS</span>
        <input value={socFilters.q} onChange={e => setSocF('q')(e.target.value)} placeholder="Search text…" style={{ width:160, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }} />
        <input value={socFilters.srcip} onChange={e => setSocF('srcip')(e.target.value)} placeholder="Src IP" style={{ width:120, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }} />
        <input value={socFilters.dstip} onChange={e => setSocF('dstip')(e.target.value)} placeholder="Dst IP" style={{ width:120, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }} />
        <input value={socFilters.country} onChange={e => setSocF('country')(e.target.value)} placeholder="Src country" style={{ width:100, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }} />
        <input value={socFilters.dstcountry} onChange={e => setSocF('dstcountry')(e.target.value)} placeholder="Dst country" style={{ width:100, padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }} />
        <select value={socFilters.action} onChange={e => setSocF('action')(e.target.value)} style={{ padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer' }}>
          <option value="all">Action: All</option>
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
        </select>
        <select value={socFilters.logtype} onChange={e => setSocF('logtype')(e.target.value)} style={{ padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer', minWidth:130 }}>
          <option value="all">Type: All</option>
          <option value="traffic">Traffic</option>
          <option value="ips">IPS</option>
          <option value="utm">UTM</option>
          <option value="vpn">VPN</option>
          <option value="login_fail">Login failures</option>
        </select>
        <select value={socFilters.sev} onChange={e => setSocF('sev')(e.target.value)} style={{ padding:'5px 10px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer' }}>
          <option value="all">Severity: All</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
        <button type="button" onClick={() => goToSocSearch(socFilters)} style={{ padding:'5px 12px', borderRadius:7, border:'none', background:'var(--accent)', color:'var(--on-accent)', fontSize:10, fontFamily:'var(--mono)', cursor:'pointer', fontWeight:600 }}>Search in Custom log search</button>
        {socViewFiltersActive && (
          <span style={{ fontSize:10, color:C.cyan, fontFamily:'var(--mono)' }}>{filteredEvents.length} / {allEvents.length} in Event Log</span>
        )}
        <button type="button" onClick={() => setSocFilters(DEFAULT_SOC_FILTERS)} style={{ background:'none', border:'1px solid var(--border)', borderRadius:7, color:C.text3, fontSize:10, fontFamily:'var(--mono)', padding:'5px 10px', cursor:'pointer' }}>Clear</button>
      </div>
      )}

      {/* -- OVERVIEW -- */}
      {tab==='overview' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(118px, 1fr))', gap:10 }}>
            <KPI label="Total Events"     value={stats?.total?.toLocaleString()}   sub={`last ${range?.label||range?.value||DEFAULT_RANGE_VALUE}`}           color="blue"   delta={null} onClick={() => goToSocSearch({})} />
            <KPI label="Blocked Sessions" value={stats?.denied?.toLocaleString()}  sub="firewall denied"           color="red"    delta={null} onClick={() => goToSocSearch({ action: 'deny' })} />
            <KPI label="IPS Alerts"       value={stats?.ips?.toLocaleString()}     sub="intrusion attempts"        color="amber"  delta={null} onClick={() => goToSocSearch({ logtype: 'ips' })} />
            <KPI label="Allowed Sessions" value={stats ? (stats.total-stats.denied)?.toLocaleString() : '—'} sub="policy permitted" color="green" delta={null} onClick={() => goToSocSearch({ action: 'allow' })} />
            <KPI label="UTM Events"       value={stats?.utm?.toLocaleString()}     sub="web/av/dlp/app"            color="cyan"   delta={null} onClick={() => goToSocSearch({ logtype: 'utm' })} />
            <KPI label="VPN Events"       value={stats?.vpn?.toLocaleString()}     sub="VPN / SSL-VPN (ES)"        color="purple" delta={null} onClick={() => goToSocSearch({ logtype: 'vpn' })} title="FortiGate VPN and SSL-VPN related logs" />
            <KPI label="Login failures"   value={stats?.loginFailed?.toLocaleString()} sub="user auth failed"     color="red"    delta={null} onClick={() => goToSocSearch({ logtype: 'login_fail' })} title="Open login-failure-filtered logs in Custom log search" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12 }}>
            <Card title="SESSION VOLUME TREND" badge={(range?.label||range?.value||DEFAULT_RANGE_VALUE).toUpperCase()} height={200}>
              <Line data={timelineData} options={{ ...co, onClick: (_, els) => { if (els.length) goToSocSearch({ logtype: 'traffic' }) }, plugins:{ legend:{ display:true, labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
            </Card>
            <Card title="SEVERITY BREAKDOWN" badge="ALERTS" badgeClass="red" height={200}>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, height:200 }}>
                <div style={{ height:140, width:140, position:'relative' }}>
                  <Doughnut data={sevData} options={{ responsive:true, maintainAspectRatio:false, cutout:'70%', plugins:{ legend:{ display:false } }, onClick: (_, els) => { if (!els.length) return; const order = ['critical','high','medium','low']; const i = els[0].index; if (order[i]) goToSocSearch({ sev: order[i] }) } }} />
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, justifyContent:'center' }}>
                  {[['Critical',C.red],['High',C.amber],['Medium',C.accent],['Low',C.green]].map(([l,c])=>(
                    <div key={l} style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, color:C.text2, fontFamily:'var(--mono)' }}>
                      <div style={{ width:8, height:8, borderRadius:2, background:c }} />{l}
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            <Card title="TOP BLOCKED IPs" badge="THREATS" badgeClass="red" noPad>
              <div style={{ padding:'10px 14px' }}>
                <BarRows items={denied.by_src.slice(0,6)} onRowClick={item => item.ip && goToSocSearch({ srcip: item.ip, action: 'deny' })} />
              </div>
            </Card>
            <Card title="TOP APPLICATIONS" badge="APP CTRL" noPad>
              <div style={{ padding:'10px 14px' }}>
                {/* Top apps from sessions */}
                <BarRows items={
                  Object.entries(
                    sessions.reduce((acc,s) => {
                      const app = s.fgt?.app || s['fgt.app'] || 'Unknown'
                      acc[app] = (acc[app]||0)+1
                      return acc
                    },{})
                  ).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>({ label:k, count:v }))
                } colorFn={i=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.amber][i]} onRowClick={item => item.label && goToSocSearch({ logtype: 'traffic', q: item.label })} />
              </div>
            </Card>
            <Card title="RECENT CRITICAL ALERTS" badge="LIVE" badgeClass="red" noPad>
              <div style={{ display:'flex', flexDirection:'column', gap:6, padding:'10px 14px' }}>
                {socCriticalAlertEntries.map(({ e, count }, i) => {
                  const cat = getSevCategory(e)
                  const sip = fgt(e, 'srcip')
                  const dip = fgt(e, 'dstip')
                  const msg =
                    e.fgt?.msg ||
                    e['fgt.msg'] ||
                    e.message ||
                    (sip && dip ? `${sip} → ${dip}` : sip || dip || '')
                  return (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 8px', borderRadius:7, border:'1px solid transparent', cursor:'pointer' }}
                      onClick={() => {
                        const atk = fgt(e, 'attack')
                        goToSocSearch({
                          ...(sip ? { srcip: sip } : {}),
                          ...(dip ? { dstip: dip } : {}),
                          ...(atk ? { q: atk, logtype: 'ips' } : isFortigateSslVpnAuthFailureEvent(e) ? { logtype: 'login_fail' } : {}),
                        })
                      }}
                      onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'}
                      onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                      <div style={{ width:6, height:36, borderRadius:3, flexShrink:0, background: cat==='critical' ? C.red : cat==='high' ? C.amber : C.accent }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{String(msg).slice(0,50)}</div>
                        <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)', marginTop:2 }}>{logSearchDeviceLabel(e)} · {fgt(e, 'subtype') || fgt(e, 'type') || 'event'}{count > 1 ? ` · ×${count} similar` : ''}</div>
                      </div>
                      <div style={{ textAlign:'right', flexShrink:0 }}>
                        <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</div>
                      </div>
                    </div>
                  )
                })}
                {socCriticalAlertEntries.length === 0 && (
                  <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'20px 0' }}>No critical alerts</div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* -- TRAFFIC -- */}
      {tab==='traffic' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Sessions" value={stats?.total?.toLocaleString()} sub={`last ${range?.label||range?.value||DEFAULT_RANGE_VALUE}`} color="blue" onClick={() => goToSocSearch({ logtype: 'traffic' })} />
            <KPI label="Denied"         value={stats?.denied?.toLocaleString()} sub="blocked" color="red" onClick={() => goToSocSearch({ action: 'deny' })} />
            <KPI label="Allowed"        value={stats ? (stats.total-stats.denied)?.toLocaleString():null} sub="permitted" color="green" onClick={() => goToSocSearch({ action: 'allow' })} />
            <KPI label="Bytes Out"      value={sessions.length ? (sessions.reduce((a,s)=>(a+(s.fgt?.sentbyte||s['fgt.sentbyte']||0)),0)/1024/1024/1024).toFixed(2)+'GB' : '�'} sub="outbound" color="cyan" onClick={() => goToSocSearch({ logtype: 'traffic' })} />
            <KPI label="Bytes In"       value={sessions.length ? (sessions.reduce((a,s)=>(a+(s.fgt?.rcvdbyte||s['fgt.rcvdbyte']||0)),0)/1024/1024/1024).toFixed(2)+'GB' : '�'} sub="inbound" color="purple" onClick={() => goToSocSearch({ logtype: 'traffic' })} />
            <KPI label="Unique Apps"    value={new Set(sessions.map(s=>s.fgt?.app||s['fgt.app'])).size||'�'} sub="applications" color="amber" onClick={() => goToSocSearch({ logtype: 'traffic' })} />
          </div>

          <Card title="TRAFFIC TIMELINE" badge={(range?.label||range?.value||DEFAULT_RANGE_VALUE).toUpperCase()} height={220}>
            <Line data={timelineData} options={{ ...co, onClick: (_, els) => { if (els.length) goToSocSearch({ logtype: 'traffic' }) }, plugins:{ legend:{ display:true, labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
          </Card>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="PROTOCOL BREAKDOWN" badge="PROTOCOLS" height={200}>
              <Doughnut data={{
                labels:['TCP','UDP','ICMP','Other'],
                datasets:[{ data:[
                  sessions.filter(s=>(s.fgt?.proto||s['fgt.proto'])===6).length,
                  sessions.filter(s=>(s.fgt?.proto||s['fgt.proto'])===17).length,
                  sessions.filter(s=>(s.fgt?.proto||s['fgt.proto'])===1).length,
                  sessions.filter(s=>![1,6,17].includes(s.fgt?.proto||s['fgt.proto'])).length,
                ], backgroundColor:[C.accent,C.cyan,C.accent2,C.text3], borderWidth:0 }]
              }} options={{ responsive:true, maintainAspectRatio:false, cutout:'60%', plugins:{ legend:{ display:true, position:'right', labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } }, onClick: (_, els) => { if (!els.length) return; const labels = ['TCP','UDP','ICMP','Other']; const q = labels[els[0].index]; if (q) goToSocSearch({ logtype: 'traffic', q }) } }} />
            </Card>
            <Card title="TOP APPLICATIONS" badge="APP CTRL" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={
                  Object.entries(sessions.reduce((acc,s)=>{ const a=s.fgt?.app||s['fgt.app']||'Unknown'; acc[a]=(acc[a]||0)+1; return acc },{}))
                  .sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>({ label:k, count:v }))
                } colorFn={i=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.red,C.accent,C.cyan][i]} onRowClick={item => item.label && goToSocSearch({ logtype: 'traffic', q: item.label })} />
              </div>
            </Card>
          </div>

          <Card title="SESSION LOG" badge="TRAFFIC" noPad>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, fontFamily:'var(--mono)', tableLayout:'fixed', minWidth: socSessionTbl.sumWidth }}>
                <ResizableColGroup widths={socSessionTbl.widths} />
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Time','Src IP','Sport','Dst IP','Dport','Proto','Action','App','Sent','Rcvd','Country','Site'].map((h, i) => (
                      <ResizableTh key={h} columnIndex={i} columnCount={12} startResize={socSessionTbl.startResize} style={socSessTh}>{h}</ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sessions.slice(0,50).map((s,i) => {
                    const f = key => s.fgt?.[key] ?? s[`fgt.${key}`]
                    const action = (f('action')||'').toLowerCase()
                    const ac = action==='allow' ? C.green : action==='deny' ? C.red : C.amber
                    const proto = f('proto')
                    return (
                      <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                        onClick={() => goToSocSearch({
                          ...(f('srcip') ? { srcip: f('srcip') } : {}),
                          ...(f('dstip') ? { dstip: f('dstip') } : {}),
                          ...(action ? { action } : {}),
                          logtype: 'traffic',
                        })}
                        onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'}
                        onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                        <td style={{ padding:'5px 8px', color:C.text3, whiteSpace:'nowrap' }}>{s['@timestamp'] ? new Date(s['@timestamp']).toLocaleTimeString() : '�'}</td>
                        <td style={{ padding:'5px 8px', color:C.cyan }}>{f('srcip')||'�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text3 }}>{f('srcport')||'�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text2 }}>{f('dstip')||'�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text3 }}>{f('dstport')||'�'}</td>
                        <td style={{ padding:'5px 8px' }}><span style={{ background:'rgba(79,126,245,0.15)', color:C.accent, padding:'1px 5px', borderRadius:4, fontSize:9 }}>{proto===6?'TCP':proto===17?'UDP':proto===1?'ICMP':proto||'�'}</span></td>
                        <td style={{ padding:'5px 8px', color:ac, fontWeight:600 }}>{f('action')||'�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text2 }}>{f('app')||'�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text3 }}>{f('sentbyte') ? (f('sentbyte')/1024).toFixed(1)+'KB' : '�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text3 }}>{f('rcvdbyte') ? (f('rcvdbyte')/1024).toFixed(1)+'KB' : '�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text3 }}>{f('srccountry')||'�'}</td>
                        <td style={{ padding:'5px 8px', color:C.text3 }}>{s.site_name||'�'}</td>
                      </tr>
                    )
                  })}
                  {sessions.length===0 && <tr><td colSpan={12} style={{ padding:30, textAlign:'center', color:C.text3 }}>No session data</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* -- THREATS & UTM -- */}
      {tab==='threats' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="IPS Alerts"    value={stats?.ips?.toLocaleString()}  sub="intrusion attempts" color="red"    onClick={() => goToSocSearch({ logtype: 'ips' })} />
            <KPI label="UTM Events"    value={stats?.utm?.toLocaleString()}  sub="total UTM"          color="amber"  onClick={() => goToSocSearch({ logtype: 'utm' })} />
            <KPI label="Attack Types"  value={threats.length}                sub="unique attacks"     color="blue"   onClick={() => goToSocSearch({ logtype: 'ips' })} />
            <KPI label="Top Attack"    value={threats[0]?.name?.slice(0,12)||'�'} sub="most frequent" color="red"    onClick={() => threats[0]?.name && goToSocSearch({ logtype: 'ips', q: threats[0].name })} />
            <KPI label="Blocked IPs"   value={denied.by_src.length}         sub="unique sources"     color="purple" onClick={() => goToSocSearch({ action: 'deny' })} />
            <KPI label="Countries"     value={denied.by_country.length}      sub="threat origins"     color="cyan"   onClick={() => goToSocSearch({ action: 'deny' })} />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="TOP IPS ATTACKS" badge={`${threats.length} types`} badgeClass="amber" height={220}>
              {threats.length > 0
                ? <Bar data={threatsData} options={{ ...co, indexAxis:'y', plugins:{ legend:{ display:false } }, onClick: (_, els) => { if (!els.length) return; const i = els[0].index; const n = threats[i]?.name; if (n) goToSocSearch({ logtype: 'ips', q: String(n) }) } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:80 }}>No IPS events</div>
              }
            </Card>
            <Card title="THREAT SEVERITY TIMELINE" badge="24H" badgeClass="amber" height={220}>
              <Line data={timelineData} options={{ ...co, onClick: (_, els) => { if (els.length) goToSocSearch({ logtype: 'ips' }) }, plugins:{ legend:{ display:true, labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
            </Card>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12 }}>
            <Card title="TOP BLOCKED SOURCE IPs" badge="THREATS" badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={denied.by_src.slice(0,8)} onRowClick={item => item.ip && goToSocSearch({ srcip: item.ip, action: 'deny' })} />
              </div>
            </Card>
            <Card title="TOP THREAT COUNTRIES" badge="GEO" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={denied.by_country.slice(0,6).map(c=>({ label:c.country, count:c.count }))} colorFn={i=>[C.red,C.amber,C.accent,C.accent2,C.cyan,C.green][i]} onRowClick={item => item.label && goToSocSearch({ country: item.label, action: 'deny' })} />
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* -- VPN & AUTH (FortiGate only; switch/Cisco auth is on NOC) -- */}
      {tab==='vpn' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
            <KPI label="VPN Events" value={stats?.vpn?.toLocaleString()} sub="in time range (ES)" color="green" onClick={() => goToSocSearch({ logtype: 'vpn' })} />
            <KPI
              label="VPN in sample"
              value={events.filter(isFortiVpnEvent).length}
              sub="loaded batch (500)"
              color="blue"
              onClick={() => goToSocSearch({ logtype: 'vpn' })}
            />
            <KPI
              label="SSL VPN login"
              value={
                events.filter(
                  e =>
                    isFirewallEvent(e) &&
                    (SSL_VPN_LOGIN_SUBTYPES.has(fortigateSubtype(e)) ||
                      SSL_VPN_LOGIN_SUBTYPES.has(eventActionLower(e))),
                ).length
              }
              sub="ssl-login / sslvpn-login / vpn-login"
              color="cyan"
              onClick={() => goToSocSearch({ logtype: 'vpn', q: 'ssl' })}
            />
            <KPI
              label="Tunnel (type=vpn)"
              value={events.filter(e => isFirewallEvent(e) && fortigateType(e) === 'vpn').length}
              sub="in loaded batch"
              color="purple"
              onClick={() => goToSocSearch({ logtype: 'vpn' })}
            />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="SESSION TIMELINE" badge={(range?.label || range?.value || DEFAULT_RANGE_VALUE).toUpperCase()} height={220}>
              <Line data={timelineData} options={{ ...co, onClick: (_, els) => { if (els.length) goToSocSearch({ logtype: 'traffic' }) }, plugins:{ legend:{ display:true, labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
            </Card>
            <Card title="VPN MIX (SAMPLE)" badge="FORTIGATE" height={220}>
              <Doughnut
                data={{
                  labels: ['Type VPN', 'SSL login', 'Other VPN-related'],
                  datasets: [{
                    data: [
                      events.filter(e => isFirewallEvent(e) && fortigateType(e) === 'vpn').length,
                      events.filter(
                        e =>
                          isFirewallEvent(e) &&
                          (SSL_VPN_LOGIN_SUBTYPES.has(fortigateSubtype(e)) ||
                            SSL_VPN_LOGIN_SUBTYPES.has(eventActionLower(e))),
                      ).length,
                      events.filter(e => {
                        if (!isFortiVpnEvent(e)) return false
                        const t = fortigateType(e)
                        const s = fortigateSubtype(e)
                        const a = eventActionLower(e)
                        if (t === 'vpn') return false
                        if (SSL_VPN_LOGIN_SUBTYPES.has(s) || SSL_VPN_LOGIN_SUBTYPES.has(a)) return false
                        return true
                      }).length,
                    ],
                    backgroundColor: [C.green, C.cyan, C.amber],
                    borderWidth: 0,
                  }],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  cutout: '55%',
                  plugins: {
                    legend: { display: true, position: 'right', labels: { color: tc.text2, font: { size: 10 }, boxWidth: 10 } },
                  },
                  onClick: (_, els) => {
                    if (!els.length) return
                    const idx = els[0].index
                    if (idx === 0) goToSocSearch({ logtype: 'vpn' })
                    else if (idx === 1) goToSocSearch({ logtype: 'vpn', q: 'ssl-login' })
                    else goToSocSearch({ logtype: 'vpn' })
                  },
                }}
              />
            </Card>
          </div>

          <Card title="RECENT VPN / SSL EVENTS" badge="SAMPLE" badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:280 }}>
              <div
                style={{
                  display:'flex',
                  gap:10,
                  padding:'6px 14px',
                  borderBottom:'1px solid var(--border)',
                  fontFamily:'var(--mono)',
                  fontSize:9,
                  fontWeight:600,
                  color:C.text3,
                  textTransform:'uppercase',
                  letterSpacing:0.6,
                }}
              >
                <span style={{ width:70, flexShrink:0 }}>Time</span>
                <span style={{ width:76, flexShrink:0 }}>Type</span>
                <span style={{ width:120, flexShrink:0 }}>User</span>
                <span style={{ flex:1, minWidth:0 }}>Message</span>
                <span style={{ width:120, flexShrink:0, textAlign:'right' }}>Firewall</span>
              </div>
              {events.filter(isFortiVpnEvent).slice(0, 30).map((e, i) => {
                const u = fortigateVpnUserLabel(e)
                return (
                <div
                  key={i}
                  style={{ display:'flex', gap:10, padding:'8px 14px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:11, cursor:'pointer', alignItems:'center' }}
                  onClick={() =>
                    goToSocSearch({
                      logtype: 'vpn',
                      ...(u ? { q: u } : { q: String(fgt(e, 'msg') || e.message || '').slice(0, 80) }),
                    })
                  }
                >
                  <span style={{ color:C.text3, width:70, flexShrink:0 }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString() : ''}</span>
                  <span className={`badge badge-${sevClass(e.syslog_severity_label)}`} style={{ flexShrink:0, maxWidth:76, overflow:'hidden', textOverflow:'ellipsis' }}>
                    {(fgt(e, 'subtype') || fgt(e, 'type') || 'vpn').toUpperCase()}
                  </span>
                  <span style={{ color: u ? C.cyan : C.text3, width:120, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={u || undefined}>
                    {u || '—'}
                  </span>
                  <span style={{ color:C.text2, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {fgt(e, 'msg') || e.message || '—'}
                  </span>
                  <span style={{ color:C.text3, width:120, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis', textAlign:'right' }}>{logSearchDeviceLabel(e)}</span>
                </div>
                )
              })}
              {events.filter(isFortiVpnEvent).length === 0 && (
                <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:40 }}>No FortiGate VPN events in the loaded sample</div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* -- GEO INTEL -- */}
      {tab==='geo' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Threat Countries" value={denied.by_country.length}                      sub="unique origins"      color="red"    onClick={() => goToSocSearch({ action: 'deny' })} />
            <KPI label="Top Threat Origin" value={denied.by_country[0]?.country?.slice(0,10)||'�'} sub="highest volume"   color="amber"  onClick={() => denied.by_country[0]?.country && goToSocSearch({ country: denied.by_country[0].country, action: 'deny' })} />
            <KPI label="Internal Denied"  value={denied.reserved_count?.toLocaleString()||'0'} sub="RFC1918 / private IPs" color="blue" onClick={() => goToSocSearch({ country: 'Reserved', action: 'deny' })} />
            <KPI label="Top Blocked"       value={denied.by_src[0]?.ip||'�'}                    sub="most blocked IP"     color="red"    onClick={() => denied.by_src[0]?.ip && goToSocSearch({ srcip: denied.by_src[0].ip, action: 'deny' })} />
            <KPI label="Total Denied"      value={stats?.denied?.toLocaleString()}               sub="blocked sessions"    color="purple" onClick={() => goToSocSearch({ action: 'deny' })} />
            <KPI label="Unique Sources"    value={denied.by_src.length}                          sub="source IPs"          color="cyan"   onClick={() => goToSocSearch({ action: 'deny' })} />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="TOP THREAT COUNTRIES" badge="GEO INTEL" badgeClass="red" height={300}>
              {denied.by_country.length > 0
                ? <Doughnut data={countryData} options={{ responsive:true, maintainAspectRatio:false, cutout:'50%', plugins:{ legend:{ display:true, position:'right', labels:{ color:tc.text2, font:{ size:10 }, boxWidth:10 } } }, onClick: (_, els) => { if (!els.length) return; const c = denied.by_country[els[0].index]?.country; if (c) goToSocSearch({ country: c, action: 'deny' }) } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:120 }}>No geo data</div>
              }
            </Card>
            <Card title="COUNTRY BREAKDOWN" badge={`${denied.by_country.length} countries`} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:6 }}>
                {denied.by_country.slice(0,10).map((c,i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }} onClick={() => c.country && goToSocSearch({ country: c.country, action: 'deny' })} title="Open in Custom log search">
                    <span style={{ fontSize:11, color:C.text2, fontFamily:'var(--mono)', width:120, flexShrink:0 }}>{c.country}</span>
                    <div style={{ flex:1, height:6, background:'var(--bg4)', borderRadius:3, overflow:'hidden' }}>
                      <div style={{ width:`${(c.count/denied.by_country[0]?.count*100).toFixed(0)}%`, height:'100%', background:[C.red,C.amber,C.accent,C.accent2,C.cyan][i%5], borderRadius:3 }} />
                    </div>
                    <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)', width:60, textAlign:'right' }}>{c.count?.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title="TOP BLOCKED SOURCE IPs � DETAILED" badge="FIREWALL DENY" badgeClass="red" noPad>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, fontFamily:'var(--mono)', tableLayout:'fixed', minWidth: socDeniedSrcTbl.sumWidth }}>
                <ResizableColGroup widths={socDeniedSrcTbl.widths} />
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Rank','Source IP','Block Count','Bar'].map((h, i) => (
                      <ResizableTh key={h} columnIndex={i} columnCount={4} startResize={socDeniedSrcTbl.startResize} style={socDeniedTh}>{h}</ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {denied.by_src.slice(0,15).map((s,i) => (
                    <tr key={i} style={{ borderBottom:'1px solid var(--border)', cursor:'pointer' }} onClick={() => s.ip && goToSocSearch({ srcip: s.ip, action: 'deny' })} title="Open in Custom log search">
                      <td style={{ padding:'5px 10px', color:C.text3 }}>#{i+1}</td>
                      <td style={{ padding:'5px 10px', color:C.cyan }}>{s.ip}</td>
                      <td style={{ padding:'5px 10px', color: i===0 ? C.red : i<3 ? C.amber : C.text2, fontWeight: i<3 ? 600 : 400 }}>{s.count?.toLocaleString()}</td>
                      <td style={{ padding:'5px 10px', overflow:'hidden' }}>
                        <div style={{ height:4, background:'var(--bg4)', borderRadius:2, overflow:'hidden' }}>
                          <div style={{ width:`${(s.count/denied.by_src[0]?.count*100).toFixed(0)}%`, height:'100%', background: i===0 ? C.red : i<3 ? C.amber : C.accent, borderRadius:2 }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* -- FIREWALL CONFIG (FortiGate) — layout mirrors NOC → Switch config -- */}
      {tab === 'config' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)', maxWidth:720 }}>
            FortiGate configuration changes: “Configuration changed”, object/attribute configured, cfg restore, and related syslog for the selected time range. Policy / VPN / system areas omit automatic SD-WAN/SLA health noise. Cisco switch config: NOC → Switch config.
            {socConfigSlaOmitted > 0 && (
              <span>{' '}{socConfigSlaOmitted.toLocaleString()} SLA-style event{socConfigSlaOmitted === 1 ? '' : 's'} omitted from the table below.</span>
            )}
          </div>
          {configErr && (
            <div style={{ padding:'10px 14px', borderRadius:8, background:'rgba(245,83,79,0.12)', border:'1px solid rgba(245,83,79,0.35)', color:C.red, fontSize:11, fontFamily:'var(--mono)' }}>{configErr}</div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
            <KPI label="Firewall config events" value={configChanges?.firewall?.total?.toLocaleString() ?? '—'} sub="in range (ES)" color="amber" delta={null} onClick={() => goToSocSearch({ q: 'Configuration changed' })} />
            <KPI label="In this view" value={configChanges ? socConfigRows.length : '—'} sub="rows loaded" color="blue" delta={null} onClick={() => goToSocSearch({ q: 'Configuration changed' })} />
            <KPI label="Firewalls" value={configChanges ? socConfigFwByHost.length : '—'} sub="with changes" color="cyan" delta={null} onClick={() => goToSocSearch({ q: 'Configuration changed' })} />
            <KPI label="Custom search" value="→" sub="refine filters" color="purple" delta={null} onClick={() => goToSocSearch({ q: 'Configuration changed' })} />
          </div>
          {(socConfigKindCounts.policy + socConfigKindCounts.vpn + socConfigKindCounts.system > 0 || socConfigKindCounts.other > 0) && (
            <div style={{ fontSize:10, fontFamily:'var(--mono)', color:C.text3 }}>
              In this sample: Policy {socConfigKindCounts.policy.toLocaleString()} · VPN {socConfigKindCounts.vpn.toLocaleString()} · System {socConfigKindCounts.system.toLocaleString()}
              {socConfigKindCounts.other > 0 && ` · Other ${socConfigKindCounts.other.toLocaleString()}`}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:12 }}>
            <Card title="TOP FIREWALLS" badge={socConfigFwByHost.length} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px' }}>
                {socConfigFwByHost.length > 0 ? (
                  <BarRows
                    items={socConfigFwByHost.map(b => ({ label: b.key, count: b.count }))}
                    colorFn={() => C.amber}
                    onRowClick={item => {
                      if (!item.label) return
                      goToSocSearch({ q: `Configuration changed ${item.label}`.slice(0, 140) })
                    }}
                  />
                ) : (
                  <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'28px 0' }}>{configChanges ? 'No firewall config changes in range' : 'Loading…'}</div>
                )}
              </div>
            </Card>
            <Card title="FIREWALL CONFIGURATION LOG" badge="FORTIGATE" badgeClass="amber" noPad>
              <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:480 }}>
                <div style={{ display:'grid', gridTemplateColumns:'minmax(72px,0.7fr) minmax(72px,0.55fr) minmax(88px,0.65fr) minmax(140px,1.4fr) minmax(100px,0.9fr)', gap:6, padding:'6px 12px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:9, fontWeight:600, color:C.text3, textTransform:'uppercase', letterSpacing:0.4 }}>
                  <span>Time</span>
                  <span>Area</span>
                  <span>Changed by</span>
                  <span>What changed</span>
                  <span title="Hostname and IP">Firewall</span>
                </div>
                {socConfigRows.length > 0 ? (
                  socConfigRows.map((e, i) => {
                    const fullMsg = fgt(e, 'msg') || e.message || ''
                    const what = e.change_what && e.change_what !== fullMsg ? `${e.change_what} — ${fullMsg}` : (e.change_what || fullMsg || '—')
                    const kind = e.change_kind || 'other'
                    const areaLabel =
                      kind === 'policy' ? 'Policy' : kind === 'vpn' ? 'VPN' : kind === 'system' ? 'System' : 'Other'
                    const areaColor = kind === 'policy' ? C.amber : kind === 'vpn' ? C.cyan : kind === 'system' ? C.accent : C.text3
                    const { name: fwName, ip: fwIp } = firewallIdentityFromEvent(e)
                    const hasName = fwName !== '—'
                    const fwPrimary = hasName ? fwName : (fwIp || '—')
                    const fwSecondary = hasName && fwIp ? fwIp : ''
                    const fwTitle = [hasName ? fwName : null, fwIp || null].filter(Boolean).join(' · ') || fwPrimary
                    return (
                      <div
                        key={e._id || i}
                        style={{
                          display:'grid',
                          gridTemplateColumns:'minmax(72px,0.7fr) minmax(72px,0.55fr) minmax(88px,0.65fr) minmax(140px,1.4fr) minmax(100px,0.9fr)',
                          gap:6,
                          alignItems:'center',
                          padding:'8px 12px',
                          borderBottom:'1px solid var(--border)',
                          fontFamily:'var(--mono)',
                          fontSize:10,
                          cursor:'pointer',
                        }}
                        onClick={() => goToSocSearch({ q: String(fullMsg || e.change_what || '').slice(0, 160) })}
                        title="Open in Custom log search"
                        onMouseEnter={el => { el.currentTarget.style.background = 'var(--bg3)' }}
                        onMouseLeave={el => { el.currentTarget.style.background = 'transparent' }}
                      >
                        <span style={{ color:C.text3, whiteSpace:'nowrap' }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}</span>
                        <span style={{ color: areaColor, fontWeight:700, fontSize:9, textTransform:'uppercase', letterSpacing:0.3 }}>{areaLabel}</span>
                        <span style={{ color:C.green, overflow:'hidden', textOverflow:'ellipsis', fontWeight:600 }} title={e.change_by}>{e.change_by || '—'}</span>
                        <span style={{ color:C.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={what}>{what}</span>
                        <div style={{ minWidth:0, display:'flex', flexDirection:'column', gap:2 }} title={fwTitle}>
                          <span style={{ color:C.cyan, overflow:'hidden', textOverflow:'ellipsis', fontWeight:600, lineHeight:1.2 }}>{fwPrimary}</span>
                          {fwSecondary ? (
                            <span style={{ fontSize:9, color:C.text3, overflow:'hidden', textOverflow:'ellipsis', lineHeight:1.2 }}>{fwSecondary}</span>
                          ) : null}
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <div style={{ color:C.text3, fontSize:11, textAlign:'center', padding:48, fontFamily:'var(--mono)' }}>
                    {!configChanges
                      ? 'Loading…'
                      : socConfigSlaOmitted > 0
                        ? 'Only automatic SLA/SD-WAN health updates in this sample. Use Custom log search for the full configuration stream.'
                        : 'No firewall configuration changes found for this range.'}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* -- EVENT LOG: FortiGate only (filters in bar above; no Cisco / switch syslog) -- */}
      {tab==='events' && (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>
            {filteredEvents.length} events · firewall only
          </div>
          <Card title="Event log" badge={String(filteredEvents.length)} badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:600 }}>
              {filteredEvents.length > 0 ? filteredEvents.map((e, i) => {
                const sevCat = getSevCategory(e)
                const sevRaw = e.syslog_severity_label || e['log.level'] || e['log.syslog.severity.code']
                const sevLabel = String(sevRaw != null && sevRaw !== '' ? sevRaw : sevCat).toUpperCase().slice(0, 4)
                const typ = (fgt(e, 'subtype') || fgt(e, 'type') || 'traffic').toUpperCase()
                const sip = fgt(e, 'srcip')
                const dip = fgt(e, 'dstip')
                const summary = [
                  sip && dip ? `${sip} → ${dip}` : sip || dip || '',
                  fgt(e, 'action'),
                  fgt(e, 'app'),
                  fgt(e, 'attack'),
                ].filter(Boolean).join(' · ')
                const msg = summary || fgt(e, 'msg') || e.message || '—'
                const ts = e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : ''
                const sc = sevCategoryBadgeClass(sevCat)
                const dev = logSearchDeviceLabel(e) || '—'
                return (
                  <div
                    key={e._id || i}
                    style={{ display:'flex', gap:10, padding:'8px 14px', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:11, cursor:'default' }}
                    onMouseEnter={el => { el.currentTarget.style.background = 'var(--bg3)' }}
                    onMouseLeave={el => { el.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ color:C.text3, width:52, flexShrink:0 }}>{ts}</span>
                    <span className={`badge badge-${sc}`} style={{ width:56, textAlign:'center', flexShrink:0 }}>{sevLabel}</span>
                    <span style={{ color:C.accent2, width:128, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis' }} title={dev}>{dev}</span>
                    <span style={{ color:C.cyan, width:72, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis' }}>{typ}</span>
                    <span style={{ color:C.text2, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={msg}>{msg}</span>
                  </div>
                )
              }) : (
                <div style={{ color:C.text3, fontSize:11, textAlign:'center', padding:60, fontFamily:'var(--mono)' }}>No firewall events match the current filters and time range</div>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'search' && (
        <LogSearch
          key={socLogSearchSeed?.id ?? 'soc-search'}
          type="firewall"
          accentColor={C.accent}
          dashboardRange={range}
          initialFilters={socLogSearchSeed?.filters}
        />
      )}

    </div>
  )
}




import RangePicker from '../../components/ui/RangePicker.jsx'
import { useEffect, useState, useRef } from 'react'
import { Line, Bar, Doughnut } from 'react-chartjs-2'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler } from 'chart.js'
import api from '../../api/client'
import { io } from 'socket.io-client'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler)

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'#e8eaf2', text2:'#8b90aa', text3:'#555a72' }

const TABS = [
  { id:'overview',  label:'Overview' },
  { id:'traffic',   label:'Traffic' },
  { id:'threats',   label:'Threats & UTM' },
  { id:'vpn',       label:'VPN & Auth' },
  { id:'geo',       label:'Geo Intel' },
  { id:'events',    label:'Event Log' },
]

const co = { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ color:C.text3, font:{ size:9 }, maxTicksLimit:8 }, grid:{ color:'rgba(99,120,200,0.07)' } }, y:{ ticks:{ color:C.text3, font:{ size:9 } }, grid:{ color:'rgba(99,120,200,0.07)' } } } }

function KPI({ label, value, sub, delta, color }) {
  const colors = { blue:C.accent, red:C.red, green:C.green, amber:C.amber, cyan:C.cyan, purple:C.accent2 }
  return (
    <div className={`kpi ${color}`} style={{ minWidth:0 }}>
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

function BarRows({ items, colorFn }) {
  const max = Math.max(...items.map(i => i.count || i.value || 0), 1)
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {items.map((item, i) => {
        const val = item.count || item.value || 0
        const pct = (val/max*100).toFixed(0)
        const color = colorFn ? colorFn(i) : [C.red,C.red,C.amber,C.amber,C.accent,C.accent][i] || C.text3
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:8 }}>
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

// Normalise raw FortiGate/Cisco syslog severity labels → filter category
// FortiGate: emergency(0) alert(1) critical(2) error(3) warning(4) notification(5) information(6) debug(7)
// Cisco:     emergency alert critical error warning notice notification informational debugging
function getSevCategory(e) {
  const raw = (e.syslog_severity_label || e.cisco_severity_label || '').toLowerCase()
  if (!raw) return e['fgt.subtype'] === 'ips' || e.fgt?.subtype === 'ips' ? 'high' : 'info'
  if (['critical','emergency','alert'].some(x => raw.includes(x))) return 'critical'
  if (['error'].some(x => raw.includes(x)))                         return 'high'
  if (['warning','warn'].some(x => raw.includes(x)))                return 'medium'
  if (['notice','notification'].some(x => raw.includes(x)))         return 'low'
  return 'info'
}

export default function SOCPage() {
  const [tab, setTab]           = useState('overview')
  const [range, setRange] = useState({ type:'preset', value:'24h', label:'24h' })
  const [stats, setStats]       = useState(null)
  const [timeline, setTimeline] = useState([])
  const [threats, setThreats]   = useState([])
  const [denied, setDenied]     = useState({ by_src:[], by_country:[] })
  const [events, setEvents]     = useState([])
  const [sessions, setSessions] = useState([])
  const [liveEvents, setLiveEvents] = useState([])
  const [sevFilter, setSevFilter]   = useState('all')
  const socketRef = useRef(null)

  useEffect(() => {
    socketRef.current = io(import.meta.env.VITE_WS_URL || 'http://localhost:5000')
    socketRef.current.on('live:events', evs => setLiveEvents(p => [...evs,...p].slice(0,100)))
    return () => socketRef.current?.disconnect()
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const [s,t,th,d,e,se] = await Promise.all([
          api.get(`/api/stats/soc?range=${range?.value||''}&from=${range?.from||''}&to=${range?.to||''}`),
          api.get(`/api/logs/traffic/timeline?range=${range?.value||''}&from=${range?.from||''}&to=${range?.to||''}`),
          api.get('/api/logs/threats/top'),
          api.get('/api/logs/denied'),
          api.get('/api/logs/events/recent?size=50'),
          api.get('/api/logs/sessions'),
        ])
        setStats(s.data); setTimeline(t.data); setThreats(th.data)
        setDenied(d.data); setEvents(e.data); setSessions(se.data)
      } catch(err){ console.error(err) }
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [range])

  const allEvents = [...liveEvents,...events].slice(0,100)
  const filteredEvents = sevFilter === 'all' ? allEvents : allEvents.filter(e => getSevCategory(e) === sevFilter)

  const rv = range?.value || '24h'
  const isShort = rv === '15m' || rv === '1h'
  const timeFmt = isShort
    ? { hour:'2-digit', minute:'2-digit' }
    : rv === '3d' || rv === '7d' || rv === '30d'
      ? { month:'short', day:'numeric', hour:'2-digit' }
      : { hour:'2-digit', minute:'2-digit' }
  const tickLimit = rv === '15m' ? 15 : rv === '1h' ? 12 : rv === '6h' ? 12 : 8

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

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div style={{ display:'flex', gap:2, background:'var(--bg3)', borderRadius:10, padding:3 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:7,
              cursor:'pointer', border:'none', fontFamily:'var(--sans)', letterSpacing:0.3,
              background: tab===t.id ? C.accent : 'transparent',
              color: tab===t.id ? '#fff' : C.text2,
              transition:'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>
        <RangePicker range={range} onChange={setRange} />
      </div>

      {/* -- OVERVIEW -- */}
      {tab==='overview' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Events"     value={stats?.total?.toLocaleString()}   sub={`last ${range?.label||range?.value||'24h'}`}           color="blue"   delta={null} />
            <KPI label="Blocked Sessions" value={stats?.denied?.toLocaleString()}  sub="firewall denied"           color="red"    delta={null} />
            <KPI label="IPS Alerts"       value={stats?.ips?.toLocaleString()}     sub="intrusion attempts"        color="amber"  delta={null} />
            <KPI label="Allowed Sessions" value={stats ? (stats.total-stats.denied)?.toLocaleString() : '�'} sub="policy permitted" color="green" delta={null} />
            <KPI label="UTM Events"       value={stats?.utm?.toLocaleString()}     sub="web/av/dlp/app"            color="cyan"   delta={null} />
            <KPI label="VPN Events"       value={stats?.vpn?.toLocaleString()}     sub="tunnel events"             color="purple" delta={null} />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12 }}>
            <Card title="SESSION VOLUME TREND" badge={(range?.label||range?.value||'24h').toUpperCase()} height={200}>
              <Line data={timelineData} options={{ ...co, plugins:{ legend:{ display:true, labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
            </Card>
            <Card title="SEVERITY BREAKDOWN" badge="ALERTS" badgeClass="red" height={200}>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, height:200 }}>
                <div style={{ height:140, width:140, position:'relative' }}>
                  <Doughnut data={sevData} options={{ responsive:true, maintainAspectRatio:false, cutout:'70%', plugins:{ legend:{ display:false } } }} />
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
                <BarRows items={denied.by_src.slice(0,6)} />
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
                } colorFn={i=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.amber][i]} />
              </div>
            </Card>
            <Card title="RECENT CRITICAL ALERTS" badge="LIVE" badgeClass="red" noPad>
              <div style={{ display:'flex', flexDirection:'column', gap:6, padding:'10px 14px' }}>
                {allEvents.filter(e=>['critical','high'].includes((e.syslog_severity_label||e.cisco_severity_label||'').toLowerCase())).slice(0,5).map((e,i) => {
                  const sev = (e.syslog_severity_label||e.cisco_severity_label||'info').toLowerCase()
                  const msg = e.fgt?.msg || e.cisco_message || e.message || `${e.fgt?.srcip||''} ? ${e.fgt?.dstip||''}`
                  return (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 8px', borderRadius:7, border:'1px solid transparent', cursor:'pointer' }}
                      onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'}
                      onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                      <div style={{ width:6, height:36, borderRadius:3, flexShrink:0, background: sev==='critical' ? C.red : sev==='high' ? C.amber : C.accent }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{msg?.slice(0,50)}</div>
                        <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)', marginTop:2 }}>{e.site_name} � {e['fgt.subtype']||e.cisco_mnemonic||'event'}</div>
                      </div>
                      <div style={{ textAlign:'right', flexShrink:0 }}>
                        <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</div>
                      </div>
                    </div>
                  )
                })}
                {allEvents.filter(e=>['critical','high'].includes((e.syslog_severity_label||e.cisco_severity_label||'').toLowerCase())).length === 0 && (
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
            <KPI label="Total Sessions" value={stats?.total?.toLocaleString()} sub={`last ${range?.label||range?.value||'24h'}`} color="blue" />
            <KPI label="Denied"         value={stats?.denied?.toLocaleString()} sub="blocked" color="red" />
            <KPI label="Allowed"        value={stats ? (stats.total-stats.denied)?.toLocaleString():null} sub="permitted" color="green" />
            <KPI label="Bytes Out"      value={sessions.length ? (sessions.reduce((a,s)=>(a+(s.fgt?.sentbyte||s['fgt.sentbyte']||0)),0)/1024/1024/1024).toFixed(2)+'GB' : '�'} sub="outbound" color="cyan" />
            <KPI label="Bytes In"       value={sessions.length ? (sessions.reduce((a,s)=>(a+(s.fgt?.rcvdbyte||s['fgt.rcvdbyte']||0)),0)/1024/1024/1024).toFixed(2)+'GB' : '�'} sub="inbound" color="purple" />
            <KPI label="Unique Apps"    value={new Set(sessions.map(s=>s.fgt?.app||s['fgt.app'])).size||'�'} sub="applications" color="amber" />
          </div>

          <Card title="TRAFFIC TIMELINE" badge={(range?.label||range?.value||'24h').toUpperCase()} height={220}>
            <Line data={timelineData} options={{ ...co, plugins:{ legend:{ display:true, labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } } }} />
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
              }} options={{ responsive:true, maintainAspectRatio:false, cutout:'60%', plugins:{ legend:{ display:true, position:'right', labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } } }} />
            </Card>
            <Card title="TOP APPLICATIONS" badge="APP CTRL" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={
                  Object.entries(sessions.reduce((acc,s)=>{ const a=s.fgt?.app||s['fgt.app']||'Unknown'; acc[a]=(acc[a]||0)+1; return acc },{}))
                  .sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>({ label:k, count:v }))
                } colorFn={i=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.red,C.accent,C.cyan][i]} />
              </div>
            </Card>
          </div>

          <Card title="SESSION LOG" badge="TRAFFIC" noPad>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, fontFamily:'var(--mono)' }}>
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Time','Src IP','Sport','Dst IP','Dport','Proto','Action','App','Sent','Rcvd','Country','Site'].map(h=>(
                      <th key={h} style={{ padding:'7px 8px', textAlign:'left', borderBottom:'1px solid var(--border)', fontWeight:500, whiteSpace:'nowrap' }}>{h}</th>
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
                      <tr key={i} style={{ borderBottom:'1px solid rgba(99,120,200,0.07)' }}
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
            <KPI label="IPS Alerts"    value={stats?.ips?.toLocaleString()}  sub="intrusion attempts" color="red"    />
            <KPI label="UTM Events"    value={stats?.utm?.toLocaleString()}  sub="total UTM"          color="amber"  />
            <KPI label="Attack Types"  value={threats.length}                sub="unique attacks"     color="blue"   />
            <KPI label="Top Attack"    value={threats[0]?.name?.slice(0,12)||'�'} sub="most frequent" color="red"    />
            <KPI label="Blocked IPs"   value={denied.by_src.length}         sub="unique sources"     color="purple" />
            <KPI label="Countries"     value={denied.by_country.length}      sub="threat origins"     color="cyan"   />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="TOP IPS ATTACKS" badge={`${threats.length} types`} badgeClass="amber" height={220}>
              {threats.length > 0
                ? <Bar data={threatsData} options={{ ...co, indexAxis:'y', plugins:{ legend:{ display:false } } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:80 }}>No IPS events</div>
              }
            </Card>
            <Card title="THREAT SEVERITY TIMELINE" badge="24H" badgeClass="amber" height={220}>
              <Line data={timelineData} options={{ ...co, plugins:{ legend:{ display:true, labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
            </Card>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12 }}>
            <Card title="TOP BLOCKED SOURCE IPs" badge="THREATS" badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={denied.by_src.slice(0,8)} />
              </div>
            </Card>
            <Card title="TOP THREAT COUNTRIES" badge="GEO" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={denied.by_country.slice(0,6).map(c=>({ label:c.country, count:c.count }))} colorFn={i=>[C.red,C.amber,C.accent,C.accent2,C.cyan,C.green][i]} />
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* -- VPN & AUTH -- */}
      {tab==='vpn' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="VPN Events"    value={stats?.vpn?.toLocaleString()}  sub="tunnel events"      color="green"  />
            <KPI label="Auth Events"   value={stats?.auth?.toLocaleString()} sub="total auth"         color="blue"   />
            <KPI label="Auth Failures" value={events.filter(e=>e.cisco_mnemonic==='SSH2_USERAUTH').length} sub="failed attempts" color="red" />
            <KPI label="Login Success" value={events.filter(e=>e.cisco_mnemonic==='LOGIN_SUCCESS').length} sub="successful logins" color="cyan" />
            <KPI label="Config Changes"value={events.filter(e=>e.cisco_mnemonic==='CONFIG_I').length} sub="switches modified" color="amber" />
            <KPI label="SSH Sessions"  value={events.filter(e=>['SSH2_SESSION','SSH2_CLOSE'].includes(e.cisco_mnemonic)).length} sub="ssh activity" color="purple" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="AUTH EVENTS TIMELINE" badge="24H" height={220}>
              <Line data={timelineData} options={{ ...co, plugins:{ legend:{ display:true, labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } }, scales:{ ...co.scales, x:{ ...co.scales.x, ticks:{ ...co.scales.x.ticks, maxTicksLimit:tickLimit } } } }} />
            </Card>
            <Card title="AUTH EVENT BREAKDOWN" badge="CISCO" height={220}>
              <Doughnut data={{
                labels:['Login Success','Logout','SSH Auth','SSH Session','Config Change'],
                datasets:[{ data:[
                  events.filter(e=>e.cisco_mnemonic==='LOGIN_SUCCESS').length,
                  events.filter(e=>e.cisco_mnemonic==='LOGOUT').length,
                  events.filter(e=>e.cisco_mnemonic==='SSH2_USERAUTH').length,
                  events.filter(e=>['SSH2_SESSION','SSH2_CLOSE'].includes(e.cisco_mnemonic)).length,
                  events.filter(e=>e.cisco_mnemonic==='CONFIG_I').length,
                ], backgroundColor:[C.green,C.text3,C.amber,C.cyan,C.red], borderWidth:0 }]
              }} options={{ responsive:true, maintainAspectRatio:false, cutout:'55%', plugins:{ legend:{ display:true, position:'right', labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } } }} />
            </Card>
          </div>

          <Card title="AUTH & CONFIG EVENTS" badge="LIVE" badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:280 }}>
              {events.filter(e=>['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION','SSH2_CLOSE','CONFIG_I'].includes(e.cisco_mnemonic)).slice(0,30).map((e,i) => (
                <div key={i} style={{ display:'flex', gap:10, padding:'8px 14px', borderBottom:'1px solid rgba(99,120,200,0.06)', fontFamily:'var(--mono)', fontSize:11, cursor:'default' }}>
                  <span style={{ color:C.text3, width:70, flexShrink:0 }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString() : ''}</span>
                  <span className={`badge badge-${sevClass(e.cisco_severity_label)}`} style={{ flexShrink:0 }}>{e.cisco_mnemonic}</span>
                  <span style={{ color:C.text2, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.cisco_message||'�'}</span>
                  <span style={{ color:C.text3, flexShrink:0 }}>{e.device_name||''}</span>
                </div>
              ))}
              {events.filter(e=>['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION','SSH2_CLOSE','CONFIG_I'].includes(e.cisco_mnemonic)).length===0 && (
                <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:40 }}>No auth events in current time range</div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* -- GEO INTEL -- */}
      {tab==='geo' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Threat Countries" value={denied.by_country.length}                      sub="unique origins"      color="red"    />
            <KPI label="Top Threat Origin" value={denied.by_country[0]?.country?.slice(0,10)||'�'} sub="highest volume"   color="amber"  />
            <KPI label="Internal Denied"  value={denied.reserved_count?.toLocaleString()||'0'} sub="RFC1918 / private IPs" color="blue" />
            <KPI label="Top Blocked"       value={denied.by_src[0]?.ip||'�'}                    sub="most blocked IP"     color="red"    />
            <KPI label="Total Denied"      value={stats?.denied?.toLocaleString()}               sub="blocked sessions"    color="purple" />
            <KPI label="Unique Sources"    value={denied.by_src.length}                          sub="source IPs"          color="cyan"   />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="TOP THREAT COUNTRIES" badge="GEO INTEL" badgeClass="red" height={300}>
              {denied.by_country.length > 0
                ? <Doughnut data={countryData} options={{ responsive:true, maintainAspectRatio:false, cutout:'50%', plugins:{ legend:{ display:true, position:'right', labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:120 }}>No geo data</div>
              }
            </Card>
            <Card title="COUNTRY BREAKDOWN" badge={`${denied.by_country.length} countries`} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:6 }}>
                {denied.by_country.slice(0,10).map((c,i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:10 }}>
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
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, fontFamily:'var(--mono)' }}>
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Rank','Source IP','Block Count','Bar'].map(h=>(
                      <th key={h} style={{ padding:'7px 10px', textAlign:'left', borderBottom:'1px solid var(--border)', fontWeight:500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {denied.by_src.slice(0,15).map((s,i) => (
                    <tr key={i} style={{ borderBottom:'1px solid rgba(99,120,200,0.07)' }}>
                      <td style={{ padding:'5px 10px', color:C.text3 }}>#{i+1}</td>
                      <td style={{ padding:'5px 10px', color:C.cyan }}>{s.ip}</td>
                      <td style={{ padding:'5px 10px', color: i===0 ? C.red : i<3 ? C.amber : C.text2, fontWeight: i<3 ? 600 : 400 }}>{s.count?.toLocaleString()}</td>
                      <td style={{ padding:'5px 10px', width:'40%' }}>
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

      {/* -- EVENT LOG -- */}
      {tab==='events' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <span style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>Filter:</span>
            {['all','critical','high','medium','low','info'].map(s => (
              <button key={s} onClick={()=>setSevFilter(s)} style={{
                padding:'3px 10px', borderRadius:6, fontSize:10, fontFamily:'var(--mono)',
                border:'1px solid var(--border)', cursor:'pointer', textTransform:'uppercase',
                background: sevFilter===s ? (s==='critical'?C.red:s==='high'?C.amber:s==='medium'?C.accent:s==='low'?C.green:C.accent) : 'var(--bg3)',
                color: sevFilter===s ? '#fff' : C.text3,
              }}>{s}</button>
            ))}
            <span style={{ marginLeft:'auto', fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{filteredEvents.length} events</span>
          </div>

          <Card title="LIVE EVENT FEED" badge="LIVE" badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:600 }}>
              {filteredEvents.length > 0 ? filteredEvents.map((e,i) => {
                const isFirewall = e._index?.includes('firewall') || e.fgt || e['fgt.type']
                const sev = e.syslog_severity_label || e.cisco_severity_label || (e['fgt.subtype']==='ips' ? 'high' : 'info')
                const type = isFirewall ? (e.fgt?.subtype||e['fgt.subtype']||e.fgt?.type||e['fgt.type']||'traffic').toUpperCase() : (e.cisco_mnemonic||'CISCO')
                const msg = isFirewall
                  ? `${e.fgt?.srcip||e['fgt.srcip']||'?'} ? ${e.fgt?.dstip||e['fgt.dstip']||'?'} ${e.fgt?.action||e['fgt.action']||''} ${e.fgt?.app||e['fgt.app']||''} ${e.fgt?.attack||e['fgt.attack']||''}`
                  : (e.cisco_message||e.message||'')
                const ts = e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''
                const sc = sevClass(sev)
                return (
                  <div key={i} style={{ display:'flex', gap:10, padding:'8px 14px', borderBottom:'1px solid rgba(99,120,200,0.06)', fontFamily:'var(--mono)', fontSize:11, cursor:'default' }}
                    onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'}
                    onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                    <span style={{ color:C.text3, width:52, flexShrink:0 }}>{ts}</span>
                    <span className={`badge badge-${sc}`} style={{ width:56, textAlign:'center', flexShrink:0 }}>{sev?.toUpperCase().slice(0,4)}</span>
                    <span style={{ color:C.cyan, width:72, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis' }}>{type}</span>
                    <span style={{ color:C.text2, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{msg}</span>
                    <span style={{ color:C.text3, flexShrink:0, fontSize:10, minWidth:80, textAlign:'right' }}>{e.site_name||e.device_name||''}</span>
                  </div>
                )
              }) : (
                <div style={{ color:C.text3, fontSize:11, textAlign:'center', padding:60, fontFamily:'var(--mono)' }}>No events found</div>
              )}
            </div>
          </Card>
        </div>
      )}

    </div>
  )
}




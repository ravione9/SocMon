import RangePicker from '../../components/ui/RangePicker.jsx'
import { useEffect, useState, useRef } from 'react'
import { Line, Bar, Doughnut } from 'react-chartjs-2'
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler } from 'chart.js'
import api from '../../api/client'
import { io } from 'socket.io-client'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler)

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'#e8eaf2', text2:'#8b90aa', text3:'#555a72' }

const TABS = [
  { id:'overview',   label:'Overview' },
  { id:'interfaces', label:'Interfaces' },
  { id:'devices',    label:'Devices' },
  { id:'macflap',    label:'MAC Flapping' },
  { id:'sites',      label:'Site Comparison' },
  { id:'events',     label:'Event Feed' },
]

const co = { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ color:C.text3, font:{ size:9 }, maxTicksLimit:8 }, grid:{ color:'rgba(99,120,200,0.07)' } }, y:{ ticks:{ color:C.text3, font:{ size:9 } }, grid:{ color:'rgba(99,120,200,0.07)' } } } }

function KPI({ label, value, sub, color }) {
  const colors = { blue:C.accent, red:C.red, green:C.green, amber:C.amber, cyan:C.cyan, purple:C.accent2 }
  return (
    <div className={`kpi ${color}`}>
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

function BarRows({ items, colorFn }) {
  const max = Math.max(...items.map(i=>i.count||0), 1)
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {items.map((item,i) => {
        const val = item.count||0
        const color = colorFn ? colorFn(i) : [C.red,C.amber,C.accent,C.cyan,C.green,C.accent2][i%6]
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:8 }}>
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
  const [range, setRange] = useState({ type:'preset', value:'24h', label:'24h' })
  const [stats, setStats]     = useState(null)
  const [events, setEvents]   = useState([])
  const [ifaceData, setIfaceData] = useState({ timeline:[], top_interfaces:[], top_devices:[] })
  const [macData, setMacData]     = useState({ events:[], by_device:[], by_vlan:[], total:0 })
  const [liveEvents, setLiveEvents] = useState([])
  const socketRef = useRef(null)

  useEffect(() => {
    socketRef.current = io(import.meta.env.VITE_WS_URL || 'http://localhost:5000')
    socketRef.current.on('live:events', evs => {
      const cisco = evs.filter(e => e._index?.includes('cisco') || e.cisco_mnemonic)
      if (cisco.length) setLiveEvents(p => [...cisco,...p].slice(0,100))
    })
    return () => socketRef.current?.disconnect()
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const [s, e, iface, mac] = await Promise.all([
          api.get(`/api/stats/noc?range=${range?.value||''}&from=${range?.from||''}&to=${range?.to||''}`),
          api.get(`/api/logs/events/recent?size=100&type=cisco`),
          api.get(`/api/logs/interfaces?range=${range?.value||''}&from=${range?.from||''}&to=${range?.to||''}`),
          api.get(`/api/logs/macflap?range=${range?.value||''}&from=${range?.from||''}&to=${range?.to||''}`),
        ])
        setStats(s.data)
        setEvents(e.data)
        setIfaceData(iface.data)
        setMacData(mac.data)
      } catch(err) { console.error(err) }
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [range])

  const allEvents = [...liveEvents, ...events].slice(0,200)
  const updownEvents  = allEvents.filter(e => e.cisco_mnemonic === 'UPDOWN')
  const macflapEvents = allEvents.filter(e => e.cisco_mnemonic === 'MACFLAP_NOTIF')
  const vlanEvents    = allEvents.filter(e => e.cisco_mnemonic === 'NATIVE_VLAN_MISMATCH')
  const authEvents    = allEvents.filter(e => ['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION'].includes(e.cisco_mnemonic))
  const configEvents  = allEvents.filter(e => e.cisco_mnemonic === 'CONFIG_I')

  const deviceCounts = allEvents.reduce((acc,e) => { const d=e.device_name||'Unknown'; acc[d]=(acc[d]||0)+1; return acc },{})
  const siteCounts   = allEvents.reduce((acc,e) => { const s=e.site_name||'Unknown'; acc[s]=(acc[s]||0)+1; return acc },{})
  const mnemonicCounts = allEvents.reduce((acc,e) => { const m=e.cisco_mnemonic||'Unknown'; acc[m]=(acc[m]||0)+1; return acc },{})
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

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div style={{ display:'flex', gap:2, background:'var(--bg3)', borderRadius:10, padding:3 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:7,
              cursor:'pointer', border:'none', fontFamily:'var(--sans)', letterSpacing:0.3,
              background: tab===t.id ? C.cyan : 'transparent',
              color: tab===t.id ? '#0a0c10' : C.text2,
              transition:'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>
        <RangePicker range={range} onChange={setRange} accentColor='#22d3ee' />
      </div>

      {/* -- OVERVIEW -- */}
      {tab==='overview' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Events"     value={stats?.total?.toLocaleString()}         sub={`last ${range?.label||range?.value||'24h'}`}       color="blue"   />
            <KPI label="Interface Events" value={stats?.updown?.toLocaleString()}        sub="up/down changes"       color="cyan"   />
            <KPI label="MAC Flapping"     value={stats?.macflap?.toLocaleString()}       sub="flap events"           color="red"    />
            <KPI label="VLAN Mismatches"  value={stats?.vlanmismatch?.toLocaleString()}  sub="native vlan issues"    color="amber"  />
            <KPI label="Active Devices"   value={Object.keys(deviceCounts).length}       sub="reporting switches"    color="green"  />
            <KPI label="Sites"            value={stats?.sites?.length||0}                sub="active locations"      color="purple" />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12 }}>
            <Card title="INTERFACE UP/DOWN TIMELINE" badge={(range && range.label ? range.label : range || '24h').toUpperCase()} badgeClass="cyan" height={200}>
              {ifaceData.timeline.length > 0
                ? <Line data={interfaceTimeline} options={{ ...co, plugins:{ legend:{ display:true, labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:80 }}>No interface events</div>
              }
            </Card>
            <Card title="EVENT TYPE BREAKDOWN" badge="CISCO" height={200}>
              {Object.keys(mnemonicCounts).length > 0
                ? <Doughnut data={eventTypeData} options={{ responsive:true, maintainAspectRatio:false, cutout:'55%', plugins:{ legend:{ display:true, position:'right', labels:{ color:C.text2, font:{ size:9 }, boxWidth:8 } } } }} />
                : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:80 }}>No data</div>
              }
            </Card>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            <Card title="MOST ACTIVE SWITCHES" badge={`${topDevices.length} devices`} badgeClass="blue" noPad>
              <div style={{ padding:'12px 14px' }}>
                <BarRows items={topDevices.slice(0,6)} colorFn={i=>[C.accent,C.cyan,C.accent2,C.green,C.amber,C.red][i%6]} />
              </div>
            </Card>
            <Card title="MAC FLAPPING � TOP DEVICES" badge={macData.by_device.length} badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                {macData.by_device.length > 0
                  ? <BarRows items={macData.by_device.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={()=>C.red} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No MAC flapping</div>
                }
              </div>
            </Card>
            <Card title="VLAN MISMATCHES � TOP DEVICES" badge={vlanEvents.length} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px' }}>
                {(() => {
                  const v = vlanEvents.reduce((acc,e)=>{ const d=e.device_name||'Unknown'; acc[d]=(acc[d]||0)+1; return acc },{})
                  const items = Object.entries(v).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>({ label:k, count:v }))
                  return items.length > 0
                    ? <BarRows items={items} colorFn={()=>C.amber} />
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
            <KPI label="Total Changes"     value={ifaceData.timeline.reduce((a,b)=>a+b.total,0)?.toLocaleString()} sub="up/down events"     color="blue"   />
            <KPI label="Port Up"           value={ifaceData.timeline.reduce((a,b)=>a+b.up,0)?.toLocaleString()}    sub="came online"        color="green"  />
            <KPI label="Port Down"         value={ifaceData.timeline.reduce((a,b)=>a+b.down,0)?.toLocaleString()}  sub="went offline"       color="red"    />
            <KPI label="Affected Ports"    value={ifaceData.top_interfaces.length}                                  sub="unique interfaces"  color="amber"  />
            <KPI label="Affected Switches" value={ifaceData.top_devices.length}                                     sub="devices"            color="cyan"   />
            <KPI label="Line Protocol"     value={updownEvents.filter(e=>e.cisco_facility==='%LINEPROTO').length}   sub="proto changes"      color="purple" />
          </div>
          <Card title="INTERFACE UP/DOWN TIMELINE" badge={(range && range.label ? range.label : range || '24h').toUpperCase()} badgeClass="cyan" height={220}>
            {ifaceData.timeline.length > 0
              ? <Line data={interfaceTimeline} options={{ ...co, plugins:{ legend:{ display:true, labels:{ color:C.text2, font:{ size:10 }, boxWidth:10 } } } }} />
              : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:90 }}>No interface events</div>
            }
          </Card>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="TOP FLAPPING INTERFACES" badge="UPDOWN" badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                {ifaceData.top_interfaces.length > 0
                  ? <BarRows items={ifaceData.top_interfaces.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={i=>i<3?C.red:i<5?C.amber:C.accent} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No data</div>
                }
              </div>
            </Card>
            <Card title="INTERFACE EVENTS PER SWITCH" badge="DEVICES" noPad>
              <div style={{ padding:'12px 14px' }}>
                {ifaceData.top_devices.length > 0
                  ? <BarRows items={ifaceData.top_devices.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={i=>[C.cyan,C.accent,C.accent2,C.green,C.amber][i%5]} />
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
                  <div key={i} style={{ display:'flex', gap:10, padding:'7px 14px', borderBottom:'1px solid rgba(99,120,200,0.06)', fontFamily:'var(--mono)', fontSize:11 }}>
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
            <KPI label="Total Switches"  value={Object.keys(deviceCounts).length}  sub="reporting devices"  color="blue"   />
            <KPI label="Total Events"    value={stats?.total?.toLocaleString()}     sub={`last ${range?.label||range?.value||'24h'}`}    color="cyan"   />
            <KPI label="Config Changes"  value={configEvents.length}               sub="switch configs"     color="amber"  />
            <KPI label="Auth Events"     value={authEvents.length}                 sub="login/ssh"          color="green"  />
            <KPI label="MAC Flaps"       value={macData.total||0}                  sub="flap events"        color="red"    />
            <KPI label="VLAN Issues"     value={vlanEvents.length}                 sub="mismatches"         color="purple" />
          </div>
          <Card title="DEVICE ACTIVITY" badge={`${Object.keys(deviceCounts).length} switches`} badgeClass="blue" noPad>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11, fontFamily:'var(--mono)' }}>
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Device','Site','Total Events','Interface','MAC Flaps','VLAN Issues','Auth','Config'].map(h=>(
                      <th key={h} style={{ padding:'8px 10px', textAlign:'left', borderBottom:'1px solid var(--border)', fontWeight:500, whiteSpace:'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(deviceCounts).sort((a,b)=>b[1]-a[1]).map(([device,total],i) => {
                    const site  = (allEvents.find(e=>e.device_name===device)||{}).site_name||'�'
                    const iface = updownEvents.filter(e=>e.device_name===device).length
                    const macf  = macData.by_device.find(b=>b.key===device)?.doc_count||0
                    const vlan  = vlanEvents.filter(e=>e.device_name===device).length
                    const auth  = authEvents.filter(e=>e.device_name===device).length
                    const conf  = configEvents.filter(e=>e.device_name===device).length
                    return (
                      <tr key={i} style={{ borderBottom:'1px solid rgba(99,120,200,0.07)' }}
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
            }} options={{ ...co, indexAxis:'y' }} />
          </Card>
        </div>
      )}

      {/* -- MAC FLAPPING -- */}
      {tab==='macflap' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Flaps"     value={macData.total||0}                          sub="flap events"       color="red"    />
            <KPI label="Affected MACs"   value={new Set(macData.events.map(e=>e.cisco_mac_address)).size} sub="unique MACs" color="amber" />
            <KPI label="Affected VLANs"  value={macData.by_vlan.length}                    sub="VLANs affected"    color="blue"   />
            <KPI label="Switches"        value={macData.by_device.length}                  sub="reporting devices" color="cyan"   />
            <KPI label="Top VLAN"        value={macData.by_vlan[0]?.key ? `VLAN ${macData.by_vlan[0].key}` : '�'} sub="most affected" color="purple" />
            <KPI label="Top Switch"      value={macData.by_device[0]?.key?.slice(0,12)||'�'} sub="most flaps"     color="red"    />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Card title="MAC FLAPPING PER SWITCH" badge={macData.by_device.length} badgeClass="red" noPad>
              <div style={{ padding:'12px 14px' }}>
                {macData.by_device.length > 0
                  ? <BarRows items={macData.by_device.map(b=>({ label:b.key, count:b.doc_count }))} colorFn={()=>C.red} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No MAC flapping detected</div>
                }
              </div>
            </Card>
            <Card title="MAC FLAPPING PER VLAN" badge={macData.by_vlan.length} badgeClass="amber" noPad>
              <div style={{ padding:'12px 14px' }}>
                {macData.by_vlan.length > 0
                  ? <BarRows items={macData.by_vlan.map(b=>({ label:`VLAN ${b.key||'?'}`, count:b.doc_count }))} colorFn={()=>C.amber} />
                  : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', padding:'30px 0' }}>No data</div>
                }
              </div>
            </Card>
          </div>
          <Card title="MAC FLAPPING EVENTS � DETAILED" badge="LIVE" badgeClass="red" noPad>
            <div style={{ overflowY:'auto', maxHeight:350 }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:10, fontFamily:'var(--mono)' }}>
                <thead>
                  <tr style={{ color:C.text3, textTransform:'uppercase', letterSpacing:0.5 }}>
                    {['Time','MAC Address','VLAN','Port From','Port To','Switch','Site'].map(h=>(
                      <th key={h} style={{ padding:'7px 10px', textAlign:'left', borderBottom:'1px solid var(--border)', fontWeight:500, whiteSpace:'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {macData.events.map((e,i) => (
                    <tr key={i} style={{ borderBottom:'1px solid rgba(99,120,200,0.07)' }}>
                      <td style={{ padding:'5px 10px', color:C.text3, whiteSpace:'nowrap' }}>{e['@timestamp'] ? new Date(e['@timestamp']).toLocaleTimeString() : '�'}</td>
                      <td style={{ padding:'5px 10px', color:C.cyan }}>{e.cisco_mac_address||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.amber }}>{e.cisco_vlan_id ? `VLAN ${e.cisco_vlan_id}` : '�'}</td>
                      <td style={{ padding:'5px 10px', color:C.text2 }}>{e.cisco_port_from||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.text2 }}>{e.cisco_port_to||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.accent }}>{e.device_name||'�'}</td>
                      <td style={{ padding:'5px 10px', color:C.text3 }}>{e.site_name||'�'}</td>
                    </tr>
                  ))}
                  {macData.events.length===0 && <tr><td colSpan={7} style={{ padding:30, textAlign:'center', color:C.text3 }}>No MAC flapping events</td></tr>}
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
              <KPI key={i} label={site.key} value={site.doc_count?.toLocaleString()} sub="total events" color={['blue','cyan','green','amber','red'][i%5]} />
            ))}
          </div>
          <Card title="LOG VOLUME PER SITE" badge="COMPARISON" badgeClass="cyan" height={220}>
            {Object.keys(siteCounts).length > 0
              ? <Bar data={siteData} options={{ ...co }} />
              : <div style={{ color:C.text3, fontSize:11, fontFamily:'var(--mono)', textAlign:'center', paddingTop:90 }}>No site data</div>
            }
          </Card>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {Object.keys(siteCounts).slice(0,4).map((site,si) => (
              <Card key={site} title={`${site} � EVENT BREAKDOWN`} badge={siteCounts[site]?.toLocaleString()} badgeClass={['blue','cyan','green','amber'][si%4]} noPad>
                <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
                  {[
                    { label:'Interface Events', count:updownEvents.filter(e=>e.site_name===site).length, color:C.cyan },
                    { label:'MAC Flapping',     count:macData.events.filter(e=>e.site_name===site).length, color:C.red },
                    { label:'VLAN Mismatches',  count:vlanEvents.filter(e=>e.site_name===site).length, color:C.amber },
                    { label:'Auth Events',      count:authEvents.filter(e=>e.site_name===site).length, color:C.green },
                    { label:'Config Changes',   count:configEvents.filter(e=>e.site_name===site).length, color:C.accent2 },
                  ].map((item,i) => (
                    <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid rgba(99,120,200,0.07)' }}>
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

      {/* -- EVENT FEED -- */}
      {tab==='events' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:10 }}>
            <KPI label="Total Events"  value={allEvents.length}       sub="loaded"          color="blue"   />
            <KPI label="Interface"     value={updownEvents.length}    sub="up/down"         color="cyan"   />
            <KPI label="MAC Flapping"  value={macData.total||0}       sub="flap alerts"     color="red"    />
            <KPI label="VLAN Issues"   value={vlanEvents.length}      sub="mismatches"      color="amber"  />
            <KPI label="Auth"          value={authEvents.length}      sub="login/ssh"       color="green"  />
            <KPI label="Config"        value={configEvents.length}    sub="config changes"  color="purple" />
          </div>
          <Card title="LIVE CISCO EVENT FEED" badge="LIVE" badgeClass="green" noPad>
            <div style={{ overflowY:'auto', maxHeight:580 }}>
              {allEvents.length > 0 ? allEvents.map((e,i) => {
                const sev = e.cisco_severity_label||'info'
                const sevColor = ['critical','error','emergency'].includes(sev) ? C.red : ['warning','high'].includes(sev) ? C.amber : C.text3
                const mnemonicColor = e.cisco_mnemonic==='MACFLAP_NOTIF'?C.red : e.cisco_mnemonic==='UPDOWN'?C.cyan : e.cisco_mnemonic==='NATIVE_VLAN_MISMATCH'?C.amber : e.cisco_mnemonic==='CONFIG_I'?C.accent2 : e.cisco_mnemonic?.startsWith('SSH')?C.green : C.text2
                return (
                  <div key={i} style={{ display:'flex', gap:10, padding:'8px 14px', borderBottom:'1px solid rgba(99,120,200,0.06)', fontFamily:'var(--mono)', fontSize:11, cursor:'default' }}
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

    </div>
  )
}



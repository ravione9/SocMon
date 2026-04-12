import { useEffect, useState } from 'react'
import api from '../../api/client'
import toast from 'react-hot-toast'

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'#e8eaf2', text2:'#8b90aa', text3:'#555a72' }

const TABS = [
  { id:'devices',  label:'Devices',     icon:'??' },
  { id:'sites',    label:'Sites',       icon:'??' },
  { id:'users',    label:'Users',       icon:'??' },
  { id:'alerts',   label:'Alert Rules', icon:'??' },
  { id:'system',   label:'System',      icon:'??' },
]

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:14, padding:28, width:500, maxHeight:'80vh', overflowY:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
          <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{title}</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:C.text3, cursor:'pointer', fontSize:18 }}>?</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, value, onChange, type='text', options, required }) {
  return (
    <div style={{ marginBottom:14 }}>
      <label style={{ fontSize:10, fontWeight:600, color:C.text3, letterSpacing:1, textTransform:'uppercase', fontFamily:'var(--mono)', display:'block', marginBottom:5 }}>{label}{required && ' *'}</label>
      {options
        ? <select value={value} onChange={e=>onChange(e.target.value)} style={{ width:'100%', padding:'9px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:8, color:C.text, fontSize:13, fontFamily:'var(--mono)', outline:'none' }}>
            {options.map(o => <option key={o.value||o} value={o.value||o}>{o.label||o}</option>)}
          </select>
        : <input type={type} value={value} onChange={e=>onChange(e.target.value)} required={required}
            style={{ width:'100%', padding:'9px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:8, color:C.text, fontSize:13, fontFamily:'var(--mono)', outline:'none' }} />
      }
    </div>
  )
}

function Btn({ label, color='accent', onClick, small, danger }) {
  const bg = danger ? C.red : color==='green' ? C.green : color==='amber' ? C.amber : C.accent
  return (
    <button onClick={onClick} style={{
      padding: small ? '4px 10px' : '8px 16px',
      borderRadius:7, border:'none', background:bg, color: danger||color==='accent' ? '#fff' : '#0a0c10',
      fontSize: small ? 11 : 12, fontWeight:600, fontFamily:'var(--sans)', cursor:'pointer',
    }}>{label}</button>
  )
}

function Badge({ label, color }) {
  const colors = { admin:[C.red,'rgba(245,83,79,0.15)'], analyst:[C.amber,'rgba(245,166,35,0.12)'], viewer:[C.text3,'rgba(85,90,114,0.2)'], active:[C.green,'rgba(34,211,160,0.1)'], inactive:[C.red,'rgba(245,83,79,0.15)'], fortigate:[C.accent,'rgba(79,126,245,0.12)'], 'cisco-switch':[C.cyan,'rgba(34,211,238,0.1)'], 'cisco-router':[C.green,'rgba(34,211,160,0.1)'], other:[C.text3,'rgba(85,90,114,0.2)'], critical:[C.red,'rgba(245,83,79,0.15)'], high:[C.amber,'rgba(245,166,35,0.12)'], medium:[C.accent,'rgba(79,126,245,0.12)'], low:[C.green,'rgba(34,211,160,0.1)'] }
  const [fg, bg] = colors[label] || [C.text2,'var(--bg4)']
  return <span style={{ fontSize:10, padding:'2px 8px', borderRadius:20, fontFamily:'var(--mono)', fontWeight:500, color:fg, background:bg, border:`1px solid ${fg}40` }}>{label}</span>
}

export default function AdminPage() {
  const [tab, setTab]         = useState('devices')
  const [devices, setDevices] = useState([])
  const [sites, setSites]     = useState([])
  const [users, setUsers]     = useState([])
  const [alerts, setAlerts]   = useState([])
  const [modal, setModal]     = useState(null)
  const [form, setForm]       = useState({})
  const [loading, setLoading] = useState(false)

  const f = key => val => setForm(p => ({ ...p, [key]: val }))

  async function loadAll() {
    try {
      const [d, s, u, a] = await Promise.all([
        api.get('/api/devices'),
        api.get('/api/sites'),
        api.get('/api/users'),
        api.get('/api/alerts'),
      ])
      setDevices(d.data)
      setSites(s.data)
      setUsers(u.data)
      setAlerts(a.data)
    } catch(err) { console.error(err) }
  }

  useEffect(() => { loadAll() }, [])

  async function save() {
    setLoading(true)
    try {
      const { _type, _id, ...data } = form
      if (_id) {
        await api.put(`/api/${_type}/${_id}`, data)
        toast.success('Updated successfully')
      } else {
        await api.post(`/api/${_type}`, data)
        toast.success('Created successfully')
      }
      setModal(null)
      setForm({})
      loadAll()
    } catch(err) { toast.error(err.response?.data?.error || 'Save failed') }
    finally { setLoading(false) }
  }

  async function remove(type, id, name) {
    if (!confirm(`Delete ${name}?`)) return
    try {
      await api.delete(`/api/${type}/${id}`)
      toast.success('Deleted')
      loadAll()
    } catch(err) { toast.error('Delete failed') }
  }

  function openCreate(type) {
    const defaults = {
      devices: { _type:'devices', name:'', ip:'', type:'cisco-switch', site: sites[0]?._id||'', notes:'', tags:'' },
      sites:   { _type:'sites', name:'', location:'', description:'', timezone:'Asia/Kolkata' },
      users:   { _type:'users', name:'', email:'', password:'', role:'viewer' },
      alerts:  { _type:'alerts', name:'', description:'', type:'threshold', source:'all', severity:'medium', enabled:true },
    }
    setForm(defaults[type])
    setModal(`create-${type}`)
  }

  function openEdit(type, item) {
    setForm({ _type:type, _id:item._id, ...item, site: item.site?._id||item.site||'' })
    setModal(`edit-${type}`)
  }

  const TH = ({ children }) => (
    <th style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid var(--border)', color:C.text3, fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:0.5, fontFamily:'var(--mono)', whiteSpace:'nowrap' }}>{children}</th>
  )
  const TD = ({ children, color }) => (
    <td style={{ padding:'10px 12px', borderBottom:'1px solid rgba(99,120,200,0.07)', color:color||C.text2, fontSize:12, fontFamily:'var(--mono)' }}>{children}</td>
  )

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div style={{ display:'flex', gap:2, background:'var(--bg3)', borderRadius:10, padding:3 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:7,
              cursor:'pointer', border:'none', fontFamily:'var(--sans)',
              background: tab===t.id ? C.accent2 : 'transparent',
              color: tab===t.id ? '#fff' : C.text2,
              transition:'all 0.15s', display:'flex', alignItems:'center', gap:6,
            }}>{t.icon} {t.label}</button>
          ))}
        </div>
      </div>

      {/* -- DEVICES -- */}
      {tab==='devices' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{devices.length} devices registered</div>
            <Btn label="+ Add Device" color="accent" onClick={()=>openCreate('devices')} />
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">DEVICE MANAGER</span>
              <span className="badge badge-blue">{devices.length} devices</span>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr><TH>Device Name</TH><TH>IP Address</TH><TH>Type</TH><TH>Site</TH><TH>Status</TH><TH>Notes</TH><TH>Actions</TH></tr>
                </thead>
                <tbody>
                  {devices.map((d,i) => (
                    <tr key={i} onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'} onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                      <TD color={C.cyan}><strong>{d.name}</strong></TD>
                      <TD>{d.ip}</TD>
                      <TD><Badge label={d.type} /></TD>
                      <TD>{d.site?.name||d.site||'—'}</TD>
                      <TD><Badge label={d.status||'unknown'} /></TD>
                      <TD color={C.text3}>{d.notes?.slice(0,30)||'—'}</TD>
                      <td style={{ padding:'8px 12px', borderBottom:'1px solid rgba(99,120,200,0.07)' }}>
                        <div style={{ display:'flex', gap:6 }}>
                          <Btn label="Edit" small onClick={()=>openEdit('devices',d)} />
                          <Btn label="Delete" small danger onClick={()=>remove('devices',d._id,d.name)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {devices.length===0 && <tr><td colSpan={7} style={{ padding:30, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>No devices — click Add Device to get started</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -- SITES -- */}
      {tab==='sites' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{sites.length} sites configured</div>
            <Btn label="+ Add Site" onClick={()=>openCreate('sites')} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
            {sites.map((s,i) => (
              <div key={i} className="card" style={{ padding:0 }}>
                <div className="card-header">
                  <span className="card-title">{s.name}</span>
                  <Badge label={s.active ? 'active' : 'inactive'} />
                </div>
                <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:8 }}>
                  <div style={{ fontSize:12, color:C.text2, fontFamily:'var(--mono)' }}>?? {s.location||'No location set'}</div>
                  <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{s.description||'No description'}</div>
                  <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>?? {s.timezone||'UTC'}</div>
                  {s.ipRanges?.length > 0 && <div style={{ fontSize:11, color:C.accent, fontFamily:'var(--mono)' }}>?? {s.ipRanges.join(', ')}</div>}
                  <div style={{ display:'flex', gap:6, marginTop:4 }}>
                    <Btn label="Edit" small onClick={()=>openEdit('sites',s)} />
                    <Btn label="Delete" small danger onClick={()=>remove('sites',s._id,s.name)} />
                  </div>
                </div>
              </div>
            ))}
            {sites.length===0 && (
              <div style={{ gridColumn:'1/-1', padding:40, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>No sites configured</div>
            )}
          </div>
        </div>
      )}

      {/* -- USERS -- */}
      {tab==='users' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{users.length} users</div>
            <Btn label="+ Add User" onClick={()=>openCreate('users')} />
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">USER MANAGEMENT</span>
              <span className="badge badge-purple">{users.length} users</span>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr><TH>Name</TH><TH>Email</TH><TH>Role</TH><TH>Status</TH><TH>Last Login</TH><TH>Actions</TH></tr>
                </thead>
                <tbody>
                  {users.map((u,i) => (
                    <tr key={i} onMouseEnter={el=>el.currentTarget.style.background='var(--bg3)'} onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                      <TD color={C.text}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <div style={{ width:28, height:28, borderRadius:7, background:'var(--bg4)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:C.accent, fontWeight:600 }}>
                            {u.name?.charAt(0).toUpperCase()}
                          </div>
                          {u.name}
                        </div>
                      </TD>
                      <TD>{u.email}</TD>
                      <TD><Badge label={u.role} /></TD>
                      <TD><Badge label={u.active ? 'active' : 'inactive'} /></TD>
                      <TD color={C.text3}>{u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'}</TD>
                      <td style={{ padding:'8px 12px', borderBottom:'1px solid rgba(99,120,200,0.07)' }}>
                        <div style={{ display:'flex', gap:6 }}>
                          <Btn label="Edit" small onClick={()=>openEdit('users',u)} />
                          <Btn label="Delete" small danger onClick={()=>remove('users',u._id,u.name)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -- ALERT RULES -- */}
      {tab==='alerts' && (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{alerts.length} rules · {alerts.filter(a=>a.enabled).length} active</div>
            <Btn label="+ Add Rule" onClick={()=>openCreate('alerts')} />
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {alerts.map((a,i) => (
              <div key={i} className="card" style={{ padding:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px' }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', background: a.enabled ? C.green : C.text3, flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                      <span style={{ fontSize:13, fontWeight:600, color:C.text }}>{a.name}</span>
                      <Badge label={a.severity} />
                      <Badge label={a.type} />
                      <Badge label={a.source} />
                    </div>
                    <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{a.description||'No description'}</div>
                    {a.lastFired && <div style={{ fontSize:10, color:C.amber, fontFamily:'var(--mono)', marginTop:2 }}>Last fired: {new Date(a.lastFired).toLocaleString()}</div>}
                  </div>
                  <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                    <Btn label={a.enabled ? 'Disable' : 'Enable'} small color={a.enabled ? 'amber' : 'green'}
                      onClick={async()=>{ await api.put(`/api/alerts/${a._id}`, { enabled:!a.enabled }); loadAll() }} />
                    <Btn label="Edit" small onClick={()=>openEdit('alerts',a)} />
                    <Btn label="Delete" small danger onClick={()=>remove('alerts',a._id,a.name)} />
                  </div>
                </div>
              </div>
            ))}
            {alerts.length===0 && (
              <div style={{ padding:40, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>
                No alert rules configured. Add rules to get notified when thresholds are exceeded.
              </div>
            )}
          </div>
        </div>
      )}

      {/* -- SYSTEM -- */}
      {tab==='system' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">AI PROVIDER</span><span className="badge badge-purple">CONFIG</span></div>
            <div style={{ padding:'16px' }}>
              <div style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)', marginBottom:12 }}>Current provider — switch without restart</div>
              {['claude','openai','ollama'].map(p => (
                <div key={p} onClick={async()=>{ await api.post('/api/ai/provider',{provider:p}); toast.success(`Switched to ${p}`) }}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:8, cursor:'pointer', marginBottom:6, border:'1px solid var(--border)', background:'var(--bg3)' }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', background: p==='claude'?C.accent2:p==='openai'?C.green:C.amber }} />
                  <span style={{ fontSize:12, color:C.text, fontFamily:'var(--mono)', fontWeight:600 }}>{p}</span>
                  <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>
                    {p==='claude'?'Anthropic Claude — best for analysis':p==='openai'?'OpenAI GPT-4o — fast and capable':'Local Ollama — private, no API cost'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">ELASTICSEARCH</span><span className="badge badge-green">CONNECTION</span></div>
            <div style={{ padding:'16px', display:'flex', flexDirection:'column', gap:10 }}>
              {[
                { label:'Host', value: import.meta.env.VITE_API_URL || 'http://localhost:5000' },
                { label:'Firewall Index', value:'firewall-*' },
                { label:'Cisco Index', value:'cisco-*' },
                { label:'Status', value:'Connected' },
              ].map((item,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{item.label}</span>
                  <span style={{ fontSize:11, color: item.label==='Status' ? C.green : C.cyan, fontFamily:'var(--mono)', fontWeight:600 }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">QUICK STATS</span><span className="badge badge-blue">SYSTEM</span></div>
            <div style={{ padding:'16px', display:'flex', flexDirection:'column', gap:8 }}>
              {[
                { label:'Total Devices', value: devices.length, color: C.accent },
                { label:'Total Sites', value: sites.length, color: C.cyan },
                { label:'Total Users', value: users.length, color: C.accent2 },
                { label:'Alert Rules', value: alerts.length, color: C.amber },
                { label:'Active Rules', value: alerts.filter(a=>a.enabled).length, color: C.green },
              ].map((item,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:12, color:C.text2, fontFamily:'var(--mono)' }}>{item.label}</span>
                  <span style={{ fontSize:16, fontWeight:700, color:item.color, fontFamily:'var(--mono)' }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">NETPULSE INFO</span><span className="badge badge-blue">v1.0.0</span></div>
            <div style={{ padding:'16px', display:'flex', flexDirection:'column', gap:10 }}>
              {[
                { label:'Version', value:'1.0.0' },
                { label:'License', value:'MIT Open Source' },
                { label:'GitHub', value:'Sunil123456789/netpulse' },
                { label:'Node.js', value:'22.x' },
                { label:'React', value:'18.x' },
                { label:'Elasticsearch', value:'9.2.2' },
              ].map((item,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:11, color:C.text3, fontFamily:'var(--mono)' }}>{item.label}</span>
                  <span style={{ fontSize:11, color:C.text2, fontFamily:'var(--mono)' }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* -- MODALS -- */}
      {modal?.includes('devices') && (
        <Modal title={modal.includes('create') ? 'Add Device' : 'Edit Device'} onClose={()=>setModal(null)}>
          <Field label="Device Name" value={form.name||''} onChange={f('name')} required />
          <Field label="IP Address" value={form.ip||''} onChange={f('ip')} required />
          <Field label="Type" value={form.type||'cisco-switch'} onChange={f('type')} options={[
            {value:'fortigate',label:'FortiGate Firewall'},
            {value:'cisco-switch',label:'Cisco Switch'},
            {value:'cisco-router',label:'Cisco Router'},
            {value:'other',label:'Other'},
          ]} />
          <Field label="Site" value={form.site||''} onChange={f('site')} options={[
            {value:'',label:'-- Select Site --'},
            ...sites.map(s=>({value:s._id,label:s.name}))
          ]} />
          <Field label="Status" value={form.status||'unknown'} onChange={f('status')} options={[
            {value:'online',label:'Online'},
            {value:'offline',label:'Offline'},
            {value:'unknown',label:'Unknown'},
          ]} />
          <Field label="Notes" value={form.notes||''} onChange={f('notes')} />
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
            <button onClick={()=>setModal(null)} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid var(--border)', background:'transparent', color:C.text2, cursor:'pointer', fontSize:12 }}>Cancel</button>
            <Btn label={loading ? 'Saving...' : 'Save Device'} onClick={save} />
          </div>
        </Modal>
      )}

      {modal?.includes('sites') && (
        <Modal title={modal.includes('create') ? 'Add Site' : 'Edit Site'} onClose={()=>setModal(null)}>
          <Field label="Site Name" value={form.name||''} onChange={f('name')} required />
          <Field label="Location" value={form.location||''} onChange={f('location')} />
          <Field label="Description" value={form.description||''} onChange={f('description')} />
          <Field label="Timezone" value={form.timezone||'Asia/Kolkata'} onChange={f('timezone')} options={[
            {value:'Asia/Kolkata',label:'Asia/Kolkata (IST)'},
            {value:'UTC',label:'UTC'},
            {value:'America/New_York',label:'America/New_York'},
            {value:'Europe/London',label:'Europe/London'},
          ]} />
          <Field label="Active" value={form.active?.toString()||'true'} onChange={v=>f('active')(v==='true')} options={[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]} />
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
            <button onClick={()=>setModal(null)} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid var(--border)', background:'transparent', color:C.text2, cursor:'pointer', fontSize:12 }}>Cancel</button>
            <Btn label={loading ? 'Saving...' : 'Save Site'} onClick={save} />
          </div>
        </Modal>
      )}

      {modal?.includes('users') && (
        <Modal title={modal.includes('create') ? 'Add User' : 'Edit User'} onClose={()=>setModal(null)}>
          <Field label="Full Name" value={form.name||''} onChange={f('name')} required />
          <Field label="Email" value={form.email||''} onChange={f('email')} type="email" required />
          {modal.includes('create') && <Field label="Password" value={form.password||''} onChange={f('password')} type="password" required />}
          <Field label="Role" value={form.role||'viewer'} onChange={f('role')} options={[
            {value:'admin',label:'Admin — full access'},
            {value:'analyst',label:'Analyst — can create tickets'},
            {value:'viewer',label:'Viewer — read only'},
          ]} />
          <Field label="Active" value={form.active?.toString()||'true'} onChange={v=>f('active')(v==='true')} options={[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]} />
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
            <button onClick={()=>setModal(null)} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid var(--border)', background:'transparent', color:C.text2, cursor:'pointer', fontSize:12 }}>Cancel</button>
            <Btn label={loading ? 'Saving...' : 'Save User'} onClick={save} />
          </div>
        </Modal>
      )}

      {modal?.includes('alerts') && (
        <Modal title={modal.includes('create') ? 'Add Alert Rule' : 'Edit Alert Rule'} onClose={()=>setModal(null)}>
          <Field label="Rule Name" value={form.name||''} onChange={f('name')} required />
          <Field label="Description" value={form.description||''} onChange={f('description')} />
          <Field label="Type" value={form.type||'threshold'} onChange={f('type')} options={[
            {value:'threshold',label:'Threshold — count exceeds value'},
            {value:'anomaly',label:'Anomaly — AI detected deviation'},
            {value:'pattern',label:'Pattern — regex/keyword match'},
          ]} />
          <Field label="Source" value={form.source||'all'} onChange={f('source')} options={[
            {value:'all',label:'All sources'},
            {value:'fortigate',label:'FortiGate only'},
            {value:'cisco',label:'Cisco only'},
          ]} />
          <Field label="Severity" value={form.severity||'medium'} onChange={f('severity')} options={[
            {value:'critical',label:'Critical'},
            {value:'high',label:'High'},
            {value:'medium',label:'Medium'},
            {value:'low',label:'Low'},
          ]} />
          <Field label="Enabled" value={form.enabled?.toString()||'true'} onChange={v=>f('enabled')(v==='true')} options={[{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}]} />
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
            <button onClick={()=>setModal(null)} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid var(--border)', background:'transparent', color:C.text2, cursor:'pointer', fontSize:12 }}>Cancel</button>
            <Btn label={loading ? 'Saving...' : 'Save Rule'} onClick={save} />
          </div>
        </Modal>
      )}

    </div>
  )
}

import { useEffect, useState } from 'react'
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../../components/ui/ResizableTable.jsx'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { APP_PAGE_KEYS, APP_PAGES } from '../../config/appPages'
import { getEffectiveAllowedPages } from '../../utils/pageAccess'
import { resolvedApiBase } from '../../utils/backendOrigin.js'

const C = {
  accent: 'var(--accent)',
  accent2: 'var(--accent2)',
  green: 'var(--green)',
  red: 'var(--red)',
  amber: 'var(--amber)',
  cyan: 'var(--cyan)',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
}

const TABS = [
  { id:'devices',  label:'Devices',     icon:'🖥', desc:'Firewalls & switches' },
  { id:'sites',    label:'Sites',       icon:'🏢', desc:'Locations & IP ranges' },
  { id:'users',    label:'Users',       icon:'👥', desc:'Roles & page access' },
  { id:'alerts',   label:'Alert Rules', icon:'🔔', desc:'Thresholds & patterns' },
  { id:'system',   label:'System',      icon:'⚙️', desc:'AI, search, stats' },
]

function Modal({ title, onClose, children }) {
  return (
    <div
      role="presentation"
      style={{
        position:'fixed', inset:0, background:'rgba(6,8,14,0.65)', backdropFilter:'blur(10px)',
        display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:20,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
        style={{
          background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:16, padding:28, width:500, maxWidth:'100%',
          maxHeight:'85vh', overflowY:'auto', boxShadow:'0 24px 64px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:22, gap:16 }}>
          <div style={{ fontSize:17, fontWeight:700, color:'var(--text)', fontFamily:'var(--sans)', letterSpacing:-0.02 }}>{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              flexShrink:0, width:36, height:36, borderRadius:10, border:'1px solid var(--border)', background:'var(--bg3)',
              color:'var(--text2)', cursor:'pointer', fontSize:20, lineHeight:1, display:'flex', alignItems:'center', justifyContent:'center',
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const inputStyle = {
  width:'100%', padding:'10px 14px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:10,
  color:'var(--text)', fontSize:13, fontFamily:'var(--mono)', outline:'none', transition:'border-color 0.15s, box-shadow 0.15s',
}

function Field({ label, value, onChange, type='text', options, required }) {
  return (
    <div style={{ marginBottom:16 }}>
      <label style={{ fontSize:10, fontWeight:600, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase', fontFamily:'var(--mono)', display:'block', marginBottom:6 }}>{label}{required && ' *'}</label>
      {options
        ? <select value={value} onChange={e=>onChange(e.target.value)} style={{ ...inputStyle, cursor:'pointer' }}>
            {options.map(o => <option key={o.value||o} value={o.value||o}>{o.label||o}</option>)}
          </select>
        : <input type={type} value={value} onChange={e=>onChange(e.target.value)} required={required} style={inputStyle} />
      }
    </div>
  )
}

function Btn({ label, color='accent', onClick, small, danger, title, variant }) {
  if (variant === 'ghost') {
    return (
      <button type="button" title={title} onClick={onClick} style={{
        padding: small ? '6px 12px' : '10px 18px', borderRadius:10, border:'1px solid var(--border)', background:'transparent',
        color:'var(--text2)', fontSize: small ? 11 : 13, fontWeight:600, fontFamily:'var(--sans)', cursor:'pointer',
      }}>{label}</button>
    )
  }
  const bg = danger ? C.red : color==='green' ? C.green : color==='amber' ? C.amber : `linear-gradient(135deg, ${C.accent}, ${C.accent2})`
  const solidFg = danger || color === 'accent' || color === 'green' || color === 'amber' ? 'var(--on-accent)' : 'var(--text)'
  return (
    <button type="button" title={title} onClick={onClick} style={{
      padding: small ? '6px 12px' : '10px 18px',
      borderRadius:10, border:'none', background:bg, color: solidFg,
      fontSize: small ? 11 : 13, fontWeight:600, fontFamily:'var(--sans)', cursor:'pointer',
      boxShadow: danger ? 'none' : color==='accent' ? '0 4px 20px rgba(79,126,245,0.25)' : 'none',
    }}>{label}</button>
  )
}

function Badge({ label, color }) {
  const colors = { admin:[C.red,'rgba(245,83,79,0.15)'], analyst:[C.amber,'rgba(245,166,35,0.12)'], viewer:[C.text3,'rgba(85,90,114,0.2)'], active:[C.green,'rgba(34,211,160,0.1)'], inactive:[C.red,'rgba(245,83,79,0.15)'], fortigate:[C.accent,'rgba(79,126,245,0.12)'], 'cisco-switch':[C.cyan,'rgba(34,211,238,0.1)'], 'cisco-router':[C.green,'rgba(34,211,160,0.1)'], other:[C.text3,'rgba(85,90,114,0.2)'], critical:[C.red,'rgba(245,83,79,0.15)'], high:[C.amber,'rgba(245,166,35,0.12)'], medium:[C.accent,'rgba(79,126,245,0.12)'], low:[C.green,'rgba(34,211,160,0.1)'] }
  const [fg, bg] = colors[label] || [C.text2,'var(--bg4)']
  return <span style={{ fontSize:10, padding:'3px 10px', borderRadius:999, fontFamily:'var(--mono)', fontWeight:600, color:fg, background:bg, border:'1px solid var(--border)' }}>{label}</span>
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

  const ADMIN_DEVICE_COLS = [160, 130, 100, 140, 88, 200, 128]
  const ADMIN_USER_COLS = [200, 220, 88, 220, 88, 180, 220]
  const deviceResize = useResizableColumns('admin-devices', ADMIN_DEVICE_COLS)
  const userResize = useResizableColumns('admin-users', ADMIN_USER_COLS)
  const adminTh = {
    padding: '12px 14px',
    textAlign: 'left',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text3)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: 'var(--mono)',
    whiteSpace: 'nowrap',
    background: 'var(--bg3)',
  }

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
      let payload = data
      if (_type === 'users') {
        payload = {
          name: data.name,
          email: data.email,
          role: data.role,
          active: data.active,
        }
        if (data.password) payload.password = data.password
        if (data.role !== 'admin' && Array.isArray(data.allowedPages)) payload.allowedPages = data.allowedPages
      }
      if (_id) {
        await api.put(`/api/${_type}/${_id}`, payload)
        toast.success('Updated successfully')
      } else {
        await api.post(`/api/${_type}`, payload)
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

  function openResetPassword(user) {
    setForm({
      _pwdResetFor: user._id,
      _pwdResetName: user.name || '',
      _pwdResetEmail: user.email || '',
      newPassword: '',
      confirmPassword: '',
    })
    setModal('reset-password')
  }

  async function savePasswordReset() {
    const pw = (form.newPassword || '').trim()
    const cf = (form.confirmPassword || '').trim()
    if (pw.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    if (pw !== cf) {
      toast.error('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      await api.put(`/api/users/${form._pwdResetFor}`, { password: pw })
      toast.success('Password updated')
      setModal(null)
      setForm({})
      loadAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reset password')
    } finally {
      setLoading(false)
    }
  }

  function openCreate(type) {
    const defaults = {
      devices: { _type:'devices', name:'', ip:'', type:'cisco-switch', site: sites[0]?._id||'', notes:'', tags:'' },
      sites:   { _type:'sites', name:'', location:'', description:'', timezone:'Asia/Kolkata' },
      users:   { _type:'users', name:'', email:'', password:'', role:'viewer', allowedPages: [...APP_PAGE_KEYS] },
      alerts:  { _type:'alerts', name:'', description:'', type:'threshold', source:'all', severity:'medium', enabled:true },
    }
    setForm(defaults[type])
    setModal(`create-${type}`)
  }

  function openEdit(type, item) {
    const base = { _type:type, _id:item._id, ...item, site: item.site?._id||item.site||'' }
    if (type === 'users') {
      const pages =
        item.role === 'admin'
          ? [...APP_PAGE_KEYS]
          : Array.isArray(item.allowedPages)
            ? item.allowedPages
            : [...APP_PAGE_KEYS]
      base.allowedPages = pages
    }
    setForm(base)
    setModal(`edit-${type}`)
  }

  const toggleUserPage = (key) => {
    setForm((f) => {
      if (f._type !== 'users') return f
      const cur = Array.isArray(f.allowedPages) ? f.allowedPages : [...APP_PAGE_KEYS]
      const allowedPages = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
      return { ...f, allowedPages }
    })
  }

  const setAllUserPages = (all) => {
    setForm((f) => (f._type === 'users' ? { ...f, allowedPages: all ? [...APP_PAGE_KEYS] : [] } : f))
  }

  const TD = ({ children, color }) => (
    <td style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', color:color||'var(--text2)', fontSize:12, fontFamily:'var(--mono)', overflow:'hidden', textOverflow:'ellipsis', verticalAlign:'middle' }}>{children}</td>
  )

  const activeTabMeta = TABS.find(x => x.id === tab)

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0, maxWidth:1400, margin:'0 auto', width:'100%', animation:'fadeIn 0.35s ease' }}>

      <div style={{ marginBottom:22 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
          <div style={{ width:4, height:36, borderRadius:4, background:`linear-gradient(180deg, ${C.accent}, ${C.accent2})` }} />
          <div>
            <h1 style={{ margin:0, fontSize:24, fontWeight:800, color:'var(--text)', fontFamily:'var(--sans)', letterSpacing:-0.03 }}>Administration</h1>
            <p style={{ margin:'6px 0 0', fontSize:13, color:'var(--text3)', fontFamily:'var(--mono)' }}>Configure inventory, access, alerting, and platform integrations.</p>
          </div>
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:8, padding:6, background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:14 }}>
          {TABS.map(t => {
            const on = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={{
                  display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderRadius:10, cursor:'pointer', border:'1px solid',
                  borderColor: on ? 'transparent' : 'transparent', fontFamily:'var(--sans)', textAlign:'left',
                  background: on ? `linear-gradient(135deg, ${C.accent}, ${C.accent2})` : 'var(--bg3)',
                  color: on ? 'var(--on-accent)' : 'var(--text2)',
                  boxShadow: on ? '0 6px 28px rgba(79,126,245,0.28)' : 'none',
                  transition:'all 0.18s ease',
                }}
              >
                <span style={{ fontSize:18, lineHeight:1 }}>{t.icon}</span>
                <span>
                  <span style={{ display:'block', fontSize:13, fontWeight:700 }}>{t.label}</span>
                  <span style={{ display:'block', fontSize:10, fontFamily:'var(--mono)', opacity: on ? 0.95 : 0.75, marginTop:2 }}>{t.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
        {activeTabMeta && (
          <p style={{ margin:'14px 0 0', fontSize:12, color:'var(--text3)', fontFamily:'var(--mono)' }}>
            <span style={{ color:'var(--accent)' }}>●</span> {activeTabMeta.desc}
          </p>
        )}
      </div>

      {/* -- DEVICES -- */}
      {tab==='devices' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:14, padding:'16px 20px', background:'linear-gradient(165deg, var(--bg3), var(--bg2))', border:'1px solid var(--border)', borderRadius:14 }}>
            <div>
              <div style={{ fontSize:11, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.8 }}>Inventory</div>
              <div style={{ fontSize:20, fontWeight:700, color:'var(--text)', fontFamily:'var(--sans)', marginTop:4 }}>{devices.length} <span style={{ fontSize:13, fontWeight:500, color:'var(--text3)' }}>devices</span></div>
            </div>
            <Btn label="+ Add device" color="accent" onClick={()=>openCreate('devices')} />
          </div>
          <div className="card" style={{ borderRadius:14, overflow:'hidden', border:'1px solid var(--border)', boxShadow:'0 8px 32px rgba(0,0,0,0.12)' }}>
            <div className="card-header" style={{ background:'var(--bg3)' }}>
              <span className="card-title">Device manager</span>
              <span className="badge badge-blue">{devices.length} total</span>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', tableLayout:'fixed', minWidth: deviceResize.sumWidth }}>
                <ResizableColGroup widths={deviceResize.widths} />
                <thead>
                  <tr>
                    {['Device Name', 'IP Address', 'Type', 'Site', 'Status', 'Notes', 'Actions'].map((label, i) => (
                      <ResizableTh key={label} columnIndex={i} columnCount={7} startResize={deviceResize.startResize} style={adminTh}>
                        {label}
                      </ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d,i) => (
                    <tr
                      key={i}
                      style={{ background: i % 2 ? 'var(--bg3)' : 'transparent', transition:'background 0.15s' }}
                      onMouseEnter={el => { el.currentTarget.style.background = 'var(--bg3)' }}
                      onMouseLeave={el => { el.currentTarget.style.background = i % 2 ? 'var(--bg3)' : 'transparent' }}
                    >
                      <TD color="var(--cyan)"><strong style={{ color:'var(--text)' }}>{d.name}</strong></TD>
                      <TD>{d.ip}</TD>
                      <TD><Badge label={d.type} /></TD>
                      <TD>{d.site?.name||d.site||'—'}</TD>
                      <TD><Badge label={d.status||'unknown'} /></TD>
                      <TD color="var(--text3)">{d.notes?.slice(0,30)||'—'}</TD>
                      <td style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', verticalAlign:'middle' }}>
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                          <Btn label="Edit" small onClick={()=>openEdit('devices',d)} />
                          <Btn label="Delete" small danger onClick={()=>remove('devices',d._id,d.name)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {devices.length===0 && <tr><td colSpan={7} style={{ padding:48, textAlign:'center', color:'var(--text3)', fontFamily:'var(--mono)', fontSize:13 }}>No devices yet. Add your first firewall or switch to get started.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -- SITES -- */}
      {tab==='sites' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:14, padding:'16px 20px', background:'linear-gradient(165deg, var(--bg3), var(--bg2))', border:'1px solid var(--border)', borderRadius:14 }}>
            <div>
              <div style={{ fontSize:11, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.8 }}>Locations</div>
              <div style={{ fontSize:20, fontWeight:700, color:'var(--text)', fontFamily:'var(--sans)', marginTop:4 }}>{sites.length} <span style={{ fontSize:13, fontWeight:500, color:'var(--text3)' }}>sites</span></div>
            </div>
            <Btn label="+ Add site" onClick={()=>openCreate('sites')} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:16 }}>
            {sites.map((s,i) => (
              <div
                key={i}
                className="card"
                style={{
                  padding:0, borderRadius:14, overflow:'hidden', border:'1px solid var(--border)',
                  transition:'transform 0.2s ease, box-shadow 0.2s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 12px 40px rgba(0,0,0,0.18)' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none' }}
              >
                <div className="card-header" style={{ background:'var(--bg3)' }}>
                  <span className="card-title">{s.name}</span>
                  <Badge label={s.active ? 'active' : 'inactive'} />
                </div>
                <div style={{ padding:'18px 18px 16px', display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ fontSize:13, color:'var(--text2)', fontFamily:'var(--mono)', lineHeight:1.5 }}>
                    <span style={{ opacity:0.85 }}>📍</span> {s.location||'No location set'}
                  </div>
                  <div style={{ fontSize:12, color:'var(--text3)', fontFamily:'var(--mono)', lineHeight:1.45 }}>
                    <span style={{ opacity:0.85 }}>📝</span> {s.description||'No description'}
                  </div>
                  <div style={{ fontSize:12, color:'var(--text3)', fontFamily:'var(--mono)' }}>
                    <span style={{ opacity:0.85 }}>🕐</span> {s.timezone||'UTC'}
                  </div>
                  {s.ipRanges?.length > 0 && (
                    <div style={{ fontSize:12, color:'var(--accent)', fontFamily:'var(--mono)', padding:'8px 10px', background:'var(--bg3)', borderRadius:8, border:'1px solid var(--border)' }}>
                      🌐 {s.ipRanges.join(', ')}
                    </div>
                  )}
                  <div style={{ display:'flex', gap:8, marginTop:8, paddingTop:14, borderTop:'1px solid var(--border)' }}>
                    <Btn label="Edit" small onClick={()=>openEdit('sites',s)} />
                    <Btn label="Delete" small danger onClick={()=>remove('sites',s._id,s.name)} />
                  </div>
                </div>
              </div>
            ))}
            {sites.length===0 && (
              <div style={{ gridColumn:'1/-1', padding:56, textAlign:'center', color:'var(--text3)', fontFamily:'var(--mono)', fontSize:13, background:'var(--bg2)', border:'1px dashed var(--border)', borderRadius:14 }}>
                No sites yet. Create a site to group devices and IP ranges.
              </div>
            )}
          </div>
        </div>
      )}

      {/* -- USERS -- */}
      {tab==='users' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:14, padding:'16px 20px', background:'linear-gradient(165deg, var(--bg3), var(--bg2))', border:'1px solid var(--border)', borderRadius:14 }}>
            <div>
              <div style={{ fontSize:11, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.8 }}>Access control</div>
              <div style={{ fontSize:20, fontWeight:700, color:'var(--text)', fontFamily:'var(--sans)', marginTop:4 }}>{users.length} <span style={{ fontSize:13, fontWeight:500, color:'var(--text3)' }}>users</span></div>
            </div>
            <Btn label="+ Add user" onClick={()=>openCreate('users')} />
          </div>
          <div className="card" style={{ borderRadius:14, overflow:'hidden', border:'1px solid var(--border)', boxShadow:'0 8px 32px rgba(0,0,0,0.12)' }}>
            <div className="card-header" style={{ background:'var(--bg3)' }}>
              <span className="card-title">User management</span>
              <span className="badge badge-purple">{users.length} accounts</span>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', tableLayout:'fixed', minWidth: userResize.sumWidth }}>
                <ResizableColGroup widths={userResize.widths} />
                <thead>
                  <tr>
                    {['Name', 'Email', 'Role', 'Pages', 'Status', 'Last Login', 'Actions'].map((label, i) => (
                      <ResizableTh key={label} columnIndex={i} columnCount={7} startResize={userResize.startResize} style={adminTh}>
                        {label}
                      </ResizableTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u,i) => (
                    <tr
                      key={i}
                      style={{ background: i % 2 ? 'var(--bg3)' : 'transparent', transition:'background 0.15s' }}
                      onMouseEnter={el => { el.currentTarget.style.background = 'var(--bg3)' }}
                      onMouseLeave={el => { el.currentTarget.style.background = i % 2 ? 'var(--bg3)' : 'transparent' }}
                    >
                      <TD color="var(--text)">
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <div style={{
                            width:36, height:36, borderRadius:10,
                            background:`linear-gradient(135deg, ${C.accent}, ${C.accent2})`,
                            display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, color:'var(--on-accent)', fontWeight:700, flexShrink:0,
                          }}>
                            {u.name?.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontWeight:600 }}>{u.name}</span>
                        </div>
                      </TD>
                      <TD>{u.email}</TD>
                      <TD><Badge label={u.role} /></TD>
                      <TD color="var(--text3)">
                        {u.role === 'admin'
                          ? 'All'
                          : !Array.isArray(u.allowedPages)
                            ? 'All (default)'
                            : u.allowedPages.length === 0
                              ? 'None'
                              : `${u.allowedPages.length}: ${u.allowedPages.join(', ')}`}
                      </TD>
                      <TD><Badge label={u.active ? 'active' : 'inactive'} /></TD>
                      <TD color="var(--text3)">{u.lastLogin ? new Date(u.lastLogin).toLocaleString('en', { timeZoneName:'short' }) : 'Never'}</TD>
                      <td style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', verticalAlign:'middle' }}>
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                          <Btn label="Edit" small onClick={()=>openEdit('users',u)} />
                          <Btn label="Password" small color="amber" title="Set a new password for this user" onClick={()=>openResetPassword(u)} />
                          <Btn label="Delete" small danger onClick={()=>remove('users',u._id,u.name)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding:48, textAlign:'center', color:'var(--text3)', fontFamily:'var(--mono)', fontSize:13 }}>
                        No users yet. Invite teammates with the right roles and page access.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* -- ALERT RULES -- */}
      {tab==='alerts' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:14, padding:'16px 20px', background:'linear-gradient(165deg, var(--bg3), var(--bg2))', border:'1px solid var(--border)', borderRadius:14 }}>
            <div>
              <div style={{ fontSize:11, fontFamily:'var(--mono)', color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.8 }}>Automation</div>
              <div style={{ fontSize:20, fontWeight:700, color:'var(--text)', fontFamily:'var(--sans)', marginTop:4 }}>
                {alerts.length} <span style={{ fontSize:13, fontWeight:500, color:'var(--text3)' }}>rules</span>
                <span style={{ margin:'0 8px', color:'var(--border)' }}>|</span>
                <span style={{ fontSize:13, color:'var(--green)', fontFamily:'var(--mono)' }}>{alerts.filter(a=>a.enabled).length} active</span>
              </div>
            </div>
            <Btn label="+ Add rule" onClick={()=>openCreate('alerts')} />
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            {alerts.map((a,i) => {
              const sev = String(a.severity || '').toLowerCase()
              const bar = sev === 'critical' ? 'var(--red)' : sev === 'high' ? 'var(--amber)' : sev === 'medium' ? 'var(--accent)' : sev === 'low' ? 'var(--green)' : 'var(--text3)'
              return (
                <div
                  key={i}
                  className="card"
                  style={{
                    padding:0, borderRadius:14, overflow:'hidden', border:'1px solid var(--border)',
                    borderLeft:`3px solid ${bar}`, boxShadow:'0 4px 24px rgba(0,0,0,0.08)',
                    transition:'transform 0.18s ease, box-shadow 0.18s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 10px 36px rgba(0,0,0,0.14)' }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 24px rgba(0,0,0,0.08)' }}
                >
                  <div style={{ display:'flex', alignItems:'flex-start', gap:16, padding:'18px 20px', flexWrap:'wrap' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:120 }}>
                      <div style={{
                        width:10, height:10, borderRadius:'50%',
                        background: a.enabled ? 'var(--green)' : 'var(--text3)',
                        boxShadow: a.enabled ? '0 0 12px rgba(34,211,160,0.45)' : 'none',
                        flexShrink:0,
                      }} />
                      <span style={{ fontSize:10, fontFamily:'var(--mono)', fontWeight:600, color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.6 }}>
                        {a.enabled ? 'Enabled' : 'Off'}
                      </span>
                    </div>
                    <div style={{ flex:1, minWidth:220 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' }}>
                        <span style={{ fontSize:15, fontWeight:700, color:'var(--text)', fontFamily:'var(--sans)' }}>{a.name}</span>
                        <Badge label={a.severity} />
                        <Badge label={a.type} />
                        <Badge label={a.source} />
                      </div>
                      <div style={{ fontSize:12, color:'var(--text3)', fontFamily:'var(--mono)', lineHeight:1.5 }}>{a.description||'No description'}</div>
                      {a.lastFired && (
                        <div style={{ fontSize:11, color:'var(--amber)', fontFamily:'var(--mono)', marginTop:8 }}>
                          Last fired: {new Date(a.lastFired).toLocaleString('en', { timeZoneName:'short' })}
                        </div>
                      )}
                    </div>
                    <div style={{ display:'flex', gap:8, flexShrink:0, flexWrap:'wrap' }}>
                      <Btn
                        label={a.enabled ? 'Disable' : 'Enable'}
                        small
                        color={a.enabled ? 'amber' : 'green'}
                        onClick={async () => { await api.put(`/api/alerts/${a._id}`, { enabled: !a.enabled }); loadAll() }}
                      />
                      <Btn label="Edit" small onClick={() => openEdit('alerts', a)} />
                      <Btn label="Delete" small danger onClick={() => remove('alerts', a._id, a.name)} />
                    </div>
                  </div>
                </div>
              )
            })}
            {alerts.length===0 && (
              <div style={{ padding:56, textAlign:'center', color:'var(--text3)', fontFamily:'var(--mono)', fontSize:13, background:'var(--bg2)', border:'1px dashed var(--border)', borderRadius:14 }}>
                No alert rules yet. Add rules to get notified when thresholds or patterns match.
              </div>
            )}
          </div>
        </div>
      )}

      {/* -- SYSTEM -- */}
      {tab==='system' && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:16 }}>
          <div className="card" style={{ borderRadius:14, border:'1px solid var(--border)', overflow:'hidden' }}>
            <div className="card-header" style={{ background:'var(--bg3)' }}><span className="card-title">AI provider</span><span className="badge badge-purple">Config</span></div>
            <div style={{ padding:18 }}>
              <div style={{ fontSize:12, color:'var(--text3)', fontFamily:'var(--mono)', marginBottom:14, lineHeight:1.5 }}>Switch model backend without restarting the server.</div>
              {['claude','openai','ollama'].map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={async () => { await api.post('/api/ai/provider',{ provider:p }); toast.success(`Switched to ${p}`) }}
                  style={{
                    display:'flex', alignItems:'center', gap:12, width:'100%', textAlign:'left',
                    padding:'12px 14px', borderRadius:10, cursor:'pointer', marginBottom:8,
                    border:'1px solid var(--border)', background:'var(--bg3)', color:'inherit',
                    transition:'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg4)'; e.currentTarget.style.borderColor = 'var(--accent)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg3)'; e.currentTarget.style.borderColor = 'var(--border)' }}
                >
                  <div style={{ width:10, height:10, borderRadius:'50%', flexShrink:0, background: p==='claude'?'var(--accent2)':p==='openai'?'var(--green)':'var(--amber)' }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color:'var(--text)', fontFamily:'var(--mono)', fontWeight:700 }}>{p}</div>
                    <div style={{ fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)', marginTop:4 }}>
                      {p==='claude' && 'Anthropic Claude — strong for analysis'}
                      {p==='openai' && 'OpenAI GPT — fast, capable'}
                      {p==='ollama' && 'Local Ollama — private, no API cost'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="card" style={{ borderRadius:14, border:'1px solid var(--border)', overflow:'hidden' }}>
            <div className="card-header" style={{ background:'var(--bg3)' }}><span className="card-title">Elasticsearch</span><span className="badge badge-green">Connection</span></div>
            <div style={{ padding:18, display:'flex', flexDirection:'column', gap:4 }}>
              {[
                { label:'API / host', value: resolvedApiBase() || 'same-origin (Vite / nginx proxy)' },
                { label:'Firewall index', value:'firewall-*' },
                { label:'Cisco index', value:'cisco-*' },
                { label:'Status', value:'Connected' },
              ].map((item,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)' }}>{item.label}</span>
                  <span style={{ fontSize:11, color: item.label==='Status' ? 'var(--green)' : 'var(--cyan)', fontFamily:'var(--mono)', fontWeight:600, textAlign:'right', maxWidth:'58%', wordBreak:'break-all' }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ borderRadius:14, border:'1px solid var(--border)', overflow:'hidden' }}>
            <div className="card-header" style={{ background:'var(--bg3)' }}><span className="card-title">Quick stats</span><span className="badge badge-blue">Live</span></div>
            <div style={{ padding:18, display:'grid', gap:12 }}>
              {[
                { label:'Devices', value: devices.length, c:'var(--accent)' },
                { label:'Sites', value: sites.length, c:'var(--cyan)' },
                { label:'Users', value: users.length, c:'var(--accent2)' },
                { label:'Alert rules', value: alerts.length, c:'var(--amber)' },
                { label:'Active rules', value: alerts.filter(a=>a.enabled).length, c:'var(--green)' },
              ].map((item,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--border)' }}>
                  <span style={{ fontSize:12, color:'var(--text2)', fontFamily:'var(--mono)' }}>{item.label}</span>
                  <span style={{ fontSize:20, fontWeight:800, color:item.c, fontFamily:'var(--mono)' }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ borderRadius:14, border:'1px solid var(--border)', overflow:'hidden' }}>
            <div className="card-header" style={{ background:'var(--bg3)' }}><span className="card-title">Platform</span><span className="badge badge-blue">v1.0.0</span></div>
            <div style={{ padding:18, display:'flex', flexDirection:'column', gap:4 }}>
              {[
                { label:'Version', value:'1.0.0' },
                { label:'License', value:'Lenskart Security Team' },
                { label:'GitHub', value:'Sunil123456789/netpulse' },
                { label:'Node.js', value:'22.x' },
                { label:'React', value:'18.x' },
                { label:'Elasticsearch', value:'9.2.2' },
              ].map((item,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)' }}>{item.label}</span>
                  <span style={{ fontSize:11, color:'var(--text2)', fontFamily:'var(--mono)', textAlign:'right', maxWidth:'55%' }}>{item.value}</span>
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
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22, paddingTop:18, borderTop:'1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={()=>setModal(null)} />
            <Btn label={loading ? 'Saving...' : 'Save device'} onClick={save} />
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
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22, paddingTop:18, borderTop:'1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={()=>setModal(null)} />
            <Btn label={loading ? 'Saving...' : 'Save site'} onClick={save} />
          </div>
        </Modal>
      )}

      {modal?.includes('users') && (
        <Modal title={modal.includes('create') ? 'Add User' : 'Edit User'} onClose={()=>setModal(null)}>
          <Field label="Full Name" value={form.name||''} onChange={f('name')} required />
          <Field label="Email" value={form.email||''} onChange={f('email')} type="email" required />
          {modal.includes('create') && <Field label="Password" value={form.password||''} onChange={f('password')} type="password" required />}
          <Field label="Role" value={form.role||'viewer'} onChange={(v) => {
            f('role')(v)
            if (v === 'admin') setForm((p) => ({ ...p, role: v, allowedPages: [...APP_PAGE_KEYS] }))
          }} options={[
            {value:'admin',label:'Admin — full access'},
            {value:'analyst',label:'Analyst — can create tickets'},
            {value:'viewer',label:'Viewer — read only'},
          ]} />
          {form.role === 'admin' ? (
            <div style={{ marginBottom: 14, padding: '12px 14px', background: 'var(--bg3)', borderRadius: 10, border: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>
              Admin accounts always have access to every page. Page checklists do not apply.
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', letterSpacing: 1, textTransform: 'uppercase', fontFamily: 'var(--mono)', display: 'block', marginBottom: 8 }}>Page access</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <Btn label="Select all" small onClick={() => setAllUserPages(true)} />
                <Btn label="Clear all" small onClick={() => setAllUserPages(false)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {APP_PAGES.map((p) => (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', fontFamily: 'var(--mono)' }}>
                    <input
                      type="checkbox"
                      checked={Array.isArray(form.allowedPages) && form.allowedPages.includes(p.key)}
                      onChange={() => toggleUserPage(p.key)}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 8 }}>
                Effective access: {getEffectiveAllowedPages({ role: form.role, allowedPages: form.allowedPages }).length} page(s)
              </div>
            </div>
          )}
          <Field label="Active" value={form.active?.toString()||'true'} onChange={v=>f('active')(v==='true')} options={[{value:'true',label:'Active'},{value:'false',label:'Inactive'}]} />
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22, paddingTop:18, borderTop:'1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={()=>setModal(null)} />
            <Btn label={loading ? 'Saving...' : 'Save user'} onClick={save} />
          </div>
        </Modal>
      )}

      {modal === 'reset-password' && (
        <Modal title="Reset password" onClose={() => { setModal(null); setForm({}) }}>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12, fontFamily: 'var(--mono)' }}>
            User: <strong style={{ color: 'var(--text)' }}>{form._pwdResetName}</strong>
            <br />
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{form._pwdResetEmail}</span>
          </div>
          <Field label="New password" value={form.newPassword || ''} onChange={f('newPassword')} type="password" required />
          <Field label="Confirm new password" value={form.confirmPassword || ''} onChange={f('confirmPassword')} type="password" required />
          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 14 }}>
            Minimum 8 characters. The user can sign in immediately with the new password.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={() => { setModal(null); setForm({}) }} />
            <Btn label={loading ? 'Saving...' : 'Update password'} onClick={savePasswordReset} color="green" />
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
            {value:'pattern',label:'Pattern — regex / keyword match'},
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
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:22, paddingTop:18, borderTop:'1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={()=>setModal(null)} />
            <Btn label={loading ? 'Saving...' : 'Save rule'} onClick={save} />
          </div>
        </Modal>
      )}

    </div>
  )
}





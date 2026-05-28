import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { useUrlTab } from '../../hooks/useUrlTab.js'

const WebSshModal  = lazy(() => import('../../components/network/WebSshModal.jsx'))
const WebUiFrame   = lazy(() => import('../../components/network/WebUiFrame.jsx'))
const RdpFrame     = lazy(() => import('../../components/network/RdpFrame.jsx'))

const C = {
  accent: 'var(--accent)',
  accent2: 'var(--accent2)',
  green: 'var(--green)',
  cyan: 'var(--cyan)',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
}

function hostForUrl(ip) {
  if (!ip) return ''
  return ip.includes(':') ? `[${ip}]` : ip
}

function httpsHref(ip, port) {
  const p = Number(port) > 0 ? port : 443
  return `https://${hostForUrl(ip)}:${p}`
}

function sshHref(username, ip, port) {
  const p = Number(port) > 0 ? port : 22
  const host = hostForUrl(ip)
  const user = (username || '').trim()
  const auth = user ? `${encodeURIComponent(user)}@` : ''
  if (p === 22) return `ssh://${auth}${host}`
  return `ssh://${auth}${host}:${p}`
}

function sshCli(username, ip, port) {
  const p = Number(port) > 0 ? port : 22
  const u = (username || '').trim()
  const userAt = u ? `${u}@` : ''
  const target = ip.includes(':') ? `[${ip}]` : ip
  if (p !== 22) return `ssh -p ${p} ${userAt}${target}`
  return `ssh ${userAt}${target}`
}

function Modal({ title, onClose, children }) {
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,8,14,0.65)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 28,
          width: 520,
          maxWidth: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 22, gap: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--sans)', letterSpacing: -0.02 }}>{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              flexShrink: 0,
              width: 36,
              height: 36,
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg3)',
              color: 'var(--text2)',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
  width: '100%',
  padding: '10px 14px',
  background: 'var(--bg3)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  color: 'var(--text)',
  fontSize: 13,
  fontFamily: 'var(--mono)',
  outline: 'none',
}

function Field({ label, value, onChange, type = 'text', options, required }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text3)',
          letterSpacing: 1,
          textTransform: 'uppercase',
          fontFamily: 'var(--mono)',
          display: 'block',
          marginBottom: 6,
        }}
      >
        {label}
        {required && ' *'}
      </label>
      {options ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          {options.map((o) => (
            <option key={o.value || o} value={o.value || o}>
              {o.label || o}
            </option>
          ))}
        </select>
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required} style={inputStyle} />
      )}
    </div>
  )
}

function Btn({ label, onClick, small, variant, title }) {
  if (variant === 'ghost') {
    return (
      <button
        type="button"
        title={title}
        onClick={onClick}
        style={{
          padding: small ? '6px 12px' : '10px 18px',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'var(--text2)',
          fontSize: small ? 11 : 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    )
  }
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        padding: small ? '6px 12px' : '10px 18px',
        borderRadius: 10,
        border: 'none',
        background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`,
        color: 'var(--on-accent)',
        fontSize: small ? 11 : 13,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 4px 20px rgba(79,126,245,0.25)',
      }}
    >
      {label}
    </button>
  )
}

const MAIN_TABS = [
  { id: 'devices', label: 'Sites & devices' },
  { id: 'sessions', label: 'SSH sessions' },
]

const SECTION_LABEL = {
  firewalls: 'FortiGate',
  switches: 'Cisco',
  servers: 'Servers',
  other: 'Other',
}

export default function NetworkAccessPage() {
  const [sites, setSites] = useState([])
  const [devices, setDevices] = useState([])
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({})
  const [loading, setLoading] = useState(false)
  const [sshOpen, setSshOpen] = useState(null)
  const [webUiFrameDevice, setWebUiFrameDevice] = useState(null)
  const [rdpDevice, setRdpDevice] = useState(null)
  const [sshSessions, setSshSessions] = useState([])
  const [sshLogSession, setSshLogSession] = useState(null)
  const [pageTab, setPageTab] = useUrlTab('devices', MAIN_TABS)
  const [expandedSiteIds, setExpandedSiteIds] = useState(() => new Set())
  const f = (key) => (val) => setForm((p) => ({ ...p, [key]: val }))

  const toggleSiteExpanded = useCallback((siteId) => {
    const id = String(siteId)
    setExpandedSiteIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    try {
      const [s, d, ssh] = await Promise.all([
        api.get('/api/sites'),
        api.get('/api/devices'),
        api.get('/api/ssh-sessions?limit=25').catch(() => ({ data: [] })),
      ])
      setSites(s.data)
      setDevices(d.data)
      setSshSessions(Array.isArray(ssh.data) ? ssh.data : [])
    } catch (e) {
      console.error(e)
      toast.error('Failed to load sites or devices')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const bySite = useMemo(() => {
    const map = new Map()
    for (const s of sites) {
      map.set(s._id, { site: s, firewalls: [], switches: [], servers: [], other: [] })
    }
    for (const d of devices) {
      const sid = d.site?._id || d.site
      const bucket = map.get(String(sid))
      if (!bucket) continue
      if (d.type === 'fortigate') bucket.firewalls.push(d)
      else if (d.type === 'cisco-switch' || d.type === 'cisco-router') bucket.switches.push(d)
      else if (d.type === 'windows-server' || d.type === 'linux-server') bucket.servers.push(d)
      else bucket.other.push(d)
    }
    for (const b of map.values()) {
      b.firewalls.sort((a, b2) => a.name.localeCompare(b2.name))
      b.switches.sort((a, b2) => a.name.localeCompare(b2.name))
      b.servers.sort((a, b2) => a.name.localeCompare(b2.name))
      b.other.sort((a, b2) => a.name.localeCompare(b2.name))
    }
    return [...map.values()].sort((a, b) => (a.site.name || '').localeCompare(b.site.name || ''))
  }, [sites, devices])

  function openAddSite() {
    setForm({ name: '', location: '', description: '', timezone: 'Asia/Kolkata', active: true })
    setModal('site-create')
  }

  function openAddDevice(siteId) {
    if (!sites.length) {
      toast.error('Add a site first')
      return
    }
    setForm({
      name: '',
      ip: '',
      type: 'cisco-switch',
      site: siteId || sites[0]?._id || '',
      status: 'unknown',
      notes: '',
      mgmtUsername: '',
      mgmtPassword: '',
      savePassword: false,
      sshPort: 22,
      httpsPort: 443,
      rdpPort: 3389,
      rdpDomain: '',
    })
    setModal('device-create')
  }

  function openEditDevice(d) {
    setForm({
      _id: d._id,
      name: d.name,
      ip: d.ip,
      type: d.type,
      site: d.site?._id || d.site,
      status: d.status || 'unknown',
      notes: d.notes || '',
      mgmtUsername: d.mgmtUsername || '',
      mgmtPassword: '',
      savePassword: !!d.hasMgmtPassword,
      sshPort: d.sshPort ?? 22,
      httpsPort: d.httpsPort ?? 443,
      rdpPort: d.rdpPort ?? 3389,
      rdpDomain: d.rdpDomain || '',
    })
    setModal('device-edit')
  }

  async function saveSite() {
    setLoading(true)
    try {
      await api.post('/api/sites', {
        name: form.name,
        location: form.location,
        description: form.description,
        timezone: form.timezone || 'UTC',
        active: form.active !== false,
      })
      toast.success('Location saved')
      setModal(null)
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  async function saveDevice() {
    setLoading(true)
    try {
      const body = {
        name: form.name,
        ip: form.ip,
        type: form.type,
        site: form.site,
        status: form.status,
        notes: form.notes,
        mgmtUsername: form.mgmtUsername,
        sshPort:   Number(form.sshPort)   || 22,
        httpsPort: Number(form.httpsPort) || 443,
        rdpPort:   Number(form.rdpPort)   || 3389,
        rdpDomain: form.rdpDomain || '',
        savePassword: !!form.savePassword,
      }
      if (form.mgmtPassword) body.mgmtPassword = form.mgmtPassword
      if (form._id) {
        await api.put(`/api/devices/${form._id}`, body)
        toast.success('Device updated')
      } else {
        await api.post('/api/devices', body)
        toast.success('Device added')
      }
      setModal(null)
      setExpandedSiteIds((prev) => {
        const next = new Set(prev)
        if (form.site) next.add(String(form.site))
        return next
      })
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  async function copyPassword(id) {
    try {
      const { data } = await api.get(`/api/devices/${id}/credentials`)
      if (!data.password) {
        toast.error('No saved password for this device')
        return
      }
      await navigator.clipboard.writeText(data.password)
      toast.success('Password copied')
    } catch {
      toast.error('Could not copy password')
    }
  }

  async function copySshCommand(d) {
    const { data } = await api.get(`/api/devices/${d._id}/credentials`).catch(() => ({ data: {} }))
    const user = data.username != null ? data.username : d.mgmtUsername
    const line = sshCli(user, d.ip, d.sshPort)
    try {
      await navigator.clipboard.writeText(line)
      toast.success('SSH command copied')
    } catch {
      toast.error('Copy failed')
    }
  }

  function requestWebSsh(d) {
    if (!d.mgmtUsername) {
      toast.error('No saved username for this device. Edit and set your username (saved per user).')
      return
    }
    if (!d.hasMgmtPassword) {
      toast.error('No saved password for your user. Edit the device, set a password, and tick save.')
      return
    }
    setSshOpen({ device: d })
  }

  async function openSshLog(id) {
    try {
      const { data } = await api.get(`/api/ssh-sessions/${id}`)
      setSshLogSession(data)
    } catch {
      toast.error('Could not load session log')
    }
  }

  function openHttps(d) {
    window.open(httpsHref(d.ip, d.httpsPort), '_blank', 'noopener,noreferrer')
  }

  function openSsh(d) {
    const u = (d.mgmtUsername || '').trim()
    window.location.href = sshHref(u, d.ip, d.sshPort)
  }

  function DeviceRow({ d }) {
    const isWindowsServer = d.type === 'windows-server'
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(100px,1fr) 128px auto',
          gap: 10,
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          fontFamily: 'var(--mono)',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 12 }}>{d.name}</div>
          <div style={{ color: 'var(--text3)', marginTop: 2, fontSize: 10 }}>
            {d.mgmtUsername || '—'} · {d.hasMgmtPassword ? 'pwd ✓' : 'no pwd'}
            {isWindowsServer && ` · :${d.rdpPort || 3389}`}
          </div>
        </div>
        <div style={{ color: C.cyan }}>
          {d.ip}
          {d.rdpDomain && <span style={{ color: 'var(--text3)' }}> ({d.rdpDomain})</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
          {/* Windows Server: RDP is the primary action */}
          {isWindowsServer && (
            <Btn
              small
              label="Web RDP"
              title="Open Remote Desktop in browser via Apache Guacamole (requires guacd on Netpulse server)"
              onClick={() => setRdpDevice(d)}
            />
          )}
          {/* Network devices / Linux: Web UI proxy is the primary action */}
          {!isWindowsServer && (
            <Btn small label="Web UI (in app)" title="Open device web UI inside Netpulse via reverse proxy (cert warning bypassed)" onClick={() => setWebUiFrameDevice(d)} />
          )}
          <Btn small label="Web SSH" title="SSH in browser (session logged in Netpulse)" onClick={() => requestWebSsh(d)} />
          {!isWindowsServer && (
            <Btn small variant="ghost" label="HTTPS" title={`Open https://${hostForUrl(d.ip)}:${d.httpsPort || 443} directly`} onClick={() => openHttps(d)} />
          )}
          <Btn small variant="ghost" label="SSH" title="Open SSH URL handler" onClick={() => openSsh(d)} />
          <Btn small variant="ghost" label="Copy SSH" onClick={() => copySshCommand(d)} />
          {d.hasMgmtPassword && <Btn small variant="ghost" label="Copy pwd" onClick={() => copyPassword(d._id)} />}
          <Btn small variant="ghost" label="Edit" onClick={() => openEditDevice(d)} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 3, height: 28, borderRadius: 3, background: `linear-gradient(180deg, ${C.accent}, ${C.accent2})` }} />
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--text)', fontFamily: 'var(--sans)', letterSpacing: -0.02 }}>Network access</h1>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          padding: 6,
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 14,
        }}
      >
        {MAIN_TABS.map((t) => {
          const on = pageTab === t.id
          const count = t.id === 'sessions' ? sshSessions.length : null
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setPageTab(t.id)}
              style={{
                padding: '8px 14px',
                borderRadius: 10,
                border: '1px solid transparent',
                cursor: 'pointer',
                fontFamily: 'var(--sans)',
                fontWeight: 700,
                fontSize: 13,
                background: on ? `linear-gradient(135deg, ${C.accent}, ${C.accent2})` : 'var(--bg3)',
                color: on ? 'var(--on-accent)' : 'var(--text2)',
                boxShadow: on ? '0 6px 28px rgba(79,126,245,0.28)' : 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {t.label}
              {count != null && count > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: on ? 'rgba(255,255,255,0.2)' : 'var(--bg4)',
                    color: on ? 'var(--on-accent)' : 'var(--text3)',
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
        <div style={{ flex: 1, minWidth: 8 }} />
        {pageTab === 'devices' && <Btn label="+ Site" onClick={openAddSite} />}
        {pageTab === 'sessions' && (
          <Btn variant="ghost" label="Refresh list" onClick={() => load()} small />
        )}
      </div>

      {pageTab === 'devices' && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {bySite.map(({ site, firewalls, switches, servers, other }) => {
          const sid = String(site._id)
          const expanded = expandedSiteIds.has(sid)
          const nDev = firewalls.length + switches.length + servers.length + other.length
          return (
          <div key={site._id} className="card" style={{ borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
            <div
              className="card-header"
              style={{
                background: 'var(--bg3)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '10px 12px',
                minHeight: 0,
              }}
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse site' : 'Expand site'}
                title={expanded ? 'Collapse' : 'Expand'}
                onClick={() => toggleSiteExpanded(site._id)}
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: expanded ? `linear-gradient(135deg, ${C.accent}, ${C.accent2})` : 'var(--bg4)',
                  color: expanded ? 'var(--on-accent)' : 'var(--text2)',
                  cursor: 'pointer',
                  fontSize: 18,
                  fontWeight: 700,
                  lineHeight: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--sans)',
                }}
              >
                {expanded ? '−' : '+'}
              </button>
              <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                <div className="card-title" style={{ fontSize: 14, lineHeight: 1.25 }}>{site.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {site.location || '—'} · {nDev} device{nDev === 1 ? '' : 's'}
                </div>
              </div>
              <Btn small label="+ Device" onClick={() => openAddDevice(site._id)} />
            </div>
            {expanded && (
            <div style={{ padding: '0 0 6px' }}>
              {firewalls.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>{SECTION_LABEL.firewalls}</div>
                  {firewalls.map((d) => <DeviceRow key={d._id} d={d} />)}
                </div>
              )}
              {switches.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>{SECTION_LABEL.switches}</div>
                  {switches.map((d) => <DeviceRow key={d._id} d={d} />)}
                </div>
              )}
              {servers.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>{SECTION_LABEL.servers}</div>
                  {servers.map((d) => <DeviceRow key={d._id} d={d} />)}
                </div>
              )}
              {other.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>{SECTION_LABEL.other}</div>
                  {other.map((d) => <DeviceRow key={d._id} d={d} />)}
                </div>
              )}
              {nDev === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No devices yet.</div>
              )}
            </div>
            )}
          </div>
          )
        })}
        {sites.length === 0 && (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text3)', border: '1px dashed var(--border)', borderRadius: 12, fontSize: 13 }}>
            Add a site (+ Site), then add devices per location.
          </div>
        )}
      </div>
      )}

      {pageTab === 'sessions' && (
        <div className="card" style={{ borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
          <div className="card-header" style={{ background: 'var(--bg3)', padding: '10px 12px' }}>
            <span className="card-title" style={{ fontSize: 14 }}>SSH sessions</span>
            <span className="badge badge-blue">{sshSessions.length}</span>
          </div>
          {sshSessions.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
              None yet — use Web SSH on a device with saved credentials.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text3)', borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
                    <th style={{ padding: '10px 14px' }}>Started</th>
                    <th style={{ padding: '10px 14px' }}>Device</th>
                    <th style={{ padding: '10px 14px' }}>User</th>
                    <th style={{ padding: '10px 14px' }}>Status</th>
                    <th style={{ padding: '10px 14px' }} />
                  </tr>
                </thead>
                <tbody>
                  {sshSessions.map((s) => (
                    <tr key={s._id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 14px', color: 'var(--text2)' }}>{s.startedAt ? new Date(s.startedAt).toLocaleString() : '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--cyan)' }}>{s.deviceName || s.device?.name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--text2)' }}>{s.user?.name || s.user?.email || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        {s.status}
                        {s.transcriptTruncated ? ' · truncated' : ''}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                        <Btn small variant="ghost" label="View log" onClick={() => openSshLog(s._id)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {modal === 'site-create' && (
        <Modal title="Add location" onClose={() => setModal(null)}>
          <Field label="Site name" value={form.name || ''} onChange={f('name')} required />
          <Field label="Location / address" value={form.location || ''} onChange={f('location')} />
          <Field label="Description" value={form.description || ''} onChange={f('description')} />
          <Field
            label="Timezone"
            value={form.timezone || 'Asia/Kolkata'}
            onChange={f('timezone')}
            options={[
              { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
              { value: 'UTC', label: 'UTC' },
              { value: 'America/New_York', label: 'America/New_York' },
              { value: 'Europe/London', label: 'Europe/London' },
            ]}
          />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={() => setModal(null)} />
            <Btn label={loading ? 'Saving…' : 'Save location'} onClick={saveSite} />
          </div>
        </Modal>
      )}

      {(modal === 'device-create' || modal === 'device-edit') && (
        <Modal title={modal === 'device-create' ? 'Add device' : 'Edit device'} onClose={() => setModal(null)}>
          <Field label="Name" value={form.name || ''} onChange={f('name')} required />
          <Field label="IP address" value={form.ip || ''} onChange={f('ip')} required />
          <Field
            label="Type"
            value={form.type || 'cisco-switch'}
            onChange={f('type')}
            options={[
              { value: 'fortigate',      label: 'FortiGate firewall' },
              { value: 'cisco-switch',   label: 'Cisco switch' },
              { value: 'cisco-router',   label: 'Cisco router' },
              { value: 'windows-server', label: 'Windows Server (RDP)' },
              { value: 'linux-server',   label: 'Linux server' },
              { value: 'other',          label: 'Other' },
            ]}
          />
          <Field
            label="Location"
            value={form.site || ''}
            onChange={f('site')}
            options={[{ value: '', label: '— Select —' }, ...sites.map((s) => ({ value: s._id, label: s.name }))]}
          />
          <Field label="SSH port"   value={String(form.sshPort   ?? 22)}   onChange={(v) => f('sshPort')(v)} />
          <Field label="HTTPS port" value={String(form.httpsPort ?? 443)}  onChange={(v) => f('httpsPort')(v)} />
          {(form.type === 'windows-server') && (
            <>
              <Field label="RDP port (default 3389)" value={String(form.rdpPort ?? 3389)} onChange={(v) => f('rdpPort')(v)} />
              <Field label="Windows domain (optional)" value={form.rdpDomain || ''} onChange={f('rdpDomain')} />
            </>
          )}
          <Field label="Username" value={form.mgmtUsername || ''} onChange={f('mgmtUsername')} />
          <Field label="Password" value={form.mgmtPassword || ''} onChange={f('mgmtPassword')} type="password" />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: 'var(--text2)', fontFamily: 'var(--sans)' }}>
              <input type="checkbox" checked={!!form.savePassword} onChange={(e) => f('savePassword')(e.target.checked)} />
              Save password on server (AES-256-GCM, your account only — not shared with other users)
            </label>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, fontFamily: 'var(--mono)', lineHeight: 1.45 }}>
              {modal === 'device-edit' ? 'Leave password empty to keep your current saved password when save is checked. Uncheck to remove your stored credentials for this device.' : 'If unchecked, a password you type is not kept after save. Other users each maintain their own saved username/password.'}
            </div>
          </div>
          <Field label="Notes" value={form.notes || ''} onChange={f('notes')} />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <Btn variant="ghost" label="Cancel" onClick={() => setModal(null)} />
            <Btn label={loading ? 'Saving…' : 'Save'} onClick={saveDevice} />
          </div>
        </Modal>
      )}

      {sshOpen && (
        <Suspense
          fallback={
            <div
              role="status"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(6,8,14,0.6)',
                color: 'var(--text2)',
                fontFamily: 'var(--mono)',
                fontSize: 14,
              }}
            >
              Loading terminal…
            </div>
          }
        >
          <WebSshModal
            key={sshOpen.device._id}
            device={sshOpen.device}
            onClose={() => {
              setSshOpen(null)
              load()
            }}
          />
        </Suspense>
      )}

      {webUiFrameDevice && (
        <Suspense
          fallback={
            <div
              role="status"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(6,8,14,0.6)',
                color: 'var(--text2)',
                fontFamily: 'var(--mono)',
              }}
            >
              Loading proxied console…
            </div>
          }
        >
          <WebUiFrame device={webUiFrameDevice} onClose={() => setWebUiFrameDevice(null)} />
        </Suspense>
      )}

      {rdpDevice && (
        <Suspense
          fallback={
            <div
              role="status"
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(6,8,14,0.85)',
                color: 'var(--text2)',
                fontFamily: 'var(--mono)',
              }}
            >
              Starting Remote Desktop…
            </div>
          }
        >
          <RdpFrame
            key={rdpDevice._id}
            device={rdpDevice}
            onClose={() => setRdpDevice(null)}
          />
        </Suspense>
      )}

      {sshLogSession && (
        <Modal title={`Session transcript — ${sshLogSession.deviceName || ''}`} onClose={() => setSshLogSession(null)}>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, fontFamily: 'var(--mono)' }}>
            {sshLogSession.startedAt && new Date(sshLogSession.startedAt).toLocaleString()} — {sshLogSession.status}
            {sshLogSession.transcriptTruncated ? ' · truncated at size cap' : ''}
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '62vh',
              overflow: 'auto',
              fontSize: 11,
              fontFamily: 'var(--mono)',
              background: 'var(--bg3)',
              padding: 14,
              borderRadius: 10,
              border: '1px solid var(--border)',
              color: 'var(--text2)',
              margin: 0,
            }}
          >
            {sshLogSession.transcript || '(empty — session may still be active or produced no data)'}
          </pre>
        </Modal>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '../../api/client'

const API = '/api/store-zabbix/alerts'

const METRICS = [
  { id: 'host_down', label: 'Host Down', hint: 'Zabbix availability + custom.ping.loss + agent.ping' },
  { id: 'agent_down', label: 'Agent Down', hint: 'agent.ping (Windows Zabbix agent)' },
  { id: 'latency', label: 'Latency (ms)', hint: 'Zabbix item: custom.ping.ms[target]' },
  { id: 'jitter', label: 'Jitter (ms)', hint: 'Zabbix item: custom.ping.jitter[target]' },
  { id: 'packet_loss', label: 'Packet Loss (%)', hint: 'Zabbix item: custom.ping.loss[target]' },
  { id: 'cpu', label: 'CPU Usage (%)', hint: 'system.cpu.util' },
  { id: 'memory', label: 'Memory Usage (%)', hint: 'vm.memory.util' },
  { id: 'interface_down', label: 'Interface Down', hint: 'Zabbix interface triggers' },
]

const OPERATORS = [
  { id: 'gt', label: '>' },
  { id: 'gte', label: '≥' },
  { id: 'lt', label: '<' },
  { id: 'lte', label: '≤' },
  { id: 'eq', label: '=' },
  { id: 'between', label: 'Between' },
]

const SEV_COLORS = {
  disaster: '#7f1d1d',
  critical: '#ef4444',
  high: '#f97316',
  warning: '#eab308',
}

const BH_POLICIES = [
  { id: 'always', label: 'Always notify (24/7)' },
  { id: 'bh_only', label: 'Notify during business hours only' },
  { id: 'outside_bh', label: 'Notify outside business hours only' },
  { id: 'suppress_after_hours', label: 'Suppress after hours' },
]

const BH_DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function blankRule() {
  return {
    name: '',
    description: '',
    enabled: true,
    severity: 'high',
    scope: { type: 'global', groupName: '', hostids: [], hostnames: [] },
    condition: { metric: 'latency', operator: 'gt', threshold: 150, thresholdMax: 250, target: '8.8.8.8' },
    businessHours: {
      enabled: false,
      policy: 'always',
      fromHour: 9,
      toHour: 18,
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'Asia/Kolkata',
    },
    channels: [],
    cooldownMinutes: 30,
  }
}

function SummaryCard({ label, value, color, sub }) {
  return (
    <div style={{
      padding: 14, borderRadius: 12, border: '1px solid var(--border)',
      background: 'linear-gradient(135deg,var(--bg2) 0%,var(--bg3) 100%)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: .6, textTransform: 'uppercase', fontFamily: 'var(--mono)' }}>
        {label}
      </div>
      <div style={{ marginTop: 8, fontSize: 26, fontWeight: 800, color: color || 'var(--text)', fontFamily: 'var(--mono)' }}>
        {value ?? '—'}
      </div>
      {sub && <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{sub}</div>}
    </div>
  )
}

function RuleModal({ open, initial, groups, onClose, onSave, saving }) {
  const [form, setForm] = useState(blankRule())
  const [testResult, setTestResult] = useState({})

  useEffect(() => {
    if (!open) return
    setForm(initial ? JSON.parse(JSON.stringify(initial)) : blankRule())
    setTestResult({})
  }, [open, initial])

  if (!open) return null

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setCond = (patch) => setForm((f) => ({ ...f, condition: { ...f.condition, ...patch } }))
  const setBh = (patch) => setForm((f) => ({ ...f, businessHours: { ...f.businessHours, ...patch } }))
  const setScope = (patch) => setForm((f) => ({ ...f, scope: { ...f.scope, ...patch } }))

  const addChannel = (type) => {
    setForm((f) => ({
      ...f,
      channels: [...f.channels, { type, webhookUrl: '', emails: [], method: 'POST', headers: {} }],
    }))
  }
  const updateChannel = (i, patch) => {
    setForm((f) => {
      const chs = [...f.channels]
      chs[i] = { ...chs[i], ...patch }
      return { ...f, channels: chs }
    })
  }
  const removeChannel = (i) => {
    setForm((f) => {
      const chs = [...f.channels]
      chs.splice(i, 1)
      return { ...f, channels: chs }
    })
  }

  const testCh = async (ch, idx) => {
    setTestResult((p) => ({ ...p, [idx]: 'sending…' }))
    try {
      const { data } = await api.post(`${API}/test-channel`, ch)
      setTestResult((p) => ({ ...p, [idx]: data.ok ? '✅ Sent' : `❌ ${data.error || 'failed'}` }))
    } catch (e) {
      setTestResult((p) => ({ ...p, [idx]: `❌ ${e.response?.data?.error || e.message}` }))
    }
  }

  const toggleBhDay = (d) => {
    const days = new Set(form.businessHours.weekdays || [])
    if (days.has(d)) days.delete(d)
    else days.add(d)
    if (!days.size) return
    setBh({ weekdays: [...days].sort((a, b) => a - b) })
  }

  const inp = {
    padding: '6px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)',
    border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)', width: '100%',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        width: 'min(720px, 100%)', maxHeight: '90vh', overflow: 'auto',
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 20,
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
          {initial?._id ? 'Edit Alert Rule' : 'New Alert Rule'}
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
            Rule name
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} style={inp} required />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
            Description
            <input value={form.description} onChange={(e) => set({ description: e.target.value })} style={inp} />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
              Severity
              <select value={form.severity} onChange={(e) => set({ severity: e.target.value })} style={inp}>
                {['disaster', 'critical', 'high', 'warning'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text3)' }}>
              Cooldown (min)
              <input type="number" min={1} value={form.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: Number(e.target.value) })} style={inp} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text2)', marginTop: 18 }}>
              <input type="checkbox" checked={!!form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Enabled
            </label>
          </div>

          {/* Scope */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, fontFamily: 'var(--mono)' }}>SCOPE</div>
            <select value={form.scope.type} onChange={(e) => setScope({ type: e.target.value })} style={{ ...inp, marginBottom: 8 }}>
              <option value="global">Global — all hosts</option>
              <option value="group">Host group</option>
              <option value="hosts">Specific hosts</option>
            </select>
            {form.scope.type === 'group' && (
              <select value={form.scope.groupName} onChange={(e) => setScope({ groupName: e.target.value })} style={inp}>
                <option value="">Select group…</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
            {form.scope.type === 'hosts' && (
              <input
                value={(form.scope.hostnames || []).join(', ')}
                onChange={(e) => setScope({ hostnames: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="Hostnames comma-separated, e.g. RP2806-E547CP91"
                style={inp}
              />
            )}
          </div>

          {/* Condition */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, fontFamily: 'var(--mono)' }}>CONDITION</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <select value={form.condition.metric} onChange={(e) => setCond({ metric: e.target.value })} style={inp}>
                {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              {!['host_down', 'agent_down', 'interface_down'].includes(form.condition.metric) && (
                <>
                  <select value={form.condition.operator} onChange={(e) => setCond({ operator: e.target.value })} style={inp}>
                    {OPERATORS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <input type="number" value={form.condition.threshold} onChange={(e) => setCond({ threshold: Number(e.target.value) })} style={inp} />
                </>
              )}
            </div>
            {form.condition.operator === 'between' && (
              <input type="number" value={form.condition.thresholdMax ?? ''} onChange={(e) => setCond({ thresholdMax: Number(e.target.value) })}
                placeholder="Max threshold" style={{ ...inp, marginTop: 8 }} />
            )}
            {['latency', 'jitter', 'packet_loss'].includes(form.condition.metric) && (
              <>
                <p style={{ margin: '8px 0 4px', fontSize: 10, color: 'var(--cyan)', fontFamily: 'var(--mono)' }}>
                  Sensor: {form.condition.metric === 'latency' ? 'custom.ping.ms' : form.condition.metric === 'jitter' ? 'custom.ping.jitter' : 'custom.ping.loss'}
                  [{form.condition.target || '8.8.8.8'}] — same as Custom Dashboard / RP store workstations
                </p>
                <input value={form.condition.target || '8.8.8.8'} onChange={(e) => setCond({ target: e.target.value })}
                  placeholder="Ping target IP (default 8.8.8.8)" style={inp} />
              </>
            )}
            {METRICS.find((m) => m.id === form.condition.metric)?.hint && (
              <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                {METRICS.find((m) => m.id === form.condition.metric).hint}
              </p>
            )}
          </div>

          {/* Business Hours */}
          <div style={{ border: '1px solid rgba(245,158,11,.35)', borderRadius: 10, padding: 12, background: 'rgba(245,158,11,.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', fontFamily: 'var(--mono)' }}>🕒 BUSINESS HOURS</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)', marginLeft: 'auto' }}>
                <input type="checkbox" checked={!!form.businessHours.enabled} onChange={(e) => setBh({ enabled: e.target.checked })} />
                Apply BH policy
              </label>
            </div>
            <select value={form.businessHours.policy} onChange={(e) => setBh({ policy: e.target.value })} style={{ ...inp, marginBottom: 8 }} disabled={!form.businessHours.enabled}>
              {BH_POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select value={form.businessHours.fromHour} onChange={(e) => setBh({ fromHour: Number(e.target.value) })} style={{ ...inp, width: 90 }} disabled={!form.businessHours.enabled}>
                {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
              </select>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>to</span>
              <select value={form.businessHours.toHour} onChange={(e) => setBh({ toHour: Number(e.target.value) })} style={{ ...inp, width: 90 }} disabled={!form.businessHours.enabled}>
                {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
              </select>
              <div style={{ display: 'flex', gap: 4 }}>
                {BH_DAYS.map((lbl, idx) => {
                  const on = (form.businessHours.weekdays || []).includes(idx)
                  return (
                    <button key={idx} type="button" disabled={!form.businessHours.enabled} onClick={() => toggleBhDay(idx)}
                      style={{
                        width: 26, height: 26, borderRadius: 5, fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
                        border: on ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: on ? 'rgba(59,130,246,.18)' : 'var(--bg3)',
                        color: on ? 'var(--accent)' : 'var(--text3)', cursor: form.businessHours.enabled ? 'pointer' : 'not-allowed',
                      }}>{lbl}</button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Notification channels */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>NOTIFICATION CHANNELS</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {['slack', 'teams', 'google_chat', 'email', 'webhook'].map((t) => (
                  <button key={t} type="button" onClick={() => addChannel(t)}
                    style={{ padding: '3px 8px', borderRadius: 5, fontSize: 10, fontFamily: 'var(--mono)', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--accent)', cursor: 'pointer' }}>
                    + {t}
                  </button>
                ))}
              </div>
            </div>
            {!form.channels.length && (
              <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Add at least one channel (Slack recommended).</div>
            )}
            {form.channels.map((ch, i) => (
              <div key={i} style={{ marginBottom: 10, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>{ch.type}</span>
                  <button type="button" onClick={() => testCh(ch, i)} style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg2)', cursor: 'pointer' }}>Test</button>
                  <button type="button" onClick={() => removeChannel(i)} style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg2)', color: '#ef4444', cursor: 'pointer' }}>✕</button>
                </div>
                {testResult[i] && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4 }}>{testResult[i]}</div>}
                {ch.type === 'email' ? (
                  <input value={(ch.emails || []).join(', ')} onChange={(e) => updateChannel(i, { emails: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                    placeholder="email@company.com, team@company.com" style={inp} />
                ) : (
                  <input value={ch.webhookUrl || ''} onChange={(e) => updateChannel(i, { webhookUrl: e.target.value })}
                    placeholder={ch.type === 'slack' ? 'https://hooks.slack.com/services/…' : 'Webhook URL'} style={inp} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12 }}>Cancel</button>
          <button type="button" disabled={saving || !form.name.trim()} onClick={() => onSave(form)}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, opacity: saving || !form.name.trim() ? .5 : 1 }}>
            {saving ? 'Saving…' : 'Save Rule'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ZabbixAlertsPanel({ apiBase = '/api/store-zabbix' }) {
  const alertsApi = `${apiBase}/alerts`
  const [subTab, setSubTab] = useState('dashboard')
  const [dashboard, setDashboard] = useState(null)
  const [rules, setRules] = useState([])
  const [events, setEvents] = useState([])
  const [groups, setGroups] = useState([])
  const [evalStatus, setEvalStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(null)
  const [saving, setSaving] = useState(false)
  const [evalBusy, setEvalBusy] = useState(false)

  const loadDashboard = useCallback(async () => {
    try {
      const { data } = await api.get(`${alertsApi}/dashboard`)
      setDashboard(data)
    } catch { setDashboard(null) }
  }, [alertsApi])

  const loadRules = useCallback(async () => {
    try {
      const { data } = await api.get(`${alertsApi}/rules`)
      setRules(data || [])
    } catch { setRules([]) }
  }, [alertsApi])

  const loadEvents = useCallback(async () => {
    try {
      const { data } = await api.get(`${alertsApi}/events`, { params: { limit: 100 } })
      setEvents(data?.events || [])
    } catch { setEvents([]) }
  }, [alertsApi])

  const loadMeta = useCallback(async () => {
    try {
      const [st, gr] = await Promise.all([
        api.get(`${alertsApi}/status`),
        api.get(`${alertsApi}/groups`),
      ])
      setEvalStatus(st.data)
      setGroups(gr.data?.groups || [])
    } catch { /* ignore */ }
  }, [alertsApi])

  const refresh = useCallback(async () => {
    setBusy(true)
    await Promise.all([loadDashboard(), loadRules(), loadEvents(), loadMeta()])
    setBusy(false)
  }, [loadDashboard, loadRules, loadEvents, loadMeta])

  useEffect(() => { refresh() }, [refresh])

  const saveRule = async (form) => {
    setSaving(true)
    try {
      if (form._id) await api.put(`${alertsApi}/rules/${form._id}`, form)
      else await api.post(`${alertsApi}/rules`, form)
      setModal(null)
      await loadRules()
    } catch (e) {
      window.alert(e.response?.data?.error || e.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = async (id) => {
    if (!window.confirm('Delete this alert rule?')) return
    await api.delete(`${alertsApi}/rules/${id}`).catch(() => {})
    loadRules()
  }

  const toggleRule = async (rule) => {
    await api.put(`${alertsApi}/rules/${rule._id}`, { ...rule, enabled: !rule.enabled }).catch(() => {})
    loadRules()
  }

  const runEval = async () => {
    setEvalBusy(true)
    try {
      const { data } = await api.post(`${alertsApi}/evaluate`)
      window.alert(`Evaluation complete: ${data.fired} fired, ${data.skipped} skipped`)
      await refresh()
    } catch (e) {
      window.alert(e.response?.data?.error || e.message)
    } finally {
      setEvalBusy(false)
    }
  }

  const summary = dashboard?.summary || {}
  const sevChart = dashboard?.bySeverity || []

  const metricLabel = (m) => METRICS.find((x) => x.id === m)?.label || m

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Toolbar */}
      <div className="opm-toolbar">
        <div className="opm-toolbar-row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="opm-toolbar-label">Alerts Management</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { id: 'dashboard', label: 'Dashboard' },
              { id: 'rules', label: 'Rules' },
              { id: 'history', label: 'History' },
            ].map((t) => (
              <button key={t.id} type="button" onClick={() => setSubTab(t.id)}
                style={{
                  padding: '5px 14px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600,
                  border: subTab === t.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: subTab === t.id ? 'rgba(59,130,246,.12)' : 'transparent',
                  color: subTab === t.id ? 'var(--accent)' : 'var(--text3)', cursor: 'pointer',
                }}>
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setModal({})}
            style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, cursor: 'pointer' }}>
            + New Rule
          </button>
          <button type="button" onClick={runEval} disabled={evalBusy}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 600, cursor: 'pointer' }}>
            {evalBusy ? 'Evaluating…' : '▶ Evaluate Now'}
          </button>
          <button type="button" onClick={refresh} disabled={busy}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer' }}>
            ↻ Refresh
          </button>
        </div>
        {evalStatus?.lastEvalAt && (
          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', paddingTop: 4 }}>
            Last auto-eval: {new Date(evalStatus.lastEvalAt).toLocaleString()} · every {Math.round((evalStatus.intervalMs || 120000) / 1000)}s
          </div>
        )}
      </div>

      {/* Dashboard */}
      {subTab === 'dashboard' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <SummaryCard label="Active Alerts" value={summary.activeAlerts} color="#3b82f6" />
            <SummaryCard label="Critical Alerts" value={summary.criticalAlerts} color="#ef4444" />
            <SummaryCard label="Disaster Alerts" value={summary.disasterAlerts} color="#7f1d1d" />
            <SummaryCard label="Alerts Today" value={summary.alertsToday} color="#8b5cf6" />
            <SummaryCard label="Resolved Today" value={summary.resolvedToday} color="#22c55e" />
            <SummaryCard label="Failed Notifications" value={summary.failedNotifications} color="#f97316" />
            <SummaryCard label="Offline Devices" value={summary.offlineDevices} color="#ef4444" sub={`of ${summary.totalHosts ?? '—'} hosts`} />
          </div>
          {dashboard?.sensors && (
            <p style={{ margin: 0, fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
              Ping sensors: {dashboard.sensors.latency} · {dashboard.sensors.jitter} · {dashboard.sensors.packetLoss}
              (RP / store Windows workstations)
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <div style={{ padding: 16, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg2)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 12, fontFamily: 'var(--mono)' }}>ALERTS BY SEVERITY</div>
              {sevChart.map((s) => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ width: 80, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>{s.label}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg4)', overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(100, (s.count / Math.max(1, summary.activeAlerts || 1)) * 100)}%`,
                      height: '100%', background: s.color,
                    }} />
                  </div>
                  <span style={{ width: 36, textAlign: 'right', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color: s.color }}>{s.count}</span>
                </div>
              ))}
            </div>

            <div style={{ padding: 16, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg2)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 12, fontFamily: 'var(--mono)' }}>ENABLED RULES ({rules.filter((r) => r.enabled).length})</div>
              {rules.filter((r) => r.enabled).slice(0, 8).map((r) => (
                <div key={r._id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLORS[r.severity] || '#64748b' }} />
                  <span style={{ flex: 1, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ color: 'var(--text3)' }}>{metricLabel(r.condition?.metric)}</span>
                </div>
              ))}
              {!rules.filter((r) => r.enabled).length && (
                <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>No enabled rules — create one to start alerting.</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Rules list */}
      {subTab === 'rules' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
            <thead>
              <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px' }}>Rule</th>
                <th style={{ padding: '10px 12px' }}>Condition</th>
                <th style={{ padding: '10px 12px' }}>Scope</th>
                <th style={{ padding: '10px 12px' }}>BH</th>
                <th style={{ padding: '10px 12px' }}>Channels</th>
                <th style={{ padding: '10px 12px' }}>Status</th>
                <th style={{ padding: '10px 12px' }} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r._id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 700, color: 'var(--text)' }}>{r.name}</div>
                    <div style={{ fontSize: 10, color: SEV_COLORS[r.severity] }}>{r.severity}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text2)' }}>
                    {metricLabel(r.condition?.metric)}
                    {!['host_down', 'agent_down'].includes(r.condition?.metric) && (
                      <> {r.condition?.operator} {r.condition?.threshold}</>
                    )}
                    {['latency', 'jitter', 'packet_loss'].includes(r.condition?.metric) && r.condition?.target && (
                      <div style={{ fontSize: 9, color: 'var(--cyan)', marginTop: 2 }}>
                        {r.condition.metric === 'latency' ? 'custom.ping.ms' : r.condition.metric === 'jitter' ? 'custom.ping.jitter' : 'custom.ping.loss'}
                        [{r.condition.target}]
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text3)' }}>
                    {r.scope?.type === 'global' ? 'All hosts' : r.scope?.type === 'group' ? r.scope.groupName : (r.scope?.hostnames || []).join(', ')}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text3)', fontSize: 10 }}>
                    {r.businessHours?.enabled ? r.businessHours.policy : '24/7'}
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text3)' }}>
                    {(r.channels || []).map((c) => c.type).join(', ') || '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button type="button" onClick={() => toggleRule(r)}
                      style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, border: '1px solid var(--border)', background: r.enabled ? 'rgba(34,197,94,.12)' : 'var(--bg3)', color: r.enabled ? '#22c55e' : 'var(--text3)', cursor: 'pointer' }}>
                      {r.enabled ? 'ON' : 'OFF'}
                    </button>
                  </td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <button type="button" onClick={() => setModal(r)} style={{ marginRight: 6, padding: '2px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg3)', cursor: 'pointer' }}>Edit</button>
                    <button type="button" onClick={() => deleteRule(r._id)} style={{ padding: '2px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg3)', color: '#ef4444', cursor: 'pointer' }}>Delete</button>
                  </td>
                </tr>
              ))}
              {!rules.length && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>No alert rules yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* History */}
      {subTab === 'history' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
            <thead>
              <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                <th style={{ padding: '10px 12px' }}>Time</th>
                <th style={{ padding: '10px 12px' }}>Rule</th>
                <th style={{ padding: '10px 12px' }}>Severity</th>
                <th style={{ padding: '10px 12px' }}>Hosts</th>
                <th style={{ padding: '10px 12px' }}>Dispatch</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev._id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px', color: 'var(--text3)' }}>{new Date(ev.firedAt).toLocaleString()}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text2)', fontWeight: 600 }}>{ev.ruleName}</td>
                  <td style={{ padding: '10px 12px', color: SEV_COLORS[ev.severity] }}>{ev.severity}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text2)' }}>
                    {ev.affectedCount}
                    {ev.hosts?.[0] && (
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                        {ev.hosts[0].hostname}
                        {ev.hosts[0].latency != null && ` · ${ev.hosts[0].latency}ms`}
                        {ev.hosts[0].jitter != null && ` · jitter ${ev.hosts[0].jitter}ms`}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 10 }}>
                    {(ev.dispatch || []).map((d, i) => (
                      <span key={i} style={{ color: d.ok ? '#22c55e' : '#ef4444', marginRight: 8 }}>
                        {d.channel}: {d.ok ? '✓' : d.error || 'fail'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {!events.length && (
                <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>No alert events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <RuleModal
        open={!!modal}
        initial={modal?._id ? modal : null}
        groups={groups}
        onClose={() => setModal(null)}
        onSave={saveRule}
        saving={saving}
      />
    </div>
  )
}

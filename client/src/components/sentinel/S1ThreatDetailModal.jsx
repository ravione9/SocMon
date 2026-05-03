import { useCallback, useEffect, useState } from 'react'
import api from '../../api/client'

const TEXT = 'var(--text)'
const TEXT2 = 'var(--text2)'
const TEXT3 = 'var(--text3)'
const BORDER = 'var(--border)'
const BG2 = 'var(--bg2)'
const BG3 = 'var(--bg3)'
const RED = '#f5534f'
const GREEN = '#22d3a0'
const ACCENT = '#14b8a6'
const PURPLE = '#a78bfa'

const MITIGATE_ACTIONS = [
  { value: 'kill', label: 'Kill' },
  { value: 'quarantine', label: 'Quarantine' },
  { value: 'un-quarantine', label: 'Un-quarantine' },
  { value: 'remediate', label: 'Remediate' },
  { value: 'rollback-remediation', label: 'Rollback remediation' },
]

const VERDICTS = [
  { value: 'undefined', label: 'Undefined' },
  { value: 'suspicious', label: 'Suspicious' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'true_positive', label: 'True positive' },
]

function formatSentinelOneAxiosErr(err, fallback) {
  const d = err.response?.data
  if (!d || typeof d !== 'object') return err.message || fallback
  const bits = []
  if (d.error) bits.push(String(d.error))
  if (d.code) bits.push(`(${String(d.code)})`)
  if (d.upstreamStatus != null) bits.push(`[SentinelOne HTTP ${d.upstreamStatus}]`)
  if (Array.isArray(d.upstream?.errors) && d.upstream.errors.length)
    bits.push(JSON.stringify(d.upstream.errors))
  if (d.hint) bits.push(String(d.hint))
  return bits.filter(Boolean).join(' ') || fallback
}

function safeStr(v, fb = '—') {
  if (v == null || v === '') return fb
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v)
      return s.length > 800 ? `${s.slice(0, 800)}…` : s
    } catch {
      return fb
    }
  }
  return String(v)
}

function fmtTs(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

function fmtBytes(n) {
  const x = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(x) || x < 0) return safeStr(n)
  if (x < 1024) return `${x} B`
  if (x < 1048576) return `${(x / 1024).toFixed(2)} KB`
  return `${(x / 1048576).toFixed(2)} MB`
}

function extractIndicators(raw) {
  const pools = [
    raw?.indicators,
    raw?.threatIndicators,
    raw?.indicatorInfos,
    raw?.threatInfo?.indicators,
  ]
  for (const p of pools) {
    if (Array.isArray(p) && p.length) return p
  }
  return []
}

function indicatorText(ind) {
  if (!ind || typeof ind !== 'object') return safeStr(ind)
  return (
    ind.description ||
    ind.title ||
    ind.name ||
    ind.indicatorDescription ||
    ind.detail ||
    ind.text ||
    safeStr(ind)
  )
}

function indicatorTactic(ind) {
  const t = ind.tactics ?? ind.tactic ?? ind.category ?? ind.mitreTactic ?? ind.mitre?.tactic
  if (Array.isArray(t)) return t.filter(Boolean).join(', ') || 'General'
  return t ? String(t) : 'General'
}

function card(title, children) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: BG3,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${BORDER}`,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.6,
          color: TEXT3,
          fontFamily: 'var(--mono)',
          textTransform: 'uppercase',
        }}
      >
        {title}
      </div>
      <div style={{ padding: '12px 14px', fontSize: 11, fontFamily: 'var(--mono)', color: TEXT2 }}>{children}</div>
    </div>
  )
}

function kv(label, value) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, marginBottom: 8, alignItems: 'start' }}>
      <span style={{ color: TEXT3, fontWeight: 600 }}>{label}</span>
      <span style={{ color: TEXT2, wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

export default function S1ThreatDetailModal({ open, threatId, onClose, onAfterMutation }) {
  const [raw, setRaw] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sideTab, setSideTab] = useState('indicators')

  const reload = useCallback(async () => {
    if (!threatId) return
    setLoading(true)
    setLoadErr(null)
    try {
      const { data } = await api.get(`/api/sentinel-one/threats/${encodeURIComponent(threatId)}`)
      setRaw(data.threat || null)
    } catch (e) {
      setLoadErr(formatSentinelOneAxiosErr(e, 'Failed to load threat'))
      setRaw(null)
    } finally {
      setLoading(false)
    }
  }, [threatId])

  useEffect(() => {
    if (!open || !threatId) {
      setRaw(null)
      setLoadErr(null)
      setSideTab('indicators')
      return
    }
    reload()
  }, [open, threatId, reload])

  useEffect(() => {
    if (!open) return
    const onKey = e => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const runMitigate = async action => {
    if (!threatId || !window.confirm(`Run mitigation "${action}" on this threat?`)) return
    setBusy(true)
    setLoadErr(null)
    try {
      await api.post('/api/sentinel-one/threats/mitigate', { ids: [threatId], action })
      await reload()
      onAfterMutation?.()
    } catch (e) {
      setLoadErr(formatSentinelOneAxiosErr(e, 'Mitigation failed'))
    } finally {
      setBusy(false)
    }
  }

  const runResolve = async () => {
    if (!threatId || !window.confirm('Mark this threat as resolved in SentinelOne?')) return
    setBusy(true)
    setLoadErr(null)
    try {
      await api.post('/api/sentinel-one/threats/resolve', { ids: [threatId] })
      await reload()
      onAfterMutation?.()
    } catch (e) {
      setLoadErr(formatSentinelOneAxiosErr(e, 'Resolve failed'))
    } finally {
      setBusy(false)
    }
  }

  const runVerdict = async verdict => {
    if (!threatId || !window.confirm(`Set analyst verdict to "${verdict}"?`)) return
    setBusy(true)
    setLoadErr(null)
    try {
      await api.post('/api/sentinel-one/threats/analyst-verdict', { ids: [threatId], verdict })
      await reload()
      onAfterMutation?.()
    } catch (e) {
      setLoadErr(formatSentinelOneAxiosErr(e, 'Verdict update failed'))
    } finally {
      setBusy(false)
    }
  }

  const copyDetailJson = () => {
    if (!raw) return
    const text = JSON.stringify(raw, null, 2)
    navigator.clipboard?.writeText(text).catch(() => {})
  }

  if (!open) return null

  const ti = raw?.threatInfo || {}
  const ar = raw?.agentRealtimeInfo || {}
  const ad = raw?.agentDetectionInfo || {}
  const indicators = extractIndicators(raw)
  const grouped = {}
  for (const ind of indicators) {
    const t = indicatorTactic(ind)
    if (!grouped[t]) grouped[t] = []
    grouped[t].push(indicatorText(ind))
  }

  const mitigationBadge = String(ti.mitigationStatus || raw?.mitigationStatus || '—').replace(/_/g, ' ').toUpperCase()
  const pendingReboot =
    ar.pendingReboot === true ||
    ar.rebootRequired === true ||
    ti.pendingReboot === true ||
    String(ar.scanAbortedReason || '').toLowerCase().includes('reboot')

  const engines = ti.engines
  const engineStr = Array.isArray(engines)
    ? engines.filter(Boolean).join(', ')
    : typeof engines === 'string'
      ? engines
      : safeStr(engines, '—')

  const verdictVal =
    ti.analystVerdict != null && ti.analystVerdict !== ''
      ? String(ti.analystVerdict).toLowerCase().replace(/\s+/g, '_')
      : 'undefined'

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10050,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '24px 16px',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="s1-threat-detail-title"
        style={{
          width: '100%',
          maxWidth: 1120,
          maxHeight: 'min(92vh, 980px)',
          marginTop: 12,
          marginBottom: 24,
          borderRadius: 12,
          border: `1px solid ${BORDER}`,
          background: BG2,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${BORDER}`,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flex: '1 1 280px' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: `${RED}28`,
                border: `1px solid ${RED}66`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
              }}
              aria-hidden
            >
              ⚠
            </div>
            <div style={{ minWidth: 0 }}>
              <div id="s1-threat-detail-title" style={{ fontSize: 13, fontWeight: 700, color: TEXT, marginBottom: 6 }}>
                {loading ? 'Loading threat…' : safeStr(ti.threatName || ti.identifyingName || threatId)}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 10 }}>
                <span
                  style={{
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: `${RED}22`,
                    color: RED,
                    fontWeight: 700,
                  }}
                >
                  {mitigationBadge}
                </span>
                <span style={{ color: TEXT3 }}>
                  AI / class: <strong style={{ color: ACCENT }}>{safeStr(ti.confidenceLevel)}</strong>
                </span>
                <span style={{ color: TEXT3 }}>
                  Incident: <strong style={{ color: TEXT2 }}>{safeStr(ti.incidentStatus)}</strong>
                </span>
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: 10, color: TEXT3, fontFamily: 'var(--mono)', display: 'flex', gap: 6, alignItems: 'center' }}>
                  Analyst verdict
                  <select
                    value={VERDICTS.some(v => v.value === verdictVal) ? verdictVal : 'undefined'}
                    disabled={busy || loading || !raw}
                    onChange={e => {
                      const v = e.target.value
                      e.target.value = verdictVal
                      if (v && v !== verdictVal) runVerdict(v)
                    }}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 6,
                      border: `1px solid ${BORDER}`,
                      background: BG3,
                      color: TEXT,
                      fontSize: 10,
                      fontFamily: 'var(--mono)',
                    }}
                  >
                    {VERDICTS.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <select
                  disabled={busy || loading || !raw}
                  defaultValue=""
                  onChange={e => {
                    const v = e.target.value
                    e.target.value = ''
                    if (v) runMitigate(v)
                  }}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 6,
                    border: `1px solid ${BORDER}`,
                    background: BG3,
                    color: TEXT,
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                  }}
                  title="Mitigation action"
                >
                  <option value="">Mitigate…</option>
                  {MITIGATE_ACTIONS.map(a => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy || loading || !raw}
                  onClick={runResolve}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 6,
                    border: `1px solid ${GREEN}`,
                    background: `${GREEN}18`,
                    color: GREEN,
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: 'var(--mono)',
                    cursor: busy ? 'wait' : 'pointer',
                  }}
                >
                  Resolve
                </button>
                <button
                  type="button"
                  disabled={!raw}
                  onClick={copyDetailJson}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: `1px solid ${BORDER}`,
                    background: BG3,
                    color: TEXT3,
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                    cursor: 'pointer',
                  }}
                >
                  Copy JSON
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 10, color: TEXT3, fontFamily: 'var(--mono)' }}>
                Identified {fmtTs(ti.identifiedAt || ti.createdAt)} · Updated {fmtTs(ti.updatedAt || raw?.updatedAt)}
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: `1px solid ${BORDER}`,
              background: BG3,
              color: TEXT2,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        {pendingReboot && raw && (
          <div
            style={{
              padding: '10px 18px',
              background: `${PURPLE}22`,
              borderBottom: `1px solid ${PURPLE}55`,
              color: PURPLE,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Reboot may be required on the endpoint to finish mitigation — reboot from SentinelOne console if applicable.
          </div>
        )}

        {loadErr && (
          <div style={{ padding: '10px 18px', background: `${RED}14`, color: RED, fontFamily: 'var(--mono)', fontSize: 11 }}>
            {loadErr}
          </div>
        )}

        <div style={{ overflowY: 'auto', flex: 1, padding: 16 }}>
          {loading && !raw ? (
            <div style={{ textAlign: 'center', padding: 48, color: TEXT3, fontFamily: 'var(--mono)' }}>Fetching threat details…</div>
          ) : raw ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {card(
                  'Scope / visibility',
                  <>
                    {kv('Threat ID', safeStr(raw.id))}
                    {kv('Storyline', safeStr(ti.storyline || ti.storylineId || ti.collectionId))}
                    {kv('Scope', safeStr(ti.scope || ti.scopeLevel || ti.scopeName))}
                    {kv('Site', safeStr(ti.siteName || ar.siteName))}
                  </>,
                )}
                {card(
                  'Threat file',
                  <>
                    {kv('Path', safeStr(ti.filePath || ti.path || ti.downloadableHash))}
                    {kv('Command line', safeStr(ti.commandLineArguments || ti.commandLine))}
                    {kv('Process user', safeStr(ti.processUser || ti.username))}
                    {kv('Publisher', safeStr(ti.publisher || ti.publisherName))}
                    {kv('Signer', safeStr(ti.signerIdentity || ti.fileSignerIdentity))}
                    {kv('Signature', safeStr(ti.signatureVerificationStatus || ti.fileVerificationType))}
                    {kv('Originating process', safeStr(ti.originatingProcess || ti.originProcess || ti.originatorProcess))}
                    {kv('SHA1', safeStr(ti.sha1 || ti.sha1Hash))}
                    {kv('SHA256', safeStr(ti.sha256 || ti.sha256Hash))}
                    {kv('Classification', safeStr(ti.classification))}
                    {kv('Detection type', safeStr(ti.detectionType || ti.detectionTypes))}
                    {kv('Engine', safeStr(engineStr))}
                    {kv('Initiated by', safeStr(ti.initiatedBy || ti.initiatedByDescription))}
                    {kv('File size', ti.fileSize != null ? fmtBytes(ti.fileSize) : '—')}
                  </>,
                )}
                {card(
                  'Endpoint',
                  <>
                    {kv('Hostname', safeStr(ar.agentComputerName || ad.endpointName))}
                    {kv('Connectivity', safeStr(ar.networkStatus || ar.agentNetworkStatus))}
                    {kv('OS', safeStr(ar.agentOsName || ar.osName || ti.agentOsName))}
                    {kv('Agent version', safeStr(ar.agentVersion || ti.agentVersion))}
                    {kv('Policy', safeStr(ar.policyName || ti.policyName))}
                    {kv('Logged in user', safeStr(ar.agentLoggedOnUsersLastLoggedInUser || ti.agentLoggedOnUsersLastLoggedInUser))}
                    {kv('UUID', safeStr(ar.agentUuid || raw.agentId))}
                    {kv('Domain', safeStr(ar.domain || ti.domain || ti.agentDomain))}
                    {kv('Mitigation status detail', safeStr(ti.mitigationStatusDetails || ti.detectionEngines))}
                  </>,
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${BORDER}` }}>
                  {[
                    { id: 'indicators', label: `Indicators (${indicators.length})` },
                    { id: 'notes', label: 'Notes' },
                    { id: 'xdr', label: 'XDR' },
                  ].map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSideTab(t.id)}
                      style={{
                        flex: 1,
                        padding: '8px 6px',
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: 'var(--mono)',
                        border: 'none',
                        cursor: 'pointer',
                        background: sideTab === t.id ? `${ACCENT}33` : BG3,
                        color: sideTab === t.id ? ACCENT : TEXT3,
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div
                  style={{
                    borderRadius: 10,
                    border: `1px solid ${BORDER}`,
                    background: BG3,
                    padding: 12,
                    minHeight: 280,
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: TEXT2,
                  }}
                >
                  {sideTab === 'indicators' &&
                    (Object.keys(grouped).length ? (
                      Object.entries(grouped).map(([tactic, lines]) => (
                        <div key={tactic} style={{ marginBottom: 14 }}>
                          <div style={{ color: ACCENT, fontWeight: 700, marginBottom: 6, fontSize: 10 }}>{tactic}</div>
                          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.45 }}>
                            {lines.map((line, i) => (
                              <li key={`${tactic}-${i}`} style={{ marginBottom: 4 }}>
                                {line}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))
                    ) : (
                      <span style={{ color: TEXT3 }}>No indicators in this payload — full behavioral map stays in SentinelOne.</span>
                    ))}
                  {sideTab === 'notes' && (
                    <span style={{ color: TEXT3 }}>
                      Notes are available in the SentinelOne console for this threat (Management API notes endpoints vary by tenant).
                    </span>
                  )}
                  {sideTab === 'xdr' && (
                    <span style={{ color: TEXT3 }}>
                      Deep XDR timelines and hunts open in SentinelOne. Use Copy JSON for integration workflows.
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : loadErr ? null : (
            <div style={{ color: TEXT3, fontFamily: 'var(--mono)', textAlign: 'center', padding: 40 }}>No threat data</div>
          )}
        </div>
      </div>
    </div>
  )
}

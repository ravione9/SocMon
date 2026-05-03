import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../../api/client'
import S1ThreatDetailModal from './S1ThreatDetailModal.jsx'

const TEXT = 'var(--text)'
const TEXT2 = 'var(--text2)'
const TEXT3 = 'var(--text3)'
const BORDER = 'var(--border)'
const BG3 = 'var(--bg3)'
const RED = '#f5534f'
const GREEN = '#22d3a0'
const ACCENT = '#14b8a6'
const AMBER = '#f5a623'

/** Single-line toolbar controls align to this height */
const FILTER_CTL_H = 38

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

/** Matches SentinelOne GET /threats mitigationStatuses (not active/blocked). */
const MITIGATION_FILTER_OPTIONS = [
  { value: '__any__', label: 'Any mitigation' },
  { value: 'not_mitigated', label: 'Not mitigated' },
  { value: 'mitigated', label: 'Mitigated' },
  { value: 'marked_as_benign', label: 'Marked benign' },
]

const INCIDENT_FILTER_OPTIONS = [
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
]

function selectStyle() {
  return {
    padding: '5px 8px',
    borderRadius: 6,
    border: `1px solid ${BORDER}`,
    background: BG3,
    color: TEXT,
    fontSize: 10,
    fontFamily: 'var(--mono)',
    maxWidth: 140,
    cursor: 'pointer',
  }
}

function filterSelectStyle() {
  return {
    boxSizing: 'border-box',
    height: FILTER_CTL_H,
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${BORDER}`,
    background: 'var(--bg2)',
    color: TEXT,
    fontSize: 12,
    fontFamily: 'var(--mono)',
    cursor: 'pointer',
    width: '100%',
    maxWidth: 220,
  }
}

function filterLabelStyle() {
  return {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    color: TEXT3,
    fontFamily: 'var(--mono)',
    marginBottom: 8,
    textTransform: 'uppercase',
  }
}

function filterInputStyle() {
  return {
    boxSizing: 'border-box',
    height: FILTER_CTL_H,
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${BORDER}`,
    background: 'var(--bg2)',
    color: TEXT,
    fontSize: 12,
    fontFamily: 'var(--mono)',
    width: '100%',
    minWidth: 0,
    outline: 'none',
  }
}

function filterBtnStyle(primary) {
  return {
    boxSizing: 'border-box',
    height: FILTER_CTL_H,
    padding: '0 16px',
    borderRadius: 8,
    border: `1px solid ${primary ? ACCENT : BORDER}`,
    background: primary ? `${ACCENT}24` : 'var(--bg2)',
    color: primary ? ACCENT : TEXT2,
    fontSize: 12,
    fontFamily: 'var(--mono)',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

function bulkToolbarSelectStyle() {
  return {
    padding: '5px 8px',
    borderRadius: 6,
    border: `1px solid ${BORDER}`,
    background: BG3,
    color: TEXT,
    fontSize: 10,
    fontFamily: 'var(--mono)',
    minWidth: 130,
    maxWidth: 160,
    cursor: 'pointer',
  }
}

function btnStyle(primary) {
  return {
    padding: '5px 10px',
    borderRadius: 6,
    border: `1px solid ${primary ? ACCENT : BORDER}`,
    background: primary ? `${ACCENT}22` : BG3,
    color: primary ? ACCENT : TEXT2,
    fontSize: 10,
    fontFamily: 'var(--mono)',
    fontWeight: 600,
    cursor: 'pointer',
  }
}

/** Prefer API JSON error + SentinelOne upstream payload when present */
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

export default function S1FixThreatsPanel({ range }) {
  const [configured, setConfigured] = useState(null)
  const [rows, setRows] = useState([])
  const [pagination, setPagination] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  /** Which bulk POST is running — drives button labels */
  const [bulkOp, setBulkOp] = useState(null)
  const [bulkMitigateAction, setBulkMitigateAction] = useState('')
  const [bulkVerdictChoice, setBulkVerdictChoice] = useState('')
  /** `__any__` → server skips mitigation filter; API allows marked_as_benign | mitigated | not_mitigated */
  const [mitigationStatuses, setMitigationStatuses] = useState('not_mitigated')
  /** Checkboxes — SentinelOne incidentStatuses: unresolved | in_progress | resolved */
  const [incidentSelections, setIncidentSelections] = useState(['unresolved', 'in_progress'])
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [detailThreatId, setDetailThreatId] = useState(null)
  const headerSelectAllRef = useRef(null)

  /** Resolved threats are almost always mitigated; not_mitigated ∩ resolved is usually empty — widen unless user chose explicit mitigation filter. */
  const widenMitigationForResolved =
    incidentSelections.includes('resolved') &&
    mitigationStatuses === 'not_mitigated'

  const toggleIncidentStatus = value => {
    setIncidentSelections(prev => {
      const has = prev.includes(value)
      if (has && prev.length <= 1) return prev
      if (has) return prev.filter(x => x !== value)
      return [...prev, value]
    })
  }

  const loadFirstPage = useCallback(async () => {
    setLoading(true)
    setErr(null)
    setSelectedIds(() => new Set())
    try {
      const { data: cfg } = await api.get('/api/sentinel-one/configured')
      setConfigured(!!cfg?.configured)
      if (!cfg?.configured) {
        setRows([])
        setPagination(null)
        return
      }
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (range?.type === 'custom' && range.from && range.to) {
        params.set('from', range.from)
        params.set('to', range.to)
      } else {
        params.set('range', range?.value || '30d')
      }
      const mitigationAny =
        mitigationStatuses === '__any__' ||
        (incidentSelections.includes('resolved') && mitigationStatuses === 'not_mitigated')
      if (mitigationAny) params.set('mitigation', 'all')
      else params.append('mitigationStatuses', mitigationStatuses)

      const inc = incidentSelections.length ? incidentSelections : ['unresolved']
      for (const s of inc) params.append('incidentStatuses', s)
      const q = searchQ.trim()
      if (q) params.set('q', q)

      const { data } = await api.get(`/api/sentinel-one/threats?${params}`)
      setRows(data.threats || [])
      setPagination(data.pagination || null)
    } catch (e) {
      setErr(formatSentinelOneAxiosErr(e, 'Failed to load threats'))
      setRows([])
      setPagination(null)
    } finally {
      setLoading(false)
    }
  }, [range, mitigationStatuses, incidentSelections, searchQ])

  useEffect(() => {
    loadFirstPage()
  }, [loadFirstPage])

  const loadMore = async () => {
    const cursor = pagination?.nextCursor
    if (!cursor || loading) return
    setLoading(true)
    setErr(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      params.set('cursor', cursor)
      const { data } = await api.get(`/api/sentinel-one/threats?${params}`)
      setRows(prev => [...prev, ...(data.threats || [])])
      setPagination(data.pagination || null)
    } catch (e) {
      setErr(formatSentinelOneAxiosErr(e, 'Failed to load more'))
    } finally {
      setLoading(false)
    }
  }

  const runMitigate = async (threatId, action) => {
    if (!window.confirm(`Run mitigation "${action}" on this threat?`)) return
    setBusyId(threatId)
    setErr(null)
    try {
      await api.post('/api/sentinel-one/threats/mitigate', { ids: [threatId], action })
      await loadFirstPage()
    } catch (e) {
      setErr(formatSentinelOneAxiosErr(e, 'Mitigation failed'))
    } finally {
      setBusyId(null)
    }
  }

  const runResolve = async threatId => {
    if (!window.confirm('Mark this threat as resolved in SentinelOne?')) return
    setBusyId(threatId)
    setErr(null)
    try {
      await api.post('/api/sentinel-one/threats/resolve', { ids: [threatId] })
      await loadFirstPage()
    } catch (e) {
      setErr(formatSentinelOneAxiosErr(e, 'Resolve failed'))
    } finally {
      setBusyId(null)
    }
  }

  const runBulkPipeline = async () => {
    const ids = [...selectedIds]
    const action = String(bulkMitigateAction || '').trim()
    const verdict = String(bulkVerdictChoice || '').trim()
    if (!ids.length || !action || !verdict) return
    const verdictLabel = VERDICTS.find(v => v.value === verdict)?.label || verdict
    const actionLabel = MITIGATE_ACTIONS.find(a => a.value === action)?.label || action
    if (
      !window.confirm(
        `Run this pipeline on ${ids.length} threat(s)?\n\n1. Mitigate: ${actionLabel}\n2. Analyst verdict: ${verdictLabel}\n3. Resolve (mark closed)\n\nSentinelOne runs these as separate API calls in order.`,
      )
    )
      return
    setBulkOp('pipeline')
    setBulkBusy(true)
    setErr(null)
    try {
      await api.post('/api/sentinel-one/threats/mitigate', { ids, action })
      await api.post('/api/sentinel-one/threats/analyst-verdict', { ids, verdict })
      await api.post('/api/sentinel-one/threats/resolve', { ids })
      await loadFirstPage()
    } catch (e) {
      setErr(formatSentinelOneAxiosErr(e, 'Bulk pipeline failed (stopped at first error)'))
    } finally {
      setBulkBusy(false)
      setBulkOp(null)
    }
  }

  const toggleSelectRow = id => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllVisible = () => {
    setSelectedIds(prev => {
      const allOnPage = rows.map(r => r.id)
      const allSelected = allOnPage.length && allOnPage.every(id => prev.has(id))
      if (allSelected) return new Set()
      return new Set(allOnPage)
    })
  }

  const selectedOnPageCount = rows.filter(r => selectedIds.has(r.id)).length
  const allVisibleSelected = rows.length > 0 && selectedOnPageCount === rows.length

  useEffect(() => {
    const el = headerSelectAllRef.current
    if (!el) return
    el.indeterminate = selectedOnPageCount > 0 && !allVisibleSelected
  }, [selectedOnPageCount, allVisibleSelected])

  const runVerdict = async (threatId, verdict) => {
    if (!window.confirm(`Set analyst verdict to "${verdict}"?`)) return
    setBusyId(threatId)
    setErr(null)
    try {
      await api.post('/api/sentinel-one/threats/analyst-verdict', { ids: [threatId], verdict })
      await loadFirstPage()
    } catch (e) {
      setErr(formatSentinelOneAxiosErr(e, 'Verdict update failed'))
    } finally {
      setBusyId(null)
    }
  }

  const nextCursor = pagination?.nextCursor

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        maxWidth: 1320,
        margin: '0 auto',
        padding: '0 4px',
        boxSizing: 'border-box',
      }}
    >
      {configured === false && (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: `${RED}18`,
            border: `1px solid ${RED}55`,
            color: RED,
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        >
          Add <code style={{ color: TEXT }}>SENTINEL_ONE_BASE_URL</code> and{' '}
          <code style={{ color: TEXT }}>SENTINEL_ONE_API_TOKEN</code> to your server environment (see{' '}
          <code style={{ color: TEXT }}>server/.env.example</code>), then restart the API.
        </div>
      )}

      {err && (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: `${RED}18`,
            border: `1px solid ${RED}55`,
            color: RED,
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        >
          {err}
        </div>
      )}

      <div
        style={{
          borderRadius: 12,
          border: `1px solid ${BORDER}`,
          background: BG3,
          overflow: 'hidden',
          boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 16px',
            borderBottom: `1px solid ${BORDER}`,
            background: 'var(--bg2)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: TEXT, fontFamily: 'var(--mono)', letterSpacing: '0.02em' }}>
            Filters
          </span>
          <span style={{ fontSize: 11, color: TEXT3, fontFamily: 'var(--mono)' }}>
            {loading ? 'Loading…' : `${rows.length} on this page`}
          </span>
        </div>

        <div style={{ padding: '16px 18px 18px' }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '18px 24px',
              alignItems: 'flex-end',
            }}
          >
            <div style={{ flex: '0 1 200px', minWidth: 160, maxWidth: 240 }}>
              <label htmlFor="s1-mitigation-filter" style={filterLabelStyle()}>
                Mitigation
              </label>
              <select
                id="s1-mitigation-filter"
                value={mitigationStatuses}
                onChange={e => setMitigationStatuses(e.target.value)}
                style={filterSelectStyle()}
                disabled={configured === false}
                aria-label="Mitigation status filter"
              >
                {MITIGATION_FILTER_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ flex: '1 1 280px', minWidth: 'min(280px, 100%)' }}>
              <span style={filterLabelStyle()} id="s1-incident-label">
                Incident status
              </span>
              <div
                role="group"
                aria-labelledby="s1-incident-label"
                aria-label="Incident status filter"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                  minHeight: FILTER_CTL_H,
                }}
              >
                {INCIDENT_FILTER_OPTIONS.map(o => {
                  const on = incidentSelections.includes(o.value)
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      disabled={configured === false}
                      onClick={() => toggleIncidentStatus(o.value)}
                      style={{
                        boxSizing: 'border-box',
                        height: FILTER_CTL_H,
                        padding: '0 14px',
                        borderRadius: 8,
                        border: `1px solid ${on ? ACCENT : BORDER}`,
                        background: on ? `${ACCENT}22` : 'var(--bg2)',
                        color: on ? ACCENT : TEXT2,
                        fontSize: 12,
                        fontFamily: 'var(--mono)',
                        fontWeight: 600,
                        cursor: configured === false ? 'not-allowed' : 'pointer',
                        whiteSpace: 'nowrap',
                        opacity: configured === false ? 0.55 : 1,
                      }}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={{ flex: '1 1 220px', minWidth: 'min(200px, 100%)', maxWidth: '100%' }}>
              <label htmlFor="s1-query-filter" style={filterLabelStyle()}>
                Search (S1 query)
              </label>
              <input
                id="s1-query-filter"
                value={searchDraft}
                onChange={e => setSearchDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    setSearchQ(searchDraft.trim())
                  }
                }}
                placeholder="Optional · Enter or Apply"
                disabled={configured === false}
                style={{
                  ...filterInputStyle(),
                  opacity: configured === false ? 0.55 : 1,
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'flex-end',
                justifyContent: 'flex-end',
                flex: '0 0 auto',
                marginLeft: 'auto',
              }}
            >
              <button
                type="button"
                style={{
                  ...filterBtnStyle(false),
                  opacity: loading || configured === false ? 0.55 : 1,
                  cursor: loading || configured === false ? 'not-allowed' : 'pointer',
                }}
                onClick={() => setSearchQ(searchDraft.trim())}
                disabled={loading || configured === false}
              >
                Apply
              </button>
              <button
                type="button"
                style={{
                  ...filterBtnStyle(true),
                  opacity: loading || configured === false ? 0.55 : 1,
                  cursor: loading || configured === false ? 'not-allowed' : 'pointer',
                }}
                onClick={() => loadFirstPage()}
                disabled={loading || configured === false}
              >
                Refresh
              </button>
            </div>
          </div>

          {widenMitigationForResolved && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${AMBER}44`,
                background: `${AMBER}12`,
                color: AMBER,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              Showing <strong style={{ color: TEXT2 }}>any mitigation</strong> because <strong style={{ color: TEXT2 }}>Resolved</strong> is selected —
              resolved threats are usually already mitigated.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span className="card-title">Threat incidents</span>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
              marginLeft: 'auto',
              justifyContent: 'flex-end',
              maxWidth: '100%',
            }}
          >
            <span
              style={{ fontSize: 9, fontWeight: 600, color: TEXT3, fontFamily: 'var(--mono)', marginRight: 4 }}
              title="Pick mitigation + verdict, then run one pipeline (mitigate → verdict → resolve)"
            >
              BULK
            </span>
            <select
              aria-label="Bulk mitigation action"
              value={bulkMitigateAction}
              onChange={e => setBulkMitigateAction(e.target.value)}
              disabled={loading || configured === false || bulkBusy}
              style={bulkToolbarSelectStyle()}
              title="Step 1 — mitigation action"
            >
              <option value="">Mitigate…</option>
              {MITIGATE_ACTIONS.map(a => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Bulk analyst verdict"
              value={bulkVerdictChoice}
              onChange={e => setBulkVerdictChoice(e.target.value)}
              disabled={loading || configured === false || bulkBusy}
              style={bulkToolbarSelectStyle()}
              title="Step 2 — analyst verdict"
            >
              <option value="">Verdict…</option>
              {VERDICTS.map(a => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              style={{
                ...btnStyle(true),
                opacity: selectedIds.size && bulkMitigateAction && bulkVerdictChoice ? 1 : 0.45,
              }}
              disabled={
                loading ||
                configured === false ||
                bulkBusy ||
                selectedIds.size === 0 ||
                !bulkMitigateAction ||
                !bulkVerdictChoice
              }
              onClick={runBulkPipeline}
              title="Runs mitigate → analyst-verdict → resolve for selected threats (single confirmation)"
            >
              {bulkBusy && bulkOp === 'pipeline'
                ? 'Running pipeline…'
                : `Mitigate → verdict → resolve (${selectedIds.size})`}
            </button>
            <span className="badge badge-teal">{loading ? '…' : rows.length}</span>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 11,
              fontFamily: 'var(--mono)',
              minWidth: 720,
            }}
          >
            <thead>
              <tr style={{ color: TEXT3, textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, width: 36 }}>
                  <input
                    ref={headerSelectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    disabled={loading || configured === false || rows.length === 0}
                    aria-label="Select all threats on this page"
                  />
                </th>
                {['Threat', 'AI / class', 'Verdict', 'Incident', 'Endpoint', 'Reported', 'Engine', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const pending = busyId === row.id
                return (
                  <tr key={row.id} style={{ color: TEXT2 }}>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, verticalAlign: 'middle' }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => toggleSelectRow(row.id)}
                        disabled={pending || bulkBusy || configured === false}
                        aria-label={`Select threat ${row.threatName}`}
                      />
                    </td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, maxWidth: 280 }}>
                      <button
                        type="button"
                        disabled={configured === false || pending || bulkBusy}
                        onClick={() => setDetailThreatId(row.id)}
                        title="Threat details"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          margin: 0,
                          color: ACCENT,
                          fontFamily: 'var(--mono)',
                          fontSize: 11,
                          cursor: configured === false || pending || bulkBusy ? 'default' : 'pointer',
                          textAlign: 'left',
                          fontWeight: 600,
                          textDecoration: 'underline',
                          textDecorationColor: `${ACCENT}66`,
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          display: 'block',
                        }}
                      >
                        {row.threatName}
                      </button>
                    </td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{row.confidenceLevel}</td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{row.analystVerdict}</td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{row.incidentStatus}</td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{row.agentComputerName}</td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>
                      {row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, maxWidth: 160 }}>{row.detectingEngine}</td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}` }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        <select
                          style={selectStyle()}
                          disabled={pending || configured === false}
                          defaultValue=""
                          onChange={e => {
                            const v = e.target.value
                            e.target.value = ''
                            if (v) runMitigate(row.id, v)
                          }}
                          title="Mitigation"
                        >
                          <option value="">Mitigate…</option>
                          {MITIGATE_ACTIONS.map(a => (
                            <option key={a.value} value={a.value}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                        <select
                          style={selectStyle()}
                          disabled={pending || configured === false}
                          defaultValue=""
                          onChange={e => {
                            const v = e.target.value
                            e.target.value = ''
                            if (v) runVerdict(row.id, v)
                          }}
                          title="Analyst verdict"
                        >
                          <option value="">Verdict…</option>
                          {VERDICTS.map(a => (
                            <option key={a.value} value={a.value}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                        <button type="button" style={{ ...btnStyle(false), color: GREEN }} disabled={pending || configured === false} onClick={() => runResolve(row.id)}>
                          Resolve
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!loading && configured !== false && rows.length === 0 && (
            <div style={{ textAlign: 'center', color: TEXT3, padding: 28, fontFamily: 'var(--mono)' }}>No threats for current filters</div>
          )}
        </div>
        {nextCursor && (
          <div style={{ padding: '12px 14px', borderTop: `1px solid ${BORDER}` }}>
            <button type="button" style={btnStyle(false)} disabled={loading} onClick={loadMore}>
              Load more
            </button>
          </div>
        )}
      </div>

      <S1ThreatDetailModal
        open={detailThreatId != null}
        threatId={detailThreatId || ''}
        onClose={() => setDetailThreatId(null)}
        onAfterMutation={loadFirstPage}
      />
    </div>
  )
}

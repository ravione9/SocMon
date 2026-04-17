import { useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import api from '../../api/client'
import { useSentinelHostGroups } from '../../hooks/useSentinelHostGroups.js'
import RangePicker from '../ui/RangePicker.jsx'
import { useResizableColumns, ResizableColGroup, ResizableTh } from '../ui/ResizableTable.jsx'

const SENTINEL_LOG_LABELS = ['Time', 'Host group', 'Host', 'User', 'Severity', 'Category', 'Event action', 'Message']
const SENTINEL_LOG_COL_DEFAULTS = [160, 140, 130, 110, 72, 110, 120, 320]

const C = {
  accent: '#14b8a6',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
  bg3: 'var(--bg3)',
  border: 'var(--border)',
}

function Input({ label, value, onChange, placeholder, width = '100%' }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: 0.5 }}>{label}</div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width,
          padding: '6px 10px',
          background: C.bg3,
          border: `1px solid ${C.border}`,
          borderRadius: 7,
          color: C.text,
          fontSize: 11,
          fontFamily: 'var(--mono)',
          outline: 'none',
        }}
      />
    </div>
  )
}

/**
 * Sentinel index log viewer + analyze strip (drill-down from XDR widgets).
 * @param {{ scope: 'all'|'no_usb'|'usb_only'|'bt_only', range: object, onRangeChange: function, drill: object|null, showAnalyze: boolean, hideRangePicker?: boolean, accentColor?: string, hostGroupSync?: string, onDrillClear?: () => void }}
 */
export default function SentinelLogSearch({
  scope,
  range,
  onRangeChange,
  drill,
  showAnalyze = true,
  hideRangePicker = false,
  accentColor,
  hostGroupSync = '',
  endpointsSync = '',
  onDrillClear,
}) {
  const accent = accentColor || C.accent
  const accentFillFg = typeof accent === 'string' && accent.includes('var(') ? 'var(--on-accent)' : '#ffffff'
  const [draft, setDraft] = useState({
    q: '',
    endpoint: '',
    hostGroup: '',
    user: '',
    usbDevice: '',
    bluetoothDevice: '',
    eventKind: '',
    eventAction: '',
  })
  const [applied, setApplied] = useState({
    q: '',
    endpoint: '',
    hostGroup: '',
    user: '',
    usbDevice: '',
    bluetoothDevice: '',
    eventKind: '',
    eventAction: '',
  })
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(50)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [exporting, setExporting] = useState(false)

  const { widths: sentColW, startResize: sentResize, sumWidth: sentTableMin } = useResizableColumns(
    'sentinel-log-table',
    SENTINEL_LOG_COL_DEFAULTS,
  )

  const setD = (k, v) => setDraft(p => ({ ...p, [k]: v }))

  /** Layout effect so drill merges into filters before the fetch effect runs (avoids one stale request). */
  useLayoutEffect(() => {
    if (!drill) return
    if (drill._clear) {
      const empty = {
        q: '',
        endpoint: '',
        hostGroup: '',
        user: '',
        usbDevice: '',
        bluetoothDevice: '',
        eventKind: '',
        eventAction: '',
      }
      setDraft(empty)
      setApplied(empty)
      setPage(0)
      return
    }
    const next = { ...drill }
    delete next._clear
    setDraft(d => ({ ...d, ...next }))
    setApplied(d => ({ ...d, ...next }))
    setPage(0)
  }, [drill])

  const scopeParam = useMemo(() => {
    const s = String(scope || 'all').toLowerCase()
    if (s === 'bluetooth_only') return 'bt_only'
    if (s === 'no_usb' || s === 'usb_only' || s === 'bt_only') return s
    return 'all'
  }, [scope])

  const { groups: hostGroupsFromLog, loading: hostGroupsLoading } = useSentinelHostGroups(range, scope)

  const hostGroupSelectOptions = useMemo(() => {
    const set = new Set(hostGroupsFromLog)
    for (const x of [draft.hostGroup, applied.hostGroup].map(s => String(s || '').trim()).filter(Boolean)) {
      set.add(x)
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [hostGroupsFromLog, draft.hostGroup, applied.hostGroup])

  /**
   * One URLSearchParams for range + filters (proper encoding for ISO dates with + / :).
   * Export uses POST + application/x-www-form-urlencoded so params always reach the API behind proxies.
   */
  const buildSentinelListQueryString = useCallback(
    (extraPairs = []) => {
      const p = new URLSearchParams()
      p.set('range', range?.value || '')
      if (range?.from) p.set('from', range.from)
      if (range?.to) p.set('to', range.to)
      p.set('scope', scopeParam)
      for (const [k, v] of extraPairs) p.set(k, String(v))
      const a = applied
      const effectiveHostGroup = (a.hostGroup.trim() || hostGroupSync || '').trim()
      if (a.q.trim()) p.set('q', a.q.trim())
      if (a.endpoint.trim()) p.set('endpoint', a.endpoint.trim())
      if (effectiveHostGroup) p.set('hostGroup', effectiveHostGroup)
      if (a.user.trim()) p.set('user', a.user.trim())
      if (scopeParam === 'usb_only' && a.usbDevice.trim()) p.set('usbDevice', a.usbDevice.trim())
      if (scopeParam === 'bt_only' && a.bluetoothDevice.trim()) p.set('bluetoothDevice', a.bluetoothDevice.trim())
      if (a.eventKind) p.set('eventKind', a.eventKind)
      if (a.eventAction?.trim()) p.set('eventAction', a.eventAction.trim())
      if (endpointsSync) p.set('endpoints', endpointsSync)
      return p.toString()
    },
    [range, scopeParam, applied, hostGroupSync, endpointsSync],
  )

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const q = buildSentinelListQueryString([
        ['page', String(page)],
        ['size', String(size)],
      ])
      const { data } = await api.get(`/api/sentinel/events?${q}`)
      setRows(data.hits || [])
      setTotal(data.total ?? 0)
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to load')
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [buildSentinelListQueryString, page, size])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  const analyzeChips = useMemo(() => {
    const chips = []
    chips.push({ k: 'Scope', v: scopeParam })
    if (applied.q.trim()) chips.push({ k: 'Query', v: applied.q.trim() })
    if (applied.endpoint.trim()) chips.push({ k: 'Endpoint', v: applied.endpoint.trim() })
    if (applied.hostGroup.trim()) chips.push({ k: 'Host group', v: applied.hostGroup.trim() })
    else if (hostGroupSync.trim()) chips.push({ k: 'Host group', v: `${hostGroupSync.trim()} (dashboard)` })
    if (applied.user.trim()) chips.push({ k: 'User', v: applied.user.trim() })
    if (applied.usbDevice.trim()) chips.push({ k: 'USB device', v: applied.usbDevice.trim() })
    if (applied.bluetoothDevice.trim()) chips.push({ k: 'Bluetooth device', v: applied.bluetoothDevice.trim() })
    if (applied.eventKind) chips.push({ k: 'Event kind', v: applied.eventKind })
    if (applied.eventAction?.trim()) chips.push({ k: 'event.action', v: applied.eventAction.trim() })
    return chips
  }, [scopeParam, applied, hostGroupSync])

  function clearAnalyze() {
    const empty = {
      q: '',
      endpoint: '',
      hostGroup: '',
      user: '',
      usbDevice: '',
      bluetoothDevice: '',
      eventKind: '',
      eventAction: '',
    }
    setDraft(empty)
    setApplied(empty)
    setPage(0)
    onDrillClear?.()
  }

  function applyFilters() {
    setApplied({ ...draft })
    setPage(0)
  }

  const exportPageCsv = () => {
    if (!rows.length) return
    const headers = ['Time', 'Host group', 'Host', 'User', 'Severity', 'Category', 'Event action', 'Message']
    const esc = v => {
      const s = v == null ? '' : String(v)
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const lines = rows.map(row => {
      const t = row['@timestamp'] ? new Date(row['@timestamp']).toISOString() : ''
      return [
        t,
        row.hostGroup ?? '—',
        row.host ?? '—',
        row.user ?? '—',
        row.severity ?? '—',
        row.category ?? '—',
        row.eventAction ?? '—',
        esc(row.message ?? ''),
      ].join(',')
    })
    const csv = ['\ufeff' + headers.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `netpulse-xdr-page-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportAllExcel = async () => {
    if (exporting || total <= 0) return
    setExporting(true)
    const tid = toast.loading('Exporting…')
    try {
      const cap = 100000
      const capped = total > cap
      const maxRows = String(capped ? cap : Math.max(total, 1))
      const qs = buildSentinelListQueryString([['maxRows', maxRows]])
      const res = await api.post('/api/sentinel/events/export', qs, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'blob',
        timeout: 600000,
      })
      const blob = res.data
      if (blob.type && blob.type.includes('json')) {
        const text = await blob.text()
        const j = JSON.parse(text)
        throw new Error(j.error || 'Export failed')
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers['content-disposition']
      const fn = cd && /filename="?([^";]+)"?/i.exec(cd)
      a.download = fn ? fn[1] : 'netpulse-xdr-sentinel-export.csv'
      a.click()
      URL.revokeObjectURL(url)
      toast.success(
        capped
          ? `Download started — first ${cap.toLocaleString()} rows (Excel CSV). Narrow filters for more.`
          : 'Download started (open in Excel)',
        { id: tid },
      )
    } catch (err) {
      let msg = err.message || 'Export failed'
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text()
          const j = JSON.parse(text)
          if (j.error) msg = j.error
        } catch {
          /* keep */
        }
      } else if (err.response?.data?.error) {
        msg = err.response.data.error
      }
      toast.error(msg, { id: tid })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!hideRangePicker && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
            {loading ? 'Loading…' : `${total.toLocaleString()} hits`}
          </span>
          <RangePicker range={range} onChange={onRangeChange} accentColor={accent} />
        </div>
      )}
      {hideRangePicker && (
        <div style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
          {loading ? 'Loading…' : `${total.toLocaleString()} hits`} · range uses page control above
        </div>
      )}

      {showAnalyze && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            border: `1px solid ${C.border}`,
            background: 'var(--bg3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: accent, fontFamily: 'var(--mono)', letterSpacing: 1 }}>ANALYZE FILTER</span>
            <button
              type="button"
              onClick={clearAnalyze}
              style={{
                fontSize: 10,
                fontFamily: 'var(--mono)',
                padding: '4px 10px',
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: 'transparent',
                color: C.text2,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {analyzeChips.map(c => (
              <span
                key={`${c.k}-${c.v}`}
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--mono)',
                  padding: '3px 8px',
                  borderRadius: 6,
                  background: `${accent}18`,
                  border: `1px solid ${accent}44`,
                  color: C.text,
                }}
              >
                <span style={{ color: C.text3 }}>{c.k}:</span> {c.v}
              </span>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <Input label="Search (message)" value={draft.q} onChange={v => setD('q', v)} placeholder="Text…" />
            <Input label="Endpoint / hostname" value={draft.endpoint} onChange={v => setD('endpoint', v)} />
            <div style={{ marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: C.text3,
                  fontFamily: 'var(--mono)',
                  marginBottom: 4,
                  letterSpacing: 0.5,
                }}
              >
                Host group
              </div>
              <select
                value={draft.hostGroup}
                onChange={e => setD('hostGroup', e.target.value)}
                title={
                  hostGroupsLoading
                    ? 'Loading host groups from logs…'
                    : 'Distinct host groups seen in logs for this time range and scope'
                }
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  background: C.bg3,
                  border: `1px solid ${C.border}`,
                  borderRadius: 7,
                  color: C.text,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  cursor: 'pointer',
                }}
              >
                <option value="">Any</option>
                {hostGroupSelectOptions.map(g => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <Input label="User" value={draft.user} onChange={v => setD('user', v)} />
            {scopeParam === 'usb_only' && (
              <Input label="USB device" value={draft.usbDevice} onChange={v => setD('usbDevice', v)} />
            )}
            {scopeParam === 'bt_only' && (
              <Input label="Bluetooth device" value={draft.bluetoothDevice} onChange={v => setD('bluetoothDevice', v)} />
            )}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 4 }}>EVENT KIND</div>
              <select
                value={draft.eventKind}
                onChange={e => setD('eventKind', e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  background: C.bg3,
                  border: `1px solid ${C.border}`,
                  borderRadius: 7,
                  color: C.text,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  cursor: 'pointer',
                }}
              >
                <option value="">Any</option>
                <option value="connected">Connected</option>
                <option value="disconnected">Disconnected</option>
                <option value="blocked">Blocked / mitigated</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 4 }}>
                EVENT.ACTION (EXACT)
              </div>
              <select
                value={draft.eventAction}
                onChange={e => setD('eventAction', e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  background: C.bg3,
                  border: `1px solid ${C.border}`,
                  borderRadius: 7,
                  color: C.text,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  cursor: 'pointer',
                }}
              >
                <option value="">Any</option>
                <option value="connected">connected</option>
                <option value="disconnected">disconnected</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={applyFilters}
            style={{
              marginTop: 4,
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              background: accent,
              color: accentFillFg,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'var(--mono)',
              cursor: 'pointer',
            }}
          >
            Apply & search
          </button>
        </div>
      )}

      {err && (
        <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245,83,79,0.12)', border: '1px solid rgba(245,83,79,0.35)', color: '#f5534f', fontSize: 12, fontFamily: 'var(--mono)' }}>
          {err}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '8px 12px',
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: 'var(--bg3)',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text, fontFamily: 'var(--mono)' }}>
          {total.toLocaleString()} results
        </span>
        <button
          type="button"
          onClick={exportPageCsv}
          disabled={rows.length === 0}
          style={{
            padding: '4px 12px',
            borderRadius: 7,
            border: `1px solid ${C.border}`,
            background: 'var(--bg4)',
            color: rows.length ? C.text2 : C.text3,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            cursor: rows.length ? 'pointer' : 'default',
          }}
        >
          ⬇ Page CSV ({rows.length})
        </button>
        <button
          type="button"
          onClick={exportAllExcel}
          disabled={exporting || total <= 0 || loading}
          title="Export all rows matching the current range and filters (UTF-8 CSV for Excel). Apply & search first if count is 0."
          style={{
            padding: '4px 12px',
            borderRadius: 7,
            border: `1px solid ${accent}55`,
            background: exporting || total <= 0 ? 'var(--bg4)' : `${accent}22`,
            color: exporting || total <= 0 ? C.text3 : C.text,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            cursor: exporting || total <= 0 ? 'default' : 'pointer',
            opacity: exporting ? 0.75 : 1,
          }}
        >
          {exporting ? '…' : '📊'} Export all (Excel){' '}
          {total > 0 ? `(${total.toLocaleString()})` : ''}
        </button>
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 10, border: `1px solid ${C.border}` }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            tableLayout: 'fixed',
            minWidth: sentTableMin,
          }}
        >
          <ResizableColGroup widths={sentColW} />
          <thead>
            <tr style={{ color: C.text3, textAlign: 'left', background: 'var(--bg3)' }}>
              {SENTINEL_LOG_LABELS.map((h, i) => (
                <ResizableTh
                  key={h}
                  columnIndex={i}
                  columnCount={SENTINEL_LOG_LABELS.length}
                  startResize={sentResize}
                  style={{
                    padding: '8px 10px',
                    borderBottom: `1px solid ${C.border}`,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row._id} style={{ color: C.text2 }}>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row['@timestamp'] ? new Date(row['@timestamp']).toLocaleString() : '—'}
                </td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.hostGroup ?? '—'}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.host}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.user}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.severity}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.category}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.eventAction ?? '—'}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', wordBreak: 'break-word' }}>{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <div style={{ textAlign: 'center', padding: 28, color: C.text3, fontFamily: 'var(--mono)' }}>No events in this range</div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={page <= 0}
          onClick={() => setPage(p => Math.max(0, p - 1))}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: 'var(--bg3)',
            color: C.text2,
            cursor: page <= 0 ? 'default' : 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 11,
          }}
        >
          Prev
        </button>
        <span style={{ fontSize: 11, color: C.text3, fontFamily: 'var(--mono)' }}>
          Page {page + 1} · {size} / page
        </span>
        <select
          value={size}
          onChange={e => { setSize(Number(e.target.value)); setPage(0) }}
          style={{ padding: '4px 8px', borderRadius: 6, background: 'var(--bg3)', border: `1px solid ${C.border}`, color: C.text, fontFamily: 'var(--mono)', fontSize: 11 }}
        >
          {[25, 50, 100, 200].map(n => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={(page + 1) * size >= total}
          onClick={() => setPage(p => p + 1)}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: 'var(--bg3)',
            color: C.text2,
            cursor: (page + 1) * size >= total ? 'default' : 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 11,
          }}
        >
          Next
        </button>
      </div>
    </div>
  )
}

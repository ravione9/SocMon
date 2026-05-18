import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../../api/client'
import RangePicker from '../ui/RangePicker.jsx'
import {
  useResizableColumns,
  ResizableColGroup,
  ResizableTh,
} from '../ui/ResizableTable.jsx'

const C = {
  accent: '#14b8a6',
  text: 'var(--text)',
  text2: 'var(--text2)',
  text3: 'var(--text3)',
  bg2: 'var(--bg2)',
  bg3: 'var(--bg3)',
  bg4: 'var(--bg4)',
  border: 'var(--border)',
  amber: '#f5a623',
  red: '#f5534f',
  green: '#22d3a0',
  blue: '#4f7ef5',
  purple: '#7c5cfc',
}

const RECENT_KEY = 'netpulse-xdr-powerquery-recent'
const VISIBLE_COLS_KEY = 'netpulse-xdr-visible-columns'
const EXPORT_COLS_KEY = 'netpulse-xdr-export-columns'
const MAX_RECENTS = 12
const CELL_TRUNCATE_LEN = 100

const DEFAULT_RESULT_COLUMNS = [
  'timestamp',
  'event.type',
  'event.category',
  'endpoint.name',
  'user.name',
  'src.process.name',
  'src.process.parent.name',
  'tgt.process.name',
  'tgt.process.cmdline',
  'src.ip',
  'tgt.ip',
  'dns.query',
  'url.address',
  'registry.keyPath',
  'message',
]

const DETAIL_COLUMNS = [
  'timestamp',
  'event.type',
  'event.action',
  'event.category',
  'event.id',
  'dataset',
  'endpoint.name',
  'agent.uuid',
  'account.name',
  'site.name',
  'user.name',
  'src.process.name',
  'src.process.parent.name',
  'src.process.cmdline',
  'src.process.user',
  'tgt.process.name',
  'tgt.process.cmdline',
  'tgt.process.user',
  'src.ip',
  'src.port',
  'tgt.ip',
  'tgt.port',
  'dns.query',
  'url.address',
  'registry.keyPath',
  'registry.valueName',
  'message',
]

const ALL_COLUMN_OPTIONS = [...new Set([...DEFAULT_RESULT_COLUMNS, ...DETAIL_COLUMNS])]

const LONG_TEXT_FIELDS = new Set([
  'tgt.process.cmdline',
  'src.process.cmdline',
  'message',
  'url.address',
  'registry.keyPath',
  'registry.valueName',
])

function loadVisibleColumns() {
  try {
    const raw = localStorage.getItem(VISIBLE_COLS_KEY)
    if (!raw) return [...DEFAULT_RESULT_COLUMNS]
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length ? arr.filter(c => typeof c === 'string') : [...DEFAULT_RESULT_COLUMNS]
  } catch {
    return [...DEFAULT_RESULT_COLUMNS]
  }
}

function saveVisibleColumns(cols) {
  try {
    localStorage.setItem(VISIBLE_COLS_KEY, JSON.stringify(cols))
  } catch {
    /* ignore */
  }
}

function loadExportColumns() {
  try {
    const raw = localStorage.getItem(EXPORT_COLS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(c => typeof c === 'string') : []
  } catch {
    return []
  }
}

function saveExportColumns(cols) {
  try {
    localStorage.setItem(EXPORT_COLS_KEY, JSON.stringify(cols))
  } catch {
    /* ignore */
  }
}

function buildDisplayQuery(input, fetchLimit, columnList) {
  let q = String(input || '').trim()
  if (!q) return q
  const cols =
    Array.isArray(columnList) && columnList.length ? columnList : DEFAULT_RESULT_COLUMNS
  if (/\|\s*columns\b/i.test(q)) {
    if (Array.isArray(columnList) && columnList.length) {
      q = q.replace(/\|\s*columns\s+[^|]+/i, `| columns ${cols.join(',')}`)
    }
  } else {
    q = `${q} | columns ${cols.join(',')}`
  }
  if (!/\|\s*limit\s+\d+/i.test(q)) {
    q = `${q} | limit ${Math.max(1, Math.min(fetchLimit || 50000, 200000))}`
  }
  return q
}

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string').slice(0, MAX_RECENTS) : []
  } catch {
    return []
  }
}

function saveRecent(q) {
  try {
    const next = [q, ...loadRecents().filter(x => x !== q)].slice(0, MAX_RECENTS)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    return next
  } catch {
    return loadRecents()
  }
}

/** Find the word under the caret so the suggestion dropdown can show the right context. */
function analyzeCursor(text, caret) {
  const upTo = text.slice(0, caret)
  const cmpJustAfterOp = /([A-Za-z_@][A-Za-z0-9_.@-]*)\s*(=|!=|<>|contains|starts\s+with|ends\s+with|in|matches)\s*['"]?([^'"\s)]*)$/i.exec(upTo)
  if (cmpJustAfterOp) {
    return { mode: 'value', field: cmpJustAfterOp[1], token: cmpJustAfterOp[3] || '' }
  }
  const opPartial = /([A-Za-z_@][A-Za-z0-9_.@-]*)\s+([a-z][a-z\s]*)$/i.exec(upTo)
  if (opPartial && !/['"]/.test(opPartial[2])) {
    return { mode: 'operator', field: opPartial[1], token: opPartial[2].trim() }
  }
  const tokenMatch = /([A-Za-z_@][A-Za-z0-9_.@-]*)$/.exec(upTo)
  const token = tokenMatch ? tokenMatch[1] : ''
  return { mode: 'field', field: '', token }
}

function replaceTokenAtCaret(text, caret, replacement) {
  const upTo = text.slice(0, caret)
  const rest = text.slice(caret)
  const stripped = upTo.replace(/([A-Za-z_@][A-Za-z0-9_.@-]*)$/, '')
  const next = `${stripped}${replacement}`
  return { text: next + rest, caret: next.length }
}

function rangeToBody(range) {
  const out = {}
  if (range?.value) out.range = range.value
  if (range?.from) out.from = range.from
  if (range?.to) out.to = range.to
  return out
}

function formatCellValue(v) {
  if (v == null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const TIMESTAMP_KEYS = ['event.time', '@timestamp', 'time', 'timestamp']

const DEFAULT_RAW_PATH = '/api/powerQuery'
const DEFAULT_RAW_BODY = `{
  "query": "event.type = 'Process Creation' | limit 50",
  "startTime": ${Date.now() - 12 * 3600 * 1000},
  "endTime": ${Date.now()}
}`

export default function SentinelQueryDataSearch({ range, onRangeChange }) {
  const [mode, setMode] = useState('powerquery') // 'powerquery' | 'raw'
  const [query, setQuery] = useState('')
  const [caret, setCaret] = useState(0)
  const [columns, setColumns] = useState([])
  const [rows, setRows] = useState([])
  const [matchingEvents, setMatchingEvents] = useState(null)
  const [omittedEvents, setOmittedEvents] = useState(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [errDetail, setErrDetail] = useState(null) // { attempts: [...], upstream: {…} }
  const [lastAttempt, setLastAttempt] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [recents, setRecents] = useState(() => loadRecents())
  const [expandedRow, setExpandedRow] = useState(null)
  const [expandedRowData, setExpandedRowData] = useState(null)
  const [expandedRowLoading, setExpandedRowLoading] = useState(false)
  const [appliedQuery, setAppliedQuery] = useState('')
  const [configured, setConfigured] = useState(true)
  const [xdrBaseUrl, setXdrBaseUrl] = useState('')
  const [fetchLimit, setFetchLimit] = useState(50000)
  const [tablePage, setTablePage] = useState(0)
  const [selectedColumns, setSelectedColumns] = useState(() => loadVisibleColumns())
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  const [expandedCells, setExpandedCells] = useState(() => new Set())
  const [allCellsExpanded, setAllCellsExpanded] = useState(false)
  const [fieldCatalog, setFieldCatalog] = useState([])
  const [inspectColumns, setInspectColumns] = useState([])
  const [exportPickerOpen, setExportPickerOpen] = useState(false)
  const [exportColumns, setExportColumns] = useState([])
  const tablePageSize = 500

  // Raw mode state
  const [rawMethod, setRawMethod] = useState('POST')
  const [rawPath, setRawPath] = useState(DEFAULT_RAW_PATH)
  const [rawBody, setRawBody] = useState(DEFAULT_RAW_BODY)
  const [rawAuth, setRawAuth] = useState('auto')
  const [rawResp, setRawResp] = useState(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawErr, setRawErr] = useState(null)

  const inputRef = useRef(null)
  const suggestTimer = useRef(null)

  const pagedRows = useMemo(() => {
    const start = tablePage * tablePageSize
    return rows.slice(start, start + tablePageSize)
  }, [rows, tablePage])
  const totalPages = Math.max(1, Math.ceil(rows.length / tablePageSize))

  const displayColumns = useMemo(() => {
    if (!columns.length) return []
    const picked = selectedColumns.filter(c => columns.includes(c))
    if (picked.length) return picked
    return columns
  }, [columns, selectedColumns])

  const colWidths = useMemo(() => {
    const base = []
    for (const c of displayColumns) {
      base.push(
        TIMESTAMP_KEYS.includes(c)
          ? 180
          : LONG_TEXT_FIELDS.has(c)
            ? 200
            : c === 'endpoint.name' || c === 'host.name'
              ? 150
              : 140,
      )
    }
    return base.length ? base : [200]
  }, [displayColumns])
  const { widths, startResize, sumWidth } = useResizableColumns(
    `xdr-pq-table-${displayColumns.length}`,
    colWidths,
  )

  const toggleCellExpand = (cellKey, e) => {
    e?.stopPropagation()
    setExpandedCells(prev => {
      const next = new Set(prev)
      if (next.has(cellKey)) next.delete(cellKey)
      else next.add(cellKey)
      return next
    })
  }

  const collapseAllCells = () => {
    setExpandedCells(new Set())
    setAllCellsExpanded(false)
  }

  const expandAllLongCells = () => {
    const keys = new Set()
    rows.forEach((row, ri) => {
      const rowId = row._id || row.id || ri
      for (const c of displayColumns) {
        const text = formatCellValue(row[c])
        if (LONG_TEXT_FIELDS.has(c) || text.length > CELL_TRUNCATE_LEN) {
          keys.add(`${rowId}:${c}`)
        }
      }
    })
    setExpandedCells(keys)
    setAllCellsExpanded(true)
  }

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/sentinel-one/xdr/configured')
      .then(({ data }) => {
        if (cancelled) return
        setConfigured(!!data.configured)
        setXdrBaseUrl(data.xdrBaseUrl || '')
      })
      .catch(() => {})
    api
      .get('/api/sentinel-one/xdr/fields')
      .then(({ data }) => {
        if (cancelled) return
        if (Array.isArray(data.fields) && data.fields.length) {
          setFieldCatalog(data.fields.map(f => (typeof f === 'string' ? f : f.name)).filter(Boolean))
        }
      })
      .catch(() => {})
    api
      .get('/api/sentinel-one/xdr/columns')
      .then(({ data }) => {
        if (cancelled) return
        if (Array.isArray(data.inspectColumns) && data.inspectColumns.length) {
          setInspectColumns(data.inspectColumns.filter(c => typeof c === 'string'))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const columnOptions = useMemo(() => {
    const fromApi = fieldCatalog.length ? fieldCatalog : []
    return [...new Set([...fromApi, ...ALL_COLUMN_OPTIONS, ...columns])].sort((a, b) => a.localeCompare(b))
  }, [fieldCatalog, columns])

  /** All fields available in Inspect Log Line + query catalog (for export picker). */
  const exportColumnOptions = useMemo(() => {
    const inspect = inspectColumns.length ? inspectColumns : []
    return [...new Set([...inspect, ...columnOptions, ...columns])].sort((a, b) => a.localeCompare(b))
  }, [inspectColumns, columnOptions, columns])

  const runSearch = useCallback(
    async qOverride => {
      const q = (qOverride != null ? qOverride : query).trim()
      if (!q) {
        toast('Type a PowerQuery first — e.g. event.type = \'Process Creation\'', { icon: 'ℹ' })
        return
      }
      const effectiveQuery = buildDisplayQuery(q, fetchLimit, selectedColumns)
      setLoading(true)
      setErr(null)
      setErrDetail(null)
      setExpandedRow(null)
      setExpandedRowData(null)
      setExpandedCells(new Set())
      setAllCellsExpanded(false)
      try {
        const body = {
          q: effectiveQuery,
          limit: fetchLimit,
          columns: selectedColumns,
          ...rangeToBody(range),
        }
        const { data } = await api.post('/api/sentinel-one/xdr/powerQuery', body, { timeout: 180000 })
        setColumns(data.columns || [])
        setRows(data.rows || [])
        setMatchingEvents(data.matchingEvents ?? null)
        setOmittedEvents(data.omittedEvents ?? null)
        setStatus(data.status || '')
        setAppliedQuery(q)
        setLastAttempt(data.attempt || null)
        setRecents(saveRecent(q))
        setTablePage(0)
      } catch (e) {
        const data = e.response?.data || {}
        setErr(data.error || e.message || 'PowerQuery failed')
        setErrDetail({
          attempts: Array.isArray(data.attempts) ? data.attempts : [],
          upstream: data.upstream || null,
          upstreamStatus: data.upstreamStatus ?? null,
          hint: data.hint || null,
        })
        setColumns([])
        setRows([])
        setMatchingEvents(null)
        setOmittedEvents(null)
        setStatus('')
        setLastAttempt(null)
      } finally {
        setLoading(false)
      }
    },
    [query, fetchLimit, range, selectedColumns],
  )

  const runRaw = useCallback(async () => {
    setRawLoading(true)
    setRawErr(null)
    setRawResp(null)
    let parsedBody
    try {
      parsedBody = rawBody.trim() ? JSON.parse(rawBody) : null
    } catch (e) {
      setRawErr(`Body is not valid JSON: ${e.message}`)
      setRawLoading(false)
      return
    }
    try {
      const { data } = await api.post(
        '/api/sentinel-one/xdr/raw',
        {
          method: rawMethod,
          path: rawPath,
          body: parsedBody,
          authScheme: rawAuth,
        },
        { timeout: 180000 },
      )
      setRawResp(data)
    } catch (e) {
      const data = e.response?.data || {}
      setRawErr(data.error || e.message || 'Raw call failed')
      setRawResp(data && (data.attempts || data.upstream) ? data : null)
    } finally {
      setRawLoading(false)
    }
  }, [rawMethod, rawPath, rawBody, rawAuth])

  // When range / pageSize change after a successful run, re-run the same query so the
  // table stays in sync with the time-window picker.
  useEffect(() => {
    if (!appliedQuery) return
    runSearch(appliedQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.value, range?.from, range?.to, fetchLimit])

  useEffect(() => {
    if (tablePage < totalPages) return
    setTablePage(Math.max(0, totalPages - 1))
  }, [tablePage, totalPages])

  const loadEventDetail = useCallback(
    async row => {
      const tsKey = ['timestamp', 'event.time', '@timestamp', 'time', 'ts'].find(k => row?.[k] != null)
      const tsRaw = tsKey ? row?.[tsKey] : null
      const eventId = row?.['event.id']
      const traceId = row?.['trace.id']
      if (tsRaw == null && !eventId && !traceId) {
        setExpandedRowData(row)
        return
      }
      setExpandedRowLoading(true)
      try {
        const body = {
          timestamp: tsRaw != null ? Number(tsRaw) : undefined,
          eventId,
          traceId,
          columns: Object.keys(row || {}).filter(Boolean),
          ...rangeToBody(range),
        }
        const { data } = await api.post('/api/sentinel-one/xdr/powerQuery/event-detail', body, {
          timeout: 120000,
        })
        const detail = data.row && typeof data.row === 'object' ? data.row : row
        setExpandedRowData({ ...row, ...detail })
      } catch {
        setExpandedRowData(row)
      } finally {
        setExpandedRowLoading(false)
      }
    },
    [range],
  )

  const addColumnFromInspect = useCallback(
    col => {
      if (!col || selectedColumns.includes(col)) return
      const next = [...selectedColumns, col]
      setSelectedColumns(next)
      saveVisibleColumns(next)
      toast.success(`Added "${col}" to table columns`)
    },
    [selectedColumns],
  )

  // Suggestion fetcher — parameters come from backend field catalog.
  useEffect(() => {
    if (!suggestOpen) return
    if (suggestTimer.current) clearTimeout(suggestTimer.current)
    const ctx = analyzeCursor(query, caret)
    suggestTimer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams()
        params.set('prefix', ctx.token || '')
        params.set('mode', ctx.mode || 'field')
        if (ctx.field) params.set('field', ctx.field)
        params.set('limit', '50')
        const extra = [...new Set([...columns, ...fieldCatalog])]
        if (extra.length) params.set('extraFields', extra.join(','))
        const { data } = await api.get(`/api/sentinel-one/xdr/suggest?${params.toString()}`)
        const list = data.suggestions || []
        setSuggestions(list)
        setHighlight(0)
      } catch {
        setSuggestions([])
      }
    }, 80)
    return () => clearTimeout(suggestTimer.current)
  }, [query, caret, suggestOpen, columns, fieldCatalog])

  const onQueryChange = e => {
    setQuery(e.target.value)
    setCaret(e.target.selectionStart || e.target.value.length)
    setSuggestOpen(true)
  }

  const applySuggestion = useCallback(
    s => {
      if (!s) return
      if (s.kind === 'template') {
        setQuery(s.text)
        setCaret(s.text.length)
        setSuggestOpen(false)
        requestAnimationFrame(() => inputRef.current?.focus())
        return
      }
      let replacement = s.text
      if (s.kind === 'operator') replacement = ` ${s.text} `
      const { text: nextText, caret: nextCaret } = replaceTokenAtCaret(query, caret, replacement)
      let final = nextText
      let finalCaret = nextCaret
      if (s.kind === 'field') {
        final = `${nextText.slice(0, nextCaret)} = ${nextText.slice(nextCaret)}`
        finalCaret = nextCaret + 3
      } else if (s.kind === 'value') {
        const quoted = `'${String(s.text).replace(/'/g, "\\'")}'`
        final = `${nextText.slice(0, nextCaret)}${quoted}${nextText.slice(nextCaret)}`
        finalCaret = nextCaret + quoted.length
      }
      setQuery(final)
      setCaret(finalCaret)
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          inputRef.current.setSelectionRange(finalCaret, finalCaret)
        }
      })
    },
    [query, caret],
  )

  const onQueryKeyDown = e => {
    if (e.key === 'ArrowDown') {
      if (!suggestOpen) setSuggestOpen(true)
      else if (suggestions.length) {
        e.preventDefault()
        setHighlight(h => (h + 1) % suggestions.length)
      }
    } else if (e.key === 'ArrowUp') {
      if (suggestions.length) {
        e.preventDefault()
        setHighlight(h => (h - 1 + suggestions.length) % suggestions.length)
      }
    } else if (e.key === 'Tab' && suggestOpen && suggestions.length) {
      e.preventDefault()
      applySuggestion(suggestions[highlight])
    } else if (e.key === 'Enter') {
      if (suggestOpen && suggestions.length) {
        const s = suggestions[highlight]
        if (s && s.kind !== 'template') {
          e.preventDefault()
          applySuggestion(s)
          return
        }
        if (s && s.kind === 'template') {
          e.preventDefault()
          setQuery(s.text)
          setCaret(s.text.length)
          setSuggestOpen(false)
          runSearch(s.text)
          return
        }
      }
      e.preventDefault()
      setSuggestOpen(false)
      runSearch(query)
    } else if (e.key === 'Escape') {
      setSuggestOpen(false)
    }
  }

  const openExportPicker = () => {
    if (!appliedQuery) {
      toast('Run a query first', { icon: 'ℹ' })
      return
    }
    const saved = loadExportColumns()
    const initial =
      saved.length > 0
        ? saved.filter(c => exportColumnOptions.includes(c))
        : selectedColumns.length
          ? [...selectedColumns]
          : [...DEFAULT_RESULT_COLUMNS]
    setExportColumns(initial.length ? initial : [...DEFAULT_RESULT_COLUMNS])
    setExportPickerOpen(true)
  }

  const runExport = async cols => {
    if (exporting || !appliedQuery) return
    const exportCols = Array.isArray(cols) && cols.length ? cols : DEFAULT_RESULT_COLUMNS
    setExportPickerOpen(false)
    setExporting(true)
    saveExportColumns(exportCols)
    const tid = toast.loading('Exporting PowerQuery results…')
    try {
      const maxRows = Math.max(1, Math.min(Number(matchingEvents || fetchLimit || 200000), 200000))
      const exportQuery = buildDisplayQuery(appliedQuery, maxRows, exportCols)
      const body = {
        q: exportQuery,
        maxRows,
        columns: exportCols,
        ...rangeToBody(range),
      }
      const res = await api.post('/api/sentinel-one/xdr/powerQuery/export', body, {
        responseType: 'blob',
        timeout: 1200000,
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
      a.download = fn ? fn[1] : 'netpulse-xdr-powerquery-export.csv'
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Download started (open in Excel)', { id: tid })
    } catch (e) {
      toast.error(e.message || 'Export failed', { id: tid })
    } finally {
      setExporting(false)
    }
  }

  const clearAll = () => {
    setQuery('')
    setSuggestOpen(false)
    setAppliedQuery('')
    setRows([])
    setColumns([])
    setMatchingEvents(null)
    setOmittedEvents(null)
    setTablePage(0)
    setExpandedRow(null)
    setExpandedRowData(null)
    setExpandedRowLoading(false)
    setExpandedCells(new Set())
    setAllCellsExpanded(false)
  }

  const applyColumnSelection = cols => {
    setSelectedColumns(cols)
    saveVisibleColumns(cols)
    setColumnPickerOpen(false)
    if (appliedQuery) runSearch(appliedQuery)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          padding: '14px 16px',
          borderRadius: 10,
          border: `1px solid ${C.border}`,
          background: C.bg2,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: C.accent, fontFamily: 'var(--mono)', letterSpacing: 1 }}>
              XDR QUERY DATA SEARCH
            </span>
            <span
              style={{
                fontSize: 9,
                fontFamily: 'var(--mono)',
                padding: '2px 8px',
                borderRadius: 5,
                background: 'rgba(124,92,252,0.12)',
                border: '1px solid rgba(124,92,252,0.35)',
                color: C.purple,
              }}
              title="Queries execute against the SentinelOne Singularity Data Lake (XDR) PowerQuery API."
            >
              SINGULARITY DATA LAKE
            </span>
            {xdrBaseUrl && (
              <span style={{ fontSize: 9, color: C.text3, fontFamily: 'var(--mono)' }}>{xdrBaseUrl}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                display: 'inline-flex',
                background: C.bg3,
                borderRadius: 7,
                padding: 2,
                border: `1px solid ${C.border}`,
              }}
            >
              {[
                { id: 'powerquery', label: 'PowerQuery' },
                { id: 'raw', label: 'Raw' },
              ].map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  style={{
                    padding: '4px 12px',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: 'var(--mono)',
                    border: 'none',
                    borderRadius: 5,
                    background: mode === m.id ? C.accent : 'transparent',
                    color: mode === m.id ? '#0a0e1a' : C.text2,
                    cursor: 'pointer',
                    letterSpacing: 0.5,
                  }}
                  title={
                    m.id === 'powerquery'
                      ? 'Type a SentinelOne PowerQuery and render the rows in a table.'
                      : 'Send an arbitrary HTTP request to the configured SentinelOne XDR base URL — useful when a query needs a custom path/body that the standard PowerQuery wrapper does not cover.'
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
            <RangePicker range={range} onChange={onRangeChange} accentColor={C.accent} />
          </div>
        </div>

        {!configured && (
          <div
            style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 8,
              background: 'rgba(245,166,35,0.12)',
              border: '1px solid rgba(245,166,35,0.4)',
              color: C.amber,
              fontSize: 11,
              fontFamily: 'var(--mono)',
            }}
          >
            SentinelOne XDR Data Lake is not configured on the server. Add
            <code style={{ marginLeft: 4, color: C.text }}>SENTINEL_ONE_XDR_BASE_URL</code> (e.g.
            <code style={{ marginLeft: 4, color: C.text }}>https://xdr.ap1.sentinelone.net</code>) and
            <code style={{ marginLeft: 4, color: C.text }}>SENTINEL_ONE_XDR_API_TOKEN</code> (Log Read Access) and restart the API.
          </div>
        )}

        {mode === 'powerquery' && (
        <>
        <div style={{ position: 'relative' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'stretch',
              gap: 0,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              background: C.bg3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '0 10px',
                display: 'flex',
                alignItems: 'center',
                color: C.text3,
                fontFamily: 'var(--mono)',
                fontSize: 12,
                borderRight: `1px solid ${C.border}`,
                background: 'var(--bg4)',
              }}
            >
              {loading ? '…' : '⌕'}
            </div>
            <input
              ref={inputRef}
              value={query}
              onChange={onQueryChange}
              onKeyDown={onQueryKeyDown}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 180)}
              onClick={e => setCaret(e.target.selectionStart || 0)}
              onKeyUp={e => setCaret(e.target.selectionStart || 0)}
              placeholder="PowerQuery, e.g. tgt.process.name = 'RemoteOptometry.exe' AND tgt.process.cmdline contains '--type=gpu-process' AND event.type = 'Process Creation'"
              spellCheck={false}
              style={{
                flex: 1,
                padding: '12px 12px',
                background: 'transparent',
                border: 'none',
                color: C.text,
                fontSize: 13,
                fontFamily: 'var(--mono)',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => {
                setSuggestOpen(false)
                runSearch(query)
              }}
              disabled={loading || !configured}
              style={{
                padding: '0 18px',
                background: configured ? C.accent : C.bg4,
                color: configured ? '#0a0e1a' : C.text3,
                fontSize: 12,
                fontWeight: 700,
                fontFamily: 'var(--mono)',
                border: 'none',
                cursor: loading ? 'wait' : configured ? 'pointer' : 'not-allowed',
                letterSpacing: 0.5,
              }}
            >
              {loading ? 'Running…' : 'Run query'}
            </button>
          </div>

          {suggestOpen && suggestions.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: 4,
                background: C.bg2,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
                zIndex: 30,
                maxHeight: 360,
                overflowY: 'auto',
              }}
            >
              {suggestions.map((s, i) => {
                const showHeader = i === 0 || suggestions[i - 1]?.category !== s.category
                return (
                  <div key={`${s.kind}-${s.text}-${i}`}>
                    {showHeader && (
                      <div
                        style={{
                          padding: '6px 12px',
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: 1,
                          color: C.text3,
                          background: C.bg3,
                          borderBottom: `1px solid ${C.border}`,
                        }}
                      >
                        {s.category || 'FIELDS'}
                      </div>
                    )}
                    <div
                      onMouseDown={e => {
                        e.preventDefault()
                        if (s.kind === 'template') {
                          setQuery(s.text)
                          setCaret(s.text.length)
                          setSuggestOpen(false)
                          runSearch(s.text)
                        } else {
                          applySuggestion(s)
                        }
                      }}
                      onMouseEnter={() => setHighlight(i)}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        background: i === highlight ? `${C.accent}1a` : 'transparent',
                        borderBottom: `1px solid ${C.border}`,
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: C.text,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <span style={{ flex: 1, color: C.text }}>{s.text}</span>
                      {s.hint && s.kind !== 'value' && (
                        <span style={{ fontSize: 10, color: C.text3, maxWidth: '48%', textAlign: 'right' }}>
                          {s.hint}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {recents.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', marginBottom: 4, letterSpacing: 0.5 }}>
              RECENT QUERIES
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {recents.map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    setQuery(r)
                    setCaret(r.length)
                    setSuggestOpen(false)
                    runSearch(r)
                  }}
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                    padding: '3px 8px',
                    borderRadius: 5,
                    border: `1px solid ${C.accent}55`,
                    background: `${C.accent}18`,
                    color: C.text,
                    cursor: 'pointer',
                    maxWidth: 360,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
        </>
        )}

        {mode === 'raw' && (
          <RawModePanel
            method={rawMethod}
            setMethod={setRawMethod}
            path={rawPath}
            setPath={setRawPath}
            body={rawBody}
            setBody={setRawBody}
            authScheme={rawAuth}
            setAuthScheme={setRawAuth}
            xdrBaseUrl={xdrBaseUrl}
            loading={rawLoading}
            err={rawErr}
            resp={rawResp}
            onSend={runRaw}
          />
        )}
      </div>

      {mode === 'powerquery' && err && (
        <div
          style={{
            padding: 10,
            borderRadius: 8,
            background: 'rgba(245,83,79,0.12)',
            border: '1px solid rgba(245,83,79,0.35)',
            color: '#f5534f',
            fontSize: 12,
            fontFamily: 'var(--mono)',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{err}</div>
          {errDetail?.hint && (
            <div style={{ color: C.amber, fontSize: 11, marginBottom: 6 }}>{errDetail.hint}</div>
          )}
          {errDetail?.attempts?.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: C.text2, fontWeight: 600 }}>
                {errDetail.attempts.length} endpoint(s) tried — click to see what SentinelOne returned
              </summary>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {errDetail.attempts.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.04)',
                      color: C.text2,
                      fontSize: 11,
                      wordBreak: 'break-all',
                    }}
                  >
                    <div style={{ color: C.text3, marginBottom: 2 }}>
                      <span style={{ color: a.status >= 200 && a.status < 300 ? C.green : C.red, fontWeight: 700 }}>
                        {a.status || '—'}
                      </span>{' '}
                      · {a.label}
                    </div>
                    <div style={{ color: C.text2 }}>{a.url}</div>
                    {a.body && <div style={{ color: C.text3, marginTop: 4, whiteSpace: 'pre-wrap' }}>{a.body}</div>}
                  </div>
                ))}
              </div>
            </details>
          )}
          <div style={{ marginTop: 8, fontSize: 10, color: C.text3 }}>
            Tip: switch to <strong style={{ color: C.text }}>Raw</strong> mode at the top to call any XDR endpoint with a
            custom body — useful when your tenant exposes PowerQuery at a non-standard path.
          </div>
        </div>
      )}
      {mode === 'powerquery' && !err && lastAttempt?.url && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 10,
            color: C.text3,
            fontFamily: 'var(--mono)',
          }}
          title={lastAttempt.label}
        >
          ✓ Returned by {lastAttempt.url}
        </div>
      )}

      {mode === 'powerquery' && (
      <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '8px 12px',
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: C.bg3,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text, fontFamily: 'var(--mono)' }}>
          Showing {pagedRows.length.toLocaleString()} / {rows.length.toLocaleString()} rows · page {Math.min(tablePage + 1, totalPages)} of {totalPages}
          {matchingEvents != null && matchingEvents !== rows.length && (
            <span style={{ color: C.text3, fontWeight: 400 }}>
              {' '}· matched {matchingEvents.toLocaleString()}
            </span>
          )}
          {status && (
            <span style={{ color: C.text3, fontWeight: 400 }}>
              {' '}· {status}
            </span>
          )}
        </span>
        {omittedEvents != null && omittedEvents > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              padding: '2px 8px',
              borderRadius: 5,
              background: 'rgba(245,166,35,0.15)',
              border: '1px solid rgba(245,166,35,0.4)',
              color: C.amber,
            }}
            title="SentinelOne truncated the result set due to PowerQuery memory limits. Narrow the query or shorten the range."
          >
            {omittedEvents.toLocaleString()} rows omitted
          </span>
        )}
        {appliedQuery && (
          <span
            style={{
              fontSize: 10,
              color: C.text3,
              fontFamily: 'var(--mono)',
              maxWidth: 420,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={appliedQuery}
          >
            Query: {appliedQuery}
          </span>
        )}
        <button
          type="button"
          onClick={clearAll}
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
          Clear
        </button>
        <button
          type="button"
          onClick={() => setColumnPickerOpen(o => !o)}
          style={{
            fontSize: 10,
            fontFamily: 'var(--mono)',
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${columnPickerOpen ? C.accent : C.border}`,
            background: columnPickerOpen ? `${C.accent}18` : 'transparent',
            color: columnPickerOpen ? C.accent : C.text2,
            cursor: 'pointer',
          }}
        >
          Columns ({selectedColumns.length})
        </button>
        {rows.length > 0 && (
          <>
            <button
              type="button"
              onClick={allCellsExpanded ? collapseAllCells : expandAllLongCells}
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
              {allCellsExpanded ? 'Collapse long text' : 'Expand long text'}
            </button>
          </>
        )}
        <label style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
          Fetch rows
          <select
            value={fetchLimit}
            onChange={e => setFetchLimit(Number(e.target.value))}
            style={{
              marginLeft: 6,
              padding: '3px 6px',
              borderRadius: 5,
              background: C.bg3,
              border: `1px solid ${C.border}`,
              color: C.text,
              fontSize: 11,
              fontFamily: 'var(--mono)',
            }}
          >
            {[10000, 50000, 100000, 200000].map(n => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
          500 / page
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setTablePage(p => Math.max(0, p - 1))}
          disabled={tablePage <= 0}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: tablePage <= 0 ? C.bg4 : 'transparent',
            color: tablePage <= 0 ? C.text3 : C.text2,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            cursor: tablePage <= 0 ? 'default' : 'pointer',
          }}
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => setTablePage(p => Math.min(totalPages - 1, p + 1))}
          disabled={tablePage >= totalPages - 1}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: tablePage >= totalPages - 1 ? C.bg4 : 'transparent',
            color: tablePage >= totalPages - 1 ? C.text3 : C.text2,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            cursor: tablePage >= totalPages - 1 ? 'default' : 'pointer',
          }}
        >
          Next
        </button>
        <button
          type="button"
          onClick={openExportPicker}
          disabled={exporting || !appliedQuery}
          title="Choose columns and export the full PowerQuery result set to CSV."
          style={{
            padding: '6px 14px',
            borderRadius: 7,
            border: `1px solid ${C.accent}55`,
            background: exporting || !appliedQuery ? C.bg4 : `${C.accent}22`,
            color: exporting || !appliedQuery ? C.text3 : C.text,
            fontSize: 11,
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            cursor: exporting || !appliedQuery ? 'default' : 'pointer',
            opacity: exporting ? 0.75 : 1,
          }}
        >
          {exporting ? 'Exporting…' : 'Export all (CSV)'}
        </button>
      </div>

      {columnPickerOpen && (
        <ColumnPickerPanel
          options={columnOptions}
          selected={selectedColumns}
          onChange={setSelectedColumns}
          onApply={() => applyColumnSelection(selectedColumns)}
          onSelectAll={() => setSelectedColumns([...columnOptions])}
          onReset={() => setSelectedColumns([...DEFAULT_RESULT_COLUMNS])}
          onClose={() => setColumnPickerOpen(false)}
        />
      )}

      {exportPickerOpen && (
        <ExportColumnModal
          options={exportColumnOptions}
          selected={exportColumns}
          onChange={setExportColumns}
          onSelectAllInspect={() => setExportColumns([...exportColumnOptions])}
          onUseTableColumns={() => setExportColumns([...selectedColumns])}
          onReset={() => setExportColumns([...DEFAULT_RESULT_COLUMNS])}
          onExport={() => runExport(exportColumns)}
          onClose={() => setExportPickerOpen(false)}
          exporting={exporting}
        />
      )}

      <div style={{ overflowX: 'auto', borderRadius: 10, border: `1px solid ${C.border}` }}>
        {displayColumns.length > 0 ? (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 11,
              fontFamily: 'var(--mono)',
              tableLayout: 'fixed',
              minWidth: sumWidth,
            }}
          >
            <ResizableColGroup widths={widths} />
            <thead>
              <tr style={{ color: C.text3, textAlign: 'left', background: C.bg3 }}>
                {displayColumns.map((h, i) => (
                  <ResizableTh
                    key={h + i}
                    columnIndex={i}
                    columnCount={displayColumns.length}
                    startResize={startResize}
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
              {pagedRows.map((row, idx) => {
                const absoluteIdx = tablePage * tablePageSize + idx
                const rowId = row._id || row.id || absoluteIdx
                const isOpen = expandedRow === rowId
                return (
                  <tr
                    key={rowId}
                    onClick={() => {
                      if (isOpen) {
                        setExpandedRow(null)
                        setExpandedRowData(null)
                        setExpandedRowLoading(false)
                        return
                      }
                      setExpandedRow(rowId)
                      setExpandedRowData(row)
                      loadEventDetail(row)
                    }}
                    style={{ color: C.text2, cursor: 'pointer' }}
                    title={isOpen ? 'Click to collapse' : 'Click to expand full event'}
                  >
                    {displayColumns.map((c, i) => {
                      const cellKey = `${rowId}:${c}`
                      const cellExpanded = expandedCells.has(cellKey)
                      return (
                        <TableCell
                          key={c + i}
                          col={c}
                          value={row[c]}
                          expanded={cellExpanded}
                          onToggle={e => toggleCellExpand(cellKey, e)}
                        />
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ textAlign: 'center', padding: 28, color: C.text3, fontFamily: 'var(--mono)' }}>
            {loading
              ? 'Running PowerQuery against the SentinelOne Data Lake…'
              : appliedQuery
                ? 'No rows returned by this PowerQuery in the selected range.'
                : 'Enter a PowerQuery above and press Enter / Run query to begin.'}
          </div>
        )}

        {expandedRow != null && (
          <InspectLogLinePanel
            row={expandedRowData}
            loading={expandedRowLoading}
            onClose={() => {
              setExpandedRow(null)
              setExpandedRowData(null)
              setExpandedRowLoading(false)
            }}
            onFieldFilter={(field, value) => {
              const v = String(value).replace(/'/g, "\\'")
              const next = query ? `${query} AND ${field} = '${v}'` : `${field} = '${v}'`
              setQuery(next)
              setCaret(next.length)
              runSearch(next)
            }}
            onAddColumn={addColumnFromInspect}
            tableColumns={selectedColumns}
          />
        )}
      </div>
      </>
      )}
    </div>
  )
}

function TableCell({ col, value, expanded, onToggle }) {
  const text =
    TIMESTAMP_KEYS.includes(col) && value != null && value !== ''
      ? safeDate(value)
      : formatCellValue(value)
  const isLong = LONG_TEXT_FIELDS.has(col) || text.length > CELL_TRUNCATE_LEN
  const truncated = isLong && !expanded && text.length > CELL_TRUNCATE_LEN
  const shown = truncated ? `${text.slice(0, CELL_TRUNCATE_LEN)}…` : text

  return (
    <td
      style={{
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        overflow: 'hidden',
        verticalAlign: 'top',
        maxHeight: expanded ? 'none' : 72,
        whiteSpace: TIMESTAMP_KEYS.includes(col) ? 'nowrap' : expanded ? 'pre-wrap' : 'nowrap',
        textOverflow: 'ellipsis',
        wordBreak: expanded ? 'break-word' : 'normal',
      }}
    >
      <span title={truncated ? text : undefined}>{shown}</span>
      {isLong && text.length > CELL_TRUNCATE_LEN && (
        <button
          type="button"
          onClick={onToggle}
          style={{
            display: 'block',
            marginTop: 4,
            padding: 0,
            border: 'none',
            background: 'none',
            color: C.accent,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      )}
    </td>
  )
}

function ColumnPickerPanel({ options, selected, onChange, onApply, onSelectAll, onReset, onClose }) {
  const toggle = col => {
    if (selected.includes(col)) onChange(selected.filter(c => c !== col))
    else onChange([...selected, col])
  }
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        background: C.bg2,
        padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text, fontFamily: 'var(--mono)' }}>
          Table & CSV columns
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onSelectAll}
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              padding: '3px 8px',
              borderRadius: 5,
              border: `1px solid ${C.border}`,
              background: 'transparent',
              color: C.text2,
              cursor: 'pointer',
            }}
          >
            Select all
          </button>
          <button
            type="button"
            onClick={onReset}
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              padding: '3px 8px',
              borderRadius: 5,
              border: `1px solid ${C.border}`,
              background: 'transparent',
              color: C.text2,
              cursor: 'pointer',
            }}
          >
            Default
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              padding: '3px 8px',
              borderRadius: 5,
              border: `1px solid ${C.border}`,
              background: 'transparent',
              color: C.text3,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 6,
          maxHeight: 220,
          overflowY: 'auto',
          fontSize: 10,
          fontFamily: 'var(--mono)',
        }}
      >
        {options.map(col => (
          <label
            key={col}
            style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text2, cursor: 'pointer' }}
          >
            <input type="checkbox" checked={selected.includes(col)} onChange={() => toggle(col)} />
            {col}
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={onApply}
        style={{
          marginTop: 10,
          padding: '6px 14px',
          borderRadius: 7,
          border: `1px solid ${C.accent}55`,
          background: `${C.accent}22`,
          color: C.text,
          fontSize: 11,
          fontFamily: 'var(--mono)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Apply & re-run query
      </button>
    </div>
  )
}

function ExportColumnModal({
  options,
  selected,
  onChange,
  onSelectAllInspect,
  onUseTableColumns,
  onReset,
  onExport,
  onClose,
  exporting,
}) {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const filtered = q ? options.filter(c => c.toLowerCase().includes(q)) : options

  const toggle = col => {
    if (selected.includes(col)) onChange(selected.filter(c => c !== col))
    else onChange([...selected, col])
  }

  const btnStyle = {
    fontSize: 10,
    fontFamily: 'var(--mono)',
    padding: '4px 10px',
    borderRadius: 5,
    border: `1px solid ${C.border}`,
    background: 'transparent',
    color: C.text2,
    cursor: 'pointer',
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(7,10,18,0.72)',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(720px, 96vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.bg2,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Export CSV — select columns</span>
          </div>
          <p style={{ margin: '0 0 10px', fontSize: 11, color: C.text3, fontFamily: 'var(--mono)' }}>
            Choose fields to include in the export. All Inspect Log Line fields are available ({options.length} total).
            Selected: {selected.length}
          </p>
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter columns…"
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: C.bg3,
              color: C.text,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            <button type="button" onClick={onSelectAllInspect} style={btnStyle} disabled={exporting}>
              Select all (inspect)
            </button>
            <button type="button" onClick={onUseTableColumns} style={btnStyle} disabled={exporting}>
              Use table columns
            </button>
            <button type="button" onClick={onReset} style={btnStyle} disabled={exporting}>
              Default set
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              style={btnStyle}
              disabled={exporting}
            >
              Clear all
            </button>
          </div>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 6,
            fontSize: 10,
            fontFamily: 'var(--mono)',
          }}
        >
          {filtered.map(col => (
            <label
              key={col}
              style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text2, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={selected.includes(col)}
                onChange={() => toggle(col)}
                disabled={exporting}
              />
              {col}
            </label>
          ))}
          {filtered.length === 0 && (
            <div style={{ gridColumn: '1 / -1', color: C.text3, padding: 12 }}>No columns match filter</div>
          )}
        </div>
        <div
          style={{
            padding: '12px 16px',
            borderTop: `1px solid ${C.border}`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button type="button" onClick={onClose} style={btnStyle} disabled={exporting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!selected.length) {
                toast.error('Select at least one column to export')
                return
              }
              onExport()
            }}
            disabled={exporting || !selected.length}
            style={{
              padding: '8px 18px',
              borderRadius: 7,
              border: `1px solid ${C.accent}55`,
              background: exporting || !selected.length ? C.bg4 : `${C.accent}22`,
              color: exporting || !selected.length ? C.text3 : C.text,
              fontSize: 11,
              fontFamily: 'var(--mono)',
              fontWeight: 600,
              cursor: exporting || !selected.length ? 'default' : 'pointer',
            }}
          >
            {exporting ? 'Exporting…' : `Export CSV (${selected.length} columns)`}
          </button>
        </div>
      </div>
    </div>
  )
}

function safeDate(v) {
  try {
    let raw = v
    if (typeof raw === 'string' && /^\d+$/.test(raw)) raw = Number(raw)
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 1e15) {
      // SentinelOne Data Lake often returns timestamps as epoch nanoseconds.
      raw = Math.floor(raw / 1_000_000)
    }
    const d = typeof raw === 'number' ? new Date(raw) : new Date(String(raw))
    if (Number.isNaN(d.getTime())) return String(v)
    return d.toLocaleString()
  } catch {
    return String(v)
  }
}

const INSPECT_VALUE_TRUNCATE = 200
const SERVER_FIELD_RE = /^@|^_/

function formatInspectValue(key, value) {
  if (value == null || value === '') return ''
  if (TIMESTAMP_KEYS.includes(key)) return safeDate(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function buildInspectEntries(row) {
  if (!row || typeof row !== 'object') return { event: [], server: [] }
  const keys = Object.keys(row).filter(k => k !== '_id' && k !== 'id' && row[k] != null && row[k] !== '')
  const event = []
  const server = []
  for (const k of keys.sort((a, b) => a.localeCompare(b))) {
    const entry = [k, row[k]]
    if (SERVER_FIELD_RE.test(k) || k.startsWith('dataSource.')) server.push(entry)
    else event.push(entry)
  }
  return { event, server }
}

const inspectBtnStyle = {
  fontSize: 10,
  fontFamily: 'var(--mono)',
  padding: '4px 8px',
  borderRadius: 5,
  border: `1px solid ${C.border}`,
  background: 'transparent',
  color: C.text2,
  cursor: 'pointer',
}

function InspectLogLinePanel({ row, loading, onClose, onFieldFilter, onAddColumn, tableColumns }) {
  const [fieldFilter, setFieldFilter] = useState('')
  const [expandedValues, setExpandedValues] = useState(() => new Set())
  const { event: eventEntries, server: serverEntries } = useMemo(() => buildInspectEntries(row), [row])

  const filterFn = ([k, v]) => {
    const q = fieldFilter.trim().toLowerCase()
    if (!q) return true
    const text = formatInspectValue(k, v).toLowerCase()
    return k.toLowerCase().includes(q) || text.includes(q)
  }
  const filteredEvent = eventEntries.filter(filterFn)
  const filteredServer = serverEntries.filter(filterFn)

  const copyJson = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(row, null, 2))
      toast.success('Event JSON copied')
    } catch {
      toast.error('Could not copy')
    }
  }
  const copyLink = () => {
    try {
      const ts = row?.timestamp ?? row?.['event.time']
      navigator.clipboard.writeText(
        `${window.location.href.split('#')[0]}#xdr-ts=${encodeURIComponent(String(ts ?? ''))}`,
      )
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy link')
    }
  }
  const toggleValueExpand = key => {
    setExpandedValues(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!row) return null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex' }}>
      <div style={{ flex: 1, background: 'rgba(7,10,18,0.55)' }} onClick={onClose} aria-hidden />
      <div
        style={{
          width: 'min(540px, 92vw)',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: C.bg2,
          borderLeft: `1px solid ${C.border}`,
          boxShadow: '-12px 0 48px rgba(0,0,0,0.35)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Inspect Log Line</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {loading && <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>Loading…</span>}
              <button type="button" onClick={copyLink} style={inspectBtnStyle}>Copy link</button>
              <button type="button" onClick={copyJson} style={inspectBtnStyle}>Copy JSON</button>
              <button type="button" onClick={onClose} style={inspectBtnStyle} title="Close">✕</button>
            </div>
          </div>
          <input
            type="text"
            value={fieldFilter}
            onChange={e => setFieldFilter(e.target.value)}
            placeholder="Filter fields"
            style={{
              marginTop: 10,
              width: '100%',
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: C.bg3,
              color: C.text,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, fontFamily: 'var(--mono)' }}>
          <InspectFieldSection
            entries={filteredEvent}
            expandedValues={expandedValues}
            onToggleExpand={toggleValueExpand}
            onFieldFilter={onFieldFilter}
            onAddColumn={onAddColumn}
            tableColumns={tableColumns}
          />
          {filteredServer.length > 0 && (
            <>
              <div style={{ padding: '10px 16px 6px', fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: C.text3, borderTop: `1px solid ${C.border}`, background: C.bg3 }}>
                SERVER FIELDS
              </div>
              <InspectFieldSection
                entries={filteredServer}
                expandedValues={expandedValues}
                onToggleExpand={toggleValueExpand}
                onFieldFilter={onFieldFilter}
                onAddColumn={onAddColumn}
                tableColumns={tableColumns}
              />
            </>
          )}
          {!loading && filteredEvent.length === 0 && filteredServer.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: C.text3 }}>No fields match filter</div>
          )}
        </div>
      </div>
    </div>
  )
}

function InspectFieldSection({ entries, expandedValues, onToggleExpand, onFieldFilter, onAddColumn, tableColumns }) {
  return entries.map(([k, v]) => (
    <InspectFieldRow
      key={k}
      fieldKey={k}
      value={v}
      expanded={expandedValues.has(k)}
      onToggleExpand={() => onToggleExpand(k)}
      onFilter={() => {
        const text = formatInspectValue(k, v)
        if (text) onFieldFilter?.(k, text)
      }}
      onAddColumn={() => onAddColumn?.(k)}
      inTable={tableColumns?.includes(k)}
    />
  ))
}

function InspectFieldRow({ fieldKey, value, expanded, onToggleExpand, onFilter, onAddColumn, inTable }) {
  const text = formatInspectValue(fieldKey, value)
  const isLong = LONG_TEXT_FIELDS.has(fieldKey) || text.length > INSPECT_VALUE_TRUNCATE
  const shown =
    isLong && !expanded && text.length > INSPECT_VALUE_TRUNCATE
      ? `${text.slice(0, INSPECT_VALUE_TRUNCATE)}…`
      : text

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 42%) 1fr', gap: '0 12px', padding: '10px 16px', borderBottom: `1px solid ${C.border}`, alignItems: 'start' }}>
      <div style={{ color: C.text, fontWeight: 500, wordBreak: 'break-word', cursor: 'pointer', lineHeight: 1.4 }} title="Click field name to add to query" onClick={onFilter}>
        {fieldKey}
      </div>
      <div style={{ color: C.text2, lineHeight: 1.45, minWidth: 0 }}>
        <div style={{ wordBreak: 'break-word', whiteSpace: expanded ? 'pre-wrap' : 'normal', maxHeight: expanded ? 'none' : isLong ? 60 : 'none', overflow: expanded ? 'visible' : 'hidden' }}>
          {shown || <span style={{ color: C.text3 }}>—</span>}
        </div>
        {isLong && text.length > INSPECT_VALUE_TRUNCATE && (
          <button type="button" onClick={e => { e.stopPropagation(); onToggleExpand() }} style={{ marginTop: 4, padding: 0, border: 'none', background: 'none', color: C.accent, fontSize: 10, cursor: 'pointer', fontFamily: 'var(--mono)' }}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {onAddColumn && (
          <button type="button" onClick={e => { e.stopPropagation(); onAddColumn() }} disabled={inTable} style={{ display: 'block', marginTop: 6, padding: '2px 0', border: 'none', background: 'none', color: inTable ? C.text3 : C.blue, fontSize: 10, cursor: inTable ? 'default' : 'pointer', fontFamily: 'var(--mono)' }}>
            {inTable ? 'In table' : '+ Add to table'}
          </button>
        )}
      </div>
    </div>
  )
}

const RAW_TEMPLATES = [
  {
    label: 'PowerQuery — Process Creation (last 12h)',
    method: 'POST',
    path: '/api/powerQuery',
    body: () =>
      JSON.stringify(
        {
          query: "event.type = 'Process Creation' | limit 50",
          startTime: Date.now() - 12 * 3600 * 1000,
          endTime: Date.now(),
        },
        null,
        2,
      ),
  },
  {
    label: 'PowerQuery — RemoteOptometry GPU process',
    method: 'POST',
    path: '/api/powerQuery',
    body: () =>
      JSON.stringify(
        {
          query:
            "tgt.process.name = 'RemoteOptometry.exe' AND tgt.process.cmdline contains '--type=gpu-process' AND event.type = 'Process Creation'",
          startTime: Date.now() - 24 * 3600 * 1000,
          endTime: Date.now(),
        },
        null,
        2,
      ),
  },
  {
    label: 'Legacy DV — submit query',
    method: 'POST',
    path: '/web/api/v2.1/dv/init-query',
    body: () =>
      JSON.stringify(
        {
          query: "EventType = 'Process Creation' AND TgtProcName = 'RemoteOptometry.exe'",
          fromDate: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
          toDate: new Date().toISOString(),
        },
        null,
        2,
      ),
  },
  {
    label: 'Tenant info ping',
    method: 'GET',
    path: '/api/v1/users/me',
    body: () => '',
  },
]

function RawModePanel({
  method,
  setMethod,
  path,
  setPath,
  body,
  setBody,
  authScheme,
  setAuthScheme,
  xdrBaseUrl,
  loading,
  err,
  resp,
  onSend,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select
          value={method}
          onChange={e => setMethod(e.target.value)}
          style={{
            padding: '6px 8px',
            background: C.bg3,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            color: C.text,
            fontFamily: 'var(--mono)',
            fontSize: 11,
          }}
        >
          {['POST', 'GET', 'PUT', 'DELETE'].map(m => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
          {xdrBaseUrl || '<SENTINEL_ONE_XDR_BASE_URL>'}
        </span>
        <input
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/api/powerQuery"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 240,
            padding: '6px 10px',
            background: C.bg3,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            color: C.text,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            outline: 'none',
          }}
        />
        <select
          value={authScheme}
          onChange={e => setAuthScheme(e.target.value)}
          title="Authorization scheme — 'auto' tries Bearer then ApiToken then Token."
          style={{
            padding: '6px 8px',
            background: C.bg3,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            color: C.text,
            fontFamily: 'var(--mono)',
            fontSize: 11,
          }}
        >
          {['auto', 'bearer', 'apitoken', 'token'].map(a => (
            <option key={a} value={a}>
              auth: {a}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onSend}
          disabled={loading || !path.trim()}
          style={{
            padding: '6px 18px',
            borderRadius: 7,
            border: 'none',
            background: loading ? C.bg4 : C.accent,
            color: loading ? C.text3 : '#0a0e1a',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            fontWeight: 700,
            cursor: loading ? 'wait' : 'pointer',
            letterSpacing: 0.5,
          }}
        >
          {loading ? 'Sending…' : 'Send'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 9, fontWeight: 600, color: C.text3, fontFamily: 'var(--mono)', letterSpacing: 0.5 }}>
          REQUEST BODY (JSON · empty for GET)
        </div>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          spellCheck={false}
          rows={8}
          style={{
            width: '100%',
            padding: '10px 12px',
            background: C.bg3,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            color: C.text,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            outline: 'none',
            resize: 'vertical',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {RAW_TEMPLATES.map(t => (
          <button
            key={t.label}
            type="button"
            onClick={() => {
              setMethod(t.method)
              setPath(t.path)
              setBody(t.body())
            }}
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              padding: '4px 10px',
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: C.bg3,
              color: C.text2,
              cursor: 'pointer',
            }}
            title={`${t.method} ${t.path}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {err && (
        <div
          style={{
            padding: 10,
            borderRadius: 8,
            background: 'rgba(245,83,79,0.12)',
            border: '1px solid rgba(245,83,79,0.35)',
            color: '#f5534f',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {err}
        </div>
      )}

      {resp && (
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            background: C.bg3,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'var(--mono)',
                padding: '2px 10px',
                borderRadius: 5,
                background:
                  resp.ok || (resp.status >= 200 && resp.status < 300)
                    ? 'rgba(34,211,160,0.15)'
                    : 'rgba(245,83,79,0.15)',
                color: resp.ok || (resp.status >= 200 && resp.status < 300) ? C.green : C.red,
              }}
            >
              HTTP {resp.status ?? '—'}
            </span>
            {resp.authScheme && (
              <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)' }}>
                auth: {resp.authScheme}
              </span>
            )}
            {resp.url && (
              <span style={{ fontSize: 10, color: C.text3, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                {resp.url}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => {
                const payload = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body, null, 2)
                navigator.clipboard?.writeText(payload).then(
                  () => toast.success('Copied response body'),
                  () => toast.error('Clipboard copy failed'),
                )
              }}
              style={{
                fontSize: 10,
                fontFamily: 'var(--mono)',
                padding: '3px 10px',
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: 'transparent',
                color: C.text2,
                cursor: 'pointer',
              }}
            >
              Copy body
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              maxHeight: 480,
              overflow: 'auto',
              padding: 12,
              background: C.bg2,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.text,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
{typeof resp.body === 'string' ? resp.body || resp.raw || '(empty)' : JSON.stringify(resp.body, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

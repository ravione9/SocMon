import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import toast from 'react-hot-toast'
import { DEFAULT_RANGE_PRESET } from '../../constants/timeRange.js'
import api from '../../api/client'
import RangePicker from './RangePicker.jsx'
import { getSevCategory } from '../../utils/logSeverity.js'
import { ciscoLoginFailureUserLabel, fortigateVpnUserLabel, logSearchDeviceLabel } from '../../utils/firewallIdentity.js'
import { useResizableColumns, ResizableColGroup, ResizableTh } from './ResizableTable.jsx'

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'var(--text)', text2:'var(--text2)', text3:'var(--text3)', bg2:'var(--bg2)', bg3:'var(--bg3)', bg4:'var(--bg4)', border:'var(--border)', border2:'var(--border2)' }

const SEV_COLORS = { critical: C.red, high: C.amber, medium: C.accent, low: C.green, info: C.cyan }

/** Safe string for table cells (Forti UTM sometimes nests msg / non-string fields). */
function strCell(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function deviceCell(e) {
  return strCell(logSearchDeviceLabel(e))
}

function fmt(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('en', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
}

function SevBadge({ e }) {
  const cat = getSevCategory(e)
  const color = SEV_COLORS[cat] || C.text2
  const label = String(e.syslog_severity_label || e.cisco_severity_label || cat || '')
    .slice(0, 4)
    .toUpperCase()
  return (
    <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, fontFamily:'var(--mono)', fontWeight:600,
      color, background: color + '20', border: `1px solid ${color}40`, whiteSpace:'nowrap' }}>
      {label}
    </span>
  )
}

function Input({ value, onChange, placeholder, width=110 }) {
  return (
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      style={{ width, padding:'5px 9px', background:C.bg3, border:`1px solid ${C.border}`,
        borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none' }} />
  )
}

function Sel({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ padding:'5px 9px', background:C.bg3, border:`1px solid ${C.border}`,
        borderRadius:7, color:C.text, fontSize:11, fontFamily:'var(--mono)', outline:'none', cursor:'pointer' }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function Btn({ label, onClick, color=C.accent, small, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: small ? '4px 10px' : '5px 14px',
      borderRadius:7, border:'none', background: disabled ? C.bg4 : color,
      color: disabled ? C.text3 : fillTextOnAccent(color),
      fontSize: small ? 10 : 11,
      fontWeight:600, fontFamily:'var(--mono)', cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1, transition:'all 0.15s', whiteSpace:'nowrap',
    }}>{label}</button>
  )
}

const PAGE_SIZES = [25, 50, 100, 200]
const LIVE_SIZES = [50, 100, 200, 500]

const SOC_FILTERS = { q:'', srcip:'', dstip:'', srccountry:'', dstcountry:'', action:'all', severity:'all', logtype:'all' }
const NOC_FILTERS = { q:'', device:'', mnemonic:'all', logtype:'all', severity:'all', site:'', iface:'', vlan:'' }

function fillTextOnAccent(accent) {
  return typeof accent === 'string' && accent.includes('var(') ? 'var(--on-accent)' : '#ffffff'
}

function drillActive(isFw, f) {
  if (!f || typeof f !== 'object') return false
  const skip = new Set(['action', 'logtype', 'severity', 'mnemonic'])
  for (const [k, v] of Object.entries(f)) {
    if (skip.has(k)) { if (v && v !== 'all') return true }
    else if (v != null && String(v).trim() !== '') return true
  }
  return false
}

export default function LogSearch({ type, accentColor, dashboardRange, initialFilters }) {
  const accent = accentColor || C.accent
  const modeFillFg = fillTextOnAccent(accent)
  const isFirewall = type === 'firewall'
  const baseF = isFirewall ? SOC_FILTERS : NOC_FILTERS
  const mergedInit = { ...baseF, ...(initialFilters || {}) }

  const [mode,       setMode]       = useState(() => (drillActive(isFirewall, initialFilters) ? 'range' : 'live'))
  const [liveSize,   setLiveSize]   = useState(50)
  const [range,      setRange]      = useState(() =>
    dashboardRange && (dashboardRange.value || (dashboardRange.from && dashboardRange.to))
      ? { ...dashboardRange }
      : { ...DEFAULT_RANGE_PRESET },
  )
  const [filters,    setFilters]    = useState(mergedInit)
  const [pageSize,   setPageSize]   = useState(50)
  const [page,       setPage]       = useState(0)

  const [results,  setResults]  = useState([])
  const [total,    setTotal]    = useState(0)
  const [aggs,     setAggs]     = useState({ by_severity: [], by_action: [] })
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [exporting, setExporting] = useState(false)

  const f = key => val => setFilters(p => ({ ...p, [key]: val }))

  /** Refetch in range/live when API-facing filters change (not free-text `q` — use Search for that). */
  const apiFilterKey = useMemo(() => {
    if (isFirewall) {
      return [
        filters.severity,
        filters.action,
        filters.logtype,
        filters.srcip,
        filters.dstip,
        filters.srccountry,
        filters.dstcountry,
      ].join('\0')
    }
    return [
      filters.severity,
      filters.device,
      filters.site,
      filters.mnemonic,
      filters.logtype,
      filters.iface,
      filters.vlan,
    ].join('\0')
  }, [isFirewall, filters])

  useEffect(() => {
    if (!dashboardRange) return
    setRange(dashboardRange)
  }, [dashboardRange?.type, dashboardRange?.value, dashboardRange?.from, dashboardRange?.to, dashboardRange?.label])

  // Build query params
  const buildParams = useCallback((overrides = {}) => {
    const p = new URLSearchParams()
    p.set('type', type)
    if (mode === 'live' || overrides.live) {
      if (range?.from && range?.to) {
        p.set('from', range.from)
        p.set('to', range.to)
      } else {
        p.set('range', range?.value || '1h')
      }
      p.set('size', String(Math.min(liveSize, 500)))
      p.set('page', '0')
    } else {
      p.set('range', range?.value || '')
      if (range?.from) p.set('from', range.from)
      if (range?.to)   p.set('to',   range.to)
      p.set('size', String(overrides.pageSize ?? pageSize))
      p.set('page', String(overrides.page     ?? page))
    }
    if (filters.q)        p.set('q',        filters.q)
    if (isFirewall) {
      if (filters.srcip)                          p.set('srcip',   filters.srcip)
      if (filters.dstip)                          p.set('dstip',   filters.dstip)
      if (filters.srccountry)                     p.set('srccountry', filters.srccountry)
      if (filters.dstcountry)                     p.set('dstcountry', filters.dstcountry)
      if (filters.action  && filters.action  !== 'all') p.set('action',  filters.action)
      if (filters.logtype && filters.logtype !== 'all') p.set('logtype', filters.logtype)
    } else {
      if (filters.device)                            p.set('device',   filters.device)
      if (filters.site)                              p.set('site',     filters.site)
      if (filters.mnemonic && filters.mnemonic !== 'all') p.set('mnemonic', filters.mnemonic)
      if (filters.logtype && filters.logtype !== 'all') p.set('logtype', filters.logtype)
      if (filters.iface)                             p.set('iface',    filters.iface)
      if (filters.vlan)                              p.set('vlan',     filters.vlan)
    }
    if (filters.severity && filters.severity !== 'all') p.set('severity', filters.severity)
    return p.toString()
  }, [type, mode, liveSize, range, pageSize, page, filters, isFirewall])

  /** Same time window + filters as search, for GET /api/logs/export (no pagination). */
  const buildExportParams = useCallback(() => {
    const p = new URLSearchParams()
    p.set('type', type)
    if (mode === 'live') {
      if (range?.from && range?.to) {
        p.set('from', range.from)
        p.set('to', range.to)
      } else {
        p.set('range', range?.value || '1h')
      }
    } else {
      p.set('range', range?.value || '')
      if (range?.from) p.set('from', range.from)
      if (range?.to) p.set('to', range.to)
    }
    if (filters.q) p.set('q', filters.q)
    if (isFirewall) {
      if (filters.srcip) p.set('srcip', filters.srcip)
      if (filters.dstip) p.set('dstip', filters.dstip)
      if (filters.srccountry) p.set('srccountry', filters.srccountry)
      if (filters.dstcountry) p.set('dstcountry', filters.dstcountry)
      if (filters.action && filters.action !== 'all') p.set('action', filters.action)
      if (filters.logtype && filters.logtype !== 'all') p.set('logtype', filters.logtype)
    } else {
      if (filters.device) p.set('device', filters.device)
      if (filters.site) p.set('site', filters.site)
      if (filters.mnemonic && filters.mnemonic !== 'all') p.set('mnemonic', filters.mnemonic)
      if (filters.logtype && filters.logtype !== 'all') p.set('logtype', filters.logtype)
      if (filters.iface) p.set('iface', filters.iface)
      if (filters.vlan) p.set('vlan', filters.vlan)
    }
    if (filters.severity && filters.severity !== 'all') p.set('severity', filters.severity)
    return p
  }, [type, mode, range, filters, isFirewall])

  const fetchData = useCallback(async (overrides = {}) => {
    try {
      if (!overrides.silent) setLoading(true)
      setError(null)
      const { data } = await api.get(`/api/logs/search?${buildParams(overrides)}`)
      setResults(data.hits)
      setTotal(data.total)
      setAggs(data.aggs)
    } catch (err) {
      setError(err.response?.data?.error || 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  const fetchDataRef = useRef(fetchData)
  fetchDataRef.current = fetchData

  // Live mode: single fetch when window/size/API filters change (no auto-polling)
  useEffect(() => {
    if (mode !== 'live') return
    fetchDataRef.current({ silent: true })
  }, [mode, liveSize, range, apiFilterKey])

  // Time range mode: fetch on range / page / API filters (no periodic refresh)
  useEffect(() => {
    if (mode !== 'range') return
    fetchDataRef.current()
  }, [mode, range, page, pageSize, apiFilterKey])

  const handleSearch = () => { setPage(0); fetchData({ page: 0 }) }

  const handleRangeChange = (r) => { setRange(r); setPage(0) }

  const switchMode = (m) => {
    setMode(m)
    setPage(0)
    setResults([])
    setTotal(0)
    setError(null)
  }

  // CSV export
  const exportCSV = () => {
    const headers = isFirewall
      ? ['Time','Severity','Device','User','Action','Src IP','Dst IP','Country','App/Type','Message']
      : ['Time','Severity','Device','User','Mnemonic','Interface','VLAN','Message']

    const rows = results.map(e => {
      const wrap = v => `"${String(v||'').replace(/"/g,'""')}"`
      const sev = isFirewall ? getSevCategory(e) : (e.syslog_severity_label || e.cisco_severity_label || '')
      if (isFirewall) return [
        fmt(e['@timestamp']), sev, logSearchDeviceLabel(e) || '—',
        fortigateVpnUserLabel(e) || '',
        e.fgt?.action||e['fgt.action']||'',
        e.fgt?.srcip||e['fgt.srcip']||'', e.fgt?.dstip||e['fgt.dstip']||'',
        e.fgt?.srccountry||e['fgt.srccountry']||'',
        e.fgt?.app||e['fgt.app']||e.fgt?.subtype||e['fgt.subtype']||'',
        wrap(e.fgt?.msg || e['fgt.msg'] || e.message || ''),
      ].join(',')
      return [
        fmt(e['@timestamp']),
        sev,
        e.device_name || '',
        ciscoLoginFailureUserLabel(e) || '',
        e.cisco_mnemonic || '',
        e.cisco_interface_full || '',
        e.cisco_vlan_id || '',
        wrap(e.cisco_message || ''),
      ].join(',')
    })

    const csv = ['\ufeff' + headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `netpulse-${type}-logs-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Server-side CSV (UTF-8 BOM) for full matching result set — same filters as Search, any custom / preset range. */
  const exportFullRangeExcel = async () => {
    if (exporting || total <= 0) return
    setExporting(true)
    const tid = toast.loading('Exporting…')
    try {
      const p = buildExportParams()
      const cap = 100000
      const capped = total > cap
      p.set('maxRows', String(capped ? cap : Math.max(total, 1)))
      const res = await api.post('/api/logs/export', p.toString(), {
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
      a.download = fn ? fn[1] : `netpulse-${type}-logs-export.csv`
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
          /* keep msg */
        }
      } else if (err.response?.data?.error) {
        msg = err.response.data.error
      }
      toast.error(msg, { id: tid })
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const showFwAuthUserCol =
    isFirewall && (filters.logtype === 'vpn' || filters.logtype === 'login_fail')
  const showNocLoginUserCol = !isFirewall && filters.logtype === 'login_fail'
  const fwTableCols = showFwAuthUserCol ? 10 : 9
  const nocTableCols = showNocLoginUserCol ? 8 : 7
  const tableColSpan = isFirewall ? fwTableCols : nocTableCols

  const logTableKey = isFirewall
    ? (showFwAuthUserCol ? 'logsearch-fw-10' : 'logsearch-fw-9')
    : (showNocLoginUserCol ? 'logsearch-noc-8' : 'logsearch-noc-7')

  const logDefaultWidths = useMemo(() => {
    if (isFirewall) {
      if (showFwAuthUserCol) {
        return [88, 72, 140, 120, 72, 120, 120, 88, 120, 320]
      }
      return [88, 72, 140, 72, 120, 120, 88, 120, 320]
    }
    if (showNocLoginUserCol) {
      return [88, 72, 140, 120, 100, 120, 72, 320]
    }
    return [88, 72, 140, 100, 120, 72, 320]
  }, [isFirewall, showFwAuthUserCol, showNocLoginUserCol])

  const logHeaders = useMemo(() => {
    if (isFirewall) {
      const h = ['Time', 'Severity', 'Device']
      if (showFwAuthUserCol) h.push('User')
      h.push('Action', 'Src IP', 'Dst IP', 'Country', 'App / Type', 'Message')
      return h
    }
    const h = ['Time', 'Severity', 'Device']
    if (showNocLoginUserCol) h.push('User')
    h.push('Mnemonic', 'Interface', 'VLAN', 'Message')
    return h
  }, [isFirewall, showFwAuthUserCol, showNocLoginUserCol])

  const { widths: logColWidths, startResize: logStartResize, sumWidth: logTableMinW } = useResizableColumns(
    logTableKey,
    logDefaultWidths,
  )

  // ── Severity stats: by_sev_cat is array [{ key, doc_count }] from API (ES 8 filters agg); fallback to terms agg ──
  const sevCats = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  const applyFromSevCatArray = arr => {
    if (!Array.isArray(arr)) return 0
    let sum = 0
    for (const b of arr) {
      const k = b?.key != null ? String(b.key) : ''
      if (k && Object.prototype.hasOwnProperty.call(sevCats, k) && typeof b.doc_count === 'number') {
        sevCats[k] = b.doc_count
        sum += b.doc_count
      }
    }
    return sum
  }
  let sevSum = applyFromSevCatArray(aggs.by_sev_cat)
  if (sevSum === 0) {
    Object.assign(sevCats, { critical: 0, high: 0, medium: 0, low: 0, info: 0 })
    const sevMap = {}
    ;(aggs.by_severity || []).forEach(b => {
      if (b && b.key != null) sevMap[String(b.key)] = b.doc_count
    })
    const rawTocat = {
      critical: 'critical', emergency: 'critical', alert: 'critical',
      error: 'high', warning: 'medium', warn: 'medium', notice: 'low', notification: 'low',
      information: 'info', informational: 'info', info: 'info', debug: 'info', debugging: 'info',
    }
    Object.entries(sevMap).forEach(([k, v]) => {
      const cat = rawTocat[k.toLowerCase()]
      if (cat) sevCats[cat] += v
    })
  }

  const actionMap = {}
  ;(aggs.by_action || []).forEach(b => {
    if (b && b.key != null) actionMap[String(b.key)] = b.doc_count
  })

  // ── Render helpers ────────────────────────────────────────────────────────
  const logThStyle = {
    padding: '7px 10px',
    textAlign: 'left',
    borderBottom: `1px solid ${C.border}`,
    color: C.text3,
    fontSize: 9,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontFamily: 'var(--mono)',
    whiteSpace: 'nowrap',
  }
  const td = (content, color = C.text2, extra = {}) => (
    <td
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid var(--border)',
        color,
        fontSize: 11,
        fontFamily: 'var(--mono)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        ...extra,
      }}
    >
      {content}
    </td>
  )

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

      {/* ── TOP BAR: mode toggle + live controls / range picker ── */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>

        {/* Mode toggle */}
        <div style={{ display:'flex', gap:2, background:'var(--bg3)', borderRadius:8, padding:3 }}>
          {['live','range'].map(m => (
            <button key={m} onClick={() => switchMode(m)} style={{
              padding:'5px 14px', fontSize:11, fontWeight:600, borderRadius:6,
              border:'none', cursor:'pointer', fontFamily:'var(--mono)', textTransform:'uppercase',
              background: mode===m ? accent : 'transparent',
              color: mode===m ? modeFillFg : C.text3, transition:'all 0.15s',
            }}>{m === 'live' ? '⬤ Live' : '⏱ Time Range'}</button>
          ))}
        </div>

        <RangePicker range={range} onChange={handleRangeChange} accentColor={accent} />

        {mode === 'live' ? (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>Max rows</span>
              <Sel value={liveSize} onChange={v => setLiveSize(Number(v))}
                options={LIVE_SIZES.map(s => ({ value:s, label:String(s) }))} />
            </div>
            <Btn label="↺ Refresh" onClick={() => fetchData()} disabled={loading} />
            <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>
              latest slice · use Refresh to update
            </span>
          </>
        ) : (
          <>
            <Btn label="↺ Refresh" onClick={handleSearch} disabled={loading} />
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>Rows</span>
              <Sel value={pageSize} onChange={v => { setPageSize(Number(v)); setPage(0) }}
                options={PAGE_SIZES.map(s => ({ value:s, label:String(s) }))} />
            </div>
            <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>
              manual refresh only
            </span>
          </>
        )}
      </div>

      {/* ── FILTER BAR ── */}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center',
        padding:'10px 14px', background:'var(--bg3)', borderRadius:10, border:`1px solid ${C.border}` }}>

        <Input value={filters.q} onChange={f('q')} placeholder="Search logs..." width={180} />

        {isFirewall ? (
          <>
            <Input value={filters.srcip} onChange={f('srcip')} placeholder="Src IP" />
            <Input value={filters.dstip} onChange={f('dstip')} placeholder="Dst IP" />
            <Input value={filters.srccountry} onChange={f('srccountry')} placeholder="Src country" width={100} />
            <Input value={filters.dstcountry} onChange={f('dstcountry')} placeholder="Dst country" width={100} />
            <Sel value={filters.action} onChange={f('action')} options={[
              {value:'all',label:'Action: All'},{value:'allow',label:'Allow'},{value:'deny',label:'Deny'},
            ]} />
            <Sel value={filters.logtype} onChange={f('logtype')} options={[
              {value:'all',label:'Type: All'},{value:'traffic',label:'Traffic'},
              {value:'utm',label:'UTM'},{value:'ips',label:'IPS'},{value:'vpn',label:'VPN'},
              {value:'login_fail',label:'Login failures'},
            ]} />
          </>
        ) : (
          <>
            <Input value={filters.device} onChange={f('device')} placeholder="Device name" />
            <Sel value={filters.mnemonic} onChange={f('mnemonic')} options={[
              {value:'all',label:'Mnemonic: All'},{value:'UPDOWN',label:'UPDOWN'},
              {value:'MACFLAP_NOTIF',label:'MACFLAP'},{value:'CONFIG_I',label:'CONFIG'},
              {value:'NATIVE_VLAN_MISMATCH',label:'VLAN MISMATCH'},
              {value:'LINK_UPDOWN',label:'LINK_UPDOWN'},{value:'LINEPROTO_UPDOWN',label:'LINEPROTO_UPDOWN'},
              {value:'LOGIN_SUCCESS',label:'LOGIN_SUCCESS'},{value:'LOGOUT',label:'LOGOUT'},
              {value:'SSH2_USERAUTH',label:'SSH2_USERAUTH'},{value:'SSH2_SESSION',label:'SSH2_SESSION'},
              {value:'STORM_CONTROL',label:'STORM_CONTROL'},{value:'SPANTREE',label:'SPANTREE'},
            ]} />
            <Sel value={filters.logtype} onChange={f('logtype')} options={[
              { value: 'all', label: 'Focus: All events' },
              { value: 'login_fail', label: 'Focus: Login failures' },
            ]} />
            <Input value={filters.site} onChange={f('site')} placeholder="Site" width={100} />
            <Input value={filters.iface} onChange={f('iface')} placeholder="Interface" width={140} />
            <Input value={filters.vlan} onChange={f('vlan')} placeholder="VLAN" width={72} />
          </>
        )}

        <Sel value={filters.severity} onChange={f('severity')} options={[
          {value:'all',label:'Severity: All'},{value:'critical',label:'Critical'},
          {value:'high',label:'High'},{value:'medium',label:'Medium'},
          {value:'low',label:'Low'},{value:'info',label:'Info'},
        ]} />

        {mode === 'range' && <Btn label="Search" onClick={handleSearch} color={accent} disabled={loading} />}

        <button onClick={() => {
          setFilters(isFirewall ? SOC_FILTERS : NOC_FILTERS)
          setPage(0)
        }} style={{ background:'none', border:`1px solid ${C.border}`, borderRadius:7,
          color:C.text3, fontSize:10, fontFamily:'var(--mono)', padding:'5px 10px', cursor:'pointer' }}>
          Clear
        </button>
      </div>

      {/* ── STATS BAR ── */}
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap',
        padding:'8px 14px', background:'var(--bg3)', borderRadius:8, border:`1px solid ${C.border}` }}>
        <span style={{ fontSize:12, fontWeight:700, color:C.text, fontFamily:'var(--mono)' }}>
          {(Number(total) || 0).toLocaleString()} results
        </span>
        <div style={{ display:'flex', gap:6 }}>
          {Object.entries(sevCats).map(([cat, count]) => (
            <span key={cat} style={{ fontSize:10, padding:'2px 8px', borderRadius:20,
              fontFamily:'var(--mono)', fontWeight:600,
              color: SEV_COLORS[cat], background: SEV_COLORS[cat]+'18',
              border:`1px solid ${SEV_COLORS[cat]}40` }}>
              {cat.toUpperCase().slice(0,4)} {count.toLocaleString()}
            </span>
          ))}
        </div>
        {isFirewall && actionMap.allow !== undefined && (
          <div style={{ display:'flex', gap:6 }}>
            <span style={{ fontSize:10, padding:'2px 8px', borderRadius:20, fontFamily:'var(--mono)',
              fontWeight:600, color:C.green, background:C.green+'18', border:`1px solid ${C.green}40` }}>
              ALLOW {(actionMap.allow||0).toLocaleString()}
            </span>
            <span style={{ fontSize:10, padding:'2px 8px', borderRadius:20, fontFamily:'var(--mono)',
              fontWeight:600, color:C.red, background:C.red+'18', border:`1px solid ${C.red}40` }}>
              DENY {(actionMap.deny||0).toLocaleString()}
            </span>
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={exportCSV}
            disabled={results.length === 0}
            style={{
              padding: '4px 12px',
              borderRadius: 7,
              border: `1px solid ${C.border}`,
              background: 'var(--bg4)',
              color: results.length ? C.text2 : C.text3,
              fontSize: 10,
              fontFamily: 'var(--mono)',
              cursor: results.length ? 'pointer' : 'default',
            }}
          >
            ⬇ Page CSV ({results.length})
          </button>
          <button
            type="button"
            onClick={exportFullRangeExcel}
            disabled={exporting || total <= 0 || loading}
            title="Export every log matching the current time range and filters (UTF-8 CSV, opens in Excel). Run Search first if results show 0."
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
            {total > 0 ? `(${Number(total).toLocaleString()})` : ''}
          </button>
        </div>
      </div>

      {/* ── ERROR ── */}
      {error && (
        <div style={{ padding:'10px 14px', borderRadius:8, background:`${C.red}15`,
          border:`1px solid ${C.red}40`, color:C.red, fontSize:11, fontFamily:'var(--mono)' }}>
          {error}
        </div>
      )}

      {/* ── TABLE ── */}
      <div style={{ background:'var(--bg2)', borderRadius:10, border:`1px solid ${C.border}`, overflow:'hidden' }}>
        <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:560 }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'fixed',
              minWidth: logTableMinW,
            }}
          >
            <ResizableColGroup widths={logColWidths} />
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg2)', zIndex: 1 }}>
              <tr>
                {logHeaders.map((label, i) => (
                  <ResizableTh
                    key={`${label}-${i}`}
                    columnIndex={i}
                    columnCount={logHeaders.length}
                    startResize={logStartResize}
                    style={logThStyle}
                  >
                    {label}
                  </ResizableTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && results.length === 0 && (
                <tr><td colSpan={tableColSpan}
                  style={{ padding:40, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>
                  Loading...
                </td></tr>
              )}
              {!loading && results.length === 0 && !error && (
                <tr><td colSpan={tableColSpan}
                  style={{ padding:40, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>
                  No results found. Try adjusting filters or time range.
                </td></tr>
              )}
              {results.map((e, i) => {
                const action = strCell(e.fgt?.action || e['fgt.action'] || '')
                const srcip = strCell(e.fgt?.srcip || e['fgt.srcip'] || '')
                const dstip = strCell(e.fgt?.dstip || e['fgt.dstip'] || '')
                const country = strCell(e.fgt?.srccountry || e['fgt.srccountry'] || '')
                const app = strCell(
                  e.fgt?.app || e['fgt.app'] || e.fgt?.subtype || e['fgt.subtype'] || '',
                )
                const msg = isFirewall
                  ? strCell(
                      e.fgt?.msg ||
                        e['fgt.msg'] ||
                        e.message ||
                        e.fgt?.attack ||
                        e['fgt.attack'] ||
                        '',
                    )
                  : strCell(e.cisco_message || '')
                const fwUser = isFirewall ? fortigateVpnUserLabel(e) : ''
                const nocUser = !isFirewall ? ciscoLoginFailureUserLabel(e) : ''
                return (
                  <tr key={e._id || i}
                    onMouseEnter={el => el.currentTarget.style.background = 'var(--bg3)'}
                    onMouseLeave={el => el.currentTarget.style.background = 'transparent'}>
                    {td(fmt(e['@timestamp']), C.text3)}
                    <td style={{ padding:'6px 10px', borderBottom:`1px solid var(--border)` }}>
                      <SevBadge e={e} />
                    </td>
                    {isFirewall ? (
                      <>
                        {td(deviceCell(e) || '—', C.accent2)}
                        {showFwAuthUserCol ? td(fwUser || '—', C.cyan) : null}
                        <td style={{ padding:'6px 10px', borderBottom:`1px solid var(--border)` }}>
                          <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, fontFamily:'var(--mono)',
                            fontWeight:600,
                            color: action==='deny' ? C.red : C.green,
                            background: action==='deny' ? C.red+'20' : C.green+'20',
                            border: `1px solid ${action==='deny' ? C.red : C.green}40` }}>
                            {(action && action.toUpperCase()) || '—'}
                          </span>
                        </td>
                        {td(srcip  || '—', C.cyan)}
                        {td(dstip  || '—', C.cyan)}
                        {td(country|| '—', C.text2)}
                        {td(app    || '—', C.accent)}
                        {td(msg.slice(0, 80) + (msg.length > 80 ? '…' : ''), C.text3, { whiteSpace: 'normal', wordBreak: 'break-word' })}
                      </>
                    ) : (
                      <>
                        {td(e.device_name || '—', C.accent)}
                        {showNocLoginUserCol ? td(nocUser || '—', C.cyan) : null}
                        {td(e.cisco_mnemonic || '—', C.amber)}
                        {td(e.cisco_interface_full || '—', C.text2)}
                        {td(e.cisco_vlan_id || '—', C.cyan)}
                        {td((msg).slice(0, 100) + (msg.length > 100 ? '…' : ''), C.text3, { whiteSpace: 'normal', wordBreak: 'break-word' })}
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── PAGINATION (range mode only) ── */}
      {mode === 'range' && total > pageSize && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12 }}>
          <Btn label="← Prev" small onClick={() => setPage(p => p - 1)} disabled={page === 0} color={accent} />
          <span style={{ fontSize:11, color:C.text2, fontFamily:'var(--mono)' }}>
            Page {page + 1} of {totalPages} &nbsp;·&nbsp; {total.toLocaleString()} total
          </span>
          <Btn label="Next →" small onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1} color={accent} />
        </div>
      )}

    </div>
  )
}

import { useState, useEffect, useRef, useCallback } from 'react'
import api from '../../api/client'
import RangePicker from './RangePicker.jsx'

const C = { accent:'#4f7ef5', accent2:'#7c5cfc', green:'#22d3a0', red:'#f5534f', amber:'#f5a623', cyan:'#22d3ee', text:'#e8eaf2', text2:'#8b90aa', text3:'#555a72', bg2:'#0f1117', bg3:'#151821', bg4:'#1c2030', border:'rgba(99,120,200,0.18)', border2:'rgba(99,120,200,0.32)' }

const SEV_COLORS = { critical: C.red, high: C.amber, medium: C.accent, low: C.green, info: C.cyan }

// Normalise raw FortiGate / Cisco syslog severity labels → filter category
function getSevCategory(e) {
  const raw = (e.syslog_severity_label || e.cisco_severity_label || '').toLowerCase()
  if (!raw) return e['fgt.subtype'] === 'ips' || e.fgt?.subtype === 'ips' ? 'high' : 'info'
  if (['critical','emergency','alert'].some(x => raw.includes(x))) return 'critical'
  if (raw.includes('error'))                                         return 'high'
  if (['warning','warn'].some(x => raw.includes(x)))                return 'medium'
  if (['notice','notification'].some(x => raw.includes(x)))         return 'low'
  return 'info'
}

function fmt(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('en', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
}

function SevBadge({ e }) {
  const cat = getSevCategory(e)
  const color = SEV_COLORS[cat] || C.text2
  const label = (e.syslog_severity_label || e.cisco_severity_label || cat).slice(0,4).toUpperCase()
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
      color: disabled ? C.text3 : '#fff', fontSize: small ? 10 : 11,
      fontWeight:600, fontFamily:'var(--mono)', cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1, transition:'all 0.15s', whiteSpace:'nowrap',
    }}>{label}</button>
  )
}

const PAGE_SIZES = [25, 50, 100, 200]
const LIVE_SIZES = [50, 100, 200]
const LIVE_INTERVAL = 5000

const SOC_FILTERS = { q:'', srcip:'', dstip:'', action:'all', severity:'all', logtype:'all' }
const NOC_FILTERS = { q:'', device:'', mnemonic:'all', severity:'all', site:'' }

export default function LogSearch({ type, accentColor }) {
  const accent = accentColor || C.accent
  const isFirewall = type === 'firewall'

  const [mode,       setMode]       = useState('live')
  const [liveSize,   setLiveSize]   = useState(50)
  const [livePaused, setLivePaused] = useState(false)
  const [range,      setRange]      = useState({ type:'preset', value:'1h', label:'1h' })
  const [filters,    setFilters]    = useState(isFirewall ? SOC_FILTERS : NOC_FILTERS)
  const [pageSize,   setPageSize]   = useState(50)
  const [page,       setPage]       = useState(0)

  const [results,  setResults]  = useState([])
  const [total,    setTotal]    = useState(0)
  const [aggs,     setAggs]     = useState({ by_severity: [], by_action: [] })
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)

  const timerRef = useRef(null)
  const f = key => val => setFilters(p => ({ ...p, [key]: val }))

  // Build query params
  const buildParams = useCallback((overrides = {}) => {
    const p = new URLSearchParams()
    p.set('type', type)
    if (mode === 'live' || overrides.live) {
      p.set('range', '1m')
      p.set('size', String(liveSize))
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
      if (filters.action  && filters.action  !== 'all') p.set('action',  filters.action)
      if (filters.logtype && filters.logtype !== 'all') p.set('logtype', filters.logtype)
    } else {
      if (filters.device)                            p.set('device',   filters.device)
      if (filters.site)                              p.set('site',     filters.site)
      if (filters.mnemonic && filters.mnemonic !== 'all') p.set('mnemonic', filters.mnemonic)
    }
    if (filters.severity && filters.severity !== 'all') p.set('severity', filters.severity)
    return p.toString()
  }, [type, mode, liveSize, range, pageSize, page, filters, isFirewall])

  const fetchData = useCallback(async (overrides = {}) => {
    if (loading && !overrides.silent) return
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
  }, [buildParams, loading])

  // Live mode interval
  useEffect(() => {
    if (mode !== 'live') { clearInterval(timerRef.current); return }
    if (livePaused)      { clearInterval(timerRef.current); return }
    fetchData({ silent: true })
    timerRef.current = setInterval(() => fetchData({ silent: true, live: true }), LIVE_INTERVAL)
    return () => clearInterval(timerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, livePaused, liveSize, filters])

  // Time range mode: fetch on range / filter / page change
  useEffect(() => {
    if (mode !== 'range') return
    fetchData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, range, page, pageSize])

  const handleSearch = () => { setPage(0); fetchData({ page: 0 }) }

  const handleRangeChange = (r) => { setRange(r); setPage(0) }

  const switchMode = (m) => {
    clearInterval(timerRef.current)
    setMode(m)
    setPage(0)
    setResults([])
    setTotal(0)
    setError(null)
  }

  // CSV export
  const exportCSV = () => {
    const headers = isFirewall
      ? ['Time','Severity','Action','Src IP','Dst IP','Country','App/Type','Message']
      : ['Time','Severity','Device','Mnemonic','Interface','VLAN','Message']

    const rows = results.map(e => {
      const wrap = v => `"${String(v||'').replace(/"/g,'""')}"`
      const sev = e.syslog_severity_label || e.cisco_severity_label || ''
      if (isFirewall) return [
        fmt(e['@timestamp']), sev, e.fgt?.action||e['fgt.action']||'',
        e.fgt?.srcip||e['fgt.srcip']||'', e.fgt?.dstip||e['fgt.dstip']||'',
        e.fgt?.srccountry||e['fgt.srccountry']||'',
        e.fgt?.app||e['fgt.app']||e.fgt?.subtype||e['fgt.subtype']||'',
        wrap(e.fgt?.msg||e['fgt.msg']||''),
      ].join(',')
      return [
        fmt(e['@timestamp']), sev, e.device_name||'', e.cisco_mnemonic||'',
        e.cisco_interface_full||'', e.cisco_vlan_id||'',
        wrap(e.cisco_message||''),
      ].join(',')
    })

    const csv  = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type:'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `netpulse-${type}-logs-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // ── Severity stats from aggs ──────────────────────────────────────────────
  const sevMap = {}
  aggs.by_severity.forEach(b => { sevMap[b.key] = b.doc_count })
  const sevCats = { critical:0, high:0, medium:0, low:0, info:0 }
  const rawTocat = { critical:'critical', emergency:'critical', alert:'critical',
    error:'high', warning:'medium', warn:'medium', notice:'low', notification:'low',
    information:'info', informational:'info', info:'info', debug:'info', debugging:'info' }
  Object.entries(sevMap).forEach(([k,v]) => {
    const cat = rawTocat[k.toLowerCase()]
    if (cat) sevCats[cat] += v
  })

  const actionMap = {}
  aggs.by_action.forEach(b => { actionMap[b.key] = b.doc_count })

  // ── Render helpers ────────────────────────────────────────────────────────
  const th = txt => (
    <th style={{ padding:'7px 10px', textAlign:'left', borderBottom:`1px solid ${C.border}`,
      color:C.text3, fontSize:9, fontWeight:600, textTransform:'uppercase',
      letterSpacing:0.5, fontFamily:'var(--mono)', whiteSpace:'nowrap' }}>{txt}</th>
  )
  const td = (content, color=C.text2, extra={}) => (
    <td style={{ padding:'6px 10px', borderBottom:`1px solid rgba(99,120,200,0.06)`,
      color, fontSize:11, fontFamily:'var(--mono)', whiteSpace:'nowrap',
      maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', ...extra }}>{content}</td>
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
              color: mode===m ? '#fff' : C.text3, transition:'all 0.15s',
            }}>{m === 'live' ? '⬤ Live' : '⏱ Time Range'}</button>
          ))}
        </div>

        {mode === 'live' ? (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>Max rows</span>
              <Sel value={liveSize} onChange={v => setLiveSize(Number(v))}
                options={LIVE_SIZES.map(s => ({ value:s, label:String(s) }))} />
            </div>
            <Btn label={livePaused ? '▶ Resume' : '⏸ Pause'}
              color={livePaused ? C.green : C.amber}
              onClick={() => setLivePaused(p => !p)} />
            {!livePaused && (
              <span style={{ fontSize:10, color:C.green, fontFamily:'var(--mono)',
                display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ width:6, height:6, borderRadius:'50%', background:C.green,
                  display:'inline-block', animation:'pulse 2s infinite' }} />
                auto-refreshing every 5s
              </span>
            )}
          </>
        ) : (
          <>
            <RangePicker range={range} onChange={handleRangeChange} accentColor={accent} />
            <Btn label="↺ Refresh" onClick={handleSearch} disabled={loading} />
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>Rows</span>
              <Sel value={pageSize} onChange={v => { setPageSize(Number(v)); setPage(0) }}
                options={PAGE_SIZES.map(s => ({ value:s, label:String(s) }))} />
            </div>
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
            <Sel value={filters.action} onChange={f('action')} options={[
              {value:'all',label:'Action: All'},{value:'allow',label:'Allow'},{value:'deny',label:'Deny'},
            ]} />
            <Sel value={filters.logtype} onChange={f('logtype')} options={[
              {value:'all',label:'Type: All'},{value:'traffic',label:'Traffic'},
              {value:'utm',label:'UTM'},{value:'ips',label:'IPS'},{value:'vpn',label:'VPN'},
            ]} />
          </>
        ) : (
          <>
            <Input value={filters.device} onChange={f('device')} placeholder="Device name" />
            <Sel value={filters.mnemonic} onChange={f('mnemonic')} options={[
              {value:'all',label:'Mnemonic: All'},{value:'UPDOWN',label:'UPDOWN'},
              {value:'MACFLAP_NOTIF',label:'MACFLAP'},{value:'CONFIG_I',label:'CONFIG'},
              {value:'NATIVE_VLAN_MISMATCH',label:'VLAN MISMATCH'},
            ]} />
            <Input value={filters.site} onChange={f('site')} placeholder="Site" width={100} />
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
          {total.toLocaleString()} results
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
        <button onClick={exportCSV} disabled={results.length === 0} style={{
          marginLeft:'auto', padding:'4px 12px', borderRadius:7, border:`1px solid ${C.border}`,
          background:'var(--bg4)', color: results.length ? C.text2 : C.text3,
          fontSize:10, fontFamily:'var(--mono)', cursor: results.length ? 'pointer' : 'default',
        }}>⬇ Export CSV ({results.length})</button>
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
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead style={{ position:'sticky', top:0, background:'var(--bg2)', zIndex:1 }}>
              <tr>
                {th('Time')}
                {th('Severity')}
                {isFirewall ? (
                  <>{th('Action')}{th('Src IP')}{th('Dst IP')}{th('Country')}{th('App / Type')}{th('Message')}</>
                ) : (
                  <>{th('Device')}{th('Mnemonic')}{th('Interface')}{th('VLAN')}{th('Message')}</>
                )}
              </tr>
            </thead>
            <tbody>
              {loading && results.length === 0 && (
                <tr><td colSpan={isFirewall ? 8 : 7}
                  style={{ padding:40, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>
                  Loading...
                </td></tr>
              )}
              {!loading && results.length === 0 && !error && (
                <tr><td colSpan={isFirewall ? 8 : 7}
                  style={{ padding:40, textAlign:'center', color:C.text3, fontFamily:'var(--mono)', fontSize:11 }}>
                  No results found. Try adjusting filters or time range.
                </td></tr>
              )}
              {results.map((e, i) => {
                const action = e.fgt?.action || e['fgt.action'] || ''
                const srcip  = e.fgt?.srcip  || e['fgt.srcip']  || ''
                const dstip  = e.fgt?.dstip  || e['fgt.dstip']  || ''
                const country= e.fgt?.srccountry || e['fgt.srccountry'] || ''
                const app    = e.fgt?.app    || e['fgt.app']    || e.fgt?.subtype || e['fgt.subtype'] || ''
                const msg    = isFirewall
                  ? (e.fgt?.msg || e['fgt.msg'] || e.fgt?.attack || e['fgt.attack'] || '')
                  : (e.cisco_message || '')
                return (
                  <tr key={e._id || i}
                    onMouseEnter={el => el.currentTarget.style.background = 'var(--bg3)'}
                    onMouseLeave={el => el.currentTarget.style.background = 'transparent'}>
                    {td(fmt(e['@timestamp']), C.text3)}
                    <td style={{ padding:'6px 10px', borderBottom:`1px solid rgba(99,120,200,0.06)` }}>
                      <SevBadge e={e} />
                    </td>
                    {isFirewall ? (
                      <>
                        <td style={{ padding:'6px 10px', borderBottom:`1px solid rgba(99,120,200,0.06)` }}>
                          <span style={{ fontSize:9, padding:'2px 6px', borderRadius:4, fontFamily:'var(--mono)',
                            fontWeight:600,
                            color: action==='deny' ? C.red : C.green,
                            background: action==='deny' ? C.red+'20' : C.green+'20',
                            border: `1px solid ${action==='deny' ? C.red : C.green}40` }}>
                            {action.toUpperCase()||'—'}
                          </span>
                        </td>
                        {td(srcip  || '—', C.cyan)}
                        {td(dstip  || '—', C.cyan)}
                        {td(country|| '—', C.text2)}
                        {td(app    || '—', C.accent)}
                        {td(msg.slice(0,80) + (msg.length>80?'…':''), C.text3, { maxWidth:300 })}
                      </>
                    ) : (
                      <>
                        {td(e.device_name         || '—', C.accent)}
                        {td(e.cisco_mnemonic       || '—', C.amber)}
                        {td(e.cisco_interface_full || '—', C.text2)}
                        {td(e.cisco_vlan_id        || '—', C.cyan)}
                        {td((msg).slice(0,100) + (msg.length>100?'…':''), C.text3, { maxWidth:350 })}
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

import { useState, useRef, useEffect } from 'react'

const C = { accent:'#4f7ef5', text:'var(--text)', text2:'var(--text2)', text3:'var(--text3)', bg2:'var(--bg2)', bg3:'var(--bg3)', bg4:'var(--bg4)', border:'var(--border)', border2:'var(--border2)' }

const PRESETS = [
  { label:'15m', value:'15m' },
  { label:'1h',  value:'1h'  },
  { label:'6h',  value:'6h'  },
  { label:'12h', value:'12h' },
  { label:'24h', value:'24h' },
  { label:'3d',  value:'3d'  },
  { label:'7d',  value:'7d'  },
  { label:'30d', value:'30d' },
]

// datetime-local inputs hold a naive string (no TZ). We must fill them with
// local-time strings so that new Date(val).toISOString() round-trips correctly.
function toLocalDT(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16)
}

export default function RangePicker({ range, onChange, accentColor }) {
  const accent = accentColor || C.accent
  const [open, setOpen]       = useState(false)
  const [mode, setMode]       = useState('preset')
  const [fromVal, setFromVal] = useState('')
  const [toVal, setToVal]     = useState('')
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // When opening the popover, sync custom datetime fields from the active range
  useEffect(() => {
    if (!open) return
    if (range?.type === 'custom' && range.from && range.to) {
      setMode('custom')
      setFromVal(toLocalDT(new Date(range.from)))
      setToVal(toLocalDT(new Date(range.to)))
    }
  }, [open, range])

  function applyCustom() {
    if (!fromVal || !toVal) return
    const from = new Date(fromVal).toISOString()
    const to   = new Date(toVal).toISOString()
    onChange({ type:'custom', from, to, label: fromVal.slice(0,16) + ' to ' + toVal.slice(0,16) })
    setOpen(false)
  }

  const isCustom = range && range.type === 'custom'
  const displayLabel = (() => {
    if (isCustom) {
      const lb = range.label || 'Custom range'
      return lb.length > 30 ? `${lb.slice(0, 30)}…` : lb
    }
    return (range && range.label) || range?.value || '24h'
  })()

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button onClick={()=>setOpen(o=>!o)} style={{
        display:'flex', alignItems:'center', gap:6,
        padding:'5px 12px', borderRadius:8,
        border:'1px solid ' + (open ? accent : C.border2),
        background: open ? accent+'15' : C.bg3,
        color: isCustom ? accent : C.text2,
        fontSize:11, fontFamily:'var(--mono)', cursor:'pointer',
        transition:'all 0.15s', whiteSpace:'nowrap',
      }}>
        {displayLabel} ▾
      </button>

      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', right:0,
          background:C.bg2, border:'1px solid '+C.border2,
          borderRadius:12, padding:16, zIndex:500,
          width:300, boxShadow:'0 8px 32px rgba(0,0,0,0.4)',
        }}>
          <div style={{ display:'flex', gap:4, marginBottom:14, background:C.bg3, borderRadius:8, padding:3 }}>
            {[{ id:'preset', label:'Presets' }, { id:'custom', label:'Custom' }].map(m => (
              <button key={m.id} type="button" onClick={()=>setMode(m.id)} style={{
                flex:1, padding:'5px 0', borderRadius:6, border:'none',
                background: mode===m.id ? accent : 'transparent',
                color: mode===m.id ? '#fff' : C.text3,
                fontSize:11, fontFamily:'var(--mono)', cursor:'pointer', fontWeight:600,
              }}>{m.label}</button>
            ))}
          </div>

          {mode==='preset' && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6 }}>
              {PRESETS.map(p => (
                <button key={p.value} onClick={()=>{ onChange({ type:'preset', value:p.value, label:p.label }); setOpen(false) }}
                  style={{
                    padding:'7px 0', borderRadius:7,
                    border:'1px solid ' + (range && range.value===p.value ? accent : C.border),
                    background: range && range.value===p.value ? accent+'20' : C.bg3,
                    color: range && range.value===p.value ? accent : C.text2,
                    fontSize:11, fontFamily:'var(--mono)', cursor:'pointer',
                    fontWeight: range && range.value===p.value ? 700 : 400,
                  }}>{p.label}</button>
              ))}
            </div>
          )}

          {mode==='custom' && (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <div>
                <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)', marginBottom:5 }}>FROM</div>
                <input type='datetime-local' value={fromVal} onChange={e=>setFromVal(e.target.value)}
                  style={{ width:'100%', padding:'8px 10px', background:C.bg3, border:'1px solid '+C.border, borderRadius:7, color:C.text, fontSize:12, fontFamily:'var(--mono)', outline:'none', colorScheme:'dark' }} />
              </div>
              <div>
                <div style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)', marginBottom:5 }}>TO</div>
                <input type='datetime-local' value={toVal} onChange={e=>setToVal(e.target.value)}
                  style={{ width:'100%', padding:'8px 10px', background:C.bg3, border:'1px solid '+C.border, borderRadius:7, color:C.text, fontSize:12, fontFamily:'var(--mono)', outline:'none', colorScheme:'dark' }} />
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <button onClick={()=>{ const n=new Date(); setToVal(toLocalDT(n)); setFromVal(toLocalDT(new Date(n-3600000))) }}
                  style={{ flex:1, padding:'6px', borderRadius:6, border:'1px solid '+C.border, background:C.bg3, color:C.text3, fontSize:10, fontFamily:'var(--mono)', cursor:'pointer' }}>Last 1h</button>
                <button onClick={()=>{ const n=new Date(); setToVal(toLocalDT(n)); setFromVal(toLocalDT(new Date(n-86400000))) }}
                  style={{ flex:1, padding:'6px', borderRadius:6, border:'1px solid '+C.border, background:C.bg3, color:C.text3, fontSize:10, fontFamily:'var(--mono)', cursor:'pointer' }}>Last 24h</button>
                <button onClick={()=>{ const n=new Date(); setToVal(toLocalDT(n)); setFromVal(toLocalDT(new Date(n-604800000))) }}
                  style={{ flex:1, padding:'6px', borderRadius:6, border:'1px solid '+C.border, background:C.bg3, color:C.text3, fontSize:10, fontFamily:'var(--mono)', cursor:'pointer' }}>Last 7d</button>
              </div>
              <button onClick={applyCustom} style={{
                padding:'8px', borderRadius:7, border:'none',
                background:accent, color:'#fff',
                fontSize:12, fontFamily:'var(--mono)', cursor:'pointer', fontWeight:600,
              }}>Apply Range</button>
            </div>
          )}

          <div style={{ marginTop:12, paddingTop:10, borderTop:'1px solid '+C.border, display:'flex', justifyContent:'space-between' }}>
            <span style={{ fontSize:10, color:C.text3, fontFamily:'var(--mono)' }}>Current: {displayLabel}</span>
            <button onClick={()=>{ onChange({ type:'preset', value:'24h', label:'24h' }); setOpen(false) }}
              style={{ fontSize:10, color:C.text3, background:'none', border:'none', cursor:'pointer', fontFamily:'var(--mono)' }}>Reset</button>
          </div>
        </div>
      )}
    </div>
  )
}

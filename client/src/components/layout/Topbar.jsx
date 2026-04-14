import { useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useAuthStore } from '../../store/authStore'
import ThemePreferences from './ThemePreferences'
const titles = { '/soc':'Security Operations Center', '/noc':'Network Operations Center', '/sentinel':'Sentinel XDR', '/infra':'Infra Monitoring', '/tickets':'Ticket Management', '/ai':'AI Assistant', '/reports':'Reports & Analytics', '/admin':'Administration' }
export default function Topbar() {
  const { pathname } = useLocation()
  const { user } = useAuthStore()
  const [time, setTime] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t) }, [])
  return (
    <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 20px', background:'var(--bg2)', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
      <div style={{ fontSize:15, fontWeight:700, color:'var(--text)' }}>{titles[pathname] || 'Lenskart'}</div>
      <div style={{ display:'flex', alignItems:'center', gap:16 }}>
        <ThemePreferences />
        <div style={{ display:'flex', alignItems:'center', gap:6, fontFamily:'var(--mono)', fontSize:11, color:'var(--green)', background:'color-mix(in srgb, var(--green) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--green) 28%, transparent)', padding:'4px 10px', borderRadius:20 }}>
          <div style={{ width:6, height:6, background:'var(--green)', borderRadius:'50%', animation:'pulse 2s infinite' }} />
          LIVE
        </div>
        <div style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--text3)' }}>
          {time.toLocaleString('en', { weekday:'short', year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', timeZoneName:'short' })}
        </div>
        <div style={{ width:30, height:30, borderRadius:8, background:'var(--bg4)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:'var(--accent)', fontFamily:'var(--mono)', fontWeight:600 }}>
          {user?.name?.charAt(0).toUpperCase() || 'U'}
        </div>
      </div>
    </header>
  )
}

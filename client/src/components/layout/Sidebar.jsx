import { NavLink } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
const nav = [
  { to:'/soc',     label:'SOC',     icon:'⚡' },
  { to:'/noc',     label:'NOC',     icon:'🌐' },
  { to:'/tickets', label:'Tickets', icon:'🎫' },
  { to:'/ai',      label:'AI',      icon:'🤖' },
  { to:'/reports', label:'Reports', icon:'📊' },
  { to:'/admin',   label:'Admin',   icon:'⚙️' },
]
export default function Sidebar() {
  const { logout } = useAuthStore()
  return (
    <aside style={{ width:64, background:'var(--bg2)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'center', paddingTop:12, paddingBottom:12, gap:4 }}>
      <div style={{ width:36, height:36, background:'linear-gradient(135deg,#4f7ef5,#7c5cfc)', borderRadius:9, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'var(--mono)', fontSize:14, fontWeight:800, color:'#fff', marginBottom:16 }}>NP</div>
      {nav.map(item => (
        <NavLink key={item.to} to={item.to} title={item.label} style={({ isActive }) => ({ width:44, height:44, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, textDecoration:'none', transition:'all 0.15s', background: isActive ? 'var(--bg4)' : 'transparent', border: isActive ? '1px solid var(--border2)' : '1px solid transparent' })}>
          {item.icon}
        </NavLink>
      ))}
      <div style={{ flex:1 }} />
      <button onClick={logout} title="Logout" style={{ width:44, height:44, borderRadius:10, border:'none', background:'transparent', color:'var(--text3)', cursor:'pointer', fontSize:18 }}>⏏</button>
    </aside>
  )
}


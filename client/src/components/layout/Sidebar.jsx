import { NavLink } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { canAccessPage } from '../../utils/pageAccess'
import AppLogo from '../brand/AppLogo.jsx'

const nav = [
  { pageKey:'soc',      to:'/soc',     label:'SOC',     icon:'⚡' },
  { pageKey:'noc',      to:'/noc',     label:'NOC',     icon:'🌐' },
  { pageKey:'sentinel', to:'/sentinel', label:'XDR',    icon:'🛡️' },
  { pageKey:'infra',    to:'/infra',   label:'Infra',  icon:'📡' },
  { pageKey:'solarwinds', to:'/solarwinds', label:'Orion', icon:'☀️' },
  { pageKey:'idcs',     to:'/idcs',    label:'IDCS',   icon:'🪪' },
  { pageKey:'ad',       to:'/ad',      label:'AD',     icon:'🏢' },
  { pageKey:'nexs',     to:'/nexs',    label:'Nexs',   icon:'🔐' },
  { pageKey:'emailSim', to:'/email-sim', label:'Mail', icon:'📧' },
  { pageKey:'tickets',  to:'/tickets', label:'Tickets', icon:'🎫' },
  { pageKey:'ai',       to:'/ai',      label:'AI',      icon:'🤖' },
  { pageKey:'reports',  to:'/reports', label:'Reports', icon:'📊' },
  { pageKey:'admin',    to:'/admin',   label:'Admin',   icon:'⚙️' },
]
export default function Sidebar() {
  const { logout, user } = useAuthStore()
  const visible = nav.filter((item) => canAccessPage(user, item.pageKey))
  return (
    <aside style={{ width:64, background:'var(--bg2)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', alignItems:'center', paddingTop:12, paddingBottom:12, gap:4 }}>
      <AppLogo size={36} title="SocMon" style={{ marginBottom: 16 }} />
      {visible.map(item => (
        <NavLink key={item.to} to={item.to} title={item.label} style={({ isActive }) => ({ width:44, height:44, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, textDecoration:'none', transition:'all 0.15s', background: isActive ? 'var(--bg4)' : 'transparent', border: isActive ? '1px solid var(--border2)' : '1px solid transparent' })}>
          {item.icon}
        </NavLink>
      ))}
      <div style={{ flex:1 }} />
      <button onClick={logout} title="Logout" style={{ width:44, height:44, borderRadius:10, border:'none', background:'transparent', color:'var(--text3)', cursor:'pointer', fontSize:18 }}>⏏</button>
    </aside>
  )
}


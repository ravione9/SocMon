import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { getFirstAllowedPath } from '../../utils/pageAccess'
export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  async function handleLogin(e) {
    e.preventDefault(); setLoading(true)
    try {
      const { data } = await api.post('/api/auth/login', { email, password })
      setAuth(data.token, data.user)
      useThemeStore.getState().syncFromUser(data.user)
      navigate(getFirstAllowedPath(data.user))
      toast.success(`Welcome back, ${data.user.name}`)
    } catch (err) { toast.error(err.response?.data?.error || 'Login failed') }
    finally { setLoading(false) }
  }
  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:380, background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:16, padding:40 }}>
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ width:48, height:48, margin:'0 auto 12px', background:'linear-gradient(135deg,#4f7ef5,#7c5cfc)', borderRadius:12, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, fontWeight:800, color:'#fff', fontFamily:'var(--mono)' }}>LK</div>
          <div style={{ fontSize:20, fontWeight:700 }}>Lenskart</div>
          <div style={{ fontSize:12, color:'var(--text3)', fontFamily:'var(--mono)', marginTop:4 }}>NOC / SOC PLATFORM</div>
        </div>
        <form onSubmit={handleLogin} style={{ display:'flex', flexDirection:'column', gap:14 }} autoComplete="on">
          {[
            { label: 'Email', type: 'email', value: email, set: setEmail, autoComplete: 'email' },
            { label: 'Password', type: 'password', value: password, set: setPassword, autoComplete: 'current-password' },
          ].map((f) => (
            <div key={f.label}>
              <label style={{ fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)', letterSpacing:1, textTransform:'uppercase' }}>{f.label}</label>
              <input
                name={f.label === 'Email' ? 'email' : 'password'}
                type={f.type}
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                required
                autoComplete={f.autoComplete}
                style={{ width:'100%', marginTop:6, padding:'10px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text)', fontSize:13, fontFamily:'var(--mono)', outline:'none' }}
              />
            </div>
          ))}
          <button type="submit" disabled={loading}
            style={{ marginTop:8, padding:11, borderRadius:8, background: loading ? 'var(--bg4)' : 'var(--accent)', border:'none', color:'#fff', fontSize:13, fontWeight:600, fontFamily:'var(--sans)', cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <div style={{ marginTop:20, textAlign:'center', fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)' }}>Lenskart v1.0.0 · Lenskart Security Team</div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { getFirstAllowedPath } from '../../utils/pageAccess'
import AppLogo from '../../components/brand/AppLogo.jsx'
import { resolvedApiBase } from '../../utils/backendOrigin.js'

export default function LoginPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saml, setSaml] = useState(null)
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    const samlErr = searchParams.get('saml_error')
    if (samlErr) {
      setError(decodeURIComponent(samlErr))
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    api.get('/api/auth/saml/config')
      .then(({ data }) => setSaml(data))
      .catch(() => setSaml(null))
  }, [])

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data } = await api.post('/api/auth/login', { email, password })
      setAuth(data.token, data.user)
      useThemeStore.getState().syncFromUser(data.user)
      navigate(getFirstAllowedPath(data.user))
      toast.success(`Welcome back, ${data.user.name}`)
    } catch (err) {
      const msg = err.response?.data?.error || 'Login failed'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const samlEnabled = !!saml?.enabled
  const showPasswordForm = !samlEnabled || saml?.allowLocalLogin !== false
  const apiBase = resolvedApiBase()
  const samlLoginHref = saml?.loginUrl || (apiBase ? `${apiBase}/api/auth/saml/login` : '/api/auth/saml/login')

  return (
    <div style={{ minHeight: 'var(--app-vh, 100vh)', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 380, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16, padding: 40 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <AppLogo size={52} title="SocMon" style={{ margin: '0 auto 14px' }} />
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Lenskart</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 4 }}>NOC / SOC PLATFORM</div>
        </div>

        {samlEnabled && (
          <a
            href={samlLoginHref}
            style={{
              display: 'block', textAlign: 'center', marginBottom: showPasswordForm ? 18 : 0,
              padding: 11, borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--accent)',
              color: 'var(--accent)', fontSize: 13, fontWeight: 600, fontFamily: 'var(--sans)', textDecoration: 'none',
            }}>
            Sign in with SSO
          </a>
        )}

        {samlEnabled && showPasswordForm && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>or</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>
        )}

        {showPasswordForm && (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} autoComplete="on">
            {[
              { label: 'Email', type: 'email', value: email, set: setEmail, autoComplete: 'email' },
              { label: 'Password', type: 'password', value: password, set: setPassword, autoComplete: 'current-password' },
            ].map((f) => (
              <div key={f.label}>
                <label style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: 1, textTransform: 'uppercase' }}>{f.label}</label>
                <input
                  name={f.label === 'Email' ? 'email' : 'password'}
                  type={f.type}
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  required
                  autoComplete={f.autoComplete}
                  style={{ width: '100%', marginTop: 6, padding: '10px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 13, fontFamily: 'var(--mono)', outline: 'none' }}
                />
              </div>
            ))}
            {error && (
              <div role="alert" style={{ fontSize: 12, padding: '10px 12px', borderRadius: 8, color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', fontFamily: 'var(--mono)' }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading}
              style={{ marginTop: 8, padding: 11, borderRadius: 8, background: loading ? 'var(--bg4)' : 'var(--accent)', border: 'none', color: 'var(--on-accent)', fontSize: 13, fontWeight: 600, fontFamily: 'var(--sans)', cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}

        {!showPasswordForm && error && (
          <div role="alert" style={{ fontSize: 12, padding: '10px 12px', borderRadius: 8, color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))', fontFamily: 'var(--mono)' }}>
            {error}
          </div>
        )}

        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)', textAlign: 'center', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
          {samlEnabled && !showPasswordForm
            ? 'Sign in using your organization SSO account. Your user must exist in Admin or auto-provisioning must be enabled.'
            : 'Local accounts use Admin password. AD accounts use domain password. SSO users use Sign in with SSO.'}
        </div>
        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>Lenskart v1.0.0 · Lenskart Security Team</div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { getFirstAllowedPath } from '../../utils/pageAccess'
import AppLogo from '../../components/brand/AppLogo.jsx'
import PageLoading from '../../components/ui/PageLoading.jsx'

export default function SamlCallbackPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()
  const [error, setError] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setError('Missing SSO token. Try signing in again.')
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const { data: user } = await api.get('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (cancelled) return
        setAuth(token, user)
        useThemeStore.getState().syncFromUser(user)
        toast.success(`Welcome, ${user.name}`)
        navigate(getFirstAllowedPath(user), { replace: true })
      } catch (err) {
        if (cancelled) return
        const msg = err.response?.data?.error || 'SSO sign-in failed'
        setError(msg)
        toast.error(msg)
      }
    })()
    return () => { cancelled = true }
  }, [searchParams, navigate, setAuth])

  if (error) {
    return (
      <div style={{ minHeight: 'var(--app-vh, 100vh)', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 380, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16, padding: 40, textAlign: 'center' }}>
          <AppLogo size={52} title="SocMon" style={{ margin: '0 auto 14px' }} />
          <div style={{ fontSize: 14, color: 'var(--red)', fontFamily: 'var(--mono)', marginBottom: 16 }}>{error}</div>
          <button type="button" onClick={() => navigate('/login', { replace: true })}
            style={{ padding: '10px 18px', borderRadius: 8, background: 'var(--accent)', border: 'none', color: 'var(--on-accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Back to login
          </button>
        </div>
      </div>
    )
  }

  return <PageLoading />
}

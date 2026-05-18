import { useState, useEffect } from 'react'
import { getNexsMeta, nexsLogin } from '../../api/nexs'
import { nexsBtnPrimary, nexsCx, nexsInputClass } from './nexsTheme'

export default function NexsLoginPanel({ onLoggedIn }) {
  const [defaultAppId, setDefaultAppId] = useState('nexs_search')
  const [userName, setUserName] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getNexsMeta()
      .then((m) => {
        const id = m?.defaultAppId || m?.portalAppId || m?.appId || 'nexs_search'
        setDefaultAppId(id)
      })
      .catch(() => {})
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!userName.trim() || !password) {
      setError('Username and password are required')
      return
    }
    setLoading(true)
    try {
      await nexsLogin({
        userName: userName.trim(),
        password,
        appId: defaultAppId,
      })
      onLoggedIn?.()
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Sign-in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`max-w-md rounded-xl border p-6 ${nexsCx.border} ${nexsCx.bg2}`}>
      <h2 className={`text-lg font-semibold mb-1 ${nexsCx.text}`}>Sign in to Nexs Auth Service</h2>
      <p className={`text-sm mb-5 ${nexsCx.text3}`}>
        Same credentials as Swagger / Nexs portal. App ID: <span className="font-mono">{defaultAppId}</span>
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={`block text-sm font-medium mb-1 ${nexsCx.text}`}>Username</label>
          <input
            type="text"
            autoComplete="username"
            className={nexsInputClass()}
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="userName"
          />
        </div>
        <div>
          <label className={`block text-sm font-medium mb-1 ${nexsCx.text}`}>Password</label>
          <input
            type="password"
            autoComplete="current-password"
            className={nexsInputClass()}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <div
            className="text-sm p-3 rounded-lg"
            style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, var(--bg3))' }}
          >
            {error}
          </div>
        )}
        <button type="submit" disabled={loading} className={`w-full ${nexsBtnPrimary()}`}>
          {loading ? 'Signing in…' : 'Sign in & get token'}
        </button>
      </form>
    </div>
  )
}

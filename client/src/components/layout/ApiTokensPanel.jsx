import { useState, useRef, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { listApiTokens, createApiToken, revokeApiToken } from '../../api/apiTokens'
import { useAuthStore } from '../../store/authStore'
import { resolvedPortalOrigin, portalAppUrl } from '../../utils/backendOrigin.js'

export default function ApiTokensPanel() {
  const user = useAuthStore((s) => s.user)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tokens, setTokens] = useState([])
  const [label, setLabel] = useState('')
  const [expiresIn, setExpiresIn] = useState('90d')
  const [newToken, setNewToken] = useState(null)
  const wrapRef = useRef(null)

  const apiEnabled = !!user?.apiAccessEnabled

  const load = useCallback(async () => {
    if (!apiEnabled) return
    setLoading(true)
    try {
      const data = await listApiTokens()
      setTokens(data.tokens || [])
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not load API tokens')
    } finally {
      setLoading(false)
    }
  }, [apiEnabled])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (open && apiEnabled) void load()
  }, [open, apiEnabled, load])

  async function onCreate() {
    const name = label.trim()
    if (!name) {
      toast.error('Enter a label (e.g. Cursor script, n8n)')
      return
    }
    setLoading(true)
    try {
      const data = await createApiToken({ label: name, expiresIn })
      setNewToken(data.token)
      setLabel('')
      setTokens((prev) => [
        {
          id: data.id,
          label: data.label,
          expiresAt: data.expiresAt,
          createdAt: data.createdAt,
          lastUsedAt: null,
        },
        ...prev,
      ])
      toast.success('API token created — copy it now')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not create token')
    } finally {
      setLoading(false)
    }
  }

  async function onRevoke(id) {
    if (!window.confirm('Revoke this API token? Scripts using it will stop working.')) return
    setLoading(true)
    try {
      await revokeApiToken(id)
      setTokens((prev) => prev.filter((t) => t.id !== id))
      toast.success('Token revoked')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Revoke failed')
    } finally {
      setLoading(false)
    }
  }

  function copyToken() {
    if (!newToken) return
    void navigator.clipboard.writeText(newToken).then(
      () => toast.success('Copied to clipboard'),
      () => toast.error('Copy failed — select and copy manually'),
    )
  }

  const base = resolvedPortalOrigin()
  const apiDocsHref = portalAppUrl('/api-docs')

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="API access tokens"
        style={{
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: apiEnabled ? 'var(--bg3)' : 'var(--bg2)',
          color: apiEnabled ? 'var(--text2)' : 'var(--text3)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          cursor: 'pointer',
          opacity: apiEnabled ? 1 : 0.85,
        }}
      >
        API
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: 380,
            maxWidth: '92vw',
            padding: 14,
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
            zIndex: 200,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>API tokens</span>
            <a
              href={apiDocsHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--accent)',
                fontFamily: 'var(--mono)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              API docs & test →
            </a>
          </div>
          {!apiEnabled ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, margin: '0 0 10px' }}>
                API access is not enabled for your account. An administrator can turn on{' '}
                <strong style={{ color: 'var(--text)' }}>Allow API access</strong> under Admin → Users.
              </p>
              <a
                href={apiDocsHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 11,
                  color: 'var(--accent)',
                  fontFamily: 'var(--mono)',
                  textDecoration: 'none',
                }}
              >
                View API documentation →
              </a>
            </>
          ) : (
            <>
              <p style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', lineHeight: 1.5, margin: '0 0 12px' }}>
                Use <code style={{ color: 'var(--cyan)' }}>Authorization: Bearer &lt;jwt&gt;</code> on{' '}
                <code style={{ color: 'var(--cyan)' }}>{base}/api/…</code>. Permissions follow your portal pages (
                {user?.allowedPages?.length ?? 0} modules).
              </p>
              {newToken && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid var(--green)',
                    background: 'color-mix(in srgb, var(--green) 8%, transparent)',
                  }}
                >
                  <div style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'var(--mono)', marginBottom: 6 }}>
                    New token (shown once)
                  </div>
                  <textarea
                    readOnly
                    value={newToken}
                    rows={3}
                    style={{
                      width: '100%',
                      fontSize: 10,
                      fontFamily: 'var(--mono)',
                      background: 'var(--bg3)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      color: 'var(--text)',
                      resize: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <button
                    type="button"
                    onClick={copyToken}
                    style={{
                      marginTop: 8,
                      padding: '6px 12px',
                      borderRadius: 8,
                      border: 'none',
                      background: 'var(--accent)',
                      color: 'var(--bg)',
                      fontSize: 11,
                      fontFamily: 'var(--mono)',
                      cursor: 'pointer',
                    }}
                  >
                    Copy token
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Label (e.g. automation)"
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 12,
                    fontFamily: 'var(--mono)',
                  }}
                />
                <select
                  value={expiresIn}
                  onChange={(e) => setExpiresIn(e.target.value)}
                  style={{
                    padding: '8px 8px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text2)',
                    fontSize: 11,
                    fontFamily: 'var(--mono)',
                  }}
                >
                  <option value="30d">30 days</option>
                  <option value="90d">90 days</option>
                  <option value="180d">180 days</option>
                  <option value="365d">1 year</option>
                </select>
              </div>
              <button
                type="button"
                disabled={loading}
                onClick={onCreate}
                style={{
                  width: '100%',
                  marginBottom: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--accent)',
                  color: 'var(--bg)',
                  fontSize: 12,
                  fontFamily: 'var(--mono)',
                  cursor: loading ? 'wait' : 'pointer',
                  opacity: loading ? 0.7 : 1,
                }}
              >
                Generate JWT
              </button>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                Active tokens
              </div>
              {loading && !tokens.length ? (
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>Loading…</div>
              ) : tokens.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>No active tokens</div>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tokens.map((t) => (
                    <li
                      key={t.id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        fontSize: 11,
                        fontFamily: 'var(--mono)',
                      }}
                    >
                      <div style={{ color: 'var(--text)', fontWeight: 600 }}>{t.label}</div>
                      <div style={{ color: 'var(--text3)', marginTop: 4 }}>
                        Expires {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : '—'}
                        {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}` : ''}
                      </div>
                      <button
                        type="button"
                        onClick={() => onRevoke(t.id)}
                        disabled={loading}
                        style={{
                          marginTop: 6,
                          padding: '4px 8px',
                          borderRadius: 6,
                          border: '1px solid var(--border)',
                          background: 'transparent',
                          color: 'var(--red)',
                          fontSize: 10,
                          cursor: 'pointer',
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

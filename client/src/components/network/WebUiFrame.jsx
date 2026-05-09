import { useCallback, useEffect, useState } from 'react'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { resolvedApiBase } from '../../utils/backendOrigin'

function absoluteIframeUrl(relative) {
  if (!relative) return null
  if (/^https?:\/\//i.test(relative)) return relative
  const base = resolvedApiBase()
  if (!base) return relative
  return base.replace(/\/$/, '') + relative
}

export default function WebUiFrame({ device, onClose }) {
  const [url, setUrl]                       = useState(null)
  const [scheme, setScheme]                 = useState('https')
  const [error, setError]                   = useState(null)
  const [loadingScheme, setLoadingScheme]   = useState(true)
  const [probe, setProbe]                   = useState(null)   // { ok, status, error }
  const [probing, setProbing]               = useState(false)
  const [iframeKey, setIframeKey]           = useState(0)

  const mint = useCallback(async (s) => {
    setLoadingScheme(true)
    setError(null)
    setUrl(null)
    try {
      const { data } = await api.post(`/api/web-mgmt/session/${device._id}?scheme=${s}`)
      setUrl(absoluteIframeUrl(data.url))
      setScheme(data.scheme || s)
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Could not start proxy session'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoadingScheme(false)
    }
  }, [device._id])

  useEffect(() => { mint(scheme) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const runProbe = useCallback(async () => {
    setProbing(true)
    setProbe(null)
    try {
      const { data } = await api.get(`/api/web-mgmt/probe/${device._id}`)
      setProbe(data)
    } catch (e) {
      setProbe({ ok: false, error: e.response?.data?.error || e.message })
    } finally {
      setProbing(false)
    }
  }, [device._id])

  function switchScheme(next) {
    if (next === scheme) return
    setProbe(null)
    mint(next)
  }

  function reload() {
    setIframeKey(k => k + 1)
  }

  const probeColor = probe
    ? probe.ok ? '#22d3a0' : '#f5534f'
    : '#888'

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(6,8,14,0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 1100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Device web console"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(1200px, 100%)',
          height: 'min(800px, 92vh)',
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg3)',
          flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {device.name} — Web UI (proxied)
            </div>
            <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)', marginTop: 3 }}>
              {device.ip} · TLS verification ignored · cert warning bypassed
            </div>
          </div>

          {/* Scheme toggles */}
          {['https', 'http'].map(s => (
            <button key={s} type="button" onClick={() => switchScheme(s)} style={{
              padding: '5px 10px', borderRadius: 7,
              border: '1px solid var(--border)',
              background: scheme === s ? 'var(--accent)' : 'var(--bg4)',
              color: scheme === s ? 'var(--on-accent)' : 'var(--text2)',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', textTransform: 'uppercase',
            }}>{s}</button>
          ))}

          {/* Connectivity probe button */}
          <button type="button" onClick={runProbe} disabled={probing} title="Check if the device is reachable from the Netpulse server" style={{
            padding: '5px 10px', borderRadius: 7,
            border: '1px solid var(--border)',
            background: 'var(--bg4)',
            color: probeColor,
            fontSize: 10, fontFamily: 'var(--mono)', cursor: 'pointer', fontWeight: 600,
            minWidth: 80,
          }}>
            {probing ? 'Probing…' : probe ? (probe.ok ? `✓ port ${probe.httpsPort}` : `✗ unreachable`) : 'Test connection'}
          </button>

          {/* Reload iframe */}
          {url && (
            <button type="button" onClick={reload} title="Reload the device UI" style={{
              padding: '5px 10px', borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--bg4)', color: 'var(--text2)',
              fontSize: 11, cursor: 'pointer',
            }}>↺ Reload</button>
          )}

          {/* Open in new tab */}
          {url && (
            <button type="button" title="Open this proxied URL in a new browser tab"
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
              style={{
                padding: '5px 10px', borderRadius: 7,
                border: '1px solid var(--border)',
                background: 'var(--bg4)', color: 'var(--text2)',
                fontSize: 11, cursor: 'pointer',
              }}>Open in new tab ↗</button>
          )}

          <button type="button" onClick={onClose} style={{
            padding: '6px 14px', borderRadius: 10,
            border: '1px solid var(--border)',
            background: 'var(--bg4)', color: 'var(--text2)',
            cursor: 'pointer', fontWeight: 600, fontSize: 12,
          }}>Close</button>
        </div>

        {/* Probe result banner */}
        {probe && !probe.ok && (
          <div style={{
            flexShrink: 0, padding: '8px 14px',
            background: 'rgba(245,83,79,0.12)',
            borderBottom: '1px solid rgba(245,83,79,0.3)',
            fontFamily: 'var(--mono)', fontSize: 11, color: '#f5534f',
          }}>
            ✗ Server cannot reach {device.ip}:{device.httpsPort || 443} — {probe.error || 'connection refused'}.
            {' '}Check that the port in <strong>Admin → Edit device</strong> matches what the device is actually listening on, and that the Netpulse server has network access to this IP.
          </div>
        )}
        {probe && probe.ok && (
          <div style={{
            flexShrink: 0, padding: '6px 14px',
            background: 'rgba(34,211,160,0.1)',
            borderBottom: '1px solid rgba(34,211,160,0.2)',
            fontFamily: 'var(--mono)', fontSize: 11, color: '#22d3a0',
          }}>
            ✓ Device is reachable on port {probe.httpsPort} (HTTP {probe.status}). If the iframe is still blank, try HTTP mode or Open in new tab ↗.
          </div>
        )}

        {/* Iframe area */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff' }}>
          {(loadingScheme || !url) && !error && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text3)', fontFamily: 'var(--mono)', background: 'var(--bg2)',
            }}>
              Starting proxy session…
            </div>
          )}
          {error && (
            <div style={{
              position: 'absolute', inset: 0, padding: 24,
              color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 13,
              background: 'var(--bg2)', whiteSpace: 'pre-wrap',
            }}>
              {error}
            </div>
          )}
          {url && !error && (
            <iframe
              key={`${url}-${iframeKey}`}
              title={`${device.name} web UI`}
              src={url}
              referrerPolicy="no-referrer"
              sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-modals allow-downloads"
              style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{
          flexShrink: 0, padding: '7px 14px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg3)',
          fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)', lineHeight: 1.5,
        }}>
          TLS cert errors are ignored server-side. For FortiGate NGUI: set Management Username + Password in
          Admin → Devices → Edit — the server pre-authenticates and injects the session cookie on every request.
          If still blank: click <strong>Test connection</strong>, try <strong>HTTP</strong> mode, or <strong>Open in new tab ↗</strong>.
        </div>
      </div>
    </div>
  )
}

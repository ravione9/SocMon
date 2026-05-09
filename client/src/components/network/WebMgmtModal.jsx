import { useEffect, useState } from 'react'
import api from '../../api/client'
import toast from 'react-hot-toast'

const panel = {
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: 24,
  width: 540,
  maxWidth: '100%',
  maxHeight: '85vh',
  overflowY: 'auto',
  boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
}

function btnStyle(primary) {
  return {
    padding: '10px 16px',
    borderRadius: 10,
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'linear-gradient(135deg, var(--accent), var(--accent2))' : 'var(--bg3)',
    color: primary ? 'var(--on-accent)' : 'var(--text2)',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'var(--sans)',
  }
}

function smallBtn() {
  return {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text2)',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'var(--mono)',
  }
}

function fallbackInfo(device) {
  const ip = String(device.ip || '').trim()
  const host = ip.includes(':') ? `[${ip}]` : ip
  const hp = Number(device.httpsPort) > 0 ? Number(device.httpsPort) : 443
  return {
    deviceId: device._id,
    deviceName: device.name,
    username: device.mgmtUsername || '',
    hasPassword: !!device.hasMgmtPassword,
    scheme: 'https',
    baseUrl: `https://${host}:${hp}`,
    httpsUrl: `https://${host}:${hp}`,
    httpUrl: `http://${host}:80`,
    httpsReachable: false,
    httpReachable: false,
    reachable: false,
    guessed: true,
    basicAuthUrl: null,
  }
}

export default function WebMgmtModal({ device, onClose }) {
  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState(() => fallbackInfo(device))
  const [probeError, setProbeError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true)
      setProbeError(null)
      try {
        const { data } = await api.get(`/api/devices/${device._id}/mgmt-probe`)
        if (!cancelled) setInfo({ ...fallbackInfo(device), ...data })
      } catch (e) {
        if (!cancelled) setProbeError(e.response?.data?.error || e.message || 'Probe failed (using configured URLs)')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [device._id])

  function openUrl(url) {
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied`)
    } catch {
      toast.error('Copy failed')
    }
  }

  async function copyPasswordFromServer() {
    try {
      const { data } = await api.get(`/api/devices/${device._id}/credentials`)
      if (!data.password) return toast.error('No saved password for this device')
      await copy(data.password, 'Password')
    } catch {
      toast.error('Could not read password')
    }
  }

  const httpsLabel = info.httpsReachable
    ? 'Open HTTPS (responding)'
    : loading
      ? 'Open HTTPS'
      : 'Open HTTPS (no response — try anyway)'
  const httpLabel = info.httpReachable
    ? 'Open HTTP (responding)'
    : loading
      ? 'Open HTTP'
      : 'Open HTTP (no response — try anyway)'

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,8,14,0.65)',
        backdropFilter: 'blur(10px)',
        zIndex: 1050,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div role="dialog" aria-modal="true" aria-label="Web console" onClick={(e) => e.stopPropagation()} style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--sans)' }}>Web console</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 6 }}>
              {device.name} · {device.ip}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              flexShrink: 0,
              width: 36,
              height: 36,
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg3)',
              color: 'var(--text2)',
              cursor: 'pointer',
              fontSize: 20,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)', lineHeight: 1.6, marginBottom: 14 }}>
          <div>
            <strong style={{ color: 'var(--text3)' }}>Detected</strong>:{' '}
            {loading
              ? 'probing…'
              : info.reachable
                ? `${info.scheme.toUpperCase()} responding`
                : 'no response from device (using configured URL)'}
          </div>
          <div style={{ marginTop: 4, color: 'var(--cyan)', wordBreak: 'break-all' }}>
            HTTPS: {info.httpsUrl} {!loading && info.httpsReachable ? '✓' : ''}
          </div>
          <div style={{ color: 'var(--cyan)', wordBreak: 'break-all' }}>
            HTTP: {info.httpUrl} {!loading && info.httpReachable ? '✓' : ''}
          </div>
          {probeError && <div style={{ color: 'var(--amber)', marginTop: 6 }}>{probeError}</div>}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          <button type="button" onClick={() => openUrl(info.httpsUrl + '/')} style={btnStyle(true)}>
            {httpsLabel}
          </button>
          <button type="button" onClick={() => openUrl(info.httpUrl + '/')} style={btnStyle(false)}>
            {httpLabel}
          </button>
        </div>

        {info.basicAuthUrl && (
          <div style={{ marginBottom: 14 }}>
            <button
              type="button"
              title="Some Cisco/legacy gear accepts user:pass@host. Modern browsers may strip the userinfo and ask for a confirmation."
              onClick={() => openUrl(info.basicAuthUrl)}
              style={{ ...btnStyle(false), fontSize: 12 }}
            >
              Try open with saved login (user:pass@host URL)
            </button>
          </div>
        )}

        {info.username && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
            <button type="button" onClick={() => copy(info.username, 'Username')} style={smallBtn()}>
              Copy username ({info.username})
            </button>
            {info.hasPassword && (
              <button type="button" onClick={copyPasswordFromServer} style={smallBtn()}>
                Copy password
              </button>
            )}
          </div>
        )}

        <div
          style={{
            fontSize: 11,
            color: 'var(--text3)',
            fontFamily: 'var(--mono)',
            lineHeight: 1.5,
            background: 'var(--bg3)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 12,
          }}
        >
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: 'var(--amber)' }}>Self-signed cert?</strong> Network gear almost always uses one. Your browser will show
            a warning page — click <em>Advanced → Proceed to {device.ip}</em> (Chrome) or <em>Accept the Risk and Continue</em> (Firefox).
          </div>
          <div>
            FortiGate / form-login UIs cannot be auto-filled cross-origin. Use <strong>Copy username/password</strong> and paste into the
            device login page.
          </div>
        </div>
      </div>
    </div>
  )
}

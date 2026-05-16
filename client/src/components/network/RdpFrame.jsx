/**
 * RdpFrame — browser-based RDP via Apache Guacamole.
 *
 * Requires guacd running on the Netpulse server (port 4822).
 *
 *   Docker:  docker run -d --name guacd -p 4822:4822 guacamole/guacd
 *   Ubuntu:  sudo apt-get install -y guacd && sudo systemctl enable --now guacd
 */
import Guacamole from '../../lib/guacamole'
import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../../api/client'
import toast from 'react-hot-toast'
import { resolvedApiBase } from '../../utils/backendOrigin'

// ── Helpers ────────────────────────────────────────────────────────────────────
function buildWsUrl(wsPath, token) {
  const base = (resolvedApiBase() || window.location.origin)
    .replace(/^http:\/\//, 'ws://')
    .replace(/^https:\/\//, 'wss://')
    .replace(/\/$/, '')
  return `${base}${wsPath}?token=${encodeURIComponent(token)}`
}

const STATE_LABEL = { 0:'idle', 1:'connecting', 2:'waiting', 3:'connected', 4:'disconnecting', 5:'disconnected' }

// ── Quality presets ────────────────────────────────────────────────────────────
const QUALITY_PRESETS = [
  { label: 'Low  (1024×768  · 8-bit)',  width: 1024, height:  768, colorDepth:  8 },
  { label: 'Med  (1280×800  · 16-bit)', width: 1280, height:  800, colorDepth: 16 },
  { label: 'High (1920×1080 · 16-bit)', width: 1920, height: 1080, colorDepth: 16 },
  { label: 'Full (1920×1080 · 32-bit)', width: 1920, height: 1080, colorDepth: 32 },
]

// ── Component ──────────────────────────────────────────────────────────────────
// Web RDP feature flag — temporarily disabled while we resolve the libguac
// instability against Windows Server 2019/2022 hosts (May 2026).  See
// UBUNTU_DEPLOY_RDP.md for context.  Set VITE_WEB_RDP_ENABLED=true in
// client/.env and rebuild to re-enable once the backend is fixed.
const WEB_RDP_ENABLED =
  String(import.meta?.env?.VITE_WEB_RDP_ENABLED ?? 'false').toLowerCase() === 'true'

export default function RdpFrame({ device, onClose }) {
  const displayWrapRef  = useRef(null)
  const containerRef    = useRef(null)
  const clientRef       = useRef(null)
  const mouseRef        = useRef(null)
  const keyboardRef     = useRef(null)
  const roRef           = useRef(null)
  const abortRef        = useRef(null)
  // Monotonically-increasing generation counter.  Each startSession call gets
  // a unique generation; every await checkpoint compares against the current
  // value so that a superseded call exits before it can open a WebSocket.
  const generationRef   = useRef(0)
  // Current CSS scale applied to the Guacamole display container.
  // Mouse coordinates from getBoundingClientRect() are in *visual* (scaled) space;
  // dividing by this factor converts them to the actual remote-desktop coordinate space.
  const scaleRef        = useRef(1)

  const [statusCode,   setStatusCode]   = useState(1)
  const [error,        setError]        = useState(null)
  const [sessionInfo,  setSessionInfo]  = useState(null)
  const [qualityIdx,   setQualityIdx]   = useState(1)
  const [fullscreen,   setFullscreen]   = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [enableWallpaper,     setEnableWallpaper]     = useState(false)
  const [enableFontSmoothing, setEnableFontSmoothing] = useState(true)
  const [security,            setSecurity]            = useState('any')
  /** Maps to Guacamole ignore-cert — automatic Yes for RDP TLS certificate prompts */
  const [ignoreCert,          setIgnoreCert]          = useState(true)
  /** When ignore-cert is off: optional FreeRDP trust-on-first-use */
  const [certTofu,           setCertTofu]            = useState(false)

  // ── Teardown helper ───────────────────────────────────────────────────────────
  const teardown = useCallback(() => {
    // Cancel any in-flight startSession async chain first.
    // This is the key fix for React StrictMode double-mount: the first mount's
    // async session creation is aborted before the second mount starts a new one.
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    if (roRef.current)       { roRef.current.disconnect(); roRef.current = null }
    if (keyboardRef.current) {
      try {
        if (typeof keyboardRef.current.destroy === 'function') keyboardRef.current.destroy()
        else {
          keyboardRef.current.onkeydown = null
          keyboardRef.current.onkeyup = null
        }
      } catch {}
      keyboardRef.current = null
    }
    if (mouseRef.current) {
      try { mouseRef.current.onmousedown = null; mouseRef.current.onmousemove = null; mouseRef.current.onmouseup = null } catch {}
      mouseRef.current = null
    }
    if (clientRef.current) {
      try { clientRef.current.disconnect() } catch {}
      clientRef.current = null
    }
  }, [])

  // ── Start session ─────────────────────────────────────────────────────────────
  const startSession = useCallback(async (preset) => {
    // Claim a generation slot.  Any prior in-flight call will see its gen no
    // longer matches generationRef.current after its next await and will exit.
    const gen = ++generationRef.current

    teardown()   // abort prior AbortController + disconnect prior client
    setError(null)
    setStatusCode(1)

    // AbortController for the axios request so the HTTP call is also cancelled
    // when a newer session supersedes this one.
    const controller = new AbortController()
    abortRef.current = controller

    // 1. Create session token via REST
    let session
    try {
      const { data } = await api.post(`/api/rdp/session/${device._id}`, {
        width:              preset.width,
        height:             preset.height,
        colorDepth:         preset.colorDepth,
        enableWallpaper,
        enableFontSmoothing,
        security,
        ignoreCert,
        certTofu: !ignoreCert && certTofu,
      }, { signal: controller.signal })
      if (gen !== generationRef.current) return  // superseded while awaiting
      session = data
      setSessionInfo(data)
    } catch (e) {
      if (gen !== generationRef.current) return  // superseded
      if (e.name === 'CanceledError' || e.name === 'AbortError') return
      const msg = e.response?.data?.error || e.message || 'Failed to create RDP session'
      setError(msg)
      setStatusCode(5)
      toast.error(msg)
      return
    }

    if (gen !== generationRef.current) return  // superseded before WebSocket open

    // 2. Open WebSocket tunnel → guacd proxy
    const wsUrl  = buildWsUrl(session.wsPath, session.token)
    const tunnel = new Guacamole.WebSocketTunnel(wsUrl)
    const client = new Guacamole.Client(tunnel)
    clientRef.current = client

    // Client registers tunnel.onerror to sync internal state; preserve it after we wrap logging.
    const clientTunnelOnError = tunnel.onerror
    tunnel.onerror = (err) => {
      try { clientTunnelOnError?.(err) } catch (e) { console.error('[rdp] tunnel onerror chain:', e) }
      console.error('[rdp] tunnel / WebSocket:', err)
    }

    // 3. Attach canvas to wrapper div
    const display  = client.getDisplay()
    const canvas   = display.getElement()
    canvas.style.display = 'block'
    if (displayWrapRef.current) {
      displayWrapRef.current.innerHTML = ''
      displayWrapRef.current.appendChild(canvas)
    }

    // 4. Scale display to fit container
    function scaleDisplay() {
      if (!displayWrapRef.current || !clientRef.current) return
      const cw = displayWrapRef.current.clientWidth
      const ch = displayWrapRef.current.clientHeight
      if (!cw || !ch) return
      const dw    = display.getWidth()  || preset.width
      const dh    = display.getHeight() || preset.height
      const scale = Math.max(0.1, Math.min(cw / dw, ch / dh))
      scaleRef.current = scale   // keep in sync so mouse handler can correct coordinates
      display.scale(scale)
    }
    const ro = new ResizeObserver(scaleDisplay)
    ro.observe(displayWrapRef.current)
    roRef.current = ro

    // 5. Mouse handler
    // getBoundingClientRect() returns *visual* (CSS-transformed) coordinates.
    // Divide by the current scale to convert to the remote desktop's coordinate space.
    const mouse = new Guacamole.Mouse(canvas)
    mouseRef.current = mouse
    const fwd = (state) => {
      if (!clientRef.current) return
      const s = scaleRef.current || 1
      clientRef.current.sendMouseState({
        ...state,
        x: state.x / s,
        y: state.y / s,
      })
    }
    mouse.onmousedown = fwd
    mouse.onmouseup   = fwd
    mouse.onmousemove = fwd

    // 6. Keyboard handler (on document so it works even when canvas loses focus)
    const keyboard = new Guacamole.Keyboard(document)
    keyboardRef.current = keyboard
    keyboard.onkeydown = (k) => { if (clientRef.current) clientRef.current.sendKeyEvent(1, k) }
    keyboard.onkeyup   = (k) => { if (clientRef.current) clientRef.current.sendKeyEvent(0, k) }

    // 7. State + error callbacks
    client.onstatechange = (state) => {
      setStatusCode(state)
      if (state === 3) scaleDisplay() // connected — fit immediately
    }
    client.onerror = (err) => {
      const msg = err?.message || String(err) || 'Guacamole error'
      console.error('[rdp] client error:', err)
      setError(msg)
      setStatusCode(5)
    }

    // 8. Connect
    client.connect()

  }, [device._id, teardown, enableWallpaper, enableFontSmoothing, security, ignoreCert, certTofu])

  // Auto-connect on mount — gated by feature flag.  When disabled, we render the
  // "temporarily unavailable" overlay below instead of attempting a connection.
  useEffect(() => {
    if (!WEB_RDP_ENABLED) {
      setError(`Web RDP is temporarily disabled in this build.\n\nPlease use mstsc directly: open Remote Desktop Connection on your machine and connect to ${device.ip}${device.rdpPort && device.rdpPort !== 3389 ? `:${device.rdpPort}` : ''}.\n\nWeb RDP will be re-enabled once the upstream Apache Guacamole stability issue against this Windows host configuration is resolved.`)
      setStatusCode(5)
      return
    }
    startSession(QUALITY_PRESETS[qualityIdx])
    return teardown
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fullscreen change listener
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])

  // ── Ctrl+Alt+Del ─────────────────────────────────────────────────────────────
  function sendCtrlAltDel() {
    const c = clientRef.current
    if (!c) return
    c.sendKeyEvent(1, 0xFFE3)  // Ctrl
    c.sendKeyEvent(1, 0xFFE9)  // Alt
    c.sendKeyEvent(1, 0xFFFF)  // Delete
    setTimeout(() => {
      c.sendKeyEvent(0, 0xFFFF)
      c.sendKeyEvent(0, 0xFFE9)
      c.sendKeyEvent(0, 0xFFE3)
    }, 80)
  }

  function reconnect(idx) {
    setQualityIdx(idx)
    setShowSettings(false)
    startSession(QUALITY_PRESETS[idx])
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  // ── Derived UI state ──────────────────────────────────────────────────────────
  const isConnected  = statusCode === 3
  const isConnecting = !error && statusCode < 3
  const statusLabel  = STATE_LABEL[statusCode] || 'unknown'
  const statusColor  = isConnected ? '#22d3a0' : error ? '#f5534f' : '#f5ba3c'
  const quality      = QUALITY_PRESETS[qualityIdx]
  const looksLikeTunnelDrop =
    typeof error === 'string' &&
    (/1005|without a WebSocket close frame/i.test(error) || /tunnel closed/i.test(error))

  const hdrBtn = (extra) => ({
    padding: '5px 10px', borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg4)', color: 'var(--text2)',
    fontSize: 11, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
    ...extra,
  })

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(6,8,14,0.92)',
        backdropFilter: 'blur(8px)',
        zIndex: 1100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: fullscreen ? 0 : 12,
      }}
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Remote Desktop — ${device.name}`}
        onClick={e => e.stopPropagation()}
        style={{
          width:  fullscreen ? '100vw' : 'min(1440px, 100%)',
          height: fullscreen ? 'var(--app-vh, 100vh)' : 'min(920px, 96vh)',
          background: '#111',
          border: fullscreen ? 'none' : '1px solid var(--border)',
          borderRadius: fullscreen ? 0 : 14,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: fullscreen ? 'none' : '0 28px 72px rgba(0,0,0,0.75)',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px',
          background: 'var(--bg2)',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {device.name} — Remote Desktop
            </div>
            <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)', marginTop: 2 }}>
              {device.ip}:{sessionInfo?.device?.rdpPort || 3389}
              {' · '}{quality.label.replace(/.*\(/, '').replace(')', '')}
              {' · '}{statusLabel}
            </div>
          </div>

          <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />

          {isConnected && (
            <button type="button" onClick={sendCtrlAltDel} style={hdrBtn()}>Ctrl+Alt+Del</button>
          )}

          {/* Settings dropdown */}
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={() => setShowSettings(v => !v)} style={hdrBtn()}>⚙ Settings</button>
            {showSettings && (
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                  background: 'var(--bg2)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: 14, zIndex: 20, width: 260,
                  boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 10, letterSpacing: 0.5 }}>DISPLAY QUALITY</div>
                {QUALITY_PRESETS.map((p, i) => (
                  <button key={i} type="button" onClick={() => reconnect(i)} style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '7px 10px', borderRadius: 7, marginBottom: 4,
                    border: '1px solid var(--border)',
                    background: i === qualityIdx ? 'var(--accent)' : 'var(--bg3)',
                    color:      i === qualityIdx ? 'var(--on-accent)' : 'var(--text2)',
                    fontSize: 11, cursor: 'pointer',
                  }}>{p.label}</button>
                ))}
                <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>SECURITY MODE</div>
                  <select
                    value={security}
                    onChange={e => setSecurity(e.target.value)}
                    style={{
                      width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 11,
                      background: 'var(--bg3)', color: 'var(--text2)',
                      border: '1px solid var(--border)', cursor: 'pointer',
                    }}
                  >
                    <option value="any">Auto-negotiate (default)</option>
                    <option value="nla">NLA — credentials required upfront</option>
                    <option value="rdp">Classic RDP — Windows login screen</option>
                    <option value="tls">TLS only</option>
                    <option value="nla-ext">NLA Extended</option>
                  </select>
                  <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5 }}>
                    <b>Auto-negotiate</b> works with most Windows servers. Use <b>NLA</b> if Windows requires "Network Level Authentication". <b>Classic RDP</b> shows the Windows login screen but is rejected by servers that enforce NLA.
                  </div>
                </div>
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: 0.5 }}>SERVER CERTIFICATE (TLS)</div>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: 'var(--text2)', cursor: 'pointer', lineHeight: 1.45 }}>
                    <input
                      type="checkbox"
                      checked={ignoreCert}
                      onChange={(e) => {
                        const v = e.target.checked
                        setIgnoreCert(v)
                        if (v) setCertTofu(false)
                      }}
                      style={{ marginTop: 2 }}
                    />
                    Always trust server TLS certificate (<code style={{ fontSize: 10 }}>ignore-cert</code>). Same idea as clicking Yes on unknown / self-signed certificates in mstsc. Recommended on LAN.
                  </label>
                  {!ignoreCert && (
                    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: 'var(--text2)', cursor: 'pointer', lineHeight: 1.45 }}>
                      <input type="checkbox" checked={certTofu} onChange={(e) => setCertTofu(e.target.checked)} style={{ marginTop: 2 }} />
                      Trust on first connect only (<code style={{ fontSize: 10 }}>cert-tofu</code>) — remembers the certificate inside guacd; strict afterwards.
                    </label>
                  )}
                </div>
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--text2)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={enableWallpaper} onChange={e => setEnableWallpaper(e.target.checked)} />
                    Desktop wallpaper
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--text2)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={enableFontSmoothing} onChange={e => setEnableFontSmoothing(e.target.checked)} />
                    Font smoothing (ClearType)
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => { setShowSettings(false); startSession(QUALITY_PRESETS[qualityIdx]) }}
                  style={{ ...hdrBtn({ width: '100%', textAlign: 'center', marginTop: 10 }) }}
                >
                  Reconnect with these settings
                </button>
              </div>
            )}
          </div>

          <button type="button" onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} style={hdrBtn()}>
            {fullscreen ? '⊡' : '⛶'}
          </button>
          <button type="button" onClick={() => startSession(quality)} title="Reconnect" style={hdrBtn()}>↺ Reconnect</button>
          <button type="button" onClick={onClose} style={hdrBtn({ padding: '6px 14px', fontWeight: 700 })}>✕ Close</button>
        </div>

        {/* Credential warning */}
        {sessionInfo?.warning && (
          <div style={{
            flexShrink: 0, padding: '8px 14px',
            background: 'rgba(245,186,60,0.12)',
            borderBottom: '1px solid rgba(245,186,60,0.3)',
            fontSize: 11, color: '#c8a840', lineHeight: 1.5,
          }}>
            ⚠ {sessionInfo.warning}
          </div>
        )}

        {/* ── Display area ── */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#000', overflow: 'hidden' }}>

          {/* Connecting overlay */}
          {isConnecting && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 2,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              background: '#0d0f14', gap: 12,
            }}>
              <div style={{ fontSize: 13, color: 'var(--text2)', fontFamily: 'var(--mono)' }}>
                Connecting to {device.ip}…
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{statusLabel}</div>
              <div style={{ fontSize: 10, color: '#555', fontFamily: 'var(--mono)', maxWidth: 560, textAlign: 'center', lineHeight: 1.5 }}>
                Requires guacd on Netpulse. TLS prompts from Windows are handled with “trust certificate” (ignore-cert) from Settings unless you turn that off.
              </div>
            </div>
          )}

          {/* Error overlay — also shows the "Web RDP temporarily disabled" message
              when WEB_RDP_ENABLED is false (no actual connection attempt is made). */}
          {error && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 2,
              padding: '32px 28px',
              background: '#0d0f14',
              fontFamily: 'var(--mono)', fontSize: 13,
              display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto',
            }}>
              <div style={{ color: '#f5534f', fontWeight: 700, fontSize: 14 }}>
                {WEB_RDP_ENABLED ? '⚠ RDP connection failed' : 'ⓘ Web RDP temporarily unavailable'}
              </div>
              <div style={{ color: '#c06060', lineHeight: 1.6, maxWidth: 680, whiteSpace: 'pre-line' }}>{error}</div>
              {WEB_RDP_ENABLED && (
                <div style={{
                  padding: 16, borderRadius: 10,
                  background: 'rgba(79,126,245,0.08)', border: '1px solid rgba(79,126,245,0.2)',
                  fontSize: 11, color: '#8ab4f8', lineHeight: 1.8,
                }}>
                  {looksLikeTunnelDrop ? (
                    <>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Tunnel dropped — guacd was usually reachable</div>
                      <div>If logs show “RDP session ready” then an immediate drop, Windows ended the session or the API restarted (Redis / node --watch). Try Classic RDP or NLA in Settings, a lower resolution preset, and stable Redis. Put a reverse proxy in front? Confirm WebSocket upgrade and idle timeouts for <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: 4 }}>/api/rdp/ws</code>.</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>guacd setup (required on the Netpulse server):</div>
                      <div>Docker: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: 4 }}>docker run -d --name guacd -p 4822:4822 guacamole/guacd</code></div>
                      <div style={{ marginTop: 4 }}>Ubuntu: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: 4 }}>sudo apt-get install -y guacd && sudo systemctl enable --now guacd</code></div>
                      <div style={{ marginTop: 4 }}>Override: set <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: 4 }}>GUACD_HOST</code> / <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: 4 }}>GUACD_PORT</code> in .env</div>
                    </>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {WEB_RDP_ENABLED && (
                  <button type="button" onClick={() => startSession(quality)} style={{ ...hdrBtn(), background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', padding: '8px 16px' }}>
                    Retry
                  </button>
                )}
                <button type="button" onClick={onClose} style={{ ...hdrBtn(), padding: '8px 16px' }}>Close</button>
              </div>
            </div>
          )}

          {/* Guacamole canvas target */}
          <div
            ref={displayWrapRef}
            style={{ width: '100%', height: '100%', cursor: isConnected ? 'none' : 'default', lineHeight: 0 }}
            tabIndex={-1}
          />
        </div>

        {/* ── Footer ── */}
        <div style={{
          flexShrink: 0, padding: '6px 14px',
          background: 'var(--bg2)', borderTop: '1px solid var(--border)',
          fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)', lineHeight: 1.5,
        }}>
          Powered by Apache Guacamole · guacd required on Netpulse server ·
          Credentials: Admin → Devices → Edit → Username + Password (Save password ticked)
        </div>
      </div>
    </div>
  )
}

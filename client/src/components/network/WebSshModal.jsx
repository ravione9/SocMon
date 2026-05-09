import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuthStore } from '../../store/authStore'
import { resolvedWsUrl } from '../../utils/backendOrigin'
import toast from 'react-hot-toast'

function createWebSshSocket(token) {
  const ws = resolvedWsUrl()
  const opts = { path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'] }
  if (ws) {
    const base = ws.replace(/\/$/, '')
    return io(`${base}/web-ssh`, opts)
  }
  return io('/web-ssh', opts)
}

export default function WebSshModal({ device, onClose }) {
  const token = useAuthStore((s) => s.token)
  const wrapRef = useRef(null)
  const [status, setStatus] = useState('connecting')

  useEffect(() => {
    if (!device?._id || !token) return undefined
    const socket = createWebSshSocket(token)

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#0d0f14',
        foreground: '#e6e8ed',
        cursor: '#4f7ef5',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(wrapRef.current)

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const d = term.cols
        const r = term.rows
        if (d > 0 && r > 0) socket.emit('web-ssh:resize', { cols: d, rows: r })
      } catch {
        /* ignore */
      }
    })
    ro.observe(wrapRef.current)

    term.onData((data) => socket.emit('web-ssh:input', data))

    socket.on('connect', () => {
      setStatus('negotiating')
      socket.emit('web-ssh:start', {
        deviceId: device._id,
        cols: term.cols,
        rows: term.rows,
      })
    })

    socket.on('web-ssh:ready', () => {
      setStatus('connected')
      term.focus()
    })

    socket.on('web-ssh:data', (data) => {
      term.write(typeof data === 'string' ? data : '')
    })

    socket.on('web-ssh:error', ({ message } = {}) => {
      setStatus('error')
      toast.error(message || 'SSH error')
      term.writeln(`\r\n\x1b[31m${message || 'SSH error'}\x1b[0m\r\n`)
    })

    socket.on('web-ssh:closed', () => {
      setStatus('closed')
      term.writeln('\r\n\x1b[33mSession closed.\x1b[0m\r\n')
    })

    socket.on('connect_error', () => {
      setStatus('error')
      toast.error('Could not connect to SSH relay (check network / auth)')
    })

    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      socket.connect()
    })

    return () => {
      ro.disconnect()
      try {
        if (socket.connected) socket.emit('web-ssh:close')
      } catch {
        /* ignore */
      }
      socket.removeAllListeners()
      socket.disconnect()
      term.dispose()
    }
  }, [device?._id, token])

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,8,14,0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Web SSH"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(960px, 100%)',
          height: 'min(640px, 85vh)',
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg3)',
            fontFamily: 'var(--sans)',
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              Web SSH — {device?.name}
            </div>
            <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', marginTop: 4 }}>
              {device?.ip} · session is recorded in Netpulse · {status}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg4)',
              color: 'var(--text2)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            Close
          </button>
        </div>
        <div ref={wrapRef} style={{ flex: 1, minHeight: 0, padding: 8, background: '#0d0f14' }} />
      </div>
    </div>
  )
}

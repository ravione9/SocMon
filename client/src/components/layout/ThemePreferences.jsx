import { useState, useRef, useEffect } from 'react'
import api from '../../api/client'
import { THEMES } from '../../constants/themes'
import { useThemeStore } from '../../store/themeStore'
import { useAuthStore } from '../../store/authStore'
import toast from 'react-hot-toast'

export default function ThemePreferences() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const theme = useThemeStore((s) => s.theme)
  const saveToProfile = useThemeStore((s) => s.saveToProfile)
  const setTheme = useThemeStore((s) => s.setTheme)
  const setSaveToProfile = useThemeStore((s) => s.setSaveToProfile)
  const patchUser = useAuthStore((s) => s.patchUser)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function persistToServer(nextTheme, nextSave, { enableProfile } = {}) {
    try {
      const body =
        !nextSave
          ? { themeSaveToProfile: false }
          : enableProfile
            ? { themeSaveToProfile: true, theme: nextTheme }
            : { theme: nextTheme }
      const { data } = await api.patch('/api/auth/me', body)
      patchUser({
        theme: data.theme,
        themeSaveToProfile: data.themeSaveToProfile,
      })
      return true
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update profile theme')
      return false
    }
  }

  function onPickTheme(id) {
    setTheme(id)
    if (saveToProfile) void persistToServer(id, true)
  }

  async function onToggleSave(checked) {
    const prev = saveToProfile
    setSaveToProfile(checked)
    const ok = checked
      ? await persistToServer(theme, true, { enableProfile: true })
      : await persistToServer(theme, false)
    if (!ok) setSaveToProfile(prev)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Theme & appearance"
        style={{
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg3)',
          color: 'var(--text2)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        Theme
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 8,
            width: 300,
            maxWidth: 'min(300px, calc(100vw - 24px))',
            padding: 14,
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
            zIndex: 50,
          }}
        >
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Appearance
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 'min(340px, 50vh)',
              overflowY: 'auto',
              paddingRight: 4,
            }}
          >
            {THEMES.map((t) => (
              <label
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: theme === t.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: theme === t.id ? 'var(--bg4)' : 'var(--bg3)',
                  cursor: 'pointer',
                }}
              >
                <input type="radio" name="np-theme" checked={theme === t.id} onChange={() => onPickTheme(t.id)} style={{ accentColor: 'var(--accent)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t.label}</div>
                  <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>{t.hint}</div>
                </div>
              </label>
            ))}
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--text2)',
            }}
          >
            <input
              type="checkbox"
              checked={saveToProfile}
              onChange={(e) => void onToggleSave(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--accent)' }}
            />
            <span>
              <strong style={{ color: 'var(--text)', display: 'block', marginBottom: 2 }}>Save theme to my profile</strong>
              Sync this choice across browsers when you are signed in. Off keeps the theme only on this device.
            </span>
          </label>
        </div>
      )}
    </div>
  )
}

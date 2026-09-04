import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import api from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import { getPageAccessLevel } from '../../utils/pageAccess'

/** Path segments that differ from APP_PAGE_KEYS (e.g. kebab-case routes). */
const PATH_SEGMENT_TO_PAGE_KEY = {
  'email-sim': 'emailSim',
  'ro-dashboard': 'roDashboard',
}

function pathToPageKey(pathname) {
  const seg = pathname.replace(/^\//, '').split('/')[0]
  if (!seg || seg === 'no-access') return null
  return PATH_SEGMENT_TO_PAGE_KEY[seg] || seg
}

export default function Layout() {
  const patchUser = useAuthStore(s => s.patchUser)
  const user = useAuthStore(s => s.user)
  const location = useLocation()
  const syncThemeFromUser = useThemeStore(s => s.syncFromUser)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await api.get('/api/auth/me')
        if (!cancelled) {
          patchUser(data)
          syncThemeFromUser(data)
        }
      } catch {
        /* 401 handled by api client */
      }
    })()
    return () => { cancelled = true }
  }, [patchUser, syncThemeFromUser])

  const pageKey = pathToPageKey(location.pathname)
  const accessLevel = pageKey && user ? getPageAccessLevel(user, pageKey) : null
  const isAiPage = pageKey === 'ai'

  return (
    <div style={{ display:'flex', height:'var(--app-vh, 100vh)', overflow:'hidden', background:'var(--bg)' }}>
      <Sidebar />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar />
        <main
          style={{
            flex: 1,
            overflow: isAiPage ? 'hidden' : 'auto',
            padding: isAiPage ? '8px 12px' : '16px 20px',
            color: 'var(--text)',
            display: isAiPage ? 'flex' : 'block',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {accessLevel === 'read' && (
            <div
              role="status"
              style={{
                marginBottom: 14,
                padding: '10px 14px',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--bg3)',
                fontSize: 12,
                fontFamily: 'var(--mono)',
                color: 'var(--text2)',
                flexShrink: 0,
              }}
            >
              <strong style={{ color: 'var(--amber)' }}>View only</strong> — You have read-only access to this area. Actions that change data may be unavailable.
            </div>
          )}
          <div style={isAiPage ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

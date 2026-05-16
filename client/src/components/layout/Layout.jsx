import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import api from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import { getPageAccessLevel } from '../../utils/pageAccess'

function pathToPageKey(pathname) {
  const seg = pathname.replace(/^\//, '').split('/')[0]
  if (!seg || seg === 'no-access') return null
  return seg
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

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      <Sidebar />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar />
        <main style={{ flex:1, overflowY:'auto', padding:'16px 20px', color:'var(--text)' }}>
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
              }}
            >
              <strong style={{ color: 'var(--amber)' }}>View only</strong> — You have read-only access to this area. Actions that change data may be unavailable.
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import api from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'

export default function Layout() {
  const patchUser = useAuthStore(s => s.patchUser)
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

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      <Sidebar />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar />
        <main style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

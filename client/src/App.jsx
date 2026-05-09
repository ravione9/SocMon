import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/layout/Layout'
import LoginPage from './pages/Login/LoginPage'
import PageLoading from './components/ui/PageLoading.jsx'
import { canAccessPage, getFirstAllowedPath } from './utils/pageAccess'

const SOCPage = lazy(() => import('./pages/SOC/SOCPage.jsx'))
const NOCPage = lazy(() => import('./pages/NOC/NOCPage.jsx'))
const AdminPage = lazy(() => import('./pages/Admin/AdminPage.jsx'))
const TicketsPage = lazy(() => import('./pages/Tickets/TicketsPage.jsx'))
const ReportsPage = lazy(() => import('./pages/Reports/ReportsPage.jsx'))
const AIPage = lazy(() => import('./pages/AI/AIPage.jsx'))
const SentinelPage = lazy(() => import('./pages/Sentinel/SentinelPage.jsx'))
const InfraMonitoringPage = lazy(() => import('./pages/Infra/InfraMonitoringPage.jsx'))
const NoAccessPage = lazy(() => import('./pages/NoAccess/NoAccessPage.jsx'))

function PrivateRoute({ children }) {
  const token = useAuthStore(s => s.token)
  return token ? children : <Navigate to="/login" replace />
}

function PageRoute({ pageKey, children }) {
  const user = useAuthStore(s => s.user)
  if (!canAccessPage(user, pageKey)) return <Navigate to={getFirstAllowedPath(user)} replace />
  return children
}

function DefaultRedirect() {
  const user = useAuthStore(s => s.user)
  return <Navigate to={getFirstAllowedPath(user)} replace />
}

export default function App() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index element={<DefaultRedirect />} />
          <Route path="no-access" element={<NoAccessPage />} />
          <Route path="soc"      element={<PageRoute pageKey="soc"><SOCPage /></PageRoute>} />
          <Route path="noc"      element={<PageRoute pageKey="noc"><NOCPage /></PageRoute>} />
          <Route path="tickets"  element={<PageRoute pageKey="tickets"><TicketsPage /></PageRoute>} />
          <Route path="admin"    element={<PageRoute pageKey="admin"><AdminPage /></PageRoute>} />
          <Route path="reports"  element={<PageRoute pageKey="reports"><ReportsPage /></PageRoute>} />
          <Route path="sentinel" element={<PageRoute pageKey="sentinel"><SentinelPage /></PageRoute>} />
          <Route path="infra"    element={<PageRoute pageKey="infra"><InfraMonitoringPage /></PageRoute>} />
          <Route path="ai"       element={<PageRoute pageKey="ai"><AIPage /></PageRoute>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

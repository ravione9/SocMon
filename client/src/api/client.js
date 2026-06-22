import axios from 'axios'
import { useAuthStore } from '../store/authStore'
import { resolvedApiBase } from '../utils/backendOrigin.js'

const apiBase = resolvedApiBase()
const api = axios.create({ baseURL: apiBase, timeout: 30000 })
api.interceptors.request.use(config => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  const reqUrl = String(config.url || '')
  if (reqUrl.includes('/custom-dashboard/reports')) {
    /* Multi-day fleet report can take several minutes for large fleets even
       with the trend-screen + history-only-on-breach optimization. */
    config.timeout = 900000
  } else if (reqUrl.includes('/zabbix') || reqUrl.includes('/store-zabbix')) {
    config.timeout = 120000
  } else if (reqUrl.includes('/store-monitor')) {
    config.timeout = 300000
  } else if (reqUrl.includes('/api/ai')) {
    config.timeout = 360000
  }
  return config
})
api.interceptors.response.use(res => res, err => {
  const status = err.response?.status
  const reqUrl = String(err.config?.url || '')
  const sentinelOneProxy =
    reqUrl.includes('sentinel-one') ||
    reqUrl.includes('/api/sentinel-one')
  const nexsProxy = reqUrl.includes('/api/nexs')
  const authAttempt =
    reqUrl.includes('/api/auth/login') ||
    reqUrl.includes('/api/auth/register')
  const hadAuthHeader = Boolean(err.config?.headers?.Authorization)
  // Only expired Netpulse JWT should force logout — not failed login/register or upstream 401 from proxied integrations.
  if (status === 401 && !sentinelOneProxy && !nexsProxy && !authAttempt && hadAuthHeader) {
    useAuthStore.getState().logout()
    window.location.href = '/login'
  }
  return Promise.reject(err)
})
export default api

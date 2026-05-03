import axios from 'axios'
import { useAuthStore } from '../store/authStore'
import { resolvedApiBase } from '../utils/backendOrigin.js'

const apiBase = resolvedApiBase()
const api = axios.create({ baseURL: apiBase, timeout: 30000 })
api.interceptors.request.use(config => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
api.interceptors.response.use(res => res, err => {
  const status = err.response?.status
  const reqUrl = String(err.config?.url || '')
  const sentinelOneProxy =
    reqUrl.includes('sentinel-one') ||
    reqUrl.includes('/api/sentinel-one')
  // Only Netpulse JWT expiry should force logout — not SentinelOne upstream 401 mirrored by our proxy.
  if (status === 401 && !sentinelOneProxy) {
    useAuthStore.getState().logout()
    window.location.href = '/login'
  }
  return Promise.reject(err)
})
export default api

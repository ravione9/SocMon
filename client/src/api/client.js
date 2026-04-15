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
  if (err.response?.status === 401) { useAuthStore.getState().logout(); window.location.href = '/login' }
  return Promise.reject(err)
})
export default api

import api from './client'
export const devicesAPI = {
  getAll: () => api.get('/api/devices'),
  getById: (id) => api.get(`/api/devices/${id}`),
  getCredentials: (id) => api.get(`/api/devices/${id}/credentials`),
  getMgmtProbe: (id) => api.get(`/api/devices/${id}/mgmt-probe`),
  create: (data) => api.post('/api/devices', data),
  update: (id, data) => api.put(`/api/devices/${id}`, data),
  delete: (id) => api.delete(`/api/devices/${id}`),
}

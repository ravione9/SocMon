import api from './client'
export const devicesAPI = {
  getAll: () => api.get('/api/devices'),
  getById: (id) => api.get(`/api/devices/${id}`),
  create: (data) => api.post('/api/devices', data),
  update: (id, data) => api.put(`/api/devices/${id}`, data),
  delete: (id) => api.delete(`/api/devices/${id}`),
}

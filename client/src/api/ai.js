import api from './client'
export const aiAPI = {
  chat: (messages, options = {}) =>
    api.post(
      '/api/ai/chat',
      {
        messages,
        modules: options.modules,
        autoModules: options.autoModules,
        mode: options.mode || 'monitor',
      },
      { signal: options.signal },
    ),
  getModules: () => api.get('/api/ai/modules'),
  search: (question) => api.post('/api/ai/search', { question }),
  triage: (alert) => api.post('/api/ai/triage', { alert }),
  anomalies: (site) => api.get('/api/ai/anomalies', { params: { site } }),
  generateReport: (params) => api.post('/api/ai/report', params),
  getProvider: () => api.get('/api/ai/provider'),
  setProvider: (provider) => api.post('/api/ai/provider', { provider }),
}

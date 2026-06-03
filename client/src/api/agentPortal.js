import api from './client'

const agentHeaders = (apiKey) =>
  apiKey ? { headers: { 'X-Netpulse-Agent-Key': apiKey } } : {}

/** External agent API (JWT or pass apiKey for X-Netpulse-Agent-Key). */
export const agentPortalAPI = {
  meta: (apiKey) => api.get('/api/agent/meta', agentHeaders(apiKey)),
  getModules: (apiKey) => api.get('/api/agent/modules', agentHeaders(apiKey)),
  exportContext: (body, apiKey) => api.post('/api/agent/context', body, agentHeaders(apiKey)),
  query: (body, apiKey) => api.post('/api/agent/query', body, agentHeaders(apiKey)),
  forward: (body, apiKey) => api.post('/api/agent/forward', body, agentHeaders(apiKey)),
  deliver: (body, apiKey) => api.post('/api/agent/deliver', body, agentHeaders(apiKey)),
}

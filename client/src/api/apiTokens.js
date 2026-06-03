import api from './client'

export function listApiTokens() {
  return api.get('/api/auth/api-tokens').then((r) => r.data)
}

export function createApiToken({ label, expiresIn }) {
  return api.post('/api/auth/api-tokens', { label, expiresIn }).then((r) => r.data)
}

export function revokeApiToken(id) {
  return api.delete(`/api/auth/api-tokens/${id}`).then((r) => r.data)
}

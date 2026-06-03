const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/
const STORE_HOST_RE = /\b([A-Z]{2,8}(?:\d{2,6})?-[A-Z0-9]{4,})\b/i

/** Primary subject (IP or store hostname) in a user question. */
export function extractQuerySubject(text) {
  const t = String(text || '')
  const ip = t.match(IPV4_RE)?.[0]
  if (ip) return { kind: 'ip', value: ip }
  const host = t.match(STORE_HOST_RE)?.[1]
  if (host) return { kind: 'hostname', value: host.toUpperCase() }
  return null
}

/** Start a fresh chat when the new question targets a different device than the prior one. */
export function shouldStartNewThreadForQuestion(newText, messages) {
  const newSub = extractQuerySubject(newText)
  if (!newSub) return false
  const users = (messages || []).filter(m => m.role === 'user' && String(m.content || '').trim())
  if (!users.length) return false
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const prev = extractQuerySubject(users[i].content)
    if (!prev) continue
    return prev.kind !== newSub.kind || prev.value !== newSub.value
  }
  return false
}

const STORAGE_PREFIX = 'netpulse-ai-chat-sessions'
const MAX_SESSIONS = 40
const MAX_MESSAGES_PER_SESSION = 120

export const AI_WELCOME_MESSAGE = {
  role: 'assistant',
  content:
    'NetPulse AI — four chat modes:\n\n' +
    '• Monitor — tries instant live handlers first; if your wording is new, it auto-runs Agent tools (still live data, no guessing).\n' +
    '• Agent — best for free-form questions: LLM picks tools (Zabbix, XDR, firewall, stores…) then explains with recommendations.\n' +
    '• Details — full per-hostname reports across Store Monitor, Sentinel, SOC, NOC.\n' +
    '• RCA — root cause analysis with correlated timeline, ranked hypotheses, and recommended actions.\n\n' +
    'Users can ask in many ways — you do not need exact phrasing. Enable data sources above, pick a mode, then ask.',
}

function storageKey(userKey) {
  return `${STORAGE_PREFIX}:${userKey || 'anonymous'}`
}

export function newSessionId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function defaultWelcomeMessages() {
  return [{ ...AI_WELCOME_MESSAGE }]
}

/** @param {import('../utils/aiChatHistory.js').ChatMessage[]} messages */
export function deriveSessionTitle(messages, fallback = 'New chat') {
  const firstUser = (messages || []).find(m => m.role === 'user' && String(m.content || '').trim())
  if (!firstUser) return fallback
  const text = String(firstUser.content).replace(/\s+/g, ' ').trim()
  if (text.length <= 52) return text
  return `${text.slice(0, 49)}…`
}

function trimMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length <= MAX_MESSAGES_PER_SESSION) return list
  const welcome = list[0]?.role === 'assistant' && !list[0]?.reqId ? [list[0]] : []
  const rest = list.filter((m, i) => !(i === 0 && welcome.length))
  return [...welcome, ...rest.slice(-MAX_MESSAGES_PER_SESSION)]
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null
  return {
    id,
    title: String(raw.title || 'New chat').slice(0, 120),
    chatMode: raw.chatMode || 'monitor',
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    messages: trimMessages(raw.messages || defaultWelcomeMessages()),
  }
}

export function loadChatSessions(userKey) {
  try {
    const raw = localStorage.getItem(storageKey(userKey))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeSession).filter(Boolean).sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  } catch {
    return []
  }
}

export function saveChatSessions(userKey, sessions) {
  try {
    const list = (Array.isArray(sessions) ? sessions : [])
      .map(normalizeSession)
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, MAX_SESSIONS)
    localStorage.setItem(storageKey(userKey), JSON.stringify(list))
    return list
  } catch {
    return sessions
  }
}

export function createChatSession({ chatMode = 'monitor', messages = null } = {}) {
  const now = new Date().toISOString()
  const msgs = messages || defaultWelcomeMessages()
  return {
    id: newSessionId(),
    title: deriveSessionTitle(msgs),
    chatMode,
    createdAt: now,
    updatedAt: now,
    messages: trimMessages(msgs),
  }
}

export function persistSessionInList(userKey, sessions, session) {
  const normalized = normalizeSession(session)
  if (!normalized) return sessions
  const rest = (sessions || []).filter(s => s.id !== normalized.id)
  const next = [normalized, ...rest]
  return saveChatSessions(userKey, next)
}

export function deleteChatSession(userKey, sessionId, sessions) {
  const next = (sessions || []).filter(s => s.id !== sessionId)
  saveChatSessions(userKey, next)
  return next
}

export function formatSessionWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
  }
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

export function hasUserMessages(messages) {
  return (messages || []).some(m => m.role === 'user' && String(m.content || '').trim())
}

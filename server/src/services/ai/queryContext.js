import { isXdrQuestion } from './xdrDirectAnswer.js'
import { isNetworkInfraQuery, isZabbixQuestion, isInfraDeviceStatusQuery, extractHostGroupFilter, extractHostGroupFromThread, extractIpv4, extractIpv4FromThread, extractZabbixHostFromThread, extractInfraHostName, extractInfraHostFromThread } from './zabbixDirectAnswer.js'
import { isFirewallQuestion, isSocReportQuery } from './socDirectAnswer.js'
import { isDisconnectionLogQuery } from './nocDirectAnswer.js'
import { isRcaQuery } from './rcaAnalysis.js'

/**
 * Parse time window from natural language, e.g. "last 1 hr" → "-1h".
 * @param {string} q
 */
export function parseQuestionTimeRange(q) {
  const text = String(q || '').toLowerCase()
  let m = text.match(/last\s+(\d+)\s*(m|min|mins|minute|minutes)\b/)
  if (m) return `-${m[1]}m`
  m = text.match(/last\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/)
  if (m) return `-${m[1]}h`
  m = text.match(/last\s+(\d+)\s*(d|day|days)\b/)
  if (m) return `-${m[1]}d`
  m = text.match(/\b(\d+)\s*(m|min|mins|minute|minutes)\b/)
  if (m) return `-${m[1]}m`
  if (/\b(last hour|past hour|1 hr|1hr|one hour)\b/.test(text)) return '-1h'
  if (/\b(last 24|24 hour|24h|last day|past day)\b/.test(text)) return '-24h'
  if (/\b(last week|7 day|7d|past week)\b/.test(text)) return '-7d'
  if (/\blast\b/.test(text)) return '-1h'
  return '-24h'
}

const CRASH_MARKERS = /\b(crash|crashed|crashes|crahed|app crash|app hang|watchdog)\b/i
const STORE_MARKERS = /\b(store monitor|offline|online|down|monitor status|how many stores)\b/i
const FOLLOWUP_AFFECTED = /\b(which stores|what stores|stores are affected|affected stores|list stores|show stores|which ones|name them|hostname)\b/i
const APP_ONLY = /\b(only for|just for|only about|asking about only)\b/i
const HOSTNAME_DETAIL = /\b(complete details|full details|all environ|all enviro|all data|full data|give me all|give me.*details|details of|everything about|store details|this hostname|usb|threat)\b/i

/** Store agent hostname — RP1537-E519BNZT or WGGN-4CE225BH1H (prefix may omit store digits). */
export const STORE_HOSTNAME_RE = /\b([A-Z]{2,5}(?:\d+)?-(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,})\b/i

/** Question asks for a hostname-scoped data dump (instant path, no LLM). */
export function isHostnameDataRequest(q) {
  const text = String(q || '')
  if (isZabbixQuestion(text) || isNetworkInfraQuery(text)) return false
  if (HOSTNAME_DETAIL.test(text)) return true
  if (/\b(all data|full data|all info|give me all|complete data|entire data|all details)\b/i.test(text)) {
    if (/\b(zabbix|network devices?|server status|servers? status)\b/i.test(text)) return false
    return true
  }
  if (/\b(data|details|info|information|status|health|report)\b/i.test(text) && /\b(of|for|about)\b/i.test(text)) {
    if (/\b(zabbix|network|server|servers|device|devices)\b/i.test(text) && !extractStoreHostname(text)) return false
    return true
  }
  return false
}

const STOPWORDS = new Set([
  'which', 'stores', 'store', 'affected', 'about', 'only', 'just', 'asking',
  'need', 'show', 'list', 'many', 'last', 'hour', 'hours', 'the', 'for',
])

const FOLLOWUP_MARKERS = /\b(this|that|same|it|those|above|previous|earlier|also|what about|how about|tell me more|follow.?up|same device|same host|same ip|same firewall|the vpn|the tunnel|these problems|that host|that device)\b/i

function isFollowUpPhrasing(q) {
  return FOLLOWUP_MARKERS.test(String(q || ''))
}

/**
 * @typedef {'crash'|'xdr'|'store'|'soc'|'general'} QueryTopic
 */

/**
 * @param {{ role: string, content: string }[]} messages
 */
export function resolveQueryContext(messages, opts = {}) {
  const chatMode = ['monitor', 'details', 'rca', 'agent'].includes(opts.chatMode) ? opts.chatMode : 'monitor'
  const thread = (messages || [])
    .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
    .map(m => ({ role: m.role, content: m.content.trim() }))
    .filter(m => m.content)

  const userMessages = thread.filter(m => m.role === 'user')
  const currentQuestion = userMessages[userMessages.length - 1]?.content || ''
  const priorAssistant = [...thread].reverse().find(m => m.role === 'assistant')?.content || ''
  const priorUser = userMessages.length > 1 ? userMessages[userMessages.length - 2]?.content || '' : ''
  const priorTopic = inferTopicFromAssistant(priorAssistant)
  const threadText = thread.map(m => m.content).join('\n')

  const isFollowUp = userMessages.length > 1
    && (isFollowUpPhrasing(currentQuestion)
      || currentQuestion.split(/\s+/).length <= 24
      || Boolean(priorTopic))
  const followUpKind = detectFollowUpKind(currentQuestion)

  const ip = extractIpv4(currentQuestion)
    || (isFollowUp ? extractIpv4FromThread(threadText) : null)
    || (isFollowUp ? extractIpv4FromThread(priorAssistant) : null)

  const zabbixHost = extractZabbixHostFromThread(currentQuestion)
    || (isFollowUp && priorTopic === 'zabbix'
      ? extractZabbixHostFromThread(priorAssistant) || extractZabbixHostFromThread(threadText)
      : null)

  const infraHost = extractInfraHostName(currentQuestion)
    || (isFollowUp ? extractInfraHostFromThread(priorUser) : null)
    || (isFollowUp ? extractInfraHostFromThread(threadText) : null)
    || (isFollowUp && priorTopic === 'zabbix' ? extractInfraHostFromThread(priorAssistant) : null)

  const ctxLite = { isFollowUp, priorTopic, threadText, priorAssistant, priorUser, ip, zabbixHost, infraHost }
  const hostGroup = extractHostGroupFilter(currentQuestion, ctxLite)
    || (isFollowUp && priorTopic === 'zabbix' ? extractHostGroupFromThread(threadText) : null)

  const hostname = extractStoreHostname(currentQuestion)
    || (!isZabbixQuestion(currentQuestion) && !isNetworkInfraQuery(currentQuestion) && isFollowUp && priorTopic === 'hostname'
      ? extractStoreHostname(priorAssistant)
      : null)
    || (!isZabbixQuestion(currentQuestion) && !isNetworkInfraQuery(currentQuestion) && isFollowUp && priorTopic === 'hostname'
      ? extractStoreHostname(threadText)
      : null)

  const appNameFromCurrent = extractAppName(currentQuestion)
  const appName = appNameFromCurrent
    || (hasExplicitCrashSubject(currentQuestion) ? null : extractAppNameFromUserHistory(userMessages.slice(0, -1)))
    || (appNameFromCurrent ? null : extractAppNameFromAssistant(priorAssistant))

  let topic = detectTopicFromQuestion(currentQuestion, appName, { chatMode, isFollowUp, priorTopic })
  if (!topic && chatMode === 'rca') topic = 'rca'
  if (!topic && chatMode === 'details' && hostname) topic = 'hostname'
  if (!topic && hostname && isHostnameDataRequest(currentQuestion)) topic = 'hostname'
  if (!topic && isFollowUp && priorTopic) topic = priorTopic
  if (!topic && isFollowUp && (ip || zabbixHost) && priorTopic === 'zabbix') topic = 'zabbix'
  if (!topic && appName && (APP_ONLY.test(currentQuestion) || priorTopic === 'crash')) {
    topic = 'crash'
  }

  let range = parseQuestionTimeRange(currentQuestion)
  if (isFollowUp && !hasExplicitTimeRange(currentQuestion)) {
    range = extractRangeFromAssistant(priorAssistant) || range
  }

  const wantsStoreList =
    followUpKind === 'affected_stores'
    || /\b(list|which|show|hostname|name them)\b/i.test(currentQuestion)
    || (topic === 'crash' && !!appName)

  const wantsCrashEventList = wantsCrashEventLog(currentQuestion, {
    isFollowUp,
    priorTopic,
    followUpKind,
  })

  const directHandler = pickDirectHandler({
    currentQuestion,
    topic,
    priorTopic,
    isFollowUp,
    followUpKind,
    appName,
    hostname,
    ip,
    zabbixHost,
    chatMode,
  })

  return {
    currentQuestion,
    topic,
    priorTopic,
    priorAssistant,
    priorUser,
    appName,
    hostname,
    hostGroup,
    ip,
    zabbixHost,
    infraHost,
    range,
    isFollowUp,
    followUpKind,
    wantsStoreList,
    wantsCrashEventList,
    directHandler,
    threadText,
    chatMode,
  }
}

/** @returns {QueryTopic|null} */
function inferTopicFromAssistant(text) {
  const t = String(text || '')
  if (/Disk usage report|Zabbix network|Infra Zabbix|Store Zabbix|Host group:|Host filter:|device analysis|── AI Analysis ──/i.test(t)) return 'zabbix'
  if (/Store hostname report|Hostname report|Metrics chart/i.test(t)) return 'hostname'
  if (/App Crashes|Influx crash|crash events/i.test(t)) return 'crash'
  if (/SentinelOne XDR|PowerQuery used/i.test(t)) return 'xdr'
  if (/Store Monitor \(LIVE/i.test(t)) return 'store'
  if (/Root Cause Analysis|Ranked hypotheses/i.test(t)) return 'rca'
  if (/Disconnection logs|USB disconnections|Cisco interface disconnections/i.test(t)) return 'noc'
  if (/FortiGate \/ SOC|SOC \/ firewall|complete report/i.test(t)) return 'soc'
  return null
}

function detectTopicFromQuestion(q, appName, ctx = {}) {
  const text = String(q || '')
  if (isRcaQuery(text, ctx)) return 'rca'
  if (isSocReportQuery(text)) return 'soc'
  if (isZabbixQuestion(text)) return 'zabbix'
  if (isInfraDeviceStatusQuery(text)) return 'zabbix'
  if (isDisconnectionLogQuery(text)) return 'noc'
  if (isFirewallQuestion(text)) return 'soc'
  if (isXdrQuestion(text)) return 'xdr'
  if (CRASH_MARKERS.test(text) || (appName && APP_ONLY.test(text))) return 'crash'
  if (STORE_MARKERS.test(text) && !FOLLOWUP_AFFECTED.test(text)) return 'store'
  if (/\b(firewall|fortigate|deny|soc)\b/i.test(text)) return 'soc'
  return null
}

function detectFollowUpKind(q) {
  const text = String(q || '').toLowerCase()
  const storeMonitorIntent = /\b(offline|online|down|monitor|connectivity|ping|isp)\b/.test(text)
  if (/\b(graph|graphical|chart|visual|plot|timeline)\b/.test(text)) return 'chart'
  if (/\b(timestamp|time stamp|timestamps|when.*crash|crash time|when the app|each crash|event log|with time)\b/.test(text)) return 'crash_events'
  if (!storeMonitorIntent && FOLLOWUP_AFFECTED.test(text)) return 'affected_stores'
  if (/\b(how many|count|total)\b/.test(text)) return 'count'
  if (/\b(list|show|which|hostname)\b/.test(text)) return 'list'
  return null
}

/** User wants per-crash rows with hostname + timestamp (not aggregate summary). */
export function wantsCrashEventLog(question, ctx = null) {
  const text = String(question || '')
  if (/\bcrash events?\b/i.test(text) && /\b(timestamp|hostname|time stamp|with time)\b/i.test(text)) return true
  if (/\b(timestamp|time stamp|timestamps|crash time|app crash time|crash event|each crash|event log|with hostname|hostname and time|when the app cras\w*|when did|what time)\b/i.test(text)) return true
  if (/\b(with|need|give|show)\b/i.test(text) && /\b(time|timestamp|hostname)\b/i.test(text) && /\b(crash|app)\b/i.test(text)) return true
  if (ctx?.followUpKind === 'crash_events') return true
  if (ctx?.isFollowUp && ctx?.priorTopic === 'crash' && /\b(time|timestamp|when|hostname|host name|event)\b/i.test(text)) return true
  return false
}

function pickDirectHandler({ currentQuestion, topic, priorTopic, isFollowUp, followUpKind, appName, hostname, ip, zabbixHost, chatMode = 'monitor' }) {
  const q = String(currentQuestion || '')
  const ctxLite = { isFollowUp, priorTopic, chatMode, hostname, ip, zabbixHost, directHandler: null }
  const storeMonitorIntent = /\b(offline|online|down|monitor status|store monitor|how many stores)\b/i.test(q)
  const chartRequest = /\b(graph|graphical|chart|visual|plot|timeline)\b/i.test(q)

  if ((isRcaQuery(q, ctxLite) || topic === 'rca') && chatMode !== 'details') return 'rca'
  if (chatMode === 'details' && hostname && !isRcaQuery(q, ctxLite)) return 'hostname'

  if (isSocReportQuery(q) || (isFirewallQuestion(q) && !isZabbixQuestion(q, ctxLite))) return 'soc'
  if (isZabbixQuestion(q, { ...ctxLite, ip, zabbixHost })) return 'zabbix'
  if (isDisconnectionLogQuery(q, { isFollowUp, priorTopic })) return 'noc'
  if (isFollowUp && priorTopic === 'noc' && /\b(usb|hostname|rp group|timestamp|disconn|show|list|required|only)\b/i.test(q)) return 'noc'

  const hostnameDetail =
    (hostname && isHostnameDataRequest(q))
    || (isFollowUp && priorTopic === 'hostname' && !isNetworkInfraQuery(q) && !isZabbixQuestion(q))
    || (chartRequest && isFollowUp && priorTopic === 'hostname')
    || (hostname && (
      HOSTNAME_DETAIL.test(q)
      || (/\b(hostname|host)\b/i.test(q) && /\b(details|detail|info|information)\b/i.test(q))
    ))

  if (hostnameDetail) return 'hostname'

  if (isXdrQuestion(q) || topic === 'xdr' || (isFollowUp && priorTopic === 'xdr' && !storeMonitorIntent)) return 'xdr'
  if (
    !storeMonitorIntent && (
      topic === 'crash'
      || priorTopic === 'crash' && isFollowUp
      || CRASH_MARKERS.test(q)
      || (appName && (APP_ONLY.test(q) || priorTopic === 'crash'))
      || (followUpKind === 'affected_stores' && priorTopic === 'crash')
      || (followUpKind === 'crash_events' && priorTopic === 'crash')
    )
  ) {
    return 'crash'
  }
  if (topic === 'store' || storeMonitorIntent) {
    return 'store'
  }
  return null
}

function hasExplicitCrashSubject(text) {
  const t = String(text || '')
  return CRASH_MARKERS.test(t)
    && /\b([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\b/.test(t)
}

function extractAppNameFromUserHistory(userMessages) {
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const name = extractAppName(userMessages[i].content)
    if (name) return name
  }
  return null
}

function extractAppName(text) {
  const t = String(text || '')
  let m = t.match(/\b([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\s+app\s+crash/i)
  if (m) return cleanAppName(m[1])
  m = t.match(/\b(?:details of|about|for)\s+([A-Za-z0-9][A-Za-z0-9_.-]*(?:[-_][A-Za-z0-9_.-]+)*)\b/i)
  if (m && !STOPWORDS.has(m[1].toLowerCase())) return cleanAppName(m[1])
  m = t.match(/\b(?:only|just)\s+(?:for|about)\s+([A-Za-z0-9_.-]+)\b/i)
  if (m) return cleanAppName(m[1])
  m = t.match(/\b(?:for|about)\s+([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/i)
  if (m) return cleanAppName(m[1])
  m = t.match(/\b([A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/)
  if (m && !STOPWORDS.has(m[1].toLowerCase())) return cleanAppName(m[1])
  m = t.match(/\b([A-Za-z0-9_-]+\.exe)\b/i)
  if (m) return cleanAppName(m[1])
  return null
}

function extractAppNameFromAssistant(text) {
  const m = String(text || '').match(/^([A-Za-z0-9_.-]+)\s+App Crashes/m)
  return m ? cleanAppName(m[1]) : null
}

function cleanAppName(name) {
  return String(name || '').replace(/[.,;:!?]+$/, '').trim()
}

export function extractStoreHostname(text) {
  const m = String(text || '').match(STORE_HOSTNAME_RE)
  return m ? m[1].toUpperCase() : null
}

function hasExplicitTimeRange(q) {
  return /\b(last|past)\s+\d+\s*(h|hr|hour|hours|m|min|d|day)/i.test(q)
    || /\b(1 hr|24h|24 hour|last hour|last day|last week)\b/i.test(q)
}

function extractRangeFromAssistant(text) {
  const t = String(text || '')
  const m = t.match(/Window:\s*(last \d+ \w+(?:\s+\w+)?)/i)
  if (!m) return null
  const label = m[1].toLowerCase()
  if (label.includes('minute') || label.includes('min')) {
    const n = label.match(/(\d+)/)
    return n ? `-${n[1]}m` : '-5m'
  }
  if (label.includes('hour')) {
    const n = label.match(/(\d+)/)
    return n ? `-${n[1]}h` : '-1h'
  }
  if (label.includes('day')) {
    const n = label.match(/(\d+)/)
    return n ? `-${n[1]}d` : '-24h'
  }
  return null
}

export function appNameMatches(recordApp, filter) {
  if (!filter) return true
  const a = String(recordApp || '').toLowerCase()
  const f = String(filter || '').toLowerCase()
  if (!a || !f) return false
  return a === f || a.includes(f) || f.includes(a)
}

function normalizeCrashToken(value) {
  return String(value || '').toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
}

/**
 * Match crash rows by app name, measurement, label, or message (e.g. Microsoft-Windows-Kernel-Power).
 * @param {{ appName?: string|null, crashType?: string, lastMessage?: string|null }} record
 * @param {string|null} filter
 * @param {(meas: string) => string} [typeLabelFn]
 */
export function crashRecordMatches(record, filter, typeLabelFn = (m) => m) {
  if (!filter) return true
  const f = normalizeCrashToken(filter)
  if (!f) return true

  if (f.includes('kernel') && f.includes('power')) {
    return record.crashType === 'bsod_kernel_power'
      || normalizeCrashToken(record.appName).includes('kernel')
      || normalizeCrashToken(record.lastMessage).includes('kernel')
  }

  const app = normalizeCrashToken(record.appName)
  const type = normalizeCrashToken(record.crashType)
  const msg = normalizeCrashToken(record.lastMessage)
  const label = normalizeCrashToken(typeLabelFn(record.crashType || ''))

  return appNameMatches(record.appName, filter)
    || (app && (app.includes(f) || f.includes(app)))
    || (type && (type.includes(f) || f.includes(type)))
    || (label && (label.includes(f) || f.includes(label)))
    || (msg && msg.includes(f))
}

export function formatRangeLabelFromInflux(range) {
  const labels = {
    '-1h': 'last 1 hour',
    '-3h': 'last 3 hours',
    '-6h': 'last 6 hours',
    '-12h': 'last 12 hours',
    '-24h': 'last 24 hours',
    '-2d': 'last 2 days',
    '-7d': 'last 7 days',
  }
  return labels[range] || range.replace(/^-/, 'last ')
}

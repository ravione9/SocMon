import { isXdrQuestion } from './xdrDirectAnswer.js'
import { isGeoConnectionQuery, isStoreConnectivityFollowUp, isStoreMonitorConnectivityQuery } from './geoConnectionQuery.js'
import { isNetworkInfraQuery, isZabbixQuestion, isInfraDeviceStatusQuery, extractHostGroupFilter, extractHostGroupFromThread, extractIpv4, extractIpv4FromThread, extractZabbixHostFromThread, extractInfraHostName, extractInfraHostFromThread, wantsCpuMemoryUtil } from './zabbixDirectAnswer.js'
import { isFirewallQuestion, isSocReportQuery } from './socDirectAnswer.js'
import { isDisconnectionLogQuery } from './nocDirectAnswer.js'
import { isRcaQuery } from './rcaAnalysis.js'
import { isStoreMonitorIssuesQuery, isStoreDowntimeQuery } from './geoConnectionQuery.js'

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
  if (/\b(last 24|24 hour|24 hours|24h|last day|past day)\b/.test(text)) return '-24h'
  if (/\b(?:time range|range|window|past|last)?\s*24\s*hours?\b/.test(text)) return '-24h'
  if (/\b(?:time range|range|window|past|last)?\s*12\s*hours?\b/.test(text)) return '-12h'
  if (/\b(last week|7 day|7d|past week)\b/.test(text)) return '-7d'
  if (/\blast\b/.test(text)) return '-1h'
  return '-24h'
}

const CRASH_MARKERS = /\b(crash|crashed|crashes|crahed|app crash|app hang|watchdog)\b/i
const STORE_MARKERS = /\b(store monitor|offline|online|down|monitor status|how many stores)\b/i
const FOLLOWUP_AFFECTED = /\b(which stores|what stores|stores are affected|affected stores|list stores|show stores|which ones|name them|hostname)\b/i
const APP_ONLY = /\b(only for|just for|only about|asking about only)\b/i
const HOSTNAME_DETAIL = /\b(complete details|full details|all environ|all enviro|all data|full data|give me all|give me.*details|details of|everything about|store details|this hostname|usb|threat)\b/i

/** Store agent hostname — RP1190-E519BNYW, RP1537-E519BNZT, WGGN-4CE225BH1H */
export const STORE_HOSTNAME_RE = /\b([A-Z]{2,8}(?:\d{2,6})?-[A-Z0-9]{4,})\b/i

/** Store/retail hostname question — search Store Monitor, Sentinel, SOC, NOC (not Infra Zabbix-only). */
export function isStoreHostnamePortalQuery(q) {
  const text = String(q || '')
  const host = extractStoreHostname(text)
  if (!host) return false
  if (/\b(zabbix|infra mon|infra host|network devices?|servers? status)\b/i.test(text) && !HOSTNAME_DETAIL.test(text)) {
    return false
  }
  if (HOSTNAME_DETAIL.test(text)) return true
  if (/\b(data|details|info|information|status|health|report|environment|environ)\b/i.test(text) && /\b(of|for|about)\b/i.test(text)) {
    return true
  }
  return false
}

/** Question asks for a hostname-scoped data dump (instant path, no LLM). */
export function isHostnameDataRequest(q) {
  const text = String(q || '')
  if (isStoreHostnamePortalQuery(text)) return true
  if (/\b(zabbix|infra mon)\b/i.test(text)) return false
  if (isNetworkInfraQuery(text)) return false
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

function sameSubjectAsPrior(currentQuestion, priorUser, priorAssistant) {
  const curIp = extractIpv4(currentQuestion)
  const curHost = extractStoreHostname(currentQuestion)
  const priorIp = extractIpv4(priorUser) || extractIpv4FromThread(priorAssistant)
  const priorHost = extractStoreHostname(priorUser) || extractStoreHostname(priorAssistant)
  if (curIp && priorIp) return curIp === priorIp
  if (curHost && priorHost) return curHost === priorHost
  if (!curIp && !curHost && (priorIp || priorHost)) {
    if (/\b(cpu|memory|mem|ram|disk|bandwidth|ping|utilization|utilisation|interface|traffic)\b/i.test(currentQuestion)) {
      return true
    }
  }
  return false
}

function isZabbixResourceFollowUp(question, priorTopic) {
  if (priorTopic !== 'zabbix') return false
  return /\b(cpu|memory|mem|ram|disk|bandwidth|ping|utilization|utilisation|interface|traffic)\b/i.test(String(question || ''))
}

function isXdrIntent(q) {
  if (isStoreMonitorConnectivityQuery(q)) return false
  return isXdrQuestion(q) || isGeoConnectionQuery(q)
}

/** New user turn targets a different IP/hostname than the prior exchange — do not inherit Zabbix/thread context. */
function detectSubjectChange(currentQuestion, priorUser, priorAssistant, priorTopic) {
  const q = String(currentQuestion || '')
  if (isXdrIntent(q) && priorTopic && priorTopic !== 'xdr') return true
  const currentIp = extractIpv4(q)
  const currentHostname = extractStoreHostname(q)
  const priorIp = extractIpv4(priorUser) || extractIpv4FromThread(priorAssistant)
  const priorHostname = extractStoreHostname(priorUser) || extractStoreHostname(priorAssistant)

  if (currentHostname && priorIp && !currentIp) return true
  if (currentHostname && priorHostname && currentHostname !== priorHostname) return true
  if (currentIp && priorHostname && !priorIp) return true
  if (currentIp && priorIp && currentIp !== priorIp) return true
  if (currentHostname && priorTopic === 'zabbix' && !isFollowUpPhrasing(q) && !isZabbixQuestion(q)) return true
  return false
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

  const subjectChanged = userMessages.length > 1
    && detectSubjectChange(currentQuestion, priorUser, priorAssistant, priorTopic)

  const inheritsThread = userMessages.length > 1 && !subjectChanged

  const sameSubject = sameSubjectAsPrior(currentQuestion, priorUser, priorAssistant)

  const storeConnCtxEarly = { isFollowUp: true, priorTopic, priorAssistant, priorUser, chatMode }
  const storeConnContinuation = userMessages.length > 1
    && isStoreMonitorConnectivityQuery(currentQuestion, storeConnCtxEarly)

  const isFollowUp = inheritsThread && (
    isFollowUpPhrasing(currentQuestion)
    || storeConnContinuation
    || (priorTopic === 'zabbix' && isZabbixResourceFollowUp(currentQuestion, priorTopic))
    || (
      priorTopic
      && sameSubject
      && /\b(it|this|that|same|those|above|more|also|why|how|utilization|utilisation|disk|bandwidth|memory|cpu|problems|ping|interface|tunnel|vpn|explain|resource)\b/i.test(currentQuestion)
      && currentQuestion.split(/\s+/).length <= 32
    )
  )
  const followUpKind = detectFollowUpKind(currentQuestion)

  const xdrIntent = isXdrIntent(currentQuestion)

  const zabbixMetricContinuation = priorTopic === 'zabbix'
    && isZabbixResourceFollowUp(currentQuestion, priorTopic)

  const ip = extractIpv4(currentQuestion)
    || (!xdrIntent && isFollowUp ? extractIpv4FromThread(threadText) : null)
    || (!xdrIntent && zabbixMetricContinuation ? extractIpv4FromThread(threadText) : null)
    || (!xdrIntent && isFollowUp ? extractIpv4FromThread(priorAssistant) : null)
    || (!xdrIntent && zabbixMetricContinuation ? extractIpv4FromThread(priorAssistant) : null)

  const zabbixHost = !xdrIntent
    ? (
      extractZabbixHostFromThread(currentQuestion)
      || (isFollowUp && priorTopic === 'zabbix'
        ? extractZabbixHostFromThread(priorAssistant) || extractZabbixHostFromThread(threadText)
        : null)
    )
    : null

  const infraHost = !xdrIntent
    ? (
      extractInfraHostName(currentQuestion)
      || (isFollowUp ? extractInfraHostFromThread(priorUser) : null)
      || (isFollowUp ? extractInfraHostFromThread(threadText) : null)
      || (isFollowUp && priorTopic === 'zabbix' ? extractInfraHostFromThread(priorAssistant) : null)
    )
    : null

  const ctxLite = { isFollowUp, subjectChanged, priorTopic, threadText, priorAssistant, priorUser, ip, zabbixHost, infraHost, hostname: extractStoreHostname(currentQuestion) }
  const hostGroup = extractHostGroupFilter(currentQuestion, ctxLite)
    || (isFollowUp && priorTopic === 'zabbix' ? extractHostGroupFromThread(threadText) : null)

  const hostname = !xdrIntent
    ? (
      extractStoreHostname(currentQuestion)
      || (!isZabbixQuestion(currentQuestion) && !isNetworkInfraQuery(currentQuestion) && isFollowUp && priorTopic === 'hostname'
        ? extractStoreHostname(priorAssistant)
        : null)
      || (!isZabbixQuestion(currentQuestion) && !isNetworkInfraQuery(currentQuestion) && isFollowUp && priorTopic === 'hostname'
        ? extractStoreHostname(threadText)
        : null)
    )
    : null

  const appNameFromCurrent = extractAppName(currentQuestion)
  const appName = appNameFromCurrent
    || (hasExplicitCrashSubject(currentQuestion) ? null : extractAppNameFromUserHistory(userMessages.slice(0, -1)))
    || (appNameFromCurrent ? null : extractAppNameFromAssistant(priorAssistant))

  const storeConnCtx = { isFollowUp, priorTopic, priorAssistant, priorUser, chatMode }
  let topic = detectTopicFromQuestion(currentQuestion, appName, { chatMode, isFollowUp, priorTopic })
  if (isStoreMonitorIssuesQuery(currentQuestion)) topic = 'store'
  if (isStoreDowntimeQuery(currentQuestion, storeConnCtx)) topic = 'store'
  if (isStoreMonitorConnectivityQuery(currentQuestion, storeConnCtx)
    || isStoreConnectivityFollowUp(currentQuestion, storeConnCtx)) {
    topic = 'store'
  }
  if (!topic && zabbixMetricContinuation && ip) topic = 'zabbix'
  if (!topic && xdrIntent) topic = 'xdr'
  if (!topic && chatMode === 'rca' && !isStoreMonitorIssuesQuery(currentQuestion)) topic = 'rca'
  if (!topic && chatMode === 'details' && hostname) topic = 'hostname'
  if (!topic && hostname && isHostnameDataRequest(currentQuestion)) topic = 'hostname'
  if (!topic && isStoreHostnamePortalQuery(currentQuestion)) topic = 'hostname'
  if (!topic && hostname && subjectChanged) topic = 'hostname'
  if (!topic && isFollowUp && priorTopic && !subjectChanged) topic = priorTopic
  if (!topic && isFollowUp && (ip || zabbixHost) && priorTopic === 'zabbix' && !subjectChanged) topic = 'zabbix'
  if (!topic && appName && (APP_ONLY.test(currentQuestion) || priorTopic === 'crash')) {
    topic = 'crash'
  }

  const absWindow = parseAbsoluteTimeWindow(currentQuestion)
    || (isFollowUp ? parseAbsoluteTimeWindow(priorUser) : null)

  let range = parseQuestionTimeRange(currentQuestion)
  if (isFollowUp && !hasExplicitTimeRange(currentQuestion)) {
    range = parseQuestionTimeRange(priorUser)
      || extractRangeFromAssistant(priorAssistant)
      || range
  }
  if (isStoreConnectivityFollowUp(currentQuestion, storeConnCtx) && range === '-1h') {
    range = parseQuestionTimeRange(priorUser) || '-24h'
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
    priorAssistant,
    priorUser,
    isFollowUp,
    subjectChanged,
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
    fromTs: absWindow?.fromTs ?? null,
    toTs: absWindow?.toTs ?? null,
    absoluteRangeLabel: absWindow?.label ?? null,
    isFollowUp,
    subjectChanged,
    followUpKind,
    wantsStoreList,
    wantsCrashEventList,
    directHandler,
    threadText,
    chatMode,
    priorStoreZabbix: /Store Zabbix/i.test(priorAssistant),
  }
}

/** @returns {QueryTopic|null} */
function inferTopicFromAssistant(text) {
  const t = String(text || '')
  if (/Disk usage report|Zabbix network|Infra Zabbix|Store Zabbix|Host group:|Host filter:|device analysis|── AI Analysis ──|(?:Memory|CPU)\s+utilization\s*—|CPU \/ memory utilization\s*—/i.test(t)) return 'zabbix'
  if (/Store hostname report|Hostname report|Metrics chart/i.test(t)) return 'hostname'
  if (/App Crashes|Influx crash|crash events/i.test(t)) return 'crash'
  if (/SentinelOne XDR|PowerQuery used/i.test(t)) return 'xdr'
  if (/Store Monitor.*\(LIVE|Store Monitor —/i.test(t)) return 'store'
  if (/Root Cause Analysis|Ranked hypotheses/i.test(t)) return 'rca'
  if (/Disconnection logs|USB disconnections|Cisco interface disconnections/i.test(t)) return 'noc'
  if (/FortiGate \/ SOC|SOC \/ firewall|complete report/i.test(t)) return 'soc'
  return null
}

function detectTopicFromQuestion(q, appName, ctx = {}) {
  const text = String(q || '')
  if (isStoreMonitorIssuesQuery(text)) return 'store'
  if (isStoreDowntimeQuery(text, ctx)) return 'store'
  if (isStoreMonitorConnectivityQuery(text, ctx)) return 'store'
  if (isStoreConnectivityFollowUp(text, ctx)) return 'store'
  if (isRcaQuery(text, ctx)) return 'rca'
  if (isXdrQuestion(text) || isGeoConnectionQuery(text)) return 'xdr'
  if (isSocReportQuery(text)) return 'soc'
  if (isZabbixQuestion(text, ctx)) return 'zabbix'
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
  if (/\b(crash|crashed|crashes)\b/i.test(text) && /\b(log|logs|event|events)\b/i.test(text)) return true
  if (/\bhow many\b/i.test(text) && /\b(crash|crashed|crashes)\b/i.test(text) && /\b(log|logs)\b/i.test(text)) return true
  if (/\bcrash events?\b/i.test(text) && /\b(timestamp|hostname|time stamp|with time)\b/i.test(text)) return true
  if (/\b(timestamp|time stamp|timestamps|crash time|app crash time|crash event|each crash|event log|with hostname|hostname and time|when the app cras\w*|when did|what time)\b/i.test(text)) return true
  if (/\b(with|need|give|show)\b/i.test(text) && /\b(time|timestamp|hostname)\b/i.test(text) && /\b(crash|app)\b/i.test(text)) return true
  if (ctx?.followUpKind === 'crash_events') return true
  if (ctx?.isFollowUp && ctx?.priorTopic === 'crash' && /\b(time|timestamp|when|hostname|host name|event)\b/i.test(text)) return true
  return false
}

function pickDirectHandler({ currentQuestion, topic, priorTopic, priorAssistant, priorUser, isFollowUp, subjectChanged, followUpKind, appName, hostname, ip, zabbixHost, chatMode = 'monitor' }) {
  const q = String(currentQuestion || '')
  const ctxLite = { isFollowUp, subjectChanged, priorTopic, chatMode, hostname, ip, zabbixHost, directHandler: null }
  const storeMonitorIntent = /\b(offline|online|down|monitor status|store monitor|how many stores)\b/i.test(q)
  const chartRequest = /\b(graph|graphical|chart|visual|plot|timeline)\b/i.test(q)

  const storeConnCtx = { isFollowUp, priorTopic, priorAssistant, priorUser, chatMode }
  if (isStoreMonitorIssuesQuery(q) || isStoreMonitorConnectivityQuery(q, storeConnCtx) || isStoreConnectivityFollowUp(q, storeConnCtx)) {
    return 'store'
  }

  if ((isRcaQuery(q, ctxLite) || topic === 'rca') && chatMode !== 'details' && !isStoreMonitorIssuesQuery(q)) return 'rca'
  if (chatMode === 'details' && hostname && !isRcaQuery(q, ctxLite)) return 'hostname'

  if (isXdrQuestion(q) || isGeoConnectionQuery(q) || topic === 'xdr') return 'xdr'
  if (isSocReportQuery(q) || (isFirewallQuestion(q) && !isZabbixQuestion(q, ctxLite))) return 'soc'
  if (hostname && isStoreHostnamePortalQuery(q)) return 'hostname'
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

  if (isFollowUp && priorTopic === 'xdr' && !storeMonitorIntent) return 'xdr'
  if (isFollowUp && priorTopic === 'zabbix' && isZabbixResourceFollowUp(q, priorTopic) && ip) return 'zabbix'
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

const MONTH_INDEX = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

const ABS_DATE_RE = /(?:on\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?)\s*(?:,?\s*(\d{4}))?/i
const ABS_TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|until|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i

function parse12hClock(hourStr, minuteStr, ampm) {
  let hour = parseInt(hourStr, 10)
  const minute = parseInt(minuteStr || '0', 10)
  const mer = String(ampm || '').toLowerCase()
  if (mer === 'pm' && hour !== 12) hour += 12
  if (mer === 'am' && hour === 12) hour = 0
  return { hour, minute }
}

function istUnixSec(day, monthIndex, year, hour, minute) {
  const pad = (n) => String(n).padStart(2, '0')
  const iso = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+05:30`
  return Math.floor(new Date(iso).getTime() / 1000)
}

function formatIstWindowLabel(day, monthIndex, year, startHour, startMin, endHour, endMin) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const fmtClock = (h, m) => {
    const mer = h >= 12 ? 'PM' : 'AM'
    const hr12 = h % 12 || 12
    return m ? `${hr12}:${String(m).padStart(2, '0')} ${mer}` : `${hr12} ${mer}`
  }
  return `${day} ${months[monthIndex]} ${year}, ${fmtClock(startHour, startMin)} – ${fmtClock(endHour, endMin)} IST`
}

/**
 * Parse absolute calendar windows, e.g. "3rd June 11 am to 8 pm IST".
 * @param {string} q
 * @returns {{ fromTs: number, toTs: number, label: string }|null}
 */
export function parseAbsoluteTimeWindow(q) {
  const text = String(q || '').toLowerCase().replace(/\u2013|\u2014/g, '-')
  const dateM = text.match(ABS_DATE_RE)
  const timeM = text.match(ABS_TIME_RE)
  if (!dateM || !timeM) return null

  const day = parseInt(dateM[1] || dateM[4], 10)
  const monthToken = String(dateM[2] || dateM[3] || '').slice(0, 3)
  const monthIndex = MONTH_INDEX[monthToken]
  if (!Number.isFinite(day) || monthIndex == null) return null

  let year = dateM[5] ? parseInt(dateM[5], 10) : new Date().getFullYear()
  if (!dateM[5]) {
    const probe = istUnixSec(day, monthIndex, year, 0, 0)
    if (probe * 1000 > Date.now() + 86400000) year -= 1
  }

  const start = parse12hClock(timeM[1], timeM[2], timeM[3])
  const end = parse12hClock(timeM[4], timeM[5], timeM[6])
  const fromTs = istUnixSec(day, monthIndex, year, start.hour, start.minute)
  let toTs = istUnixSec(day, monthIndex, year, end.hour, end.minute)
  if (toTs <= fromTs) toTs += 86400

  return {
    fromTs,
    toTs,
    label: formatIstWindowLabel(day, monthIndex, year, start.hour, start.minute, end.hour, end.minute),
  }
}

function hasExplicitTimeRange(q) {
  return /\b(last|past)\s+\d+\s*(h|hr|hour|hours|m|min|d|day)/i.test(q)
    || /\b(1 hr|12h|12 hour|12 hours|24h|24 hour|24 hours|last hour|last day|last week)\b/i.test(q)
    || /\b(?:time range|range|window)?\s*(12|24)\s*hours?\b/i.test(q)
    || (ABS_DATE_RE.test(q) && ABS_TIME_RE.test(q))
}

export { hasExplicitTimeRange }

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

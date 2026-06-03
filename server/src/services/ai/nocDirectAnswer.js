import { getESClient } from '../../config/elasticsearch.js'
import { formatPortalTimestamp } from '../../utils/portalTimestamp.js'
import {
  getSentinelIndex,
  USB_PERIPHERAL_EVENT_BOOL,
  USB_PERIPHERAL_DISCONNECT_FILTER,
  AGENT_DISCONNECTED_BOOL,
} from '../../utils/sentinelQueries.js'

const DISCONNECT_MARKERS = /\b(disconnect\w*|disconn\w*|link down|interface down|went down|updown|flap|offline log|port down|tunnel down)\b/i
const USB_MARKERS = /\b(usb|use\s+disconn)\b/i
const STORE_HOSTNAME_RE = /^RP\d/i

function strVal(v) {
  if (v == null) return ''
  return String(v).trim()
}

function flatField(src, key) {
  if (!src || !key) return ''
  const nested = key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), src)
  if (nested != null && typeof nested !== 'object') return strVal(nested)
  return strVal(src[key])
}

function pickSentinelHost(src) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  const ad = src.agentDetectionInfo || src.agent_detection_info || {}
  const s1a = src.sentinel_one?.agent || src['sentinel_one.agent'] || {}
  return strVal(ar.agentComputerName)
    || strVal(ad.agentComputerName)
    || strVal(s1a.computer_name)
    || flatField(src, 'host.name')
    || strVal(src.host?.name)
    || strVal(src.host?.hostname)
    || flatField(src, 'data.computerName')
    || flatField(src, 'data.computer_name')
    || strVal(src.computer_name)
    || '—'
}

function pickUsbDevice(src) {
  const s1d = src.sentinel_one?.activity?.data || src['sentinel_one.activity.data'] || {}
  return flatField(src, 'device.name')
    || strVal(src.device?.name)
    || strVal(src.device?.product)
    || strVal(src.device_name)
    || flatField(src, 'data.deviceName')
    || flatField(src, 'data.device_name')
    || strVal(s1d.deviceName)
    || strVal(s1d.device_name)
    || flatField(src, 'data.productName')
    || flatField(src, 'data.externalDeviceType')
    || strVal(s1d.productName)
    || strVal(s1d.externalDeviceType)
    || ''
}

function pickUsbMessage(src) {
  const device = pickUsbDevice(src)
  const eventType = flatField(src, 'data.eventType')
  if (eventType && device) return `${device} ${eventType}`
  if (eventType) return eventType
  if (device) return `${device} disconnected`
  for (const v of [
    src.message,
    src.event?.action,
    flatField(src, 'data.ruleName'),
  ]) {
    const s = strVal(v)
    if (s) return s.slice(0, 120)
  }
  const raw = strVal(src.event?.original)
  if (raw && raw.length <= 120) return raw
  return 'USB disconnected'
}

function pickHostGroup(src) {
  const ar = src.agentRealtimeInfo || src.agent_realtime_info || {}
  for (const c of [
    flatField(src, 'data.scopeName'),
    flatField(src, 'data.siteName'),
    flatField(src, 'data.groupName'),
    src.data?.scopeName,
    src.data?.siteName,
    src.group?.name,
    src.site?.name,
    src.groupName,
    src.site_name,
    ar.groupName,
    ar.group_name,
  ]) {
    const s = strVal(c)
    if (s) return s
  }
  return ''
}

function inferStoreGroup(hostname) {
  const h = String(hostname || '').toUpperCase()
  if (h.startsWith('RP')) return 'RP Group'
  if (h.startsWith('LK')) return 'POS System Group'
  return ''
}

export function isDisconnectionLogQuery(question, ctx = null) {
  const q = String(question || '')
  if (DISCONNECT_MARKERS.test(q) || USB_MARKERS.test(q)) {
    if (/\b(store monitor|offline stores?|influx|how many stores)\b/i.test(q)) return false
    return true
  }
  if (ctx?.isFollowUp && ctx?.priorTopic === 'noc') {
    if (/\b(usb|hostname|rp group|rp stores?|timestamp|disconn|show|list|all|with|required|only)\b/i.test(q)) return true
  }
  return false
}

function wantsUsbDisconnect(question) {
  return USB_MARKERS.test(String(question || ''))
}

function wantsRpGroupFilter(question) {
  return /\b(rp group|rp stores?|required rp|only rp|retail point)\b/i.test(String(question || ''))
}

function shouldFilterRpGroup(question, ctx = null) {
  const q = String(question || '')
  if (/\b(all hosts?|corporate|lk group|pos group|no filter|include all|every host)\b/i.test(q)) return false
  if (wantsRpGroupFilter(q)) return true
  if (ctx?.isFollowUp && ctx?.priorTopic === 'noc' && /\b(rp group|only rp|required rp)\b/i.test(q)) return true
  return false
}

function parseRange(q) {
  const text = String(q || '').toLowerCase()
  let m = text.match(/last\s+(\d+)\s*(m|min|mins|minute|minutes)\b/)
  if (m) return `-${m[1]}m`
  m = text.match(/(?:within|in|for)\s+(\d+)\s*(m|min|mins|minute|minutes)\b/)
  if (m) return `-${m[1]}m`
  m = text.match(/last\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/)
  if (m) return `-${m[1]}h`
  m = text.match(/last\s+(\d+)\s*(d|day|days)\b/)
  if (m) return `-${m[1]}d`
  m = text.match(/\b(\d+)\s*(m|min|mins|minute|minutes)\b/)
  if (m) return `-${m[1]}m`
  if (/\b(last hour|1 hr|1hr|one hour)\b/.test(text)) return '-1h'
  if (/\b(last 24|24h|last day|today)\b/.test(text)) return '-24h'
  return '-5m'
}

function rangeGte(range) {
  const m = String(range || '-5m').match(/^-?(\d+)(h|d|m)$/)
  if (!m) return 'now-5m'
  return `now-${m[1]}${m[2]}`
}

function rangeLabel(range) {
  const m = String(range || '-5m').match(/^-?(\d+)(h|d|m)$/)
  if (!m) return 'last 5 minutes'
  const unit = { h: 'hour', d: 'day', m: 'minute' }[m[2]] || m[2]
  return `last ${m[1]} ${unit}${Number(m[1]) !== 1 ? 's' : ''}`
}

function fmtTs(v) {
  return formatPortalTimestamp(v)
}

function rpGroupMustClause() {
  return {
    bool: {
      should: [
        { prefix: { 'host.name.keyword': 'RP' } },
        { prefix: { 'host.hostname.keyword': 'RP' } },
        { prefix: { 'data.computerName.keyword': 'RP' } },
        { prefix: { 'data.computer_name.keyword': 'RP' } },
        { prefix: { 'agentRealtimeInfo.agentComputerName.keyword': 'RP' } },
        { prefix: { 'agent_realtime_info.agentComputerName.keyword': 'RP' } },
        { wildcard: { 'host.name.keyword': 'RP*' } },
        { wildcard: { 'agentRealtimeInfo.agentComputerName.keyword': 'RP*' } },
      ],
      minimum_should_match: 1,
    },
  }
}

async function withEsTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Elasticsearch timeout after ${ms}ms`)), ms)),
  ])
}

const USB_SOURCE_FIELDS = [
  '@timestamp', 'host', 'message', 'event', 'device', 'device_name', 'data',
  'agentRealtimeInfo', 'agent_realtime_info', 'agentDetectionInfo', 'agent_detection_info',
  'group', 'groupName', 'site_name', 'computer_name', 'sentinel_one',
]

function normalizeUsbEvent(src) {
  const host = pickSentinelHost(src)
  return {
    ts: src['@timestamp'],
    hostname: host,
    storeGroup: inferStoreGroup(host),
    hostGroup: pickHostGroup(src),
    device: pickUsbDevice(src),
    message: pickUsbMessage(src),
  }
}

async function fetchDisconnectionLogs(range, { usbOnly = false, rpGroupOnly = false } = {}) {
  const es = getESClient()
  const tr = { gte: rangeGte(range), lte: 'now' }
  const timeoutMs = Number.parseInt(process.env.ES_SOC_TIMEOUT_MS || '8000', 10)
  const usbSize = rpGroupOnly ? 100 : 50

  const usbMust = [
    { range: { '@timestamp': tr } },
    USB_PERIPHERAL_EVENT_BOOL,
    USB_PERIPHERAL_DISCONNECT_FILTER,
  ]
  if (rpGroupOnly) usbMust.push(rpGroupMustClause())

  const tasks = []

  if (!usbOnly) {
    tasks.push(
      withEsTimeout(es.search({
        index: 'cisco-*',
        body: {
          size: 30,
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: {
            bool: {
              must: [
                { range: { '@timestamp': tr } },
                { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } },
                { match: { cisco_message: 'changed state to down' } },
              ],
            },
          },
          _source: ['@timestamp', 'device_name', 'site_name', 'cisco_interface_full', 'cisco_message', 'cisco_mnemonic'],
        },
      }), timeoutMs).then(r => ({
        type: 'cisco',
        total: r.hits?.total?.value ?? r.hits?.hits?.length ?? 0,
        events: (r.hits?.hits || []).map(h => h._source || {}),
      })).catch(e => ({ type: 'cisco', error: e.message, events: [], total: 0 })),
    )
  }

  tasks.push(
    withEsTimeout(es.search({
      index: getSentinelIndex(),
      body: {
        size: usbSize,
        sort: [{ '@timestamp': { order: 'desc' } }],
        query: { bool: { must: usbMust } },
        _source: USB_SOURCE_FIELDS,
      },
    }), timeoutMs).then(r => ({
      type: 'usb',
      total: r.hits?.total?.value ?? r.hits?.hits?.length ?? 0,
      events: (r.hits?.hits || []).map(h => normalizeUsbEvent(h._source || {})),
    })).catch(e => ({ type: 'usb', error: e.message, events: [], total: 0 })),
  )

  if (!usbOnly) {
    tasks.push(
      withEsTimeout(es.search({
        index: getSentinelIndex(),
        body: {
          size: 20,
          sort: [{ '@timestamp': { order: 'desc' } }],
          query: {
            bool: {
              must: [{ range: { '@timestamp': tr } }, AGENT_DISCONNECTED_BOOL],
            },
          },
          _source: USB_SOURCE_FIELDS,
        },
      }), timeoutMs).then(r => ({
        type: 'agent',
        total: r.hits?.total?.value ?? r.hits?.hits?.length ?? 0,
        events: (r.hits?.hits || []).map(h => normalizeUsbEvent(h._source || {})),
      })).catch(e => ({ type: 'agent', error: e.message, events: [], total: 0 })),
    )
  }

  return Promise.all(tasks)
}

/**
 * Instant disconnection logs from NOC (Cisco) + Sentinel (USB/agent) — no LLM.
 */
export async function tryDirectNocAnswer(question, allowedPages, ctx = null) {
  if (!isDisconnectionLogQuery(question, ctx)) return null

  const fetchedAt = new Date().toISOString()
  const range = ctx?.range || parseRange(question)
  const window = rangeLabel(range)
  const usbOnly = wantsUsbDisconnect(question)
    || (ctx?.isFollowUp && ctx?.priorTopic === 'noc' && !/\b(cisco|interface|updown|agent disconnect)\b/i.test(question))
  const rpGroupOnly = shouldFilterRpGroup(question, ctx)
  const canNoc = allowedPages.includes('noc')
  const canSentinel = allowedPages.includes('sentinel')

  if (!canNoc && !canSentinel) {
    return {
      content: 'Disconnection logs require access to NOC or Sentinel pages in NetPulse.',
      contextMeta: [{ id: 'noc', label: 'NOC', freshness: 'live', fetchedAt, configured: false }],
      contextPreview: {},
      queryContext: { topic: 'noc', isFollowUp: ctx?.isFollowUp },
    }
  }

  if (!process.env.ES_HOST) {
    return {
      content: 'Elasticsearch is not configured — cannot fetch disconnection logs.',
      contextMeta: [{ id: 'noc', label: 'NOC', freshness: 'live', fetchedAt, configured: false }],
      contextPreview: {},
      queryContext: { topic: 'noc', isFollowUp: ctx?.isFollowUp },
    }
  }

  const results = await fetchDisconnectionLogs(range, { usbOnly, rpGroupOnly })
  const cisco = results.find(r => r.type === 'cisco')
  const usb = results.find(r => r.type === 'usb')
  const agent = results.find(r => r.type === 'agent')

  const lines = [
    `Disconnection logs (LIVE — fetched ${formatPortalTimestamp(fetchedAt)})`,
    `Window: ${window}${rpGroupOnly ? ' · filter: RP Group stores (hostname RP*)' : ''}`,
    '',
  ]

  if (canNoc && !usbOnly && cisco) {
    lines.push('── Cisco interface disconnections (NOC / cisco-*) ──')
    if (cisco.error) {
      lines.push(`  Error: ${cisco.error}`)
    } else if (!cisco.events.length) {
      lines.push(`  No interface down events in ${window}.`)
    } else {
      lines.push(`  Total down events: ${cisco.total}`)
      for (const e of cisco.events.slice(0, 20)) {
        const dev = e.device_name || e.site_name || '—'
        const iface = e.cisco_interface_full ? ` · ${e.cisco_interface_full}` : ''
        const msg = (e.cisco_message || '').slice(0, 80)
        lines.push(`    • ${fmtTs(e['@timestamp'])} · ${dev}${iface} · ${msg}`)
      }
      if (cisco.total > 20) lines.push(`    … ${cisco.total - 20} more (open NOC → Interface Events)`)
    }
    lines.push('')
  }

  if (canSentinel && usb) {
    lines.push('── USB disconnections (Sentinel / Elasticsearch) ──')
    if (usb.error) {
      lines.push(`  Error: ${usb.error}`)
    } else if (!usb.events.length) {
      lines.push(`  No USB disconnect events in ${window}${rpGroupOnly ? ' for RP Group stores' : ''}.`)
    } else {
      lines.push(`  Total USB disconnects: ${usb.total}${rpGroupOnly ? ' (RP Group only)' : ''}`)
      const showAll = usbOnly || usb.total <= 100
      const limit = showAll ? usb.events.length : 50
      for (const e of usb.events.slice(0, limit)) {
        const groupPart = e.storeGroup ? ` (${e.storeGroup})` : (e.hostGroup ? ` · ${e.hostGroup}` : '')
        const devicePart = e.device ? ` · device: ${e.device}` : ''
        lines.push(`    • ${fmtTs(e.ts)} · ${e.hostname}${groupPart}${devicePart} · ${e.message}`)
      }
      if (usb.total > limit) lines.push(`    … ${usb.total - limit} more (open Sentinel → USB)`)
    }
    lines.push('')
  }

  if (canSentinel && agent && !usbOnly) {
    lines.push('── Agent disconnections (Sentinel) ──')
    if (agent.error) {
      lines.push(`  Error: ${agent.error}`)
    } else if (!agent.events.length) {
      lines.push(`  No agent disconnect events in ${window}.`)
    } else {
      lines.push(`  Total agent disconnects: ${agent.total}`)
      for (const e of agent.events.slice(0, 10)) {
        lines.push(`    • ${fmtTs(e.ts)} · ${e.hostname} · ${e.message}`)
      }
    }
    lines.push('')
  }

  lines.push('(Direct answer from live Elasticsearch — no LLM wait.)')

  const hasData = [cisco, usb, agent].some(r => r?.events?.length)
  if (!hasData) {
    lines.push(`No disconnection events found in ${window}. Try a wider window, e.g. "last 1 hour USB disconnection log".`)
  }

  return {
    content: lines.join('\n'),
    contextMeta: [{
      id: 'noc',
      label: 'NOC / Disconnections',
      freshness: 'live',
      fetchedAt,
      configured: true,
      note: `${window}${rpGroupOnly ? ' · RP Group' : ''} · cisco ${cisco?.total ?? 0} · usb ${usb?.total ?? 0}`,
    }],
    contextPreview: {
      noc: {
        window,
        total: (cisco?.total ?? 0) + (usb?.total ?? 0),
        updown: cisco?.total ?? 0,
        usbDisconnect: usb?.total ?? 0,
        rpGroupOnly,
      },
    },
    queryContext: { topic: 'noc', isFollowUp: ctx?.isFollowUp },
  }
}

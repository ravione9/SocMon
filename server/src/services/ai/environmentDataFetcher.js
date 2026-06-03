import { getESClient } from '../../config/elasticsearch.js'
import {
  getSentinelIndex,
  USB_PERIPHERAL_EVENT_BOOL,
  USB_PERIPHERAL_DISCONNECT_FILTER,
  THREAT_DETECTED_BOOL,
  ACTIVE_THREAT_BOOL,
  AGENT_CONNECTED_BOOL,
  AGENT_DISCONNECTED_BOOL,
} from '../../utils/sentinelQueries.js'
import {
  isSentinelOneConfigured,
  fetchThreatsList,
} from '../../utils/sentinelOneApi.js'

function isEsConfigured() {
  return Boolean(process.env.ES_HOST && process.env.ES_USER)
}

/** @param {string} range e.g. "-6h" */
export function influxRangeToEsPreset(range) {
  const m = /^-(\d+)([smhd])$/i.exec(String(range || ''))
  if (!m) return '6h'
  return `${m[1]}${m[2].toLowerCase()}`
}

function esTimeRange(range) {
  return { gte: `now-${influxRangeToEsPreset(range)}` }
}

function endpointMustClause(hostname) {
  const fields = [
    'agentRealtimeInfo.agentComputerName.keyword',
    'host.name.keyword',
    'host.hostname.keyword',
    'computer_name.keyword',
  ]
  return {
    bool: {
      should: fields.map(f => ({ term: { [f]: hostname } })),
      minimum_should_match: 1,
    },
  }
}

function firewallHostMustClause(hostname) {
  const esc = String(hostname).replace(/[\\*?]/g, '')
  return {
    bool: {
      should: [
        { term: { 'fgt.devname.keyword': hostname } },
        { term: { 'host.hostname.keyword': hostname } },
        { term: { 'host.name.keyword': hostname } },
        { term: { 'hostname.keyword': hostname } },
        { term: { 'device.name.keyword': hostname } },
        { wildcard: { message: `*${esc}*` } },
      ],
      minimum_should_match: 1,
    },
  }
}

function ciscoHostMustClause(hostname) {
  const esc = String(hostname).replace(/[\\*?]/g, '')
  return {
    bool: {
      should: [
        { term: { 'device_name.keyword': hostname } },
        { wildcard: { 'device_name.keyword': `*${esc}*` } },
        { match_phrase: { cisco_message: hostname } },
      ],
      minimum_should_match: 1,
    },
  }
}

async function esCount(index, must) {
  if (!isEsConfigured()) return { count: 0, error: 'Elasticsearch not configured' }
  try {
    const r = await getESClient().count({
      index,
      query: { bool: { must } },
    })
    return { count: r.count ?? 0 }
  } catch (err) {
    return { count: 0, error: err.message || 'Elasticsearch count failed' }
  }
}

async function esSearch(index, must, size, source) {
  if (!isEsConfigured()) return []
  try {
    const r = await getESClient().search({
      index,
      size,
      sort: [{ '@timestamp': 'desc' }],
      query: { bool: { must } },
      _source: source,
    })
    return (r.hits?.hits || []).map(h => h._source || {})
  } catch {
    return []
  }
}

function pickMessage(src) {
  return src.message || src.event?.original || src['fgt.msg'] || src.cisco_message || src.event_message || '—'
}

function pickAction(src) {
  return src.event?.action || src['event.action'] || src['fgt.action'] || src.cisco_mnemonic || '—'
}

/**
 * Fetch Sentinel + SOC + NOC data scoped to a store hostname.
 * @param {string} hostname
 * @param {string} range Influx-style e.g. "-6h"
 * @param {string[]} allowedPages
 */
export async function fetchHostnameEnvironments(hostname, range, allowedPages = []) {
  const tr = esTimeRange(range)
  const rangePreset = influxRangeToEsPreset(range)
  const out = {}

  if (allowedPages.includes('sentinel')) {
    if (!isEsConfigured()) {
      out.sentinel = { configured: false, error: 'Elasticsearch not configured' }
    } else {
      const index = getSentinelIndex()
      const endpoint = endpointMustClause(hostname)
      const baseMust = [{ range: { '@timestamp': tr } }, endpoint]

      const usbBase = [...baseMust, USB_PERIPHERAL_EVENT_BOOL]
      const usbConnectedMust = [...usbBase, { bool: { must_not: [USB_PERIPHERAL_DISCONNECT_FILTER] } }]
      const usbDisconnectedMust = [...usbBase, USB_PERIPHERAL_DISCONNECT_FILTER]
      const threatMust = [...baseMust, THREAT_DETECTED_BOOL, { bool: { must_not: [USB_PERIPHERAL_EVENT_BOOL] } }]
      const activeThreatMust = [...baseMust, ACTIVE_THREAT_BOOL, { bool: { must_not: [USB_PERIPHERAL_EVENT_BOOL] } }]

      const [
        usbConnected,
        usbDisconnected,
        threatsDetected,
        activeThreats,
        agentDisconnected,
        agentConnected,
        usbSamples,
        threatSamples,
      ] = await Promise.all([
        esCount(index, usbConnectedMust),
        esCount(index, usbDisconnectedMust),
        esCount(index, threatMust),
        esCount(index, activeThreatMust),
        esCount(index, [...baseMust, AGENT_DISCONNECTED_BOOL]),
        esCount(index, [...baseMust, AGENT_CONNECTED_BOOL]),
        esSearch(index, usbBase, 6, ['@timestamp', 'message', 'event.action', 'device.name', 'sentinel_one.activity.data.deviceName']),
        esSearch(index, threatMust, 6, ['@timestamp', 'message', 'threatInfo.threatName', 'threatInfo.filePath', 'event.action']),
      ])

      let s1Threats = { configured: false }
      if (isSentinelOneConfigured()) {
        try {
          const list = await fetchThreatsList({
            range: rangePreset,
            q: hostname,
            limit: '8',
            mitigation: 'all',
            incidents: 'all',
          })
          s1Threats = {
            configured: true,
            threats: (list.threats || []).slice(0, 5).map(t => ({
              name: t.threatName || t.classification || '—',
              status: t.mitigationStatus || t.incidentStatus || '—',
              agent: t.agentComputerName || '—',
              createdAt: t.createdAt || null,
            })),
          }
        } catch (err) {
          s1Threats = { configured: true, error: err.message }
        }
      }

      out.sentinel = {
        configured: true,
        usbConnected: usbConnected.count,
        usbDisconnected: usbDisconnected.count,
        threatsDetected: threatsDetected.count,
        activeThreats: activeThreats.count,
        agentDisconnected: agentDisconnected.count,
        agentConnected: agentConnected.count,
        usbSamples: usbSamples.map(s => ({
          ts: s['@timestamp'],
          action: pickAction(s),
          message: pickMessage(s).slice(0, 140),
          device: s.device?.name || s['sentinel_one.activity.data.deviceName'] || '',
        })),
        threatSamples: threatSamples.map(s => ({
          ts: s['@timestamp'],
          name: s.threatInfo?.threatName || pickMessage(s).slice(0, 100),
          action: pickAction(s),
        })),
        s1Threats,
        errors: [usbConnected.error, threatsDetected.error].filter(Boolean),
      }
    }
  }

  if (allowedPages.includes('soc')) {
    if (!isEsConfigured()) {
      out.soc = { configured: false, error: 'Elasticsearch not configured' }
    } else {
      const hostFilter = firewallHostMustClause(hostname)
      const baseMust = [{ range: { '@timestamp': tr } }, hostFilter]
      const [total, denies, ips, utm, samples] = await Promise.all([
        esCount('firewall-*', baseMust),
        esCount('firewall-*', [...baseMust, { term: { 'fgt.action.keyword': 'deny' } }]),
        esCount('firewall-*', [...baseMust, { term: { 'fgt.subtype.keyword': 'ips' } }]),
        esCount('firewall-*', [...baseMust, { term: { 'fgt.type.keyword': 'utm' } }]),
        esSearch('firewall-*', baseMust, 6, ['@timestamp', 'fgt.action', 'fgt.srcip', 'fgt.dstip', 'fgt.msg', 'fgt.devname', 'fgt.subtype']),
      ])
      out.soc = {
        configured: true,
        total: total.count,
        denies: denies.count,
        ips: ips.count,
        utm: utm.count,
        samples: samples.map(s => ({
          ts: s['@timestamp'],
          action: s['fgt.action'] || '—',
          subtype: s['fgt.subtype'] || '',
          src: s['fgt.srcip'] || '—',
          dst: s['fgt.dstip'] || '—',
          msg: (s['fgt.msg'] || pickMessage(s)).slice(0, 120),
        })),
        error: total.error || denies.error,
      }
    }
  }

  if (allowedPages.includes('noc')) {
    if (!isEsConfigured()) {
      out.noc = { configured: false, error: 'Elasticsearch not configured' }
    } else {
      const hostFilter = ciscoHostMustClause(hostname)
      const baseMust = [{ range: { '@timestamp': tr } }, hostFilter]
      const [total, updown, macflap, vlanMismatch, samples] = await Promise.all([
        esCount('cisco-*', baseMust),
        esCount('cisco-*', [...baseMust, { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }]),
        esCount('cisco-*', [...baseMust, { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }]),
        esCount('cisco-*', [...baseMust, { term: { 'cisco_mnemonic.keyword': 'NATIVE_VLAN_MISMATCH' } }]),
        esSearch('cisco-*', baseMust, 6, ['@timestamp', 'device_name', 'cisco_mnemonic', 'cisco_message', 'cisco_interface_full']),
      ])
      out.noc = {
        configured: true,
        total: total.count,
        updown: updown.count,
        macflap: macflap.count,
        vlanMismatch: vlanMismatch.count,
        samples: samples.map(s => ({
          ts: s['@timestamp'],
          device: s.device_name || '—',
          mnemonic: s.cisco_mnemonic || '—',
          iface: s.cisco_interface_full || '',
          msg: (s.cisco_message || pickMessage(s)).slice(0, 120),
        })),
        error: total.error,
      }
    }
  }

  return out
}

export function formatEnvironmentSections(env, rangeLabel, formatTs) {
  const lines = []
  const fmt = formatTs || ((v) => String(v || '—'))

  if (env.sentinel) {
    lines.push('', '── Sentinel (LIVE — Elasticsearch) ──')
    const s = env.sentinel
    if (!s.configured) {
      lines.push(`  Not configured${s.error ? `: ${s.error}` : ''}`)
    } else {
      lines.push(`  USB connected: ${s.usbConnected} · disconnected: ${s.usbDisconnected}`)
      lines.push(`  Threats detected: ${s.threatsDetected} · active: ${s.activeThreats}`)
      lines.push(`  Agent connected events: ${s.agentConnected} · disconnected: ${s.agentDisconnected}`)
      if (s.usbSamples?.length) {
        lines.push('  Recent USB events:')
        for (const e of s.usbSamples.slice(0, 5)) {
          const dev = e.device ? ` · ${e.device}` : ''
          lines.push(`    • ${fmt(e.ts)} · ${e.action}${dev} · ${e.message}`)
        }
      }
      if (s.threatSamples?.length) {
        lines.push('  Recent threat events (ES):')
        for (const e of s.threatSamples.slice(0, 4)) {
          lines.push(`    • ${fmt(e.ts)} · ${e.name}`)
        }
      }
      if (s.s1Threats?.configured && s.s1Threats.threats?.length) {
        lines.push('  SentinelOne API threats:')
        for (const t of s.s1Threats.threats) {
          lines.push(`    • ${t.name} · ${t.status} · ${t.agent}`)
        }
      } else if (s.s1Threats?.error) {
        lines.push(`  SentinelOne API: ${s.s1Threats.error}`)
      }
    }
  }

  if (env.soc) {
    lines.push('', '── SOC / Firewall (LIVE — Elasticsearch) ──')
    const s = env.soc
    if (!s.configured) {
      lines.push(`  Not configured${s.error ? `: ${s.error}` : ''}`)
    } else {
      lines.push(`  Events (${rangeLabel}): ${s.total} · denies: ${s.denies} · IPS: ${s.ips} · UTM: ${s.utm}`)
      if (s.samples?.length) {
        lines.push('  Recent firewall events:')
        for (const e of s.samples.slice(0, 5)) {
          lines.push(`    • ${fmt(e.ts)} · ${e.action}/${e.subtype} · ${e.src} → ${e.dst} · ${e.msg}`)
        }
      } else {
        lines.push('  No firewall events matched this hostname in the window.')
      }
    }
  }

  if (env.noc) {
    lines.push('', '── NOC / Switch (LIVE — Elasticsearch) ──')
    const n = env.noc
    if (!n.configured) {
      lines.push(`  Not configured${n.error ? `: ${n.error}` : ''}`)
    } else {
      lines.push(`  Events (${rangeLabel}): ${n.total} · UPDOWN: ${n.updown} · MAC flaps: ${n.macflap} · VLAN mismatch: ${n.vlanMismatch}`)
      if (n.samples?.length) {
        lines.push('  Recent switch events:')
        for (const e of n.samples.slice(0, 5)) {
          const iface = e.iface ? ` · ${e.iface}` : ''
          lines.push(`    • ${fmt(e.ts)} · ${e.device} · ${e.mnemonic}${iface} · ${e.msg}`)
        }
      } else {
        lines.push('  No Cisco/switch events matched this hostname in the window.')
      }
    }
  }

  return lines
}

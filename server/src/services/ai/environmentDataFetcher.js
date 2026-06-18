import { getESClient } from '../../config/elasticsearch.js'
import {
  getSentinelIndex,
  USB_PERIPHERAL_EVENT_BOOL,
  USB_PERIPHERAL_DISCONNECT_FILTER,
  BLUETOOTH_DEVICE_EVENT_BOOL,
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

/** USB/threat search needs a wider window when the user asks for last 10m. */
export function sentinelLookbackPreset(range) {
  const m = /^-(\d+)([smhd])$/i.exec(String(range || ''))
  if (!m) return '24h'
  const n = Number.parseInt(m[1], 10)
  const u = m[2].toLowerCase()
  if (u === 's' || u === 'm') return '24h'
  if (u === 'h' && n <= 1) return '24h'
  return `${n}${u}`
}

function esTimeRange(preset) {
  return { gte: `now-${preset}`, lte: 'now' }
}

/** Build ES @timestamp filter — absolute session window or relative now-N preset. */
function buildEsTimestampRange({ fromSec, toSec, range, windowLabel } = {}) {
  if (fromSec != null && toSec != null && fromSec < toSec) {
    return {
      absolute: true,
      clause: {
        range: {
          '@timestamp': {
            gte: new Date(fromSec * 1000).toISOString(),
            lte: new Date(toSec * 1000).toISOString(),
          },
        },
      },
      label: windowLabel || `unix ${fromSec}–${toSec}`,
    }
  }
  const preset = influxRangeToEsPreset(range || '-24h')
  return {
    absolute: false,
    preset,
    clause: { range: { '@timestamp': esTimeRange(preset) } },
    label: windowLabel || `last ${preset}`,
  }
}

function peripheralTextBlob(sample) {
  return `${sample?.device || ''} ${sample?.message || ''} ${sample?.action || ''}`.toLowerCase()
}

function isPhoropterText(text) {
  return /phoropter|refractor|auto[\s-]?refractor|vision[\s-]?pro/i.test(text)
}

function isBluetoothText(text) {
  return /\bbluetooth\b|\bbt\b|bluetooth device|bluetooth radio/i.test(text)
}

function isMicText(text) {
  return /microphone|\bmic\b|headset|audio input|webcam/i.test(text)
}

function isSpeakerText(text) {
  return /speaker|\bspk\b|audio output|sound output/i.test(text)
}

/** Classify USB/BT samples for LKST dossier peripheral rows. */
export function categorizePeripheralEvents(usbSamples = [], btSamples = []) {
  const counts = {
    phoropterBluetooth: 0,
    phoropterCable: 0,
    usbMicrophone: 0,
    usbSpeaker: 0,
    otherUsb: 0,
    otherBluetooth: 0,
  }
  for (const s of btSamples || []) {
    const t = peripheralTextBlob(s)
    if (isPhoropterText(t) || isBluetoothText(t)) counts.phoropterBluetooth += 1
    else counts.otherBluetooth += 1
  }
  for (const s of usbSamples || []) {
    const t = peripheralTextBlob(s)
    if (isPhoropterText(t)) counts.phoropterCable += 1
    else if (isMicText(t)) counts.usbMicrophone += 1
    else if (isSpeakerText(t)) counts.usbSpeaker += 1
    else counts.otherUsb += 1
  }
  return counts
}

function endpointMustClause(hostname, storeTag = '', aliasHostnames = []) {
  const names = new Set()
  for (const n of [hostname, storeTag, ...(aliasHostnames || [])]) {
    if (n) names.add(String(n).trim())
  }
  const should = []

  for (const h of names) {
    const esc = h.replace(/[\\*?]/g, '')
    const exactFields = [
      'agentRealtimeInfo.agentComputerName.keyword',
      'agent_realtime_info.agentComputerName.keyword',
      'agentDetectionInfo.agentComputerName.keyword',
      'host.name.keyword',
      'host.hostname.keyword',
      'computer_name.keyword',
      'data.computerName.keyword',
      'data.computer_name.keyword',
    ]
    for (const f of exactFields) {
      should.push({ term: { [f]: h } })
    }
    if (esc) {
      for (const f of [
        'agentRealtimeInfo.agentComputerName.keyword',
        'agent_realtime_info.agentComputerName.keyword',
        'agentDetectionInfo.agentComputerName.keyword',
      ]) {
        should.push({ wildcard: { [f]: `${esc}*` } })
        should.push({ wildcard: { [f]: `*${esc}*` } })
      }
      should.push({ wildcard: { 'host.name.keyword': `*${esc}*` } })
      should.push({ wildcard: { 'computer_name.keyword': `*${esc}*` } })
    }
  }

  return { bool: { should, minimum_should_match: 1 } }
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

function pickUsbDevice(src) {
  const s1d = src['sentinel_one.activity.data'] || src.sentinel_one?.activity?.data || {}
  return src.device?.name
    || src['sentinel_one.activity.data.deviceName']
    || s1d.deviceName
    || src.data?.deviceName
    || src.data?.productName
    || s1d.productName
    || s1d.externalDeviceType
    || ''
}

function pickUsbMessage(src) {
  const device = pickUsbDevice(src)
  const eventType = src.data?.eventType || src['sentinel_one.activity.data']?.eventType
  if (eventType && device) return `${device} — ${eventType}`
  if (eventType) return String(eventType)
  for (const v of [src.message, src.event?.original, src.data?.ruleName, pickAction(src)]) {
    const s = String(v || '').trim()
    if (s && s !== '—') return s.slice(0, 140)
  }
  if (device) return device
  return 'USB peripheral event'
}

function mapUsbSample(s) {
  const action = pickAction(s)
  const actLow = String(action).toLowerCase()
  const isDisconnect = actLow.includes('disconnect') || actLow.includes('removed')
  return {
    ts: s['@timestamp'],
    action: isDisconnect ? 'disconnected' : (actLow.includes('connect') ? 'connected' : action),
    message: pickUsbMessage(s),
    device: pickUsbDevice(s),
  }
}

/**
 * Fetch Sentinel + SOC + NOC data scoped to a store hostname.
 * @param {string} hostname
 * @param {string} range Influx-style e.g. "-6h"
 * @param {string[]} allowedPages
 */
export async function fetchHostnameEnvironments(hostname, range, allowedPages = [], opts = {}) {
  const storeTag = String(opts.storeTag || '').trim()
  const aliasHostnames = Array.isArray(opts.aliasHostnames) ? opts.aliasHostnames : []
  const agentHost = String(opts.agentHostname || hostname || '').trim()
  const userWindow = buildEsTimestampRange({
    fromSec: opts.fromSec,
    toSec: opts.toSec,
    range,
    windowLabel: opts.windowLabel,
  })
  const extendSentinelWindow = opts.extendSentinelWindow !== false && !userWindow.absolute
  const sentinelPreset = extendSentinelWindow ? sentinelLookbackPreset(range) : influxRangeToEsPreset(range)
  const searchWindow = extendSentinelWindow
    ? buildEsTimestampRange({ range: `-${sentinelPreset}`, windowLabel: `last ${sentinelPreset}` })
    : userWindow
  const out = {}

  if (allowedPages.includes('sentinel')) {
    if (!isEsConfigured()) {
      out.sentinel = { configured: false, error: 'Elasticsearch not configured' }
    } else {
      const index = getSentinelIndex()
      const endpoint = endpointMustClause(agentHost, storeTag, aliasHostnames)
      const baseMust = [searchWindow.clause, endpoint]

      const usbBase = [...baseMust, USB_PERIPHERAL_EVENT_BOOL]
      const usbConnectedMust = [...usbBase, { bool: { must_not: [USB_PERIPHERAL_DISCONNECT_FILTER] } }]
      const usbDisconnectedMust = [...usbBase, USB_PERIPHERAL_DISCONNECT_FILTER]
      const threatMust = [...baseMust, THREAT_DETECTED_BOOL, { bool: { must_not: [USB_PERIPHERAL_EVENT_BOOL] } }]
      const activeThreatMust = [...baseMust, ACTIVE_THREAT_BOOL, { bool: { must_not: [USB_PERIPHERAL_EVENT_BOOL] } }]
      const usbSampleSize = opts.usbSampleSize || 20
      const btSampleSize = opts.btSampleSize || usbSampleSize

      const usbFields = [
        '@timestamp', 'message', 'event.action', 'event.original',
        'device.name', 'sentinel_one.activity.data.deviceName',
        'sentinel_one.activity.data', 'data.eventType', 'data.deviceName', 'data.productName', 'data.ruleName',
        'agentRealtimeInfo.agentComputerName',
      ]
      const btBase = [...baseMust, BLUETOOTH_DEVICE_EVENT_BOOL]

      const userWindowFetch = (extendSentinelWindow && searchWindow.preset !== influxRangeToEsPreset(range))
        ? (async () => {
          const userBase = [userWindow.clause, endpoint]
          const userUsbBase = [...userBase, USB_PERIPHERAL_EVENT_BOOL]
          const userBtBase = [...userBase, BLUETOOTH_DEVICE_EVENT_BOOL]
          const [uc, ud, us, bs] = await Promise.all([
            esCount(index, [...userUsbBase, { bool: { must_not: [USB_PERIPHERAL_DISCONNECT_FILTER] } }]),
            esCount(index, [...userUsbBase, USB_PERIPHERAL_DISCONNECT_FILTER]),
            esSearch(index, userUsbBase, usbSampleSize, usbFields),
            esSearch(index, userBtBase, btSampleSize, usbFields),
          ])
          const usbMapped = us.map(mapUsbSample)
          const btMapped = bs.map(mapUsbSample)
          return {
            window: userWindow.label,
            usbConnected: uc.count,
            usbDisconnected: ud.count,
            usbSamples: usbMapped,
            bluetoothSamples: btMapped,
            peripheralCounts: categorizePeripheralEvents(usbMapped, btMapped),
          }
        })()
        : Promise.resolve(null)

      const [
        usbConnected,
        usbDisconnected,
        threatsDetected,
        activeThreats,
        agentDisconnected,
        agentConnected,
        usbSamples,
        btSamples,
        threatSamples,
        usbInUserWindow,
      ] = await Promise.all([
        esCount(index, usbConnectedMust),
        esCount(index, usbDisconnectedMust),
        esCount(index, threatMust),
        esCount(index, activeThreatMust),
        esCount(index, [...baseMust, AGENT_DISCONNECTED_BOOL]),
        esCount(index, [...baseMust, AGENT_CONNECTED_BOOL]),
        esSearch(index, usbBase, usbSampleSize, usbFields),
        esSearch(index, btBase, btSampleSize, usbFields),
        esSearch(index, threatMust, 8, ['@timestamp', 'message', 'threatInfo.threatName', 'threatInfo.filePath', 'event.action']),
        userWindowFetch,
      ])

      let s1Threats = { configured: false }
      if (isSentinelOneConfigured()) {
        try {
          const list = await fetchThreatsList({
            range: sentinelPreset,
            q: storeTag || hostname,
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

      const usbMapped = usbSamples.map(mapUsbSample)
      const btMapped = btSamples.map(mapUsbSample)
      const categorized = usbInUserWindow?.peripheralCounts
        ? { ...usbInUserWindow.peripheralCounts }
        : categorizePeripheralEvents(usbMapped, btMapped)
      const peripheralCounts = {
        ...categorized,
        usbConnectedTotal: usbInUserWindow?.usbConnected ?? usbConnected.count,
        usbDisconnectedTotal: usbInUserWindow?.usbDisconnected ?? usbDisconnected.count,
      }

      out.sentinel = {
        configured: true,
        source: 'Elasticsearch sentinel-* (Device Control / peripheral logs)',
        agentHostnameUsed: agentHost,
        aliasHostnamesUsed: [...aliasHostnames],
        searchWindow: searchWindow.label,
        searchWindowAbsolute: searchWindow.absolute,
        searchFromSec: opts.fromSec ?? null,
        searchToSec: opts.toSec ?? null,
        userSearchWindow: userWindow.label,
        usbInUserWindow,
        usbConnected: usbConnected.count,
        usbDisconnected: usbDisconnected.count,
        bluetoothEventCount: btMapped.length,
        peripheralCounts,
        threatsDetected: threatsDetected.count,
        activeThreats: activeThreats.count,
        agentDisconnected: agentDisconnected.count,
        agentConnected: agentConnected.count,
        usbSamples: usbMapped,
        bluetoothSamples: btMapped,
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
      const baseMust = [userWindow.clause, hostFilter]
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
      const baseMust = [userWindow.clause, hostFilter]
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

export function formatEnvironmentSections(env, rangeLabel, formatTs, opts = {}) {
  const lines = []
  const fmt = formatTs || ((v) => String(v || '—'))
  const showEmpty = opts.showEmptyModules === true
  const maxUsbSamples = opts.maxUsbSamples || 5
  const pushHeader = (title) => {
    if (lines.length) lines.push('')
    lines.push(title)
  }

  if (env.sentinel) {
    const s = env.sentinel
    if (!s.configured) {
      pushHeader('── Sentinel (LIVE — Elasticsearch) ──')
      lines.push(`  Not configured${s.error ? `: ${s.error}` : ''}`)
    } else {
      const hasSentinelData =
        Number(s.usbConnected || 0) > 0
        || Number(s.usbDisconnected || 0) > 0
        || Number(s.threatsDetected || 0) > 0
        || Number(s.activeThreats || 0) > 0
        || Number(s.agentConnected || 0) > 0
        || Number(s.agentDisconnected || 0) > 0
        || (s.usbSamples?.length || 0) > 0
        || (s.threatSamples?.length || 0) > 0
        || (s.s1Threats?.threats?.length || 0) > 0
        || Boolean(s.s1Threats?.error)
        || (s.errors?.length || 0) > 0
      if (hasSentinelData || showEmpty) {
        const extendedWindow = s.searchWindow && s.searchWindow !== s.userSearchWindow
        pushHeader(`── Sentinel / USB (LIVE — Elasticsearch) ──`)
        if (s.searchWindowAbsolute) {
          lines.push(`  Search window: ${s.userSearchWindow || s.searchWindow} (absolute session bounds)`)
        } else if (extendedWindow && s.usbInUserWindow) {
          lines.push(`  USB in query window (${s.userSearchWindow || s.searchWindow}): connected ${s.usbInUserWindow.usbConnected} · disconnected ${s.usbInUserWindow.usbDisconnected}`)
          lines.push(`  USB in extended window (${s.searchWindow}): connected ${s.usbConnected} · disconnected ${s.usbDisconnected}`)
          if (s.usbInUserWindow.usbConnected === 0 && s.usbInUserWindow.usbDisconnected === 0 && (s.usbConnected > 0 || s.usbDisconnected > 0)) {
            lines.push('  Note: No USB activity in the query window — recent USB events below are from the extended search.')
          }
        } else if (!hasSentinelData) {
          lines.push(`  No USB, threat, or agent events matched this hostname in ${s.userSearchWindow || s.searchWindow || rangeLabel}.`)
          if (s.agentHostnameUsed) lines.push(`  Agent filter: ${s.agentHostnameUsed}`)
        } else {
          lines.push(`  USB connected: ${s.usbConnected} · disconnected: ${s.usbDisconnected}`)
        }
        if (s.peripheralCounts) {
          const p = s.peripheralCounts
          lines.push(`  Phoropter BT: ${p.phoropterBluetooth} · Phoropter cable/USB: ${p.phoropterCable} · Mic: ${p.usbMicrophone} · Speaker: ${p.usbSpeaker}`)
        }
        if (hasSentinelData) {
          lines.push(`  Threats detected: ${s.threatsDetected} · active: ${s.activeThreats}`)
          lines.push(`  Agent connected events: ${s.agentConnected} · disconnected: ${s.agentDisconnected}`)
          const usbList = (s.usbInUserWindow?.usbSamples?.length && s.usbInUserWindow.usbConnected + s.usbInUserWindow.usbDisconnected > 0)
            ? s.usbInUserWindow.usbSamples
            : s.usbSamples
          if (usbList?.length) {
            lines.push('  Recent USB events:')
            for (const e of usbList.slice(0, maxUsbSamples)) {
              const dev = e.device && !String(e.message).includes(e.device) ? ` · ${e.device}` : ''
              lines.push(`    • ${fmt(e.ts)} · ${e.action}${dev} · ${e.message}`)
            }
            if (usbList.length > maxUsbSamples) {
              lines.push(`    … and ${usbList.length - maxUsbSamples} more USB events`)
            }
          } else if (Number(s.usbConnected || 0) === 0 && Number(s.usbDisconnected || 0) === 0) {
            lines.push('  No USB peripheral events in search window.')
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
    }
  }

  if (env.soc) {
    const s = env.soc
    if (!s.configured) {
      pushHeader('── SOC / Firewall (LIVE — Elasticsearch) ──')
      lines.push(`  Not configured${s.error ? `: ${s.error}` : ''}`)
    } else {
      const hasSocData =
        Number(s.total || 0) > 0
        || Number(s.denies || 0) > 0
        || Number(s.ips || 0) > 0
        || Number(s.utm || 0) > 0
        || (s.samples?.length || 0) > 0
        || Boolean(s.error)
      if (hasSocData) {
        pushHeader('── SOC / Firewall (LIVE — Elasticsearch) ──')
        lines.push(`  Events (${rangeLabel}): ${s.total} · denies: ${s.denies} · IPS: ${s.ips} · UTM: ${s.utm}`)
        if (s.samples?.length) {
          lines.push('  Recent firewall events:')
          for (const e of s.samples.slice(0, 5)) {
            lines.push(`    • ${fmt(e.ts)} · ${e.action}/${e.subtype} · ${e.src} → ${e.dst} · ${e.msg}`)
          }
        }
      }
    }
  }

  if (env.noc) {
    const n = env.noc
    if (!n.configured) {
      pushHeader('── NOC / Switch (LIVE — Elasticsearch) ──')
      lines.push(`  Not configured${n.error ? `: ${n.error}` : ''}`)
    } else {
      const hasNocData =
        Number(n.total || 0) > 0
        || Number(n.updown || 0) > 0
        || Number(n.macflap || 0) > 0
        || Number(n.vlanMismatch || 0) > 0
        || (n.samples?.length || 0) > 0
        || Boolean(n.error)
      if (hasNocData) {
        pushHeader('── NOC / Switch (LIVE — Elasticsearch) ──')
        lines.push(`  Events (${rangeLabel}): ${n.total} · UPDOWN: ${n.updown} · MAC flaps: ${n.macflap} · VLAN mismatch: ${n.vlanMismatch}`)
        if (n.samples?.length) {
          lines.push('  Recent switch events:')
          for (const e of n.samples.slice(0, 5)) {
            const iface = e.iface ? ` · ${e.iface}` : ''
            lines.push(`    • ${fmt(e.ts)} · ${e.device} · ${e.mnemonic}${iface} · ${e.msg}`)
          }
        }
      }
    }
  }

  return lines
}

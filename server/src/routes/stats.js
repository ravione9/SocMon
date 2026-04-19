import { Router } from 'express'
import { getESClient } from '../config/elasticsearch.js'
import Ticket from '../models/Ticket.js'
import { fortigateVpnFilterBool } from '../utils/fortigateVpnQuery.js'
import { fortigateUserLoginFailedBool, ciscoUserLoginFailedBool } from '../utils/loginFailureQuery.js'
import { FIREWALL_DEVICE_LABEL_SCRIPT } from '../utils/firewallDeviceRuntimeScript.js'

const router = Router()

function getTimeRange(req) {
  const range = req.query.range || '12h'
  const dateFrom = req.query.from
  const dateTo = req.query.to
  return dateFrom && dateTo ? { gte: dateFrom, lte: dateTo } : { gte: 'now-' + range }
}

function utcStartOfDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function fmtUtcDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return iso
  }
}

/** Previous UTC calendar day (full day). */
function windowDaily(now = new Date()) {
  const todayStart = utcStartOfDay(now)
  const start = new Date(todayStart)
  start.setUTCDate(start.getUTCDate() - 1)
  const end = new Date(todayStart.getTime() - 1)
  return {
    gte: start.toISOString(),
    lte: end.toISOString(),
    preset: 'daily',
    periodLabel: `${fmtUtcDate(start.toISOString())} (UTC, full day)`,
  }
}

/** Seven UTC calendar days ending yesterday (aligned with daily reports). */
function windowWeekly(now = new Date()) {
  const todayStart = utcStartOfDay(now)
  const end = new Date(todayStart.getTime() - 1)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 6)
  start.setUTCHours(0, 0, 0, 0)
  return {
    gte: start.toISOString(),
    lte: end.toISOString(),
    preset: 'weekly',
    periodLabel: `${fmtUtcDate(start.toISOString())} – ${fmtUtcDate(end.toISOString())} (UTC, 7 days)`,
  }
}

const vpnBool = fortigateVpnFilterBool()

/** Match FortiGate device name / ECS device / Cisco hostname (exact keyword where available). */
function deviceClause(name) {
  const d = String(name || '').trim()
  if (!d) return null
  return {
    bool: {
      should: [
        { term: { 'fgt.devname.keyword': d } },
        { term: { 'device.name.keyword': d } },
        { term: { 'observer.name.keyword': d } },
        { term: { 'device_name.keyword': d } },
      ],
      minimum_should_match: 1,
    },
  }
}

const FW_EVENT_TYPES = new Set(['traffic', 'utm', 'ips', 'vpn', 'deny', 'allow', 'event'])
const CISCO_EVENT_TYPES = new Set(['updown', 'config', 'macflap', 'vlanmismatch', 'auth'])

function fortigateEventClause(eventType) {
  const et = String(eventType || 'all').toLowerCase()
  if (et === 'all' || !FW_EVENT_TYPES.has(et)) return null
  switch (et) {
    case 'traffic':
      return { term: { 'fgt.type.keyword': 'traffic' } }
    case 'utm':
      return { term: { 'fgt.type.keyword': 'utm' } }
    case 'ips':
      return { term: { 'fgt.subtype.keyword': 'ips' } }
    case 'vpn':
      return vpnBool
    case 'deny':
      return { term: { 'fgt.action.keyword': 'deny' } }
    case 'allow':
      return { term: { 'fgt.action.keyword': 'allow' } }
    case 'event':
      return { term: { 'fgt.type.keyword': 'event' } }
    default:
      return null
  }
}

function ciscoEventClause(eventType) {
  const et = String(eventType || 'all').toLowerCase()
  if (et === 'all' || !CISCO_EVENT_TYPES.has(et)) return null
  switch (et) {
    case 'updown':
      return { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }
    case 'config':
      return { term: { 'cisco_mnemonic.keyword': 'CONFIG_I' } }
    case 'macflap':
      return { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }
    case 'vlanmismatch':
      return { term: { 'cisco_mnemonic.keyword': 'NATIVE_VLAN_MISMATCH' } }
    case 'auth':
      return {
        terms: { 'cisco_mnemonic.keyword': ['LOGIN_SUCCESS', 'LOGOUT', 'SSH2_USERAUTH', 'SSH2_SESSION'] },
      }
    default:
      return null
  }
}

function buildHighlights(soc, noc, denied, threats, tickets, filterNote) {
  const lines = []
  if (filterNote) lines.push(filterNote)
  lines.push(`Firewall telemetry recorded ${soc.total.toLocaleString()} events in the selected period.`)
  if (soc.denied > 0) {
    lines.push(`${soc.denied.toLocaleString()} policy deny events; review top sources and threat signatures below.`)
  } else {
    lines.push('No firewall deny events in this period.')
  }
  if (soc.ips > 0) lines.push(`${soc.ips.toLocaleString()} IPS-related events logged.`)
  if (noc.total > 0) lines.push(`Network (Cisco) index: ${noc.total.toLocaleString()} events, including ${noc.updown} interface up/down messages.`)
  if (tickets.createdInPeriod > 0 || tickets.closedInPeriod > 0) {
    lines.push(`Tickets: ${tickets.createdInPeriod} opened and ${tickets.closedInPeriod} closed during the period (${tickets.openNow} currently open).`)
  }
  if (threats.length && threats[0].count) {
    const n = threats[0].name || '(unnamed)'
    lines.push(`Most frequent IPS signature: “${n}” (${threats[0].count.toLocaleString()} hits).`)
  }
  if (denied.by_src.length && denied.by_src[0].count) {
    const ip = denied.by_src[0].ip || '—'
    lines.push(`Top denied source IP: ${ip} (${denied.by_src[0].count.toLocaleString()} sessions).`)
  }
  return lines
}

router.get('/soc', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const [totalHits, deniedHits, ipsHits, authHits, utmHits, vpnHits, fwLoginFailedHits] = await Promise.all([
      es.count({ index: 'firewall-*', body: { query: { range: { '@timestamp': tr } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.action.keyword': 'deny' } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.subtype.keyword': 'ips' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { terms: { 'cisco_mnemonic.keyword': ['LOGIN_SUCCESS','LOGOUT','SSH2_USERAUTH','SSH2_SESSION'] } }] } } } }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'fgt.type.keyword': 'utm' } }] } } } }),
      es.count({
        index: 'firewall-*',
        body: {
          query: {
            bool: {
              must: [{ range: { '@timestamp': tr } }, fortigateVpnFilterBool()],
            },
          },
        },
      }),
      es.count({
        index: 'firewall-*',
        body: {
          query: {
            bool: {
              must: [{ range: { '@timestamp': tr } }, fortigateUserLoginFailedBool()],
            },
          },
        },
      }),
    ])
    res.json({
      total:  totalHits.count,
      denied: deniedHits.count,
      ips:    ipsHits.count,
      auth:   authHits.count,
      utm:    utmHits.count,
      vpn:    vpnHits.count,
      loginFailed: fwLoginFailedHits.count,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/noc', async (req, res) => {
  try {
    const es = getESClient()
    const tr = getTimeRange(req)
    const [total, updown, macflap, vlanmismatch, sites, loginFailedHits] = await Promise.all([
      es.count({ index: 'cisco-*', body: { query: { range: { '@timestamp': tr } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }] } } } }),
      es.count({ index: 'cisco-*', body: { query: { bool: { must: [{ range: { '@timestamp': tr } }, { term: { 'cisco_mnemonic.keyword': 'NATIVE_VLAN_MISMATCH' } }] } } } }),
      es.search({ index: 'cisco-*,firewall-*', body: { size: 0, query: { range: { '@timestamp': tr } }, aggs: { sites: { terms: { field: 'site_name.keyword', size: 10 } } } } }),
      es.count({
        index: 'cisco-*',
        body: {
          query: {
            bool: {
              must: [{ range: { '@timestamp': tr } }, ciscoUserLoginFailedBool()],
            },
          },
        },
      }),
    ])
    res.json({
      total:        total.count,
      updown:       updown.count,
      macflap:      macflap.count,
      vlanmismatch: vlanmismatch.count,
      sites:        sites.aggregations.sites.buckets,
      loginFailed:  loginFailedHits.count,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

function mapAggBuckets(buckets, keyName = 'key') {
  if (!Array.isArray(buckets)) return []
  return buckets.map(b => ({
    [keyName]: b.key === '__missing__' || b.key == null ? 'Unknown' : String(b.key),
    count: b.doc_count,
  }))
}

const FW_REPORT_BY_TYPE_AGG = { terms: { field: 'fgt.type.keyword', size: 14, missing: '__missing__' } }

async function fetchFirewallReportBreakdown(es, fwQ) {
  try {
    return await es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: fwQ,
        runtime_mappings: {
          report_fw_device: {
            type: 'keyword',
            script: { source: FIREWALL_DEVICE_LABEL_SCRIPT },
          },
        },
        aggs: {
          by_device: { terms: { field: 'report_fw_device', size: 25, missing: '__missing__' } },
          by_type: FW_REPORT_BY_TYPE_AGG,
        },
      },
    })
  } catch {
    return es.search({
      index: 'firewall-*',
      body: {
        size: 0,
        query: fwQ,
        aggs: {
          by_device: { terms: { field: 'fgt.devname.keyword', size: 25, missing: '__missing__' } },
          by_type: FW_REPORT_BY_TYPE_AGG,
        },
      },
    })
  }
}

/** Aggregated SOC/NOC/ticket summary for Reports UI (daily / weekly / custom ISO range). */
router.get('/report', async (req, res) => {
  try {
    const preset = String(req.query.preset || '').toLowerCase()
    let tr
    let meta
    if (preset === 'daily') {
      const w = windowDaily()
      tr = { gte: w.gte, lte: w.lte }
      meta = { preset: w.preset, periodLabel: w.periodLabel, from: w.gte, to: w.lte }
    } else if (preset === 'weekly') {
      const w = windowWeekly()
      tr = { gte: w.gte, lte: w.lte }
      meta = { preset: w.preset, periodLabel: w.periodLabel, from: w.gte, to: w.lte }
    } else if (req.query.from && req.query.to) {
      tr = { gte: req.query.from, lte: req.query.to }
      meta = {
        preset: 'custom',
        periodLabel: `${fmtUtcDate(req.query.from)} – ${fmtUtcDate(req.query.to)} (custom)`,
        from: req.query.from,
        to: req.query.to,
      }
    } else {
      return res.status(400).json({ error: 'Use preset=daily, preset=weekly, or both from= and to= (ISO-8601).' })
    }

    const fromD = new Date(meta.from)
    const toD = new Date(meta.to)
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD > toD) {
      return res.status(400).json({ error: 'Invalid from/to date range.' })
    }

    const deviceStr = String(req.query.device || '').trim()
    const eventType = String(req.query.eventType || 'all').toLowerCase()

    const rangeQ = { range: { '@timestamp': tr } }
    const fwMust = [rangeQ]
    const ciscoMust = [rangeQ]
    const dc = deviceClause(deviceStr)
    if (dc) {
      fwMust.push(dc)
      ciscoMust.push(dc)
    }
    const fwc = fortigateEventClause(eventType)
    if (fwc) fwMust.push(fwc)
    const cisc = ciscoEventClause(eventType)
    if (cisc) ciscoMust.push(cisc)

    const fwQ = { bool: { must: fwMust } }
    const ciscoQ = { bool: { must: ciscoMust } }

    const ticketRange = { $gte: fromD, $lte: toD }

    const es = getESClient()

    const [
      totalHits,
      deniedHits,
      ipsHits,
      authHits,
      utmHits,
      vpnHits,
      nocTotal,
      updown,
      macflap,
      vlanmismatch,
      configCisco,
      deniedAgg,
      threatsAgg,
      ticketCreated,
      ticketClosed,
      ticketOpen,
      fwBreakdown,
      ciscoBreakdown,
    ] = await Promise.all([
      es.count({ index: 'firewall-*', body: { query: fwQ } }),
      es.count({
        index: 'firewall-*',
        body: { query: { bool: { must: [...fwMust, { term: { 'fgt.action.keyword': 'deny' } }] } } },
      }),
      es.count({
        index: 'firewall-*',
        body: { query: { bool: { must: [...fwMust, { term: { 'fgt.subtype.keyword': 'ips' } }] } } },
      }),
      es.count({
        index: 'cisco-*',
        body: {
          query: {
            bool: {
              must: [
                ...ciscoMust,
                { terms: { 'cisco_mnemonic.keyword': ['LOGIN_SUCCESS', 'LOGOUT', 'SSH2_USERAUTH', 'SSH2_SESSION'] } },
              ],
            },
          },
        },
      }),
      es.count({
        index: 'firewall-*',
        body: { query: { bool: { must: [...fwMust, { term: { 'fgt.type.keyword': 'utm' } }] } } },
      }),
      es.count({ index: 'firewall-*', body: { query: { bool: { must: [...fwMust, vpnBool] } } } }),
      es.count({ index: 'cisco-*', body: { query: ciscoQ } }),
      es.count({
        index: 'cisco-*',
        body: { query: { bool: { must: [...ciscoMust, { term: { 'cisco_mnemonic.keyword': 'UPDOWN' } }] } } },
      }),
      es.count({
        index: 'cisco-*',
        body: { query: { bool: { must: [...ciscoMust, { term: { 'cisco_mnemonic.keyword': 'MACFLAP_NOTIF' } }] } } },
      }),
      es.count({
        index: 'cisco-*',
        body: { query: { bool: { must: [...ciscoMust, { term: { 'cisco_mnemonic.keyword': 'NATIVE_VLAN_MISMATCH' } }] } } },
      }),
      es.count({
        index: 'cisco-*',
        body: { query: { bool: { must: [...ciscoMust, { term: { 'cisco_mnemonic.keyword': 'CONFIG_I' } }] } } },
      }),
      es.search({
        index: 'firewall-*',
        body: {
          size: 0,
          query: { bool: { must: [...fwMust, { term: { 'fgt.action.keyword': 'deny' } }] } },
          aggs: {
            by_src: { terms: { field: 'fgt.srcip.keyword', size: 10 } },
            by_country: { terms: { field: 'fgt.srccountry.keyword', size: 8 } },
          },
        },
      }),
      es.search({
        index: 'firewall-*',
        body: {
          size: 0,
          query: { bool: { must: [...fwMust, { term: { 'fgt.subtype.keyword': 'ips' } }] } },
          aggs: { attacks: { terms: { field: 'fgt.attack.keyword', size: 10 } } },
        },
      }),
      Ticket.countDocuments({ createdAt: ticketRange }),
      Ticket.countDocuments({ status: 'closed', resolvedAt: ticketRange }),
      Ticket.countDocuments({ status: { $in: ['open', 'in-progress'] } }),
      fetchFirewallReportBreakdown(es, fwQ),
      es.search({
        index: 'cisco-*',
        body: {
          size: 0,
          query: ciscoQ,
          aggs: {
            by_device: { terms: { field: 'device_name.keyword', size: 20, missing: '__missing__' } },
            by_mnemonic: { terms: { field: 'cisco_mnemonic.keyword', size: 20, missing: '__missing__' } },
          },
        },
      }),
    ])

    const soc = {
      total: totalHits.count,
      denied: deniedHits.count,
      ips: ipsHits.count,
      utm: utmHits.count,
      vpn: vpnHits.count,
      allowedEstimate: Math.max(0, totalHits.count - deniedHits.count),
      switchAuthEvents: authHits.count,
    }

    const noc = {
      total: nocTotal.count,
      updown: updown.count,
      macflap: macflap.count,
      vlanmismatch: vlanmismatch.count,
      configChanges: configCisco.count,
    }

    const denied = {
      by_src: deniedAgg.aggregations?.by_src?.buckets?.map(b => ({ ip: b.key, count: b.doc_count })) ?? [],
      by_country: deniedAgg.aggregations?.by_country?.buckets?.map(b => ({ country: b.key, count: b.doc_count })) ?? [],
    }

    const threats = threatsAgg.aggregations?.attacks?.buckets?.map(b => ({ name: b.key, count: b.doc_count })) ?? []

    const tickets = {
      createdInPeriod: ticketCreated,
      closedInPeriod: ticketClosed,
      openNow: ticketOpen,
    }

    const breakdown = {
      firewallByDevice: mapAggBuckets(fwBreakdown.aggregations?.by_device?.buckets, 'device'),
      firewallByType: mapAggBuckets(fwBreakdown.aggregations?.by_type?.buckets, 'type'),
      ciscoByDevice: mapAggBuckets(ciscoBreakdown.aggregations?.by_device?.buckets, 'device'),
      ciscoByMnemonic: mapAggBuckets(ciscoBreakdown.aggregations?.by_mnemonic?.buckets, 'mnemonic'),
    }

    const filterParts = []
    if (deviceStr) filterParts.push(`Device filter: “${deviceStr}” (Forti devname / ECS device.name / Cisco device_name).`)
    if (eventType !== 'all') filterParts.push(`Event-type filter: ${eventType}.`)
    const filterNote = filterParts.length ? filterParts.join(' ') : null

    const highlights = buildHighlights(soc, noc, denied, threats, tickets, filterNote)

    res.json({
      meta: {
        ...meta,
        generatedAt: new Date().toISOString(),
        title: 'Lenskart Security & Operations Report',
        timezoneNote:
          'Log timestamps follow your Elasticsearch @timestamp field. Preset daily/weekly windows use UTC calendar boundaries.',
        filters: {
          device: deviceStr || null,
          eventType: eventType === 'all' ? null : eventType,
        },
      },
      highlights,
      soc,
      noc,
      denied,
      threats,
      tickets,
      breakdown,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router

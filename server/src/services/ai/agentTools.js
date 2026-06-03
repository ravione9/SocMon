/**
 * SocMon AI Agent — tool definitions and executors.
 * Each tool wraps an existing direct-answer handler (live portal data).
 */
import { tryDirectZabbixAnswer } from './zabbixDirectAnswer.js'
import { tryDirectHostnameAnswer } from './hostnameDirectAnswer.js'
import { tryDirectXdrAnswer } from './xdrDirectAnswer.js'
import { tryDirectSOCAnswer } from './socDirectAnswer.js'
import { buildPortalContext, tryDirectStoreAnswer } from './portalContextBuilder.js'

/** @typedef {{ name: string, description: string, parameters: object }} AgentToolDef */

/** @type {AgentToolDef[]} */
export const AGENT_TOOLS = [
  {
    name: 'get_disk_report',
    description: 'Live disk/filesystem usage for all hosts in a Zabbix host group (e.g. lenskart-database). Returns per-host disk % and capacity.',
    parameters: {
      type: 'object',
      properties: {
        hostGroup: { type: 'string', description: 'Exact Zabbix host group name' },
      },
      required: ['hostGroup'],
    },
  },
  {
    name: 'get_switch_status',
    description: 'Live ping/availability status for network switches from Infra Zabbix.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_server_status',
    description: 'Live availability summary for servers, VMs, or databases in Infra Zabbix.',
    parameters: {
      type: 'object',
      properties: {
        deviceType: {
          type: 'string',
          enum: ['server', 'vm', 'database'],
          description: 'Filter by device category (default server)',
        },
      },
    },
  },
  {
    name: 'get_bandwidth',
    description: 'Live interface bandwidth/traffic for a host by IP address from Zabbix.',
    parameters: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: 'IPv4 address of the monitored host' },
      },
      required: ['ip'],
    },
  },
  {
    name: 'check_host_in_group',
    description: 'Check whether a host IP belongs to a Zabbix host group and show its disk usage.',
    parameters: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: 'IPv4 address' },
        hostGroup: { type: 'string', description: 'Zabbix host group name' },
      },
      required: ['ip', 'hostGroup'],
    },
  },
  {
    name: 'get_hostname_report',
    description: 'Full environment report for a store agent hostname (Store Monitor, Sentinel, SOC, NOC).',
    parameters: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'Store agent hostname e.g. RP1537-E519BNZT' },
      },
      required: ['hostname'],
    },
  },
  {
    name: 'get_store_summary',
    description: 'Live store monitor summary — online/offline counts and optional offline hostname list.',
    parameters: {
      type: 'object',
      properties: {
        listOffline: { type: 'boolean', description: 'Include offline store hostnames' },
      },
    },
  },
  {
    name: 'get_xdr_threats',
    description: 'SentinelOne XDR threat inventory or recent threats.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time range e.g. -1h, -24h (default -24h)' },
        newOnly: { type: 'boolean', description: 'Only new/unresolved threats' },
      },
    },
  },
  {
    name: 'get_firewall_denies',
    description: 'SOC firewall deny/denied connection summary from live logs.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time range e.g. -1h, -24h' },
      },
    },
  },
  {
    name: 'get_xdr_investigation',
    description:
      'Run live SentinelOne XDR PowerQuery for failed login, DNS, IP Connect, process creation, geo connections, threats, etc. Pass the user question in natural language.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Full investigation question with time window' },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_geo_connections',
    description:
      'Count firewall / network sessions to or from a country (e.g. China, India) from live FortiGate logs and XDR where available.',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name e.g. China, India' },
        direction: { type: 'string', enum: ['to', 'from'], description: 'to = destination country, from = source country' },
        range: { type: 'string', description: 'Time range e.g. -12h, -24h' },
      },
      required: ['country'],
    },
  },
]

const TOOL_BY_NAME = Object.fromEntries(AGENT_TOOLS.map(t => [t.name, t]))

export function getAgentToolDefinitions() {
  return AGENT_TOOLS
}

/**
 * @param {string} name
 * @param {object} args
 * @param {import('../../models/User.js').default} user
 * @param {string[]} allowedPages
 * @param {object} ctx
 */
export async function executeAgentTool(name, args, user, allowedPages, ctx = null) {
  const tool = TOOL_BY_NAME[name]
  if (!tool) {
    return { ok: false, error: `Unknown tool: ${name}` }
  }

  const a = args && typeof args === 'object' ? args : {}
  const started = Date.now()

  try {
    let hit = null
    let modulesUsed = []

    switch (name) {
      case 'get_disk_report': {
        const hostGroup = String(a.hostGroup || '').trim()
        if (!hostGroup) return { ok: false, error: 'hostGroup is required' }
        hit = await tryDirectZabbixAnswer(
          `disk usage report for ${hostGroup} group`,
          allowedPages,
          ctx,
        )
        modulesUsed = ['zabbix']
        break
      }
      case 'get_switch_status':
        hit = await tryDirectZabbixAnswer('give me the switch status', allowedPages, ctx)
        modulesUsed = ['zabbix']
        break
      case 'get_server_status': {
        const dt = String(a.deviceType || 'server').trim()
        hit = await tryDirectZabbixAnswer(`need all ${dt} status`, allowedPages, ctx)
        modulesUsed = ['zabbix']
        break
      }
      case 'get_bandwidth': {
        const ip = String(a.ip || '').trim()
        if (!ip) return { ok: false, error: 'ip is required' }
        hit = await tryDirectZabbixAnswer(`bandwidth utilization on ${ip} of all port`, allowedPages, ctx)
        modulesUsed = ['zabbix']
        break
      }
      case 'check_host_in_group': {
        const ip = String(a.ip || '').trim()
        const hostGroup = String(a.hostGroup || '').trim()
        if (!ip || !hostGroup) return { ok: false, error: 'ip and hostGroup are required' }
        hit = await tryDirectZabbixAnswer(`check ${ip} belong to ${hostGroup}`, allowedPages, ctx)
        modulesUsed = ['zabbix']
        break
      }
      case 'get_hostname_report': {
        const hostname = String(a.hostname || '').trim()
        if (!hostname) return { ok: false, error: 'hostname is required' }
        hit = await tryDirectHostnameAnswer(`complete details of ${hostname}`, allowedPages, ctx)
        modulesUsed = ['storeMonitor', 'sentinelXdr', 'soc', 'noc']
        break
      }
      case 'get_store_summary': {
        const portalContext = await buildPortalContext(user, ['storeMonitor', 'storeProblems'], {})
        const q = a.listOffline
          ? 'how many stores offline list hostname'
          : 'store monitor summary how many stores offline online'
        const content = tryDirectStoreAnswer(q, portalContext, ctx)
        if (!content) return { ok: false, error: 'Store Monitor not configured or no data' }
        hit = { content, contextMeta: portalContext.meta, contextPreview: {} }
        modulesUsed = ['storeMonitor', 'storeProblems']
        break
      }
      case 'get_xdr_threats': {
        const range = a.range ? `last ${a.range.replace(/^-/, '')}` : 'last 24 hours'
        const q = a.newOnly ? `new threat in xdr ${range}` : `xdr threats ${range}`
        hit = await tryDirectXdrAnswer(q, allowedPages, ctx)
        modulesUsed = ['sentinelXdr']
        break
      }
      case 'get_firewall_denies': {
        const range = a.range ? `last ${a.range.replace(/^-/, '')}` : 'last 1 hour'
        hit = await tryDirectSOCAnswer(`firewall deny summary ${range}`, allowedPages, ctx)
        modulesUsed = ['soc']
        break
      }
      case 'get_xdr_investigation': {
        const question = String(a.question || '').trim()
        if (!question) return { ok: false, error: 'question is required' }
        hit = await tryDirectXdrAnswer(question, allowedPages, ctx)
        modulesUsed = ['sentinelXdr']
        break
      }
      case 'get_geo_connections': {
        const country = String(a.country || '').trim()
        if (!country) return { ok: false, error: 'country is required' }
        const dir = a.direction === 'from' ? 'from' : 'to'
        const range = a.range ? `last ${String(a.range).replace(/^-/, '')}` : 'last 12 hours'
        const q = `sentinel xdr how many connections ${dir} ${country} ${range}`
        hit = await tryDirectXdrAnswer(q, allowedPages, ctx)
        modulesUsed = ['sentinelXdr', 'soc']
        break
      }
      default:
        return { ok: false, error: `Tool not implemented: ${name}` }
    }

    if (!hit?.content) {
      return {
        ok: false,
        tool: name,
        error: 'No live data returned — check permissions, .env config, or query parameters.',
        durationMs: Date.now() - started,
      }
    }

    return {
      ok: true,
      tool: name,
      content: hit.content,
      contextMeta: hit.contextMeta || [],
      contextPreview: hit.contextPreview || {},
      chartSeries: hit.chartSeries,
      modulesUsed,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    return {
      ok: false,
      tool: name,
      error: err.message || String(err),
      durationMs: Date.now() - started,
    }
  }
}

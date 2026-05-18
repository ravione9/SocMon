/**
 * SentinelOne XDR PowerQuery field catalog and query-builder suggestions.
 * Single source of truth — consumed by /xdr/fields and /xdr/suggest.
 */
import { INSPECT_LOG_COLUMNS } from './xdrPowerQuery.js'

const FIELD_DESC = {
  'event.type': 'Event type (Process Creation, DNS Resolved, …)',
  'event.action': 'Specific event action',
  'event.category': 'process / network / file / registry / …',
  'event.id': 'Windows event id',
  'event.time': 'Event timestamp',
  'event.dataset': 'Source feed (ActivityFeed, …)',
  'dataSource.name': 'Source of the event',
  'dataSource.vendor': 'Vendor name',
  'dataSource.category': 'Data source category',
  'src.process.name': 'Source process name',
  'src.process.cmdline': 'Source process command line',
  'src.process.parent.name': 'Parent process name',
  'src.process.childProcCount': 'Child process count',
  'src.process.crossProcessCount': 'Cross-process operation count',
  'tgt.process.name': 'Target process name',
  'tgt.process.cmdline': 'Target process command line',
  'endpoint.name': 'Hostname / endpoint',
  'endpoint.os': 'Endpoint OS',
  'endpoint.type': 'Endpoint type',
  'agent.uuid': 'SentinelOne agent UUID',
  'account.name': 'Account name',
  'site.name': 'Site name',
  'site.id': 'Site id',
  'severity': 'Event severity (1–5)',
  'session': 'Session identifier',
  'group.id': 'Group id',
  'trace.id': 'Trace / storyline correlation id',
  timestamp: 'Event timestamp (epoch ns)',
  'src.ip': 'Source IP address',
  'src.ip.address': 'Source IP address',
  'src.port': 'Source port',
  'src.port.number': 'Source port number',
  'tgt.ip': 'Destination IP',
  'tgt.ip.address': 'Destination IP',
  'tgt.port': 'Destination port',
  'tgt.port.number': 'Destination port number',
  'dns.query': 'DNS query name',
  'registry.keyPath': 'Registry key path',
}

/** Extra names seen in Singularity Data Lake UI (merged with inspect columns). */
const EXTRA_FIELD_NAMES = [
  'session',
  'severity',
  'group.id',
  'dataSource.category',
  'endpoint.type',
  'src.ip.address',
  'src.port.number',
  'tgt.ip.address',
  'tgt.port.number',
  'host.name',
  'user.name',
  'message',
  'dataset',
  'os.name',
  'mgmt.url',
  'meta.event.name',
]

export const PQ_OPERATORS = ['=', '!=', 'contains', 'starts with', 'ends with', 'in', 'matches', 'is empty', 'is not empty']

export const PQ_TEMPLATES = [
  { label: 'Process Creation events', query: "event.type = 'Process Creation'" },
  { label: 'Process Modification events', query: "event.type = 'Process Modification'" },
  { label: 'Network Connection events', query: "event.type = 'IP Connect'" },
  { label: 'DNS query events', query: "event.type = 'DNS Resolved'" },
  { label: 'A specific process by name', query: "tgt.process.name = 'RemoteOptometry.exe'" },
  { label: 'Process spawned by a parent', query: "src.process.parent.name = 'explorer.exe' AND event.type = 'Process Creation'" },
  { label: 'Command line contains text', query: "tgt.process.cmdline contains '--type=gpu-process'" },
  { label: 'Windows event id', query: "event.id = '1002'" },
  { label: 'Endpoint hostname', query: "endpoint.name = 'RP1234-ABC567XY'" },
  { label: 'Activity feed for a process', query: "dataSource.name = 'ActivityFeed' AND tgt.process.name = 'RemoteOptometry.exe'" },
]

const VALUE_HINTS = {
  'event.type': [
    'Process Creation',
    'Process Modification',
    'Process Termination',
    'IP Connect',
    'IP Listen',
    'DNS Resolved',
    'File Creation',
    'File Modification',
    'File Deletion',
    'Registry Value Modified',
    'Registry Key Created',
    'Login',
    'Logout',
  ],
  'event.category': ['process', 'network', 'file', 'registry', 'indicators', 'login'],
  severity: ['1', '2', '3', '4', '5'],
  'endpoint.os': ['windows', 'linux', 'macos'],
  'tgt.process.signedStatus': ['signed', 'unsigned'],
  'src.process.signedStatus': ['signed', 'unsigned'],
  'src.process.integrityLevel': ['LOW', 'MEDIUM', 'HIGH', 'SYSTEM'],
  'tgt.process.integrityLevel': ['LOW', 'MEDIUM', 'HIGH', 'SYSTEM'],
  'dataSource.name': ['ActivityFeed', 'SentinelOne'],
  'dataSource.vendor': ['SentinelOne'],
}

function fieldDescription(name) {
  return FIELD_DESC[name] || name.replace(/\./g, ' · ')
}

function buildFieldCatalog(extraNames = []) {
  const names = [...new Set([...INSPECT_LOG_COLUMNS, ...EXTRA_FIELD_NAMES, ...extraNames])].sort((a, b) =>
    a.localeCompare(b),
  )
  return names.map(name => ({ name, desc: fieldDescription(name) }))
}

let cachedCatalog = null

export function getXdrFieldCatalog(extraNames = []) {
  if (!extraNames.length && cachedCatalog) return cachedCatalog
  const catalog = buildFieldCatalog(extraNames)
  if (!extraNames.length) cachedCatalog = catalog
  return catalog
}

function rankPrefix(name, prefix) {
  const n = name.toLowerCase()
  const p = prefix.toLowerCase()
  if (!p) return 0
  if (n === p) return 0
  if (n.startsWith(p)) return 1
  if (n.includes(p)) return 2
  return 99
}

/**
 * @param {{ prefix?: string, mode?: 'field'|'operator'|'value'|'template'|'auto', field?: string, limit?: number, extraFields?: string[] }} opts
 */
export function buildPowerQuerySuggestions(opts = {}) {
  const prefix = String(opts.prefix || '').trim()
  const prefixLower = prefix.toLowerCase()
  const mode = String(opts.mode || 'auto').toLowerCase()
  const field = String(opts.field || '').trim()
  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 80)
  const catalog = getXdrFieldCatalog(opts.extraFields || [])

  const strict = mode !== 'auto'
  const wantFields = mode === 'field' || (!strict && !field)
  const wantOperators = mode === 'operator'
  const wantValues = mode === 'value' && !!field
  const wantTemplates = mode === 'template' || (!strict && !prefix && !field)

  const out = []

  if (wantFields) {
    const fields = catalog
      .filter(f => !prefixLower || f.name.toLowerCase().includes(prefixLower))
      .sort((a, b) => rankPrefix(a.name, prefix) - rankPrefix(b.name, prefix) || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(f => ({
        kind: 'field',
        category: 'FIELDS',
        text: f.name,
        hint: f.desc,
      }))
    out.push(...fields)
  }

  if (wantOperators && (mode === 'operator' || prefix.length <= 12)) {
    const operators = PQ_OPERATORS.filter(op => !prefixLower || op.toLowerCase().includes(prefixLower))
      .map(op => ({ kind: 'operator', category: 'OPERATORS', text: op }))
    out.push(...operators)
  }

  if (wantValues && field) {
    const hints = VALUE_HINTS[field] || []
    const values = hints
      .filter(v => !prefixLower || v.toLowerCase().includes(prefixLower))
      .slice(0, limit)
      .map(v => ({
        kind: 'value',
        category: 'VALUES',
        text: v,
        hint: field,
      }))
    out.push(...values)
  }

  if (wantTemplates && !field) {
    const templates = PQ_TEMPLATES.filter(
      t =>
        !prefixLower ||
        t.query.toLowerCase().includes(prefixLower) ||
        t.label.toLowerCase().includes(prefixLower),
    )
      .slice(0, 12)
      .map(t => ({ kind: 'template', category: 'TEMPLATES', text: t.query, hint: t.label }))
    out.push(...templates)
  }

  return out
}

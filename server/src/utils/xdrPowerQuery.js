/**
 * Shared PowerQuery column projection and CSV formatting for SentinelOne XDR.
 */
import { formatTimestampIstForCsv } from './csvTimestampIst.js'

export const DEFAULT_TABLE_COLUMNS = [
  'timestamp',
  'event.type',
  'event.category',
  'endpoint.name',
  'user.name',
  'src.process.name',
  'src.process.parent.name',
  'tgt.process.name',
  'tgt.process.cmdline',
  'src.ip',
  'tgt.ip',
  'dns.query',
  'url.address',
  'registry.keyPath',
  'message',
]

export const DETAIL_COLUMNS = [
  'timestamp',
  'event.type',
  'event.action',
  'event.category',
  'event.id',
  'dataset',
  'endpoint.name',
  'agent.uuid',
  'account.name',
  'site.name',
  'user.name',
  'src.process.name',
  'src.process.parent.name',
  'src.process.cmdline',
  'src.process.user',
  'tgt.process.name',
  'tgt.process.cmdline',
  'tgt.process.user',
  'src.ip',
  'src.port',
  'tgt.ip',
  'tgt.port',
  'dns.query',
  'url.address',
  'registry.keyPath',
  'registry.valueName',
  'message',
]

/** All fields users can add to table/export (union, deduped). */
export const ALL_EXPORT_COLUMNS = [...new Set([...DEFAULT_TABLE_COLUMNS, ...DETAIL_COLUMNS])]

/** Wide projection for Inspect Log Line / event detail drawer (SentinelOne-style). */
export const INSPECT_LOG_COLUMNS = [
  ...new Set([
    ...DETAIL_COLUMNS,
    'account.id',
    'account.name',
    'agent.version',
    'dataSource.name',
    'dataSource.vendor',
    'dataset',
    'endpoint.os',
    'event.dataset',
    'event.time',
    'meta.event.name',
    'mgmt.id',
    'mgmt.osRevision',
    'mgmt.url',
    'os.name',
    'packet.id',
    'process.unique.key',
    'severity',
    'site.id',
    'trace.id',
    'tgt.process.displayName',
    'tgt.process.image.binaryIsExecutable',
    'tgt.process.image.description',
    'tgt.process.image.extension',
    'tgt.process.image.internalName',
    'tgt.process.image.md5',
    'tgt.process.image.path',
    'tgt.process.image.productName',
    'tgt.process.image.productVersion',
    'tgt.process.image.sha1',
    'tgt.process.image.sha256',
    'tgt.process.image.size',
    'tgt.process.image.type',
    'tgt.process.image.uid',
    'tgt.process.integrityLevel',
    'tgt.process.isNative64Bit',
    'tgt.process.isRedirectCmdProcessor',
    'tgt.process.isStorylineRoot',
    'tgt.process.parent.image.type',
    'tgt.process.pid',
    'tgt.process.sessionId',
    'tgt.process.signedStatus',
    'tgt.process.startTime',
    'tgt.process.storyline.id',
    'tgt.process.subsystem',
    'tgt.process.userSid',
    'src.process.childProcCount',
    'src.process.crossProcessCount',
    'src.process.displayName',
    'src.process.image.binaryIsExecutable',
    'src.process.image.description',
    'src.process.image.extension',
    'src.process.image.internalName',
    'src.process.image.md5',
    'src.process.image.path',
    'src.process.image.productName',
    'src.process.image.productVersion',
    'src.process.image.sha1',
    'src.process.image.sha256',
    'src.process.image.size',
    'src.process.image.type',
    'src.process.image.uid',
    'src.process.indicatorBootConfigurationUpdateCount',
    'src.process.indicatorEvasionCount',
    'src.process.indicatorExploitationCount',
    'src.process.indicatorGeneralCount',
    'src.process.indicatorInfostealerCount',
    'src.process.indicatorInjectionCount',
    'src.process.indicatorPersistenceCount',
    'src.process.indicatorPostExploitationCount',
    'src.process.indicatorRansomwareCount',
    'src.process.indicatorReconnaissanceCount',
    'src.process.integrityLevel',
    'src.process.isNative64Bit',
    'src.process.isRedirectCmdProcessor',
    'src.process.isStorylineRoot',
    'src.process.moduleCount',
    'src.process.netConnCount',
    'src.process.netConnInCount',
    'src.process.netConnOutCount',
    'src.process.parent.cmdline',
    'src.process.parent.displayName',
    'src.process.parent.image.extension',
    'src.process.parent.image.md5',
    'src.process.parent.image.path',
    'src.process.parent.image.sha1',
    'src.process.parent.image.sha256',
    'src.process.parent.image.signature.isValid',
    'src.process.parent.image.size',
    'src.process.parent.image.type',
    'src.process.parent.image.uid',
    'src.process.parent.integrityLevel',
    'src.process.parent.isNative64Bit',
    'src.process.parent.pid',
    'src.process.parent.publisher',
    'src.process.parent.user',
    'src.process.pid',
    'src.process.registryChangeCount',
    'src.process.signedStatus',
    'src.process.startTime',
    'src.process.tgtFileDeletionCount',
    'src.process.uid',
    'tgt.file.path',
    'tgt.file.sha256',
    'network.protocol',
  ]),
]

const TIMESTAMP_FIELDS = new Set(['timestamp', 'event.time', '@timestamp', 'time', 'ts'])

/**
 * Build PowerQuery with optional explicit column list; always adds limit.
 */
export function buildPowerQueryText(input, columns, fetchLimit) {
  let q = String(input || '').trim()
  if (!q) return q

  const cols = Array.isArray(columns) && columns.length
    ? columns.map(c => String(c).trim()).filter(Boolean)
    : DEFAULT_TABLE_COLUMNS

  if (/\|\s*columns\b/i.test(q)) {
    if (Array.isArray(columns) && columns.length) {
      q = q.replace(/\|\s*columns\s+[^|]+/i, `| columns ${cols.join(',')}`)
    }
  } else {
    q = `${q} | columns ${cols.join(',')}`
  }
  if (!/\|\s*limit\s+\d+/i.test(q)) {
    const lim = Math.max(1, Math.min(Number(fetchLimit) || 50000, 200000))
    q = `${q} | limit ${lim}`
  }
  return q
}

/** Format one cell for CSV (Excel-safe timestamps). */
export function formatPowerQueryCsvValue(column, value) {
  if (value == null || value === '') return ''

  const col = String(column || '')
  if (TIMESTAMP_FIELDS.has(col)) {
    const raw = value
    let n = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (Number.isFinite(n)) {
      let ms = n
      if (n > 1e15) ms = Math.floor(n / 1_000_000)
      else if (n > 1e12) ms = n
      const d = new Date(ms)
      if (!Number.isNaN(d.getTime())) {
        return formatTimestampIstForCsv(d.toISOString())
      }
      if (n > 1e15) return `="${String(Math.trunc(n))}"`
    }
    return String(raw)
  }

  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

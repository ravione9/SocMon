/** Map FortiGate syslog numeric level (0–7) → dashboard category */
function fortinetLevelToCategory(n) {
  if (!Number.isFinite(n)) return ''
  if (n <= 2) return 'critical'
  if (n === 3) return 'high'
  if (n === 4) return 'medium'
  if (n === 5) return 'low'
  return 'info'
}

/** Map ECS / string log levels (incl. FortiGate short forms: i, w, e, n — see Elastic FortiGate integration / log.level). */
function ecsLevelToCategory(s) {
  const x = String(s || '')
    .trim()
    .toLowerCase()
  if (!x) return ''
  if (x.length <= 2 && !/[\s_]/.test(x)) {
    if (['i', 'd'].includes(x)) return 'info'
    if (x === 'e') return 'high'
    if (['w'].includes(x)) return 'medium'
    if (['n'].includes(x)) return 'low'
    if (['a', 'c'].includes(x)) return 'critical'
  }
  if (['emergency', 'fatal', 'critical', 'alert'].some(k => x === k || x.includes(k))) return 'critical'
  if (x === 'error' || x.includes('error')) return 'high'
  if (x.includes('warn')) return 'medium'
  if (x.includes('notice')) return 'low'
  if (x.includes('info') || x.includes('debug')) return 'info'
  return ''
}

function readSyslogSeverityCode(e) {
  const v = e.log?.syslog?.severity?.code ?? e['log.syslog.severity.code']
  if (v == null || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 7 ? n : null
}

/**
 * Normalise FortiGate / Cisco / ECS severity → critical | high | medium | low | info
 * (Used for SOC filters, charts, and log table badges.)
 */
export function getSevCategory(e) {
  const raw = String(
    e.syslog_severity_label || e.cisco_severity_label || e['syslog_severity_label'] || e['cisco_severity_label'] || '',
  ).toLowerCase()
  if (raw) {
    if (['critical', 'emergency', 'alert'].some(x => raw.includes(x))) return 'critical'
    if (raw.includes('error')) return 'high'
    if (['warning', 'warn'].some(x => raw.includes(x))) return 'medium'
    if (['notice', 'notification'].some(x => raw.includes(x))) return 'low'
    if (raw.includes('information') || raw.includes('informational') || raw.includes('debug')) return 'info'
    return 'info'
  }

  const sysCode = readSyslogSeverityCode(e)
  if (sysCode != null) {
    const cat = fortinetLevelToCategory(sysCode)
    if (cat) return cat
  }

  const ffn = e['fortinet.firewall.severity'] || e.fortinet?.firewall?.severity
  if (ffn) {
    const cat = ecsLevelToCategory(ffn)
    if (cat) return cat
  }

  const fgtLevel = e.fgt?.level ?? e['fgt.level']
  if (fgtLevel != null && String(fgtLevel).trim() !== '') {
    const n = Number(fgtLevel)
    if (Number.isFinite(n)) {
      const cat = fortinetLevelToCategory(n)
      if (cat) return cat
    }
    const fromStr = ecsLevelToCategory(fgtLevel)
    if (fromStr) return fromStr
  }

  const logLvl = e.log?.level ?? e['log.level']
  if (logLvl) {
    const cat = ecsLevelToCategory(logLvl)
    if (cat) return cat
  }

  if (e.fgt?.subtype === 'ips' || e['fgt.subtype'] === 'ips') return 'high'
  return 'info'
}

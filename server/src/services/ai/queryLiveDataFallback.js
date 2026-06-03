/**
 * When Monitor mode has no matching direct handler, optionally fall back to Agent (LLM + live tools)
 * so users can phrase questions many ways without pre-built templates for each variant.
 */
import { isHostnameDataRequest, extractStoreHostname } from './queryContext.js'

const LIVE_DATA_MARKERS =
  /\b(sentinel|sentinal|xdr|sentinelone|zabbix|infra|disk|firewall|fortigate|deny|denies|offline|online|threat|malware|login|logon|connection|connect|china|india|bandwidth|switch|server|store|crash|usb|rca|powershell|dns|process|geo|country|session|vpn|ips|utm|noc|disconnection|speedtest|ping)\b/i

export function needsLiveAgentFallback(question, chatMode = 'monitor') {
  if (chatMode !== 'monitor') return false
  if (process.env.AI_MONITOR_AGENT_FALLBACK === '0') return false
  const q = String(question || '')
  if (isHostnameDataRequest(q) && extractStoreHostname(q)) return false
  return LIVE_DATA_MARKERS.test(q)
}

export function isAgentFallbackEnabled() {
  return process.env.AI_MONITOR_AGENT_FALLBACK !== '0'
}

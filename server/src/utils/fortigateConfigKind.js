/**
 * Classify FortiGate configuration-change docs for SOC (policy / VPN / system / noise).
 * @param {Record<string, unknown>} src Elasticsearch _source (expects fgt, message)
 * @returns {'policy'|'vpn'|'system'|'sla_auto'|'other'}
 */
export function fortigateConfigKind(src) {
  const f = src.fgt || {}
  const cfg = String(f.cfgpath || f.cfg_path || '').toLowerCase()
  const msg = String(f.msg || f.logdesc || src.message || '').toLowerCase()
  const hay = `${cfg} ${msg}`

  if (
    cfg.includes('virtual-wan-link') ||
    cfg.includes('system.sd-wan') ||
    /health-check|healthcheck|perf-monitor|link-monitor/.test(cfg) ||
    (/\bsla\b/.test(hay) &&
      (cfg.includes('wan') || cfg.includes('virtual') || cfg.includes('sd-wan') || /health|member|update/.test(msg)))
  ) {
    return 'sla_auto'
  }

  if (
    cfg.startsWith('vpn.') ||
    cfg.includes('ssl-vpn') ||
    cfg.includes('sslvpn') ||
    (cfg.includes('ipsec') && !cfg.startsWith('firewall.'))
  ) {
    return 'vpn'
  }

  if (
    cfg.includes('firewall.policy') ||
    cfg.includes('firewall policy') ||
    cfg.includes('firewall.policy6') ||
    (cfg.startsWith('firewall.') &&
      /policy|addrgrp|address|addr\.|service\.custom|service group|vip|ippool|multicast|shaper|profile-protocol|ldb-monitor/.test(
        cfg,
      )) ||
    /\bfirewall\s+policy\b/.test(msg) ||
    /\bcmd=[^,]*\b(policyid|policypackage)\b/i.test(msg) ||
    /\bpolicyid=/.test(msg) ||
    /\bpolicypackage\b/.test(msg) ||
    /\b(fromintf|tointf|srcintf|dstintf)=/.test(msg) ||
    (/\baddrgrp\b|\baddress\s+object\b|\bvirtual\s+ip\b|\bippool\b/.test(msg) && !/\bvpn\s+ssl\b/.test(msg))
  ) {
    return 'policy'
  }

  if (
    cfg.startsWith('system.') ||
    cfg.startsWith('log.') ||
    cfg.startsWith('router.') ||
    cfg.startsWith('switch-controller.') ||
    cfg.startsWith('wireless-controller.')
  ) {
    return 'system'
  }

  if (/ipsec|ssl.?vpn|vpn tunnel|dialup/.test(msg)) return 'vpn'
  if (/firewall|policy|addrgrp|address object|policyid|virtual ip/.test(msg)) return 'policy'
  if (/system\.|dns|ntp|admin|snmp|interface/.test(msg)) return 'system'
  return 'other'
}

/**
 * FortiGate VPN tunnels + SSL-VPN user auth in Elasticsearch.
 * Pipelines vary: some docs use fgt.* (syslog/KV), others fortinet.firewall.* (Elastic integration).
 * Subtype strings differ by FortiOS; we OR several shapes so SOC counts and log search stay aligned.
 */
export const FORTIGATE_VPN_SUBTYPES = [
  'ssl-login',
  'sslvpn-login',
  'vpn-login',
  'sslvpn',
  'ssl-connection',
  'ssl-web',
  'radius-auth',
  'sslvpn-auth',
  'ftgd-auth',
]

/** Bool fragment: use inside bool.filter or bool.must (not root query alone). */
export function fortigateVpnFilterBool() {
  const subs = FORTIGATE_VPN_SUBTYPES
  return {
    bool: {
      should: [
        { term: { 'fgt.type.keyword': 'vpn' } },
        { term: { 'fgt.type': 'vpn' } },
        { terms: { 'fgt.subtype.keyword': subs } },
        { terms: { 'fgt.subtype': subs } },
        { term: { 'fortinet.firewall.type.keyword': 'vpn' } },
        { term: { 'fortinet.firewall.type': 'vpn' } },
        { terms: { 'fortinet.firewall.subtype.keyword': subs } },
        { terms: { 'fortinet.firewall.subtype': subs } },
        { terms: { 'event.action.keyword': subs } },
        { terms: { 'event.action': subs } },
        // FortiOS often uses ssl-* / vpn-* subtypes; keyword prefix catches variants not in the list
        { prefix: { 'fgt.subtype.keyword': 'ssl-' } },
        { prefix: { 'fortinet.firewall.subtype.keyword': 'ssl-' } },
        { prefix: { 'fgt.subtype.keyword': 'vpn' } },
        { prefix: { 'fortinet.firewall.subtype.keyword': 'vpn' } },
        // Raw syslog / unparsed lines still carry type= / subtype=
        { match_phrase: { message: 'type=vpn' } },
        { match_phrase: { message: 'type="vpn"' } },
        { match_phrase: { message: 'subtype=ssl-login' } },
        { match_phrase: { message: 'subtype="ssl-login"' } },
        { match_phrase: { message: 'subtype=sslvpn' } },
        { match_phrase: { 'fgt.msg': 'SSL VPN' } },
        { match_phrase: { message: 'SSL-VPN' } },
      ],
      minimum_should_match: 1,
    },
  }
}

/**
 * User / admin login failure signals in Elasticsearch (FortiGate firewall-* and Cisco cisco-*).
 * Pipelines differ; we OR structured fields, mnemonics, and short message prefixes.
 *
 * We intentionally do NOT match fgt.status=failure or vague "failed" in logdesc — FortiGate uses
 * those for SSL inspection / WAD (e.g. "SSL decryption failure") which are not user logins.
 * DNS filter logs (e.g. "DNS lookup of … from client", type dns / subtype dns-query) are excluded.
 */

const FORTI_FAIL_SUBTYPES = [
  'ssl-login-fail',
  'sslvpn-login-fail',
  'auth-fail',
  'login-fail',
  'radius-auth-fail',
  'ftgd-auth-fail',
]

/** Traffic / UTM noise that is not authentication. */
const fortigateLoginFailureExclusions = {
  bool: {
    should: [
      { match_phrase: { message: 'SSL decryption' } },
      { match_phrase: { 'fgt.msg': 'SSL decryption' } },
      { match_phrase: { message: 'decryption failure' } },
      { match_phrase: { 'fgt.msg': 'decryption failure' } },
      { match_phrase: { message: 'SSL decryption failure' } },
      { match_phrase: { 'fgt.msg': 'SSL decryption failure' } },
      { match_phrase: { 'fortinet.firewall.msg': 'SSL decryption' } },
      { match_phrase: { 'fortinet.firewall.msg': 'decryption failure' } },
      { match_phrase: { message: 'Certificate verification failed' } },
      { match_phrase: { 'fgt.msg': 'Certificate verification failed' } },
      { match_phrase: { message: 'certificate verify failed' } },
      { match_phrase: { 'fgt.msg': 'certificate verify failed' } },
      // DNS filter / resolution logs — not user authentication (e.g. "DNS lookup of host.local from client")
      { match_phrase: { message: 'DNS lookup' } },
      { match_phrase: { 'fgt.msg': 'DNS lookup' } },
      { match_phrase: { 'fortinet.firewall.msg': 'DNS lookup' } },
      { match_phrase: { message: 'DNS query' } },
      { match_phrase: { 'fgt.msg': 'DNS query' } },
      { match_phrase: { 'fortinet.firewall.msg': 'DNS query' } },
      { match_phrase: { message: 'dns lookup' } },
      { match_phrase: { 'fgt.msg': 'dns lookup' } },
    ],
    minimum_should_match: 1,
  },
}

/** FortiGate DNS log type / subtype — exclude from login-failure bucket entirely. */
const fortigateDnsTypeExclusion = {
  bool: {
    should: [
      { term: { 'fgt.type.keyword': 'dns' } },
      { term: { 'fgt.type': 'dns' } },
      { term: { 'fortinet.firewall.type.keyword': 'dns' } },
      { term: { 'fortinet.firewall.type': 'dns' } },
      { terms: { 'fgt.subtype.keyword': ['dns-query'] } },
      { terms: { 'fgt.subtype': ['dns-query'] } },
      { terms: { 'fortinet.firewall.subtype.keyword': ['dns-query'] } },
      { terms: { 'fortinet.firewall.subtype': ['dns-query'] } },
    ],
    minimum_should_match: 1,
  },
}

/** Bool fragment for firewall-* (place inside bool.filter or bool.must). */
export function fortigateUserLoginFailedBool() {
  const subs = FORTI_FAIL_SUBTYPES
  return {
    bool: {
      must: [
        {
          bool: {
            should: [
              {
                bool: {
                  must: [
                    { term: { 'event.outcome.keyword': 'failure' } },
                    { terms: { 'event.category.keyword': ['authentication', 'iam'] } },
                  ],
                },
              },
              {
                bool: {
                  must: [
                    { term: { 'event.outcome': 'failure' } },
                    { terms: { 'event.category': ['authentication', 'iam'] } },
                  ],
                },
              },
              { terms: { 'fgt.subtype.keyword': subs } },
              { terms: { 'fgt.subtype': subs } },
              { terms: { 'fortinet.firewall.subtype.keyword': subs } },
              { terms: { 'fortinet.firewall.subtype': subs } },
              { term: { 'fgt.action.keyword': 'login-fail' } },
              { term: { 'fgt.action': 'login-fail' } },
              { match_bool_prefix: { 'fgt.msg': 'Login failed' } },
              { match_bool_prefix: { message: 'Login failed' } },
              { match_bool_prefix: { 'fgt.msg': 'login failed' } },
              { match_bool_prefix: { message: 'Authentication failure' } },
              { match_bool_prefix: { 'fgt.msg': 'Authentication failure' } },
              { match_bool_prefix: { message: 'User login failed' } },
              { match_bool_prefix: { 'fgt.msg': 'User login failed' } },
            ],
            minimum_should_match: 1,
          },
        },
      ],
      must_not: [fortigateLoginFailureExclusions, fortigateDnsTypeExclusion],
    },
  }
}

const CISCO_LOGIN_FAIL_MNEMONICS = [
  'LOGIN_FAILED',
  'AUTHENTICATION_FAILED',
  'DOT1X_AUTH_FAIL',
  'SSH2_AUTHFAIL',
  'USER_LOGIN_FAILURE',
  'AAA_LOGIN_FAILED',
  'LOGIN_AUTHENTICATION_FAILED',
]

/** Bool fragment for cisco-* */
export function ciscoUserLoginFailedBool() {
  const mns = CISCO_LOGIN_FAIL_MNEMONICS
  return {
    bool: {
      should: [
        { terms: { 'cisco_mnemonic.keyword': mns } },
        { terms: { 'cisco_mnemonic': mns } },
        { match_bool_prefix: { cisco_message: 'Login failed' } },
        { match_bool_prefix: { cisco_message: 'login failed' } },
        { match_bool_prefix: { cisco_message: '%LOGIN' } },
        { match_bool_prefix: { message: 'Authentication failed' } },
        { match_bool_prefix: { cisco_message: 'Authentication failure' } },
        { match_bool_prefix: { cisco_message: 'Bad secrets' } },
      ],
      minimum_should_match: 1,
      must_not: [
        { match_phrase: { message: 'DNS lookup' } },
        { match_phrase: { cisco_message: 'DNS lookup' } },
        { match_phrase: { message: 'DNS query' } },
        { match_phrase: { cisco_message: 'DNS query' } },
      ],
    },
  }
}

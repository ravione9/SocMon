import { fortigateConfigKind } from './fortigateConfigKind.js'

describe('fortigateConfigKind', () => {
  test('firewall.policy path → policy', () => {
    expect(fortigateConfigKind({ fgt: { cfgpath: 'firewall.policy', msg: 'Configuration changed' } })).toBe('policy')
  })

  test('firewall policy (space) path → policy', () => {
    expect(fortigateConfigKind({ fgt: { cfgpath: 'firewall policy', msg: 'Object configured' } })).toBe('policy')
  })

  test('policyid in cmd text → policy', () => {
    expect(
      fortigateConfigKind({
        fgt: { msg: 'Object configured (cmd=set policyid 3 ...)' },
      }),
    ).toBe('policy')
  })

  test('fromintf= in message → policy', () => {
    expect(
      fortigateConfigKind({
        fgt: { msg: 'Configuration changed: fromintf=port1 tointf=port2' },
      }),
    ).toBe('policy')
  })

  test('vpn.ipsec → vpn (before generic firewall)', () => {
    expect(fortigateConfigKind({ fgt: { cfgpath: 'vpn.ipsec.phase1-interface', msg: 'Configuration changed' } })).toBe(
      'vpn',
    )
  })

  test('virtual-wan-link → sla_auto', () => {
    expect(fortigateConfigKind({ fgt: { cfgpath: 'system.virtual-wan-link', msg: 'Configuration changed' } })).toBe(
      'sla_auto',
    )
  })

  test('system.dns → system', () => {
    expect(fortigateConfigKind({ fgt: { cfgpath: 'system.dns', msg: 'Attribute configured' } })).toBe('system')
  })

  test('falls back to message on root when fgt.msg empty', () => {
    expect(
      fortigateConfigKind({
        message: 'Object configured policyid=12',
        fgt: {},
      }),
    ).toBe('policy')
  })
})

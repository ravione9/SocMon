import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractNumericStoreCode,
  normalizeStoreCode,
  resolveStoreIdentity,
  hostMatchesStoreCode,
} from '../src/storeCodeAlias.js'
import { buildStoreHistoryQuestion } from '../src/goodMinutesCompliance.js'

describe('extractNumericStoreCode', () => {
  it('extracts from LKST, RP, LK, and plain digits', () => {
    assert.equal(extractNumericStoreCode('LKST336'), '336')
    assert.equal(extractNumericStoreCode('RP336'), '336')
    assert.equal(extractNumericStoreCode('RP0336-PG04'), '336')
    assert.equal(extractNumericStoreCode('336'), '336')
    assert.equal(extractNumericStoreCode('1514'), '1514')
  })
})

describe('resolveStoreIdentity', () => {
  it('maps LKST336 to RP336 Zabbix primary', () => {
    const id = resolveStoreIdentity('LKST336')
    assert.equal(id.displayCode, 'LKST336')
    assert.equal(id.numericCode, '336')
    assert.equal(id.zabbixPrimary, 'RP336')
    assert.ok(id.queryTerms.includes('RP336'))
  })

  it('maps LKST64 to RP64 and RP064 aliases', () => {
    const id = resolveStoreIdentity('LKST64')
    assert.equal(id.zabbixPrimary, 'RP64')
    assert.ok(id.queryTerms.includes('RP064'))
  })

  it('accepts RP336 input and still displays LKST336', () => {
    const id = resolveStoreIdentity('RP336')
    assert.equal(id.displayCode, 'LKST336')
    assert.equal(id.zabbixPrimary, 'RP336')
  })
})

describe('hostMatchesStoreCode', () => {
  it('matches RP336 hostname to code 336', () => {
    assert.equal(hostMatchesStoreCode('RP336-PG04NPFY', '336'), true)
    assert.equal(hostMatchesStoreCode('LKST3360-PG04', '336'), false)
  })
})

describe('buildStoreHistoryQuestion', () => {
  it('includes RP alias in netpulse_query question for LKST336', () => {
    const q = buildStoreHistoryQuestion('LKST336')
    assert.match(q, /LKST336/)
    assert.match(q, /RP336/)
  })
})

describe('normalizeStoreCode', () => {
  it('adds LKST prefix when missing', () => {
    assert.equal(normalizeStoreCode('336'), 'LKST336')
    assert.equal(normalizeStoreCode('1514'), 'LKST1514')
  })
})

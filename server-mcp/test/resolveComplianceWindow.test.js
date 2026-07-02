import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveComplianceWindow,
  parseDateOnlyString,
  parseMonthString,
  localMidnightUnix,
} from '../src/resolveComplianceWindow.js'

describe('parseDateOnlyString', () => {
  it('parses YYYY-MM-DD', () => {
    assert.deepEqual(parseDateOnlyString('2025-06-01'), { year: 2025, monthIndex: 5, day: 1 })
  })
})

describe('parseMonthString', () => {
  it('parses YYYY-MM', () => {
    assert.deepEqual(parseMonthString('2025-06'), { year: 2025, monthIndex: 5 })
  })
  it('parses June 2025', () => {
    assert.deepEqual(parseMonthString('June 2025'), { year: 2025, monthIndex: 5 })
  })
})

describe('resolveComplianceWindow', () => {
  it('accepts fromDate and toDate (general format)', () => {
    const w = resolveComplianceWindow({ fromDate: '2025-06-01', toDate: '2025-06-30' })
    assert.equal(w.fromDate, '2025-06-01')
    assert.equal(w.toDate, '2025-06-30')
    assert.equal(w.source, 'date')
    assert.ok(w.fromUnix < w.toUnix)
    assert.equal(w.periodLabel, 'this month')
  })

  it('accepts month shorthand', () => {
    const w = resolveComplianceWindow({ month: '2025-06' })
    assert.equal(w.fromDate, '2025-06-01')
    assert.equal(w.toDate, '2025-06-30')
    assert.equal(w.source, 'month')
  })

  it('still accepts fromUnix/toUnix', () => {
    const w = resolveComplianceWindow({ fromUnix: 1748736000, toUnix: 1751328000 })
    assert.equal(w.source, 'unix')
    assert.equal(w.fromUnix, 1748736000)
    assert.equal(w.toUnix, 1751328000)
  })

  it('June 2025 midnight IST matches expected unix', () => {
    const from = localMidnightUnix(2025, 5, 1, 330)
    const w = resolveComplianceWindow({ fromDate: '2025-06-01', toDate: '2025-06-01' })
    assert.equal(w.fromUnix, from)
  })
})

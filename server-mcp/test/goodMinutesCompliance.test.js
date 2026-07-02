/**
 * Unit tests for good-minutes compliance scoring.
 * Run: npm test (from server-mcp/)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  enumerateBhMinutes,
  extractPingSamples,
  scoreStoreCompliance,
  normalizeStoreCode,
  normalizeStoreCodes,
  buildInternetMatrix,
  aggregateBhSampleStats,
  formatInternetMatrixText,
  resolveBusinessHours,
  formatBusinessHoursLabel,
  formatCeoOneLiner,
  computeFleetSummary,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_THRESHOLDS,
} from '../src/goodMinutesCompliance.js'

/** One BH day: 10:00–22:00 IST = 12h = 720 minutes (04:30–16:30 UTC). */
function istDayWindow(dateStr) {
  const fromUnix = Math.floor(new Date(`${dateStr}T04:30:00Z`).getTime() / 1000)
  const toUnix = Math.floor(new Date(`${dateStr}T16:30:00Z`).getTime() / 1000)
  return { fromUnix, toUnix }
}

function samplesEveryMinute(fromUnix, toUnix, { latencyMs = 20, jitterMs = 5 } = {}) {
  const latency = []
  const jitter = []
  let t = fromUnix
  while (t < toUnix) {
    latency.push({ clock: t, ms: latencyMs })
    jitter.push({ clock: t, ms: jitterMs })
    t += 60
  }
  return { latency, jitter }
}

describe('resolveBusinessHours', () => {
  it('defaults to 10am–10pm IST', () => {
    const bh = resolveBusinessHours()
    assert.equal(bh.startHour, 10)
    assert.equal(bh.endHour, 22)
    assert.equal(bh.tzOffsetMinutes, 330)
    assert.equal(bh.label, '10am–10pm IST')
  })

  it('accepts custom override', () => {
    const bh = resolveBusinessHours({ startHour: 9, endHour: 21 })
    assert.equal(bh.startHour, 9)
    assert.equal(bh.endHour, 21)
    assert.equal(bh.label, '9am–9pm IST')
  })

  it('rejects startHour >= endHour', () => {
    assert.throws(() => resolveBusinessHours({ startHour: 22, endHour: 10 }), /startHour/)
  })
})

describe('formatBusinessHoursLabel', () => {
  it('formats am/pm labels', () => {
    assert.equal(formatBusinessHoursLabel(DEFAULT_BUSINESS_HOURS), '10am–10pm IST')
  })
})

describe('formatCeoOneLiner', () => {
  it('formats the CEO fleet one-liner', () => {
    const line = formatCeoOneLiner(2640, 3000, 99, 'this month')
    assert.equal(line, '2,640 / 3,000 stores met the connectivity standard this month — target 99%.')
  })
})

describe('computeFleetSummary', () => {
  it('counts stores with goodMinutesPct at target', () => {
    const perStore = [
      { compliant: true, goodMinutesPct: 99.5 },
      { compliant: true, goodMinutesPct: 100 },
      { compliant: false, goodMinutesPct: 95 },
    ]
    const fleet = computeFleetSummary(perStore, 99, { periodLabel: 'this month' })
    assert.equal(fleet.storesCompliant, 2)
    assert.equal(fleet.totalStores, 3)
    assert.equal(fleet.oneLineSummary, '2 / 3 stores met the connectivity standard this month — target 99%.')
  })
})

describe('normalizeStoreCode', () => {
  it('adds LKST prefix when missing', () => {
    assert.equal(normalizeStoreCode('1514'), 'LKST1514')
    assert.equal(normalizeStoreCode('lkst4711'), 'LKST4711')
    assert.equal(normalizeStoreCode('LKST9999'), 'LKST9999')
  })

  it('normalizes array of codes', () => {
    assert.deepEqual(normalizeStoreCodes(['1514', 'LKST4711']), ['LKST1514', 'LKST4711'])
  })
})

describe('buildInternetMatrix', () => {
  it('returns PASS-prefixed values for a clean store', () => {
    const { fromUnix, toUnix } = istDayWindow('2026-06-10')
    const bhMinutes = enumerateBhMinutes(fromUnix, toUnix, DEFAULT_BUSINESS_HOURS)
    const { latency, jitter } = samplesEveryMinute(fromUnix, toUnix)
    const stats = aggregateBhSampleStats(latency, jitter, bhMinutes)
    const row = scoreStoreCompliance({
      store: '1514',
      bhMinutes,
      latencySamples: latency,
      jitterSamples: jitter,
      thresholds: DEFAULT_THRESHOLDS,
      latestUploadMbps: 25,
    })
    const matrix = buildInternetMatrix(row, stats, DEFAULT_THRESHOLDS)
    assert.equal(matrix.store, 'LKST1514')
    assert.equal(matrix.prefix, 'LKST')
    assert.equal(matrix.overallPrefix, 'PASS')
    assert.equal(matrix.rows[0].prefix, 'PASS')
    assert.equal(matrix.rows[0].value, 'Up')
    assert.equal(matrix.rows[4].prefix, 'PASS')
    const text = formatInternetMatrixText(matrix)
    assert.match(text, /^LKST1514 — Internet Matrix/)
    assert.match(text, /PASS Up/)
  })
})

describe('enumerateBhMinutes', () => {
  it('counts 720 minutes for a full 10–22 IST day', () => {
    const { fromUnix, toUnix } = istDayWindow('2026-06-10')
    const mins = enumerateBhMinutes(fromUnix, toUnix, DEFAULT_BUSINESS_HOURS)
    assert.equal(mins.length, 720)
  })
})

describe('extractPingSamples', () => {
  it('collects nested latency/jitter points by clock', () => {
    const json = {
      portalContext: {
        modules: {
          storeZabbix: {
            latencyHistory: {
              byHost: {
                '1': {
                  key: 'custom.ping.ms[8.8.8.8]',
                  points: [{ clock: 1000, ms: 25 }, { clock: 1060, ms: 30 }],
                },
              },
            },
            jitterHistory: {
              byHost: {
                '1': {
                  key: 'custom.ping.jitter[8.8.8.8]',
                  points: [{ clock: 1000, ms: 4 }, { clock: 1060, ms: 6 }],
                },
              },
            },
          },
        },
      },
    }
    const { latency, jitter } = extractPingSamples(json)
    assert.equal(latency.length, 2)
    assert.equal(jitter.length, 2)
    assert.equal(latency[0].ms, 25)
  })
})

describe('scoreStoreCompliance', () => {
  it('fully clean store → 100% strict and covered, flag ok', () => {
    const { fromUnix, toUnix } = istDayWindow('2026-06-10')
    const bhMinutes = enumerateBhMinutes(fromUnix, toUnix, DEFAULT_BUSINESS_HOURS)
    const { latency, jitter } = samplesEveryMinute(fromUnix, toUnix)

    const row = scoreStoreCompliance({
      store: 'LKST1514',
      bhMinutes,
      latencySamples: latency,
      jitterSamples: jitter,
      thresholds: DEFAULT_THRESHOLDS,
      latestUploadMbps: 50,
    })

    assert.equal(row.goodMinutesPct, 100)
    assert.equal(row.compliant, true)
    assert.equal(row.compliantStrict, true)
    assert.equal(row.dataQualityFlag, 'ok')
    assert.equal(row.lossMin, 0)
  })

  it('whole missing BH day → low strict %, high covered % (if partial), monitoring_gap', () => {
    const { fromUnix, toUnix } = istDayWindow('2026-06-11')
    const bhMinutes = enumerateBhMinutes(fromUnix, toUnix, DEFAULT_BUSINESS_HOURS)

    // Only last hour has samples — rest is one big monitoring gap
    const gapStart = toUnix - 3600
    const { latency, jitter } = samplesEveryMinute(gapStart, toUnix)

    const row = scoreStoreCompliance({
      store: 'LKST4711',
      bhMinutes,
      latencySamples: latency,
      jitterSamples: jitter,
      thresholds: DEFAULT_THRESHOLDS,
    })

    assert.ok(row.goodMinutesPct < 20, `expected low good-minutes, got ${row.goodMinutesPct}`)
    assert.equal(row.goodMinutesPctCovered, 100)
    assert.equal(row.dataQualityFlag, 'monitoring_gap')
    assert.ok(row.biggestGapMin >= 600)
    assert.equal(row.compliantStrict, false)
  })

  it('scattered short gaps → intermittent_loss flag', () => {
    const { fromUnix, toUnix } = istDayWindow('2026-06-12')
    const bhMinutes = enumerateBhMinutes(fromUnix, toUnix, DEFAULT_BUSINESS_HOURS)

    const latency = []
    const jitter = []
    // 5-minute gaps every 30 minutes across the day
    for (let t = fromUnix; t < toUnix; t += 60) {
      const slot = Math.floor((t - fromUnix) / 1800) % 2
      if (slot === 0) continue // skip 30-min block every hour → scattered 30-min holes
      latency.push({ clock: t, ms: 15 })
      jitter.push({ clock: t, ms: 3 })
    }

    const row = scoreStoreCompliance({
      store: 'LKST9999',
      bhMinutes,
      latencySamples: latency,
      jitterSamples: jitter,
      thresholds: DEFAULT_THRESHOLDS,
    })

    assert.equal(row.dataQualityFlag, 'intermittent_loss')
    assert.ok(row.lossMin > 0)
    assert.ok(row.biggestGapMin < row.lossMin * 0.5)
  })

  it('latency over threshold increments latencyBadMin', () => {
    const bhMinutes = [960, 1020, 1080, 1140]
    const latency = [
      { clock: 960, ms: 20 },
      { clock: 1020, ms: 80 },
      { clock: 1080, ms: 20 },
      { clock: 1140, ms: 20 },
    ]
    const jitter = latency.map((p) => ({ clock: p.clock, ms: 5 }))

    const row = scoreStoreCompliance({
      store: 'TEST',
      bhMinutes,
      latencySamples: latency,
      jitterSamples: jitter,
      thresholds: DEFAULT_THRESHOLDS,
    })

    assert.equal(row.latencyBadMin, 1)
    assert.equal(row.goodMin, 3)
    assert.equal(row.jitterBadMin, 0)
  })
})

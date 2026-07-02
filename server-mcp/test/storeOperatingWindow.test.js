import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectBootEvents,
  buildEffectiveBhMinutes,
  floorToMinute,
  SHUTDOWN_GAP_MINUTES,
} from '../src/storeOperatingWindow.js'

const BH = { startHour: 10, endHour: 22, tzOffsetMinutes: 330 }

/** One BH day minutes: 10:00–21:59 IST on 2025-06-10 */
function oneDayBhMinutes() {
  const from = Math.floor(new Date('2025-06-10T04:30:00Z').getTime() / 1000)
  const minutes = []
  for (let i = 0; i < 720; i++) minutes.push(from + i * 60)
  return minutes
}

describe('detectBootEvents', () => {
  it('detects uptime counter drop as boot', () => {
    const bootAt = Math.floor(new Date('2025-06-10T05:30:00Z').getTime() / 1000) // 11:00 IST
    const events = detectBootEvents([
      { clock: bootAt - 120, value: 50000 },
      { clock: bootAt, value: 60 },
    ])
    assert.equal(events.length, 1)
    assert.ok(events[0].at <= bootAt)
  })
})

describe('buildEffectiveBhMinutes', () => {
  it('starts counting when store boots at 11am (BH 10–10)', () => {
    const nominal = oneDayBhMinutes()
    const bhStart = nominal[0]
    const bootAt = bhStart + 3600 // 11:00 IST
    const latency = []
    for (let m = bootAt; m < bhStart + 720 * 60; m += 60) {
      latency.push({ clock: m, ms: 20 })
    }
    const result = buildEffectiveBhMinutes({
      businessHours: BH,
      nominalBhMinutes: nominal,
      latencySamples: latency,
      uptimePoints: [
        { clock: bootAt - 60, value: 40000 },
        { clock: bootAt, value: 120 },
      ],
      crashTimes: [],
      enabled: true,
    })
    assert.equal(result.nominalExpectedMin, 720)
    assert.ok(result.perDay[0].trimmedStartMin >= 59 && result.perDay[0].trimmedStartMin <= 60)
    assert.ok(result.adjustedExpectedMin >= 659 && result.adjustedExpectedMin <= 662)
    assert.equal(result.perDay[0].startSource, 'uptime_boot')
  })

  it('ends matrix when store shuts down early (no pings before BH close)', () => {
    const nominal = oneDayBhMinutes()
    const bhStart = nominal[0]
    const lastPing = bhStart + 8 * 3600 // 6pm IST
    const latency = []
    for (let m = bhStart; m <= lastPing; m += 60) {
      latency.push({ clock: m, ms: 20 })
    }
    const result = buildEffectiveBhMinutes({
      businessHours: BH,
      nominalBhMinutes: nominal,
      latencySamples: latency,
      uptimePoints: [],
      crashTimes: [],
      enabled: true,
    })
    assert.ok(result.adjustedExpectedMin < 720)
    assert.equal(result.perDay[0].endSource, 'early_shutdown')
    assert.ok(result.perDay[0].trimmedEndMin >= SHUTDOWN_GAP_MINUTES)
  })

  it('uses first crash in BH when no uptime boot', () => {
    const nominal = oneDayBhMinutes()
    const bhStart = nominal[0]
    const crashAt = bhStart + 3600
    const latency = []
    for (let m = crashAt; m < bhStart + 720 * 60; m += 60) {
      latency.push({ clock: m, ms: 20 })
    }
    const result = buildEffectiveBhMinutes({
      businessHours: BH,
      nominalBhMinutes: nominal,
      latencySamples: latency,
      uptimePoints: [],
      crashTimes: [crashAt + 120],
      enabled: true,
    })
    assert.equal(result.perDay[0].startSource, 'crash_log')
    assert.equal(floorToMinute(crashAt + 120), result.perDay[0].effectiveStartUnix)
  })
})

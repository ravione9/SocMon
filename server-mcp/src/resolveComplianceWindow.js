/**
 * Resolve good_minutes_compliance time window from general date formats or unix seconds.
 * Date-only strings are interpreted in the store timezone (default IST, UTC+5:30).
 */

const DEFAULT_TZ_OFFSET_MINUTES = 330

const MONTH_NAMES = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
}

/** Unix seconds for local midnight on calendar parts (tzOffsetMinutes east of UTC). */
export function localMidnightUnix(year, monthIndex, day, tzOffsetMinutes = 330) {
  return Math.floor(Date.UTC(year, monthIndex, day) / 1000) - tzOffsetMinutes * 60
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatIsoDate(year, monthIndex, day) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`
}

/** Parse YYYY-MM-DD or YYYY/MM/DD date-only string. */
export function parseDateOnlyString(input) {
  const s = String(input || '').trim()
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (!m) return null
  const year = Number(m[1])
  const monthIndex = Number(m[2]) - 1
  const day = Number(m[3])
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null
  return { year, monthIndex, day }
}

/** Parse "2025-06", "June 2025", "Jun 2025". */
export function parseMonthString(input) {
  const s = String(input || '').trim()
  const iso = s.match(/^(\d{4})[-/](\d{1,2})$/)
  if (iso) {
    const year = Number(iso[1])
    const monthIndex = Number(iso[2]) - 1
    if (monthIndex < 0 || monthIndex > 11) return null
    return { year, monthIndex }
  }
  const named = s.match(/^([a-zA-Z]+)\s+(\d{4})$/i)
  if (named) {
    const monthIndex = MONTH_NAMES[named[1].toLowerCase()]
    if (monthIndex == null) return null
    return { year: Number(named[2]), monthIndex }
  }
  return null
}

/** Parse ISO datetime or date-only; returns unix seconds (instant). */
export function parseGeneralDateTime(input, tzOffsetMinutes = 330) {
  if (input == null || input === '') return null
  if (typeof input === 'number' && Number.isFinite(input)) return Math.floor(input)

  const s = String(input).trim()
  const dateOnly = parseDateOnlyString(s)
  if (dateOnly) return localMidnightUnix(dateOnly.year, dateOnly.monthIndex, dateOnly.day, tzOffsetMinutes)

  const parsed = Date.parse(s)
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)

  return null
}

/**
 * Resolve compliance window from tool args.
 * Accepts: fromDate+toDate, month, or fromUnix+toUnix.
 */
export function resolveComplianceWindow(args = {}) {
  const tzOffsetMinutes = args.businessHours?.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES

  const fromUnixRaw = parseGeneralDateTime(args.fromUnix ?? args.from, tzOffsetMinutes)
  const toUnixRaw = parseGeneralDateTime(args.toUnix ?? args.to, tzOffsetMinutes)

  if (fromUnixRaw != null && toUnixRaw != null && fromUnixRaw < toUnixRaw) {
    return buildWindow(fromUnixRaw, toUnixRaw, {
      source: args.fromDate || args.toDate ? 'date' : 'unix',
      tzOffsetMinutes,
      periodLabel: args.periodLabel,
    })
  }

  const fromDate = args.fromDate ?? args.from
  const toDate = args.toDate ?? args.to
  if (fromDate && toDate) {
    const fromParts = parseDateOnlyString(fromDate)
    const toParts = parseDateOnlyString(toDate)
    if (!fromParts || !toParts) {
      throw new Error('fromDate/toDate must be YYYY-MM-DD (e.g. "2025-06-01", "2025-06-30")')
    }
    const fromUnix = localMidnightUnix(fromParts.year, fromParts.monthIndex, fromParts.day, tzOffsetMinutes)
    // Exclusive end: midnight after the last inclusive calendar day
    const toUnix = localMidnightUnix(toParts.year, toParts.monthIndex, toParts.day, tzOffsetMinutes) + 86400
    if (fromUnix >= toUnix) throw new Error('fromDate must be on or before toDate')
    return buildWindow(fromUnix, toUnix, {
      source: 'date',
      fromDate: formatIsoDate(fromParts.year, fromParts.monthIndex, fromParts.day),
      toDate: formatIsoDate(toParts.year, toParts.monthIndex, toParts.day),
      tzOffsetMinutes,
      periodLabel: args.periodLabel,
    })
  }

  if (args.month) {
    const parts = parseMonthString(args.month)
    if (!parts) {
      throw new Error('month must be YYYY-MM or "June 2025" (e.g. "2025-06")')
    }
    const fromUnix = localMidnightUnix(parts.year, parts.monthIndex, 1, tzOffsetMinutes)
    const nextMonth = parts.monthIndex === 11
      ? { year: parts.year + 1, monthIndex: 0 }
      : { year: parts.year, monthIndex: parts.monthIndex + 1 }
    const toUnix = localMidnightUnix(nextMonth.year, nextMonth.monthIndex, 1, tzOffsetMinutes)
    const lastDay = new Date(Date.UTC(parts.year, parts.monthIndex + 1, 0)).getUTCDate()
    return buildWindow(fromUnix, toUnix, {
      source: 'month',
      month: args.month,
      fromDate: formatIsoDate(parts.year, parts.monthIndex, 1),
      toDate: formatIsoDate(parts.year, parts.monthIndex, lastDay),
      tzOffsetMinutes,
      periodLabel: args.periodLabel || 'this month',
    })
  }

  throw new Error(
    'Provide a time window using fromDate+toDate (YYYY-MM-DD), month (e.g. "2025-06"), or fromUnix+toUnix',
  )
}

function buildWindow(fromUnix, toUnix, meta = {}) {
  const spanDays = (toUnix - fromUnix) / 86400
  const periodLabel = meta.periodLabel || inferPeriodLabel(spanDays)
  const tzLabel = meta.tzOffsetMinutes === 330 ? 'IST' : `UTC${meta.tzOffsetMinutes >= 0 ? '+' : ''}${meta.tzOffsetMinutes / 60}h`

  return {
    fromUnix,
    toUnix,
    fromDate: meta.fromDate || isoDateFromUnix(fromUnix, meta.tzOffsetMinutes ?? 330),
    toDate: meta.toDate || isoDateFromUnix(toUnix - 1, meta.tzOffsetMinutes ?? 330),
    fromAt: new Date(fromUnix * 1000).toISOString(),
    toAt: new Date(toUnix * 1000).toISOString(),
    label: meta.fromDate && meta.toDate
      ? `${meta.fromDate} – ${meta.toDate} (${tzLabel})`
      : `${new Date(fromUnix * 1000).toISOString()} – ${new Date(toUnix * 1000).toISOString()}`,
    periodLabel,
    source: meta.source || 'unix',
    month: meta.month || null,
    spanDays: Math.round(spanDays * 10) / 10,
  }
}

function isoDateFromUnix(unixSec, tzOffsetMinutes) {
  const localMs = unixSec * 1000 + tzOffsetMinutes * 60 * 1000
  const d = new Date(localMs)
  return formatIsoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function inferPeriodLabel(spanDays) {
  if (spanDays >= 25 && spanDays <= 35) return 'this month'
  if (spanDays >= 6 && spanDays <= 8) return 'this week'
  if (spanDays >= 0.9 && spanDays <= 1.1) return 'today'
  return 'this period'
}

export function formatWindowInputHelp() {
  return {
    examples: [
      { fromDate: '2025-06-01', toDate: '2025-06-30' },
      { month: '2025-06' },
      { month: 'June 2025' },
      { fromUnix: 1748736000, toUnix: 1751328000 },
    ],
    note: 'Date-only values use local timezone (default IST). toDate is inclusive (full calendar day included).',
    defaultBusinessHours: '10am–10pm IST',
  }
}

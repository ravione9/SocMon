/**
 * Format @timestamp from ES / API (ISO UTC string) for CSV rows in Asia/Kolkata (IST).
 * Example: 2026-05-09 23:06:16 IST
 */
export function formatTimestampIstForCsv(value) {
  if (value == null || value === '') return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = t => parts.find(p => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} IST`
}

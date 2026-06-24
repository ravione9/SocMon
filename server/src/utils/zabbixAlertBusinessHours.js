/** Business-hours helpers for Zabbix Store alerts (timezone-aware). */

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * Local hour (0–23) and weekday (0=Sun) in the rule timezone.
 * @param {Date} now
 * @param {string} [timezone]
 */
export function getZonedHourAndDay(now = new Date(), timezone = 'Asia/Kolkata') {
  const tz = String(timezone || 'Asia/Kolkata').trim() || 'Asia/Kolkata'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now)
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10)
    const wd = parts.find((p) => p.type === 'weekday')?.value || ''
    return { hour, day: WEEKDAY_MAP[wd] ?? now.getDay(), timezone: tz }
  } catch {
    return { hour: now.getHours(), day: now.getDay(), timezone: 'UTC (fallback)' }
  }
}

export function isWithinBusinessHours(bh, now = new Date()) {
  if (!bh?.enabled) return true
  const { hour, day } = getZonedHourAndDay(now, bh.timezone)
  const days = bh.weekdays || [1, 2, 3, 4, 5]
  if (!days.includes(day)) return false
  const from = bh.fromHour ?? 9
  const to = bh.toHour ?? 18
  if (from <= to) return hour >= from && hour < to
  return hour >= from || hour < to
}

export function shouldNotifyForBhPolicy(rule, now = new Date()) {
  const bh = rule.businessHours || {}
  if (!bh.enabled || bh.policy === 'always') return true
  const inBh = isWithinBusinessHours(bh, now)
  if (bh.policy === 'bh_only' || bh.policy === 'suppress_after_hours') return inBh
  if (bh.policy === 'outside_bh') return !inBh
  return true
}

/** Human-readable BH status for UI / logs. */
export function describeBusinessHoursStatus(rule, now = new Date()) {
  const bh = rule.businessHours || {}
  if (!bh.enabled || bh.policy === 'always') {
    return { active: true, label: '24/7', inWindow: true }
  }
  const { hour, day, timezone } = getZonedHourAndDay(now, bh.timezone)
  const inWindow = isWithinBusinessHours(bh, now)
  const shouldNotify = shouldNotifyForBhPolicy(rule, now)
  const days = bh.weekdays || [1, 2, 3, 4, 5]
  const from = bh.fromHour ?? 9
  const to = bh.toHour ?? 18
  return {
    active: shouldNotify,
    inWindow,
    policy: bh.policy,
    timezone,
    localHour: hour,
    localDay: day,
    weekdays: days,
    window: `${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`,
    label: shouldNotify ? 'notifying now' : 'suppressed (outside BH window)',
  }
}

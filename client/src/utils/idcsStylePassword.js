/**
 * Shared password helpers — same scheme as IDCS UserTable “Set Password” modal:
 * easy-to-share: two plain words + 3 digits + exactly one uppercase letter + one special (@, #, or $).
 */

export const EASY_PASSWORD_ADJECTIVES = [
  'happy', 'swift', 'bright', 'calm', 'clever', 'cozy', 'daily', 'eager', 'fancy', 'gentle',
  'jolly', 'lucky', 'merry', 'noble', 'polite', 'quiet', 'rapid', 'royal', 'sunny', 'tidy',
  'vivid', 'warm', 'witty', 'bold', 'clear', 'fresh', 'golden', 'silver', 'amber', 'crimson',
]

export const EASY_PASSWORD_NOUNS = [
  'apple', 'beacon', 'bridge', 'candle', 'compass', 'dolphin', 'eagle', 'forest', 'garden',
  'harbor', 'island', 'jasmine', 'kettle', 'lantern', 'meadow', 'orchard', 'pillar', 'ribbon',
  'river', 'summit', 'tower', 'valley', 'willow', 'bamboo', 'coral', 'delta', 'ember', 'falcon',
]

export const EASY_PASSWORD_SPECIALS = ['@', '#', '$']

export function secureRnd(max) {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null
  if (c?.getRandomValues) {
    const a = new Uint32Array(1)
    c.getRandomValues(a)
    return a[0] % max
  }
  return Math.floor(Math.random() * max)
}

/** @returns {string} */
export function generateRandomPassword() {
  const a = EASY_PASSWORD_ADJECTIVES[secureRnd(EASY_PASSWORD_ADJECTIVES.length)]
  const b = EASY_PASSWORD_NOUNS[secureRnd(EASY_PASSWORD_NOUNS.length)]
  const letters = `${a}${b}`
  const upperIdx = secureRnd(letters.length)
  const chars = letters.split('')
  chars[upperIdx] = chars[upperIdx].toUpperCase()
  const wordsPart = chars.join('')
  const num = 100 + secureRnd(900)
  const sym = EASY_PASSWORD_SPECIALS[secureRnd(EASY_PASSWORD_SPECIALS.length)]
  return `${wordsPart}${num}${sym}`
}

/**
 * @param {string} password
 * @returns {{ label: string, bar: string, pct: string } | null}
 */
export function computePasswordStrength(password) {
  if (!password) return null
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  if (score <= 2) return { label: 'Weak', bar: 'var(--red)', pct: '25%' }
  if (score <= 3) return { label: 'Fair', bar: 'var(--amber)', pct: '50%' }
  if (score <= 4) return { label: 'Good', bar: 'var(--accent)', pct: '75%' }
  return { label: 'Strong', bar: 'var(--green)', pct: '100%' }
}

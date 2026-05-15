/**
 * Shared theme-aware utilities for IDCS screens (respects data-theme / globals.css).
 */

export const idcsCx = {
  text: 'text-[var(--text)]',
  text2: 'text-[var(--text2)]',
  text3: 'text-[var(--text3)]',
  border: 'border-[var(--border)]',
  borderB: 'border-b border-[var(--border)]',
  divide: 'divide-[var(--border)]',
  bg2: 'bg-[var(--bg2)]',
  bg3: 'bg-[var(--bg3)]',
  ringAccent: 'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
}

export function idcsInputClass(extra = '') {
  return [
    'w-full rounded-lg px-3 py-2 text-sm border',
    idcsCx.border,
    idcsCx.bg3,
    idcsCx.text,
    'placeholder:text-[var(--placeholder,var(--text3))]',
    idcsCx.ringAccent,
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}

export function idcsBtnPrimary() {
  return 'font-medium px-4 py-2.5 rounded-lg disabled:opacity-50 transition-opacity bg-[var(--accent)] hover:opacity-90 text-[var(--on-accent)]'
}

export function idcsBtnDanger() {
  return 'font-medium px-4 py-2.5 rounded-lg disabled:opacity-50 transition-opacity bg-[var(--red)] hover:opacity-90 text-white'
}

export function idcsBtnGhost() {
  return `font-medium px-4 py-2.5 rounded-lg transition-colors border ${idcsCx.border} bg-[var(--bg3)] ${idcsCx.text2} hover:opacity-90`
}

export function idcsBtnSecondary() {
  return `font-medium rounded-lg transition-colors ${idcsCx.bg3} ${idcsCx.text2} border ${idcsCx.border} hover:opacity-90`
}

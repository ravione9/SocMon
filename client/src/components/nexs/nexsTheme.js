/** Theme helpers for Nexs screens (matches IDCS styling). */
export const nexsCx = {
  text: 'text-[var(--text)]',
  text2: 'text-[var(--text2)]',
  text3: 'text-[var(--text3)]',
  border: 'border-[var(--border)]',
  bg2: 'bg-[var(--bg2)]',
  bg3: 'bg-[var(--bg3)]',
}

export function nexsInputClass(extra = '') {
  return [
    'w-full rounded-lg px-3 py-2 text-sm border',
    nexsCx.border,
    nexsCx.bg3,
    nexsCx.text,
    'placeholder:text-[var(--text3)]',
    'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}

export function nexsBtnPrimary() {
  return 'font-medium px-4 py-2.5 rounded-lg disabled:opacity-50 bg-[var(--accent)] hover:opacity-90 text-[var(--on-accent)]'
}

export function nexsBtnGhost() {
  return `font-medium px-4 py-2 rounded-lg border ${nexsCx.border} ${nexsCx.bg3} ${nexsCx.text2} hover:opacity-90`
}

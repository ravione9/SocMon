/** Keep in sync with server/src/constants/appPages.js */
export const APP_PAGE_KEYS = ['soc', 'noc', 'sentinel', 'infra', 'tickets', 'reports', 'ai', 'admin']

export const APP_PAGES = [
  { key: 'soc', label: 'SOC', path: '/soc' },
  { key: 'noc', label: 'NOC', path: '/noc' },
  { key: 'sentinel', label: 'XDR / Sentinel', path: '/sentinel' },
  { key: 'infra', label: 'Infra monitoring', path: '/infra' },
  { key: 'tickets', label: 'Tickets', path: '/tickets' },
  { key: 'reports', label: 'Reports', path: '/reports' },
  { key: 'ai', label: 'AI assistant', path: '/ai' },
  { key: 'admin', label: 'Admin', path: '/admin' },
]

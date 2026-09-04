/** Keep in sync with server/src/constants/appPages.js */
export const APP_PAGE_KEYS = ['soc', 'noc', 'sentinel', 'infra', 'storeZabbix', 'roDashboard', 'storeMonitor', 'solarwinds', 'idcs', 'ad', 'nexs', 'tickets', 'reports', 'emailSim', 'ai', 'admin']

/** Hidden from sidebar + direct routes until re-enabled (remove key to show again). */
export const HIDDEN_APP_PAGE_KEYS = []

export function isPageNavVisible(pageKey) {
  return !HIDDEN_APP_PAGE_KEYS.includes(pageKey)
}

export const APP_PAGES = [
  { key: 'soc',      label: 'SOC',            path: '/soc' },
  { key: 'noc',      label: 'NOC',            path: '/noc' },
  { key: 'sentinel', label: 'XDR / Sentinel', path: '/sentinel' },
  { key: 'infra',    label: 'Infra monitoring', path: '/infra' },
  { key: 'storeZabbix', label: 'Store Zabbix', path: '/store-zabbix' },
  { key: 'roDashboard', label: 'Ro Dashboard', path: '/ro-dashboard' },
  { key: 'storeMonitor', label: 'Store Monitor', path: '/store-monitor' },
  { key: 'solarwinds', label: 'SolarWinds Orion', path: '/solarwinds' },
  { key: 'idcs',     label: 'IDCS Users',      path: '/idcs' },
  { key: 'ad',       label: 'Active Directory', path: '/ad' },
  { key: 'nexs',     label: 'Nexs Users',      path: '/nexs' },
  { key: 'tickets',  label: 'Tickets',         path: '/tickets' },
  { key: 'reports',  label: 'Reports',         path: '/reports' },
  { key: 'emailSim', label: 'Email simulation', path: '/email-sim' },
  { key: 'ai',       label: 'SocMon AI',       path: '/ai' },
  { key: 'admin',    label: 'Admin',           path: '/admin' },
]

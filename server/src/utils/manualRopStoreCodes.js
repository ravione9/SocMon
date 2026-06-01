/** Manual ROP + SD-WAN store codes from MANUAL_ROP_SDWAN_STORE_CODES env (comma/newline separated). */
export function getManualRopSdwanStoreCodes() {
  const raw = String(process.env.MANUAL_ROP_SDWAN_STORE_CODES || '').trim()
  if (!raw) return []
  return [...new Set(
    raw
      .split(/[\n,;|\t]+/)
      .map((c) => String(c || '').trim().toUpperCase().replace(/^STORE[-_\s]*/i, ''))
      .filter(Boolean),
  )]
}

/** Default time window for most dashboards / logs (Elasticsearch `now-12h`). */
export const DEFAULT_RANGE_VALUE = '12h'

export const DEFAULT_RANGE_PRESET = Object.freeze({
  type: 'preset',
  value: DEFAULT_RANGE_VALUE,
  label: DEFAULT_RANGE_VALUE,
})

/** SOC (firewall) page only — shorter default window. */
export const SOC_DEFAULT_RANGE_VALUE = '15m'

export const SOC_DEFAULT_RANGE_PRESET = Object.freeze({
  type: 'preset',
  value: SOC_DEFAULT_RANGE_VALUE,
  label: SOC_DEFAULT_RANGE_VALUE,
})

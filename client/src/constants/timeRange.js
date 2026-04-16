/** Default dashboard / log time window (Elasticsearch `now-15m`, etc.). */
export const DEFAULT_RANGE_VALUE = '15m'

export const DEFAULT_RANGE_PRESET = Object.freeze({
  type: 'preset',
  value: DEFAULT_RANGE_VALUE,
  label: DEFAULT_RANGE_VALUE,
})

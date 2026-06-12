import mongoose from 'mongoose'

/**
 * Lifecycle-based problem tracking.
 * One document per (storeTag + code) active session.
 * - firstSeenAt: when the problem was first detected
 * - lastSeenAt:  updated on every check while still active
 * - resolvedAt:  set when the problem disappears from InfluxDB data
 * - status:      'active' | 'resolved'
 *
 * TTL index removes RESOLVED records older than PROBLEM_HISTORY_TTL_DAYS (default 60 days).
 */
const storeProblemHistorySchema = new mongoose.Schema({
  storeTag:     { type: String, required: true },
  hostname:     { type: String, default: '' },
  serial:       { type: String, default: '' },
  connState:    { type: String, default: 'unknown' },
  gatewayVendor:{ type: String, default: '' },
  severity:     { type: String, enum: ['critical', 'high', 'warning'], required: true },
  code:         { type: String, required: true },
  message:      { type: String, default: '' },
  online:       { type: Boolean, default: false },
  status:       { type: String, enum: ['active', 'resolved'], default: 'active', index: true },
  firstSeenAt:  { type: Date, required: true, index: true },
  lastSeenAt:   { type: Date, required: true },
  resolvedAt:   { type: Date, default: null, index: true },
  durationMs:   { type: Number, default: null },
}, { timestamps: false, versionKey: false })

storeProblemHistorySchema.index({ storeTag: 1, code: 1, status: 1 })
// Fast recent disconnect-event fetch for MCP/UI tables.
storeProblemHistorySchema.index({ code: 1, firstSeenAt: -1 })
storeProblemHistorySchema.index({ firstSeenAt: -1, severity: 1 })
storeProblemHistorySchema.index({ status: 1, firstSeenAt: -1 })

// TTL on resolvedAt — only expires resolved records after N days
const TTL_DAYS = parseInt(process.env.PROBLEM_HISTORY_TTL_DAYS || '60', 10)
storeProblemHistorySchema.index({ resolvedAt: 1 }, { expireAfterSeconds: TTL_DAYS * 86400, sparse: true })

export default mongoose.model('StoreProblemHistory', storeProblemHistorySchema)

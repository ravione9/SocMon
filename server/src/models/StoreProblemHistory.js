import mongoose from 'mongoose'

/**
 * One document per problem-per-store per snapshot.
 * Each snapshot run inserts all active problems with the same snapshotAt timestamp.
 * TTL index removes documents older than PROBLEM_HISTORY_TTL_DAYS (default 60 days).
 */
const storeProblemHistorySchema = new mongoose.Schema({
  snapshotAt:   { type: Date, required: true, index: true },
  storeTag:     { type: String, required: true, index: true },
  hostname:     { type: String, default: '' },
  serial:       { type: String, default: '' },
  connState:    { type: String, default: 'unknown' },
  gatewayVendor:{ type: String, default: '' },
  severity:     { type: String, enum: ['critical', 'high', 'warning'], required: true, index: true },
  code:         { type: String, required: true },
  message:      { type: String, default: '' },
  online:       { type: Boolean, default: false },
}, { timestamps: false, versionKey: false })

// Compound index for efficient range + severity queries
storeProblemHistorySchema.index({ snapshotAt: -1, severity: 1 })
storeProblemHistorySchema.index({ snapshotAt: -1, storeTag: 1 })

// TTL — auto-expire old records (60 days by default, override via env)
const TTL_DAYS = parseInt(process.env.PROBLEM_HISTORY_TTL_DAYS || '60', 10)
storeProblemHistorySchema.index({ snapshotAt: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 })

export default mongoose.model('StoreProblemHistory', storeProblemHistorySchema)

import mongoose from 'mongoose'

const channelSchema = new mongoose.Schema({
  type: { type: String, enum: ['slack', 'google_chat', 'email'], required: true },
  webhookUrl: { type: String, default: '' },
  emails: [{ type: String }],
}, { _id: false })

const storeAlertRuleSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  enabled:     { type: Boolean, default: true },
  group:       { type: String, enum: ['SD-WAN Group', 'RP Group', 'POS System Group', 'General Group', 'all'], default: 'all' },
  condition: {
    metric:    { type: String, enum: ['offline', 'packet_loss', 'latency', 'cpu', 'memory', 'download_mbps', 'upload_mbps', 'isp_down', 'hotspot', 'dns_fail', 'http_fail'], required: true },
    operator:  { type: String, enum: ['gt', 'lt', 'eq', 'gte', 'lte'], default: 'gt' },
    threshold: { type: Number, default: 0 },
    target:    { type: String, default: '' },
  },
  severity:  { type: String, enum: ['critical', 'high', 'warning'], default: 'high' },
  /** Flux range for snapshot evaluation e.g. '-15m', '-1h', '-6h', '-24h' */
  evaluationRange: { type: String, default: '-1h' },
  channels:  [channelSchema],
  cooldownMinutes: { type: Number, default: 30 },
  lastFiredAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

storeAlertRuleSchema.index({ enabled: 1, group: 1 })
export default mongoose.model('StoreAlertRule', storeAlertRuleSchema)

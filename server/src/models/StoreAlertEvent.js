import mongoose from 'mongoose'

const storeAlertEventSchema = new mongoose.Schema({
  ruleId:        { type: mongoose.Schema.Types.ObjectId, ref: 'StoreAlertRule', index: true },
  ruleName:      { type: String, required: true },
  severity:      { type: String, enum: ['critical', 'high', 'warning'], required: true },
  group:         { type: String, default: 'all' },
  condition:     { type: Object },
  affectedCount: { type: Number, default: 0 },
  stores:        [{
    hostname: String, serial: String, storeTag: String,
    connState: String, gatewayIp: String, gatewayVendor: String,
    online: Boolean, lastSeen: String, triggeredValue: Number,
    crashBreakdown: [{ app: String, crashType: String, count: Number }],
  }],
  hasMore:       { type: Boolean, default: false },
  dispatch:      [{ channel: String, ok: Boolean, error: String }],
  firedAt:       { type: Date, default: Date.now, index: true },
}, { timestamps: false })

storeAlertEventSchema.index({ firedAt: -1 })
storeAlertEventSchema.index({ ruleId: 1, firedAt: -1 })

export default mongoose.model('StoreAlertEvent', storeAlertEventSchema)

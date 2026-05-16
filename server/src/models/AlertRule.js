import mongoose from 'mongoose'

const alertRuleSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String },
  enabled:     { type: Boolean, default: true },
  type:        { type: String, enum: ['threshold', 'anomaly', 'pattern'], required: true },
  source:      { type: String, enum: ['fortigate', 'cisco', 'all'], default: 'all' },
  condition:   { type: Object, required: true },
  severity:    { type: String, enum: ['critical', 'high', 'medium', 'low'], default: 'medium' },
  actions:     [{ type: String, enum: ['slack', 'email', 'ticket', 'webhook'] }],
  cooldown:    { type: Number, default: 300 },
  lastFired:   { type: Date },
}, { timestamps: true })

// Alert engine filters by enabled + source on every tick; index speeds it up cheaply.
alertRuleSchema.index({ enabled: 1, source: 1 })

export default mongoose.model('AlertRule', alertRuleSchema)

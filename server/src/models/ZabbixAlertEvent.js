import mongoose from 'mongoose'

const zabbixAlertEventSchema = new mongoose.Schema({
  ruleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ZabbixAlertRule', index: true },
  ruleName: { type: String, required: true },
  severity: { type: String, enum: ['disaster', 'critical', 'high', 'warning'], required: true },
  condition: { type: Object },
  affectedCount: { type: Number, default: 0 },
  hosts: [{
    hostid: String,
    hostname: String,
    name: String,
    triggeredValue: Number,
    latency: Number,
    jitter: Number,
    packetLoss: Number,
    cpu: Number,
    memory: Number,
    pingTarget: String,
    sensorKeys: {
      latency: String,
      jitter: String,
      packetLoss: String,
    },
    trigger: String,
  }],
  hasMore: { type: Boolean, default: false },
  dispatch: [{ channel: String, ok: Boolean, error: String, status: Number }],
  eventStatus: { type: String, enum: ['problem', 'resolved'], default: 'problem' },
  /** instant_sla | zabbix_problem | zabbix_webhook | scheduled */
  source: { type: String, default: 'scheduled' },
  firedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: false })

zabbixAlertEventSchema.index({ firedAt: -1 })
zabbixAlertEventSchema.index({ ruleId: 1, firedAt: -1 })

export default mongoose.model('ZabbixAlertEvent', zabbixAlertEventSchema)

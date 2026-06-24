import mongoose from 'mongoose'

const channelSchema = new mongoose.Schema({
  type: { type: String, enum: ['slack', 'teams', 'google_chat', 'email', 'webhook'], required: true },
  webhookUrl: { type: String, default: '' },
  emails: [{ type: String }],
  /** Generic webhook extras */
  method: { type: String, enum: ['POST', 'PUT'], default: 'POST' },
  headers: { type: Object, default: {} },
}, { _id: false })

const zabbixAlertRuleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  enabled: { type: Boolean, default: true },
  severity: { type: String, enum: ['disaster', 'critical', 'high', 'warning'], default: 'high' },
  scope: {
    type: { type: String, enum: ['global', 'group', 'hosts'], default: 'global' },
    groupName: { type: String, default: '' },
    hostids: [{ type: String }],
    hostnames: [{ type: String }],
  },
  condition: {
    metric: {
      type: String,
      enum: [
        'host_down', 'agent_down', 'interface_down',
        'cpu', 'memory', 'disk',
        'latency', 'jitter', 'packet_loss',
        'bandwidth', 'zabbix_problem',
      ],
      required: true,
    },
    operator: { type: String, enum: ['gt', 'lt', 'eq', 'gte', 'lte', 'between'], default: 'gt' },
    threshold: { type: Number, default: 0 },
    thresholdMax: { type: Number, default: null },
    target: { type: String, default: '8.8.8.8' },
    /** Zabbix trigger name substring when metric = zabbix_problem */
    triggerPattern: { type: String, default: '' },
  },
  /** Business-hours notification policy */
  businessHours: {
    enabled: { type: Boolean, default: false },
    /** always | bh_only | outside_bh | suppress_after_hours */
    policy: { type: String, enum: ['always', 'bh_only', 'outside_bh', 'suppress_after_hours'], default: 'always' },
    fromHour: { type: Number, default: 9 },
    toHour: { type: Number, default: 18 },
    weekdays: { type: [Number], default: [1, 2, 3, 4, 5] },
    timezone: { type: String, default: 'Asia/Kolkata' },
  },
  channels: [channelSchema],
  cooldownMinutes: { type: Number, default: 30 },
  lastFiredAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

zabbixAlertRuleSchema.index({ enabled: 1 })
export default mongoose.model('ZabbixAlertRule', zabbixAlertRuleSchema)

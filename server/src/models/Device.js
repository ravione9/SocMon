import mongoose from 'mongoose'

const deviceSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  ip:         { type: String, required: true, unique: true },
  type:       { type: String, enum: ['fortigate', 'cisco-switch', 'cisco-router', 'other'], required: true },
  site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
  status:     { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
  lastSeen:   { type: Date },
  syslogPort: { type: Number, default: 514 },
  notes:      { type: String },
  tags:       [String],
}, { timestamps: true })

export default mongoose.model('Device', deviceSchema)

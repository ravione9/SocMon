import mongoose from 'mongoose'

const deviceSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  ip:         { type: String, required: true, unique: true },
  type:       { type: String, enum: ['fortigate', 'cisco-switch', 'cisco-router', 'windows-server', 'linux-server', 'other'], required: true },
  site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
  status:     { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
  lastSeen:   { type: Date },
  syslogPort: { type: Number, default: 514 },
  /** SSH / management UI port (credentials are per-user — see DeviceUserCredential). */
  sshPort:         { type: Number, default: 22 },
  httpsPort:       { type: Number, default: 443 },
  /** RDP access (Windows Server / workstation). Default port 3389. */
  rdpPort:         { type: Number, default: 3389 },
  rdpDomain:       { type: String, default: '' },
  notes:      { type: String },
  tags:       [String],
}, { timestamps: true })

export default mongoose.model('Device', deviceSchema)

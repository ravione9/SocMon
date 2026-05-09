import mongoose from 'mongoose'

/** Per-user management credentials for a device (SSH / HTTPS / RDP). Not shared across users. */
const schema = new mongoose.Schema({
  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  mgmtUsername:    { type: String, default: '' },
  mgmtPasswordEnc: { type: String, default: null },
}, { timestamps: true })

schema.index({ user: 1, device: 1 }, { unique: true })

export default mongoose.model('DeviceUserCredential', schema)

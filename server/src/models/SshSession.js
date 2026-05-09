import mongoose from 'mongoose'

const sshSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    deviceName: { type: String, default: '' },
    siteName: { type: String, default: '' },
    host: { type: String, required: true },
    port: { type: Number, default: 22 },
    sshUser: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    status: { type: String, enum: ['active', 'closed', 'error'], default: 'active' },
    errorMessage: { type: String },
    bytesFromClient: { type: Number, default: 0 },
    bytesFromDevice: { type: Number, default: 0 },
    /** Audited terminal I/O (direction labels); capped in service when too large. */
    transcript: { type: String, default: '' },
    transcriptTruncated: { type: Boolean, default: false },
  },
  { timestamps: true },
)

sshSessionSchema.index({ startedAt: -1 })
sshSessionSchema.index({ device: 1, startedAt: -1 })

export default mongoose.model('SshSession', sshSessionSchema)

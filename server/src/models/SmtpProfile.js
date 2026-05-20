import mongoose from 'mongoose'

const smtpProfileSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, default: 587 },
    /** Use TLS from the start (465-style). */
    secure: { type: Boolean, default: false },
    username: { type: String, default: '', trim: true },
    /** AES-GCM blob via deviceCrypto helpers (same key material as device credentials). */
    authPassEncrypted: { type: String, default: '' },
    fromEmail: { type: String, required: true, trim: true, lowercase: true },
    fromName: { type: String, default: '', trim: true },
  },
  { timestamps: true },
)

smtpProfileSchema.index({ createdBy: 1, name: 1 })

export default mongoose.model('SmtpProfile', smtpProfileSchema)

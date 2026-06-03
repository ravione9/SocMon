import mongoose from 'mongoose'

const userApiTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    /** JWT `jti` — used to verify and revoke without storing the full token. */
    jti: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
)

userApiTokenSchema.index({ userId: 1, revokedAt: 1 })

export default mongoose.model('UserApiToken', userApiTokenSchema)

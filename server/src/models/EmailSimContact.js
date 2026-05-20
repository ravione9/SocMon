import mongoose from 'mongoose'

/** Saved targets (address book) — use in campaigns via contact IDs. */
const emailSimContactSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    mergeVars: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
)

emailSimContactSchema.index({ createdBy: 1, email: 1 }, { unique: true })

export default mongoose.model('EmailSimContact', emailSimContactSchema)

import mongoose from 'mongoose'

const emailSimGroupSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
  },
  { timestamps: true },
)

emailSimGroupSchema.index({ createdBy: 1, name: 1 })

export default mongoose.model('EmailSimGroup', emailSimGroupSchema)

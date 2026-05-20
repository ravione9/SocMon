import mongoose from 'mongoose'

const emailSimTemplateSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    htmlBody: { type: String, required: true },
    category: { type: String, default: 'custom', trim: true },
  },
  { timestamps: true },
)

emailSimTemplateSchema.index({ createdBy: 1, name: 1 })

export default mongoose.model('EmailSimTemplate', emailSimTemplateSchema)

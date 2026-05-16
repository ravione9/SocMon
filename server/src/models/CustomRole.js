import mongoose from 'mongoose'
import { APP_PAGE_KEY_SET } from '../constants/appPages.js'

const pageEntrySchema = new mongoose.Schema(
  {
    pageKey: { type: String, required: true },
    access: { type: String, enum: ['read', 'full'], required: true },
  },
  { _id: false },
)

const customRoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    pages: { type: [pageEntrySchema], default: [] },
  },
  { timestamps: true },
)

customRoleSchema.pre('validate', function (next) {
  if (!Array.isArray(this.pages)) return next()
  const seen = new Set()
  for (const p of this.pages) {
    if (!p.pageKey || !APP_PAGE_KEY_SET.has(p.pageKey)) {
      return next(new Error(`Invalid page key: ${p.pageKey}`))
    }
    if (seen.has(p.pageKey)) {
      return next(new Error(`Duplicate page key: ${p.pageKey}`))
    }
    seen.add(p.pageKey)
  }
  next()
})

export default mongoose.model('CustomRole', customRoleSchema)

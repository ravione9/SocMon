import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true, select: false },
  role:      { type: String, enum: ['admin', 'analyst', 'viewer'], default: 'viewer' },
  /** App route keys (soc, noc, …). Omitted or non-array = all pages for non-admin (legacy). Empty array = no pages. */
  allowedPages: [{ type: String }],
  active:    { type: Boolean, default: true },
  lastLogin: { type: Date },
  avatar:    { type: String },
  /** UI theme id; validated on write; only used when themeSaveToProfile is true. */
  theme: { type: String, default: null },
  themeSaveToProfile: { type: Boolean, default: false },
}, { timestamps: true })

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

userSchema.methods.comparePassword = async function(candidate) {
  return bcrypt.compare(candidate, this.password)
}

export default mongoose.model('User', userSchema)

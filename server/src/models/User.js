import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  /** Omit for portal users who authenticate against Active Directory (see authKind). */
  password:  { type: String, required: false, select: false },
  /** Local = bcrypt portal password; ad = LDAP bind against the configured domain (still requires a Mongo row + access grants). */
  authKind:  { type: String, enum: ['local', 'ad'], default: 'local' },
  /** When authKind is ad: UPN / DOMAIN\samAccount / DN — leave empty to bind with portal email as the LDAP user name (typical when UPN matches email). */
  adLoginIdentity: { type: String, default: '' },
  role:      { type: String, enum: ['admin', 'custom_admin', 'role_template', 'analyst', 'viewer'], default: 'viewer' },
  /** When role is role_template, ACL comes from CustomRole only. */
  customRoleId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomRole', default: null },
  /** App route keys (soc, noc, …). Full admin ignores this. role_template ignores stored values (computed). custom_admin uses only listed keys; omitted = none. Analyst/viewer: omitted or non-array = all pages (legacy). Empty array = no pages. */
  allowedPages: [{ type: String }],
  active:    { type: Boolean, default: true },
  lastLogin: { type: Date },
  avatar:    { type: String },
  /** UI theme id; validated on write; only used when themeSaveToProfile is true. */
  theme: { type: String, default: null },
  themeSaveToProfile: { type: Boolean, default: false },
  /** When true, user may create long-lived JWT API tokens (Admin → Users). */
  apiAccessEnabled: { type: Boolean, default: false },
  /** Per-user UI state (themes, dashboard filters, etc.). */
  uiPrefs: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true })

userSchema.pre('validate', function(next) {
  if (this.authKind === 'ad') {
    return next()
  }
  const needPw = this.isNew || this.isModified('password')
  if (needPw) {
    const p = this.password
    if (!p || String(p).length < 1) {
      return next(new Error('Password is required for local accounts'))
    }
    if (String(p).length < 8) {
      return next(new Error('Password must be at least 8 characters'))
    }
  }
  next()
})

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next()
  if (!this.password) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

userSchema.methods.comparePassword = async function(candidate) {
  if (!this.password) return false
  return bcrypt.compare(candidate, this.password)
}

export default mongoose.model('User', userSchema)

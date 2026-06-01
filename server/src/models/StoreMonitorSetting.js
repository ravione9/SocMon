import mongoose from 'mongoose'

/**
 * Single-document settings store for the Store Network Monitor page.
 * Uses findOneAndUpdate with upsert so there is always exactly one document.
 */
const storeMonitorSettingSchema = new mongoose.Schema({
  /** Comma/newline list of manual ROP+SD-WAN store codes visible to all users. */
  manualRopSdwanCodes: { type: String, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

const StoreMonitorSetting = mongoose.model('StoreMonitorSetting', storeMonitorSettingSchema)
export default StoreMonitorSetting

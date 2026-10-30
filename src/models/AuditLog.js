const mongoose = require('mongoose');
const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true }, // e.g. 'lead.create', 'auth.login'
    entityType: { type: String, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    meta: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

auditLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);

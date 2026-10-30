const mongoose = require('mongoose');
const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true }, // e.g. 'new_lead', 'hot_lead', 'site_visit_due'
    title: { type: String, required: true },
    body: { type: String, default: '' },
    isRead: { type: Boolean, default: false },
    link: { type: String, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);

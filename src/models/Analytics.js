const mongoose = require('mongoose');
const { Schema } = mongoose;

// Daily rollup per owner, computed by a nightly cron job for fast dashboard reads.
const analyticsSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: String, required: true }, // YYYY-MM-DD

    leadsAdded: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    repliesReceived: { type: Number, default: 0 },
    siteVisitsScheduled: { type: Number, default: 0 },
    dealsClosed: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
  },
  { timestamps: true }
);

analyticsSchema.index({ ownerId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Analytics', analyticsSchema);

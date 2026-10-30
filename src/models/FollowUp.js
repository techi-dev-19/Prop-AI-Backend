const mongoose = require('mongoose');
const { Schema } = mongoose;

const followUpSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    nextFollowUpDate: { type: Date, required: true },
    nextFollowUpMessage: { type: String, required: true },
    urgency: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    buyingProbability: { type: Number, min: 0, max: 100, default: null },

    status: { type: String, enum: ['pending', 'sent', 'done', 'skipped'], default: 'pending' },
    generatedBy: { type: String, default: 'gemini' },
  },
  { timestamps: true }
);

followUpSchema.index({ ownerId: 1, status: 1, nextFollowUpDate: 1 });

module.exports = mongoose.model('FollowUp', followUpSchema);

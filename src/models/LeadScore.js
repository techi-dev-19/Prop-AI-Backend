const mongoose = require('mongoose');
const { Schema } = mongoose;

// Append-only history of every AI scoring run for a lead.
// Lead.leadScore always mirrors the most recent entry's `score`.
const leadScoreSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },

    score: { type: Number, min: 0, max: 100, required: true },
    level: { type: String, enum: ['cold', 'warm', 'hot'], required: true },

    interestLevel: { type: String, default: null },
    buyingIntent: { type: String, default: null },
    budgetMatch: { type: Boolean, default: null },
    closingProbability: { type: Number, min: 0, max: 100, default: null },

    summary: { type: String, default: '' },
    reason: { type: String, default: '' },
    modelVersion: { type: String, default: 'gemini' },
  },
  { timestamps: true }
);

leadScoreSchema.index({ leadId: 1, createdAt: -1 });

module.exports = mongoose.model('LeadScore', leadScoreSchema);

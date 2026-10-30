const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * A saved list of contacts the client can message again and again
 * (Bulk message → "Saved audience"). Built by selecting rows in Upload Data,
 * by uploading a new sheet from the bulk screen, or by a filter.
 */
const audienceSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    tags: [{ type: String, trim: true, maxlength: 40 }],
    source: { type: String, enum: ['selection', 'upload', 'filter'], default: 'selection' },
    leadIds: [{ type: Schema.Types.ObjectId, ref: 'Lead' }],
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

audienceSchema.index({ ownerId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Audience', audienceSchema);

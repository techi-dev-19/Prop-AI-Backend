const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  language: { type: String, required: true, trim: true, default: 'en_US' },
  imageUrl: { type: String, default: '', trim: true },
  bodyText: { type: String, default: '', trim: true },
}, { timestamps: true });
schema.index({ ownerId: 1, name: 1, language: 1 }, { unique: true });
module.exports = mongoose.model('WhatsAppTemplateAsset', schema);

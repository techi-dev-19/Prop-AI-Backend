const mongoose = require("mongoose");
const { Schema } = mongoose;

const emailTemplateSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  subject: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, trim: true, maxlength: 5000 },
  imageUrl: { type: String, trim: true, default: "" },
  category: { type: String, enum: ["marketing", "follow_up", "property_update", "general"], default: "marketing" },
}, { timestamps: true });

emailTemplateSchema.index({ ownerId: 1, name: 1 }, { unique: true });
emailTemplateSchema.index({ ownerId: 1, updatedAt: -1 });

module.exports = mongoose.model("EmailTemplate", emailTemplateSchema);

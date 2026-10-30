const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * One site / project (e.g. "Homez Heights, Gomti Nagar") with its own
 * brochures and photos. Unit rows in Properties link to a site by project
 * name, so every site keeps its own brochure and the AI sends the right one.
 */
const brochureSchema = new Schema(
  {
    url: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: 'brochure.pdf' },
    label: { type: String, trim: true, default: '' }, // e.g. "Tower B floor plans"
    publicId: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const propertySiteSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    nameKey: { type: String, required: true }, // lower-case, spaces squashed — matches Property.projectName
    city: { type: String, trim: true, default: '' },
    location: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    mapsLink: { type: String, trim: true, default: '' },
    brochures: { type: [brochureSchema], default: [] },
    images: [{ type: String, trim: true }],
  },
  { timestamps: true }
);

propertySiteSchema.index({ ownerId: 1, nameKey: 1 }, { unique: true });

propertySiteSchema.statics.keyFor = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

module.exports = mongoose.model('PropertySite', propertySiteSchema);

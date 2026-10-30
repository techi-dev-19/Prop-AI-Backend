const mongoose = require("mongoose");
const { Schema } = mongoose;

const propertySchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    }, // builder

    projectName: { type: String, required: true, trim: true },
    builderName: { type: String, trim: true },
    propertyType: { type: String, trim: true }, // Apartment / Villa / Plot / Commercial ...
    bhk: { type: String, trim: true }, // "2", "3", "2-3", "Studio"
    location: { type: String, trim: true },
    city: { type: String, trim: true, index: true },

    budgetMin: { type: Number, default: null },
    budgetMax: { type: Number, default: null },
    sizeSqft: { type: Number, default: null },

    amenities: [{ type: String, trim: true }],
    parking: { type: Boolean, default: false },
    reraNumber: { type: String, trim: true },

    nearbyMetro: { type: String, trim: true },
    nearbySchool: { type: String, trim: true },
    nearbyHospital: { type: String, trim: true },
    mapsLink: { type: String, trim: true },

    description: { type: String, trim: true },
    images: [{ type: String, trim: true }],

    brochureUrl: {
      type: String,
      trim: true,
      default: null,
    },

    brochureName: {
      type: String,
      trim: true,
      default: null,
    },

    floorPlanUrl: {
      type: String,
      trim: true,
      default: null,
    },

    videoUrl: {
      type: String,
      trim: true,
      default: null,
    },

    dataSource: {
      type: String,
      enum: ["manual", "csv", "brochure"],
      default: "manual",
    },

    brochureExtractionStatus: {
      type: String,
      enum: ["not_applicable", "pending", "processing", "completed", "failed"],
      default: "not_applicable",
    },

    brochureExtractedAt: {
      type: Date,
      default: null,
    },

    isActive: { type: Boolean, default: true },

    // Excel-mode inventory status. Only "available" units are suggested by the AI.
    availability: {
      type: String,
      enum: ["available", "booked", "sold"],
      default: "available",
      index: true,
    },
    floor: { type: String, trim: true, default: "" },
    possession: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

propertySchema.index({
  ownerId: 1,
  city: 1,
  budgetMin: 1,
  budgetMax: 1,
  bhk: 1,
});
propertySchema.index({
  projectName: "text",
  description: "text",
  location: "text",
});

module.exports = mongoose.model("Property", propertySchema);

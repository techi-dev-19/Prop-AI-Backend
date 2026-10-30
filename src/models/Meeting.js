const mongoose = require('mongoose');
const { Schema } = mongoose;

const meetingSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', default: null },

    preferredDate: { type: String, required: true }, // ISO date (YYYY-MM-DD)
    preferredTime: { type: String, required: true }, // "HH:mm" 24hr

    status: {
      type: String,
      enum: ['scheduled', 'visited', 'not_visited', 'rescheduled', 'cancelled'],
      default: 'scheduled',
    },
    notes: { type: String, default: '' },

    // Where the visit was booked: by the AI inside a WhatsApp chat, or by a broker by hand.
    source: { type: String, enum: ['whatsapp_ai', 'manual'], default: 'manual', index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },

    // Google Calendar sync — set once the event is booked (see
    // services/calendar/googleCalendarService.js). Null if Calendar isn't
    // configured or the booking call failed.
    googleEventId: { type: String, default: null },
    googleEventLink: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Meeting', meetingSchema);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;

const ROLES = ['admin', 'builder', 'broker'];

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: 'broker' },

    isActive: { type: Boolean, default: true },

    // Refresh token rotation: only a hash is ever stored.
    refreshTokenHash: { type: String, select: false, default: null },
    tokenVersion: { type: Number, default: 0 }, // bumping this invalidates all outstanding refresh tokens

    // Password reset flow
    resetPasswordTokenHash: { type: String, select: false, default: null },
    resetPasswordExpires: { type: Date, select: false, default: null },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.pre('save', async function preSave(next) {
  if (!this.isModified('passwordHash')) return next();
  // passwordHash field is set to the PLAIN password by callers (see setPassword),
  // then hashed here on save so it's never persisted in plain text.
  if (!this._plainPassword) return next();
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(this._plainPassword, salt);
  this._plainPassword = undefined;
  next();
});

userSchema.methods.setPassword = function setPassword(plainPassword) {
  this._plainPassword = plainPassword;
  this.passwordHash = plainPassword; // placeholder, replaced by pre-save hook
};

userSchema.methods.comparePassword = function comparePassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.refreshTokenHash;
  delete obj.resetPasswordTokenHash;
  delete obj.resetPasswordExpires;
  return obj;
};

userSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('User', userSchema);

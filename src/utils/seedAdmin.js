/**
 * One-off script to create the first Admin account.
 * Usage: npm run seed:admin  (reads ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME from env, or falls back below)
 */
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');

(async () => {
  await connectDB();

  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const name = process.env.ADMIN_NAME || 'Platform Admin';

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin already exists: ${email}`);
    process.exit(0);
  }

  const admin = new User({ name, email, role: 'admin' });
  admin.setPassword(password);
  await admin.save();

  console.log(`Admin created: ${email} / ${password} (change this password immediately)`);
  process.exit(0);
})();

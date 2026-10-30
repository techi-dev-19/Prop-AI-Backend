require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');
const Settings = require('../models/Settings');

(async () => {
  const email = String(process.env.CLIENT_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.CLIENT_PASSWORD || '');
  const name = String(process.env.CLIENT_NAME || 'PropAI').trim();
  if (!email || !password || password.length < 12) {
    throw new Error('Set CLIENT_EMAIL and a strong CLIENT_PASSWORD (at least 12 characters) in the backend environment before running npm run seed:client.');
  }
  await connectDB();
  let user = await User.findOne({ email });
  if (user) {
    console.log(`Client user already exists: ${email}. No password or role was changed.`);
  } else {
    user = new User({ name, email, role: 'broker' });
    user.setPassword(password);
    await user.save();
    console.log(`PropAI client user created: ${email}`);
  }
  await Settings.findOneAndUpdate({}, { $setOnInsert: { companyName: 'PropAI' } }, { upsert: true, new: true });
  console.log('Single-client setup is ready. Change company profile and provider configuration from the app as needed.');
  await require('mongoose').disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[seed:client] Failed:', err.message);
  process.exit(1);
});

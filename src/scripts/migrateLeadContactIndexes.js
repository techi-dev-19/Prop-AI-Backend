/**
 * One-time, safe migration for tenants' existing Leads collection.
 * Removes the old unique (ownerId, phone) index that treats null/missing phone
 * values as duplicates, normalizes blank contact fields, then creates the new
 * partial unique index that applies only to actual string phone numbers.
 * Run during a maintenance window after backing up MongoDB.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri);
  const collection = mongoose.connection.collection('leads');
  const indexes = await collection.indexes();

  for (const index of indexes) {
    const keys = Object.keys(index.key || {});
    const isLegacyPhoneIndex = index.unique && keys.length === 2 && index.key.ownerId === 1 && index.key.phone === 1 && !index.partialFilterExpression;
    if (isLegacyPhoneIndex) {
      console.log(`[migration] dropping legacy index ${index.name}`);
      await collection.dropIndex(index.name);
    }
  }

  const cleanup = await collection.updateMany(
    { $or: [{ phone: '' }, { phone: { $exists: false } }, { phone: { $type: 'string', $regex: /^\s*$/ } }] },
    { $set: { phone: null } },
  );
  if (cleanup.modifiedCount) console.log(`[migration] normalized ${cleanup.modifiedCount} blank/missing phone field(s)`);

  await collection.createIndex(
    { ownerId: 1, phone: 1 },
    { unique: true, partialFilterExpression: { phone: { $type: 'string' } }, name: 'owner_phone_unique_nonempty' },
  );
  console.log('[migration] owner_phone_unique_nonempty index is ready');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[migration] failed:', error.message);
  try { await mongoose.disconnect(); } catch { /* best effort */ }
  process.exitCode = 1;
});

const mongoose = require('mongoose');
const env = require('./env');

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(env.mongoUri, {
      autoIndex: env.nodeEnv !== 'production', // build indexes automatically only outside prod
    });
    isConnected = true;
    console.log(`[db] MongoDB connected -> ${mongoose.connection.host}/${mongoose.connection.name}`);
  } catch (err) {
    console.error('[db] MongoDB connection failed:', err.message);
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected');
    isConnected = false;
  });

  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB error:', err.message);
  });

  return mongoose.connection;
}

module.exports = connectDB;

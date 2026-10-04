const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Read .env
const actualEnvPath = path.resolve(__dirname, '../.env');
const content = fs.readFileSync(actualEnvPath, 'utf8');
content.split('\n').forEach(line => {
  const parts = line.trim().split('=');
  const key = parts[0]?.trim();
  const val = parts.slice(1).join('=').trim();
  if (key && !key.startsWith('#') && val) {
    process.env[key] = val;
  }
});

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not found in .env');
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Successfully connected to MongoDB');

  const db = mongoose.connection.db;
  const accountsCol = db.collection('accountstates');

  const res = await accountsCol.findOneAndUpdate(
    { accountId: 'default' },
    {
      $set: {
        accountId: 'default',
        initialBalance: 100.00,
        currentBalance: 100.00,
        totalPnL: 0,
        totalTrades: 0,
        winsCount: 0,
        lossesCount: 0,
        breakevenCount: 0,
        updatedAt: new Date()
      }
    },
    { returnDocument: 'after', upsert: true }
  );

  console.log('Account Reset Result:', res);

  // Check and clean active trades
  const tradesCol = db.collection('trades');
  const activeCount = await tradesCol.countDocuments({ status: { $ne: 'ARCHIVED' } });
  console.log('Active trades currently pending:', activeCount);

  if (activeCount > 0) {
    const updateRes = await tradesCol.updateMany(
      { status: { $ne: 'ARCHIVED' } },
      { $set: { status: 'ARCHIVED', closedAt: new Date() } }
    );
    console.log('Archived active trades:', updateRes.modifiedCount);
  }

  await mongoose.disconnect();
  console.log('Done!');
}

run().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});

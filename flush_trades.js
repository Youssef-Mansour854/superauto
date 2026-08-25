const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Load environment variables from .env file
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...values] = trimmed.split('=');
        if (key) {
          const val = values.join('=').trim().replace(/^["']|["']$/g, '');
          process.env[key.trim()] = val;
        }
      }
    });
  }
}

loadEnv();

// Define schemas with strict: false so all fields can be saved/queried seamlessly
const tradeSchema = new mongoose.Schema({}, { strict: false });
const Trade = mongoose.models.Trade || mongoose.model('Trade', tradeSchema, 'trades');

const tradeHistorySchema = new mongoose.Schema({}, { strict: false });
const TradeHistory = mongoose.models.TradeHistory || mongoose.model('TradeHistory', tradeHistorySchema, 'trade_history');

async function flushTrades() {
  console.log('--- STARTING TRADE FLUSH ---');
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌ MONGODB_URI is not set in environment or .env file!');
    process.exit(1);
  }

  await mongoose.connect(mongoUri, { bufferCommands: false });
  console.log('✅ Connected to MongoDB.');

  // Fetch all active trades (status: ALERT_SENT)
  const activeTrades = await Trade.find({ status: 'ALERT_SENT' });
  console.log(`Found ${activeTrades.length} active trade(s) to flush.`);

  if (activeTrades.length === 0) {
    console.log('No active trades found in ALERT_SENT status.');
    await mongoose.disconnect();
    return;
  }

  let flushedCount = 0;
  for (const trade of activeTrades) {
    const tradeObj = trade.toObject();
    const tradeId = tradeObj._id;

    // Build TradeHistory object
    const historyItem = {
      ...tradeObj,
      tradeId: tradeId.toString(),
      status: 'ARCHIVED',
      pnl: 0,
      exitPrice: tradeObj.exitPrice || tradeObj.entryPrice,
      closedAt: new Date()
    };
    delete historyItem._id;

    // Move to TradeHistory & remove from Trade
    await TradeHistory.create(historyItem);
    await Trade.deleteOne({ _id: tradeId });
    flushedCount++;
    console.log(`[${flushedCount}] Flushed Trade ID ${tradeId} (${tradeObj.symbol}) -> Moved to TradeHistory (status: 'ARCHIVED', pnl: 0)`);
  }

  console.log(`\n✅ SUCCESS: Flushed ${flushedCount} active trade(s) from Trade model to TradeHistory collection.`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
  console.log('--- FLUSH COMPLETE ---');
}

flushTrades().catch((err) => {
  console.error('❌ Error flushing trades:', err.message || err);
  process.exit(1);
});

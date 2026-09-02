const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');

// Load environment variables from .env file if present
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

// Define Mongoose Trade Schema for diagnostics
const tradeSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  action: { type: String, required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number },
  sl: { type: Number },
  tp: { type: Number },
  tradeType: { type: String },
  status: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  closedAt: { type: Date }
}, { strict: false });

const Trade = mongoose.models.Trade || mongoose.model('Trade', tradeSchema);

async function verifyHealth() {
  console.log('========================================');
  console.log('   SYSTEM HEALTH DIAGNOSTIC VERIFICATION');
  console.log('========================================\n');

  let apiSuccess = false;
  let dbSuccess = false;

  // 1. Test Twelve Data API
  console.log('[1/2] Testing Twelve Data API for EUR/USD...');
  const apiKey = process.env.TWELVEDATA_API_KEY || '';
  if (!apiKey) {
    console.error('❌ TWELVEDATA_API_KEY is missing from environment or .env file!');
  } else {
    try {
      const url = 'https://api.twelvedata.com/time_series';
      const response = await axios.get(url, {
        params: {
          symbol: 'EUR/USD',
          interval: '5min',
          outputsize: 1,
          apikey: apiKey
        },
        timeout: 10000,
        validateStatus: () => true
      });

      if (response.status === 429 || (response.data && response.data.code === 429)) {
        console.error('❌ 429 Rate Limit Exceeded! Twelve Data API call limit reached.');
        console.error('Response details:', JSON.stringify(response.data, null, 2));
      } else if (response.status === 401 || (response.data && response.data.code === 401)) {
        console.error('❌ 401 Unauthorized! Invalid TWELVEDATA_API_KEY.');
        console.error('Response details:', JSON.stringify(response.data, null, 2));
      } else if (response.data && response.data.status === 'error') {
        console.error(`❌ Twelve Data API error: ${response.data.message || JSON.stringify(response.data)}`);
      } else if (response.data && Array.isArray(response.data.values) && response.data.values.length > 0) {
        const latestCandle = response.data.values[0];
        console.log('✅ Twelve Data API test passed successfully!');
        console.log(`   Symbol: EUR/USD | Datetime: ${latestCandle.datetime} | Close Price: $${latestCandle.close}`);
        apiSuccess = true;
      } else {
        console.warn('⚠️ Unexpected response structure from Twelve Data:', JSON.stringify(response.data, null, 2));
      }
    } catch (err) {
      console.error('❌ Error requesting Twelve Data API:', err.message || err);
    }
  }

  console.log('\n----------------------------------------\n');

  // 2. Test MongoDB State
  console.log('[2/2] Testing MongoDB State & Querying Trades...');
  const mongoUri = process.env.MONGODB_URI || '';
  if (!mongoUri) {
    console.error('❌ MONGODB_URI is missing from environment or .env file!');
  } else {
    try {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(mongoUri, { bufferCommands: false });
      console.log('✅ Connected to MongoDB successfully.');

      const activeTradesCount = await Trade.countDocuments({ status: 'ALERT_SENT' });
      const totalTradesCount = await Trade.countDocuments({});

      console.log(`   Active Trades (status: 'ALERT_SENT'): ${activeTradesCount}`);
      console.log(`   Total Trades in DB: ${totalTradesCount}`);

      if (activeTradesCount > 0) {
        const activeTrades = await Trade.find({ status: 'ALERT_SENT' }).sort({ timestamp: -1 });
        activeTrades.forEach((t, index) => {
          console.log(`   [${index + 1}] ID: ${t._id} | Symbol: ${t.symbol} | Type: ${t.tradeType || 'SCALP'} | Action: ${t.action} | Entry: $${t.entryPrice} | Date: ${t.timestamp}`);
        });
      }
      dbSuccess = true;
    } catch (dbErr) {
      console.error('❌ MongoDB Diagnostic Failure:', dbErr.message || dbErr);
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB.');
      }
    }
  }

  console.log('\n========================================');
  console.log(`   HEALTH CHECK OVERALL: ${apiSuccess && dbSuccess ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log('========================================');
}

verifyHealth().catch((err) => {
  console.error('Fatal diagnostic error:', err);
  process.exit(1);
});

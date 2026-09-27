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

// Define Trade Schema & Model for Mongoose
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
  createdAt: { type: Date }
}, { strict: false });

const Trade = mongoose.models.Trade || mongoose.model('Trade', tradeSchema);

async function runDiagnostics() {
  console.log('--- STARTING ENGINE DIAGNOSTICS ---\n');

  // 1. MongoDB Connection & Active Trades Query
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌ MONGODB_URI is not set in environment or .env file!');
  } else {
    try {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(mongoUri, { bufferCommands: false });
      console.log('✅ Connected to MongoDB successfully.\n');

      console.log('Querying active trades (status: ALERT_SENT)...');
      const activeTrades = await Trade.find({ status: 'ALERT_SENT' });

      console.log(`Found ${activeTrades.length} active trade(s):`);
      if (activeTrades.length === 0) {
        console.log('No active trades currently in ALERT_SENT status.');
      } else {
        const now = Date.now();
        activeTrades.forEach((trade, index) => {
          const tradeTime = trade.timestamp ? new Date(trade.timestamp).getTime() : (trade.createdAt ? new Date(trade.createdAt).getTime() : now);
          const activeMinutes = Math.floor((now - tradeTime) / (1000 * 60));
          console.log(`  [${index + 1}] Symbol: ${trade.symbol} | Entry Price: ${trade.entryPrice} | Active for: ${activeMinutes} minutes (ID: ${trade._id})`);
        });
      }
      console.log('');
    } catch (dbErr) {
      console.error('❌ MongoDB Connection/Query Error:', dbErr.message || dbErr);
    }
  }

  // 2. Twelve Data API Test Request
  const twelveDataApiKey = process.env.TWELVEDATA_API_KEY;
  console.log('Testing Twelve Data API request for EUR/USD...');
  if (!twelveDataApiKey) {
    console.warn('⚠️ TWELVEDATA_API_KEY is not set in environment or .env file!');
  }

  try {
    const url = 'https://api.twelvedata.com/time_series';
    const response = await axios.get(url, {
      params: {
        symbol: 'EUR/USD',
        interval: '5min',
        outputsize: 5,
        apikey: twelveDataApiKey || ''
      },
      timeout: 10000,
      validateStatus: () => true // Resolve response for any HTTP status code to catch 429
    });

    console.log(`Twelve Data HTTP Response Status: ${response.status} ${response.statusText}`);

    if (response.status === 429 || (response.data && response.data.code === 429)) {
      console.error('❌ RATE LIMIT DETECTED (Code 429)! Twelve Data API limit reached.');
      console.error('Response Body:', JSON.stringify(response.data, null, 2));
    } else if (response.data && response.data.status === 'error') {
      console.error('❌ Twelve Data API Error Response:', response.data.message || response.data);
    } else if (response.data && (response.data.values || response.data['EUR/USD'])) {
      const candles = response.data.values || response.data['EUR/USD']?.values || [];
      console.log(`✅ Twelve Data API test successful. Received ${candles.length} candle(s) for EUR/USD.`);
    } else {
      console.log('Twelve Data API Response:', JSON.stringify(response.data, null, 2));
    }
  } catch (apiErr) {
    console.error('❌ Twelve Data API Request Error:', apiErr.message || apiErr);
  }

  console.log('\n--- DIAGNOSTICS COMPLETE ---');

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

runDiagnostics().catch(err => {
  console.error('Fatal error during execution:', err);
  process.exit(1);
});

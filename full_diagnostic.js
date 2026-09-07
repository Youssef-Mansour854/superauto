const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');

// 1. Load Environment Variables from .env
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

// 2. Mongoose Schema for Trade Collection
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

// 3. Twelve Data API Fetcher matching lib/twelvedata.ts
function normalizeTwelveDataSymbol(symbol) {
  if (symbol === '^IXIC' || symbol === 'IXIC') return 'IXIC';
  if (symbol === '^DJI' || symbol === 'DJI') return 'DJI';
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD') return 'XAU/USD';
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD') return 'BTC/USD';
  return symbol;
}

async function fetchLatestCandle(symbol) {
  const apiSymbol = normalizeTwelveDataSymbol(symbol);
  const apiKey = process.env.TWELVEDATA_API_KEY || 'demo';
  const url = 'https://api.twelvedata.com/time_series';

  console.log(`\n>>> Testing Twelve Data for '${symbol}' (apiSymbol: '${apiSymbol}')...`);
  console.log(`    API Key: ${apiKey ? (apiKey === 'demo' ? 'demo (Default placeholder)' : apiKey.substring(0, 5) + '...') : 'MISSING'}`);

  try {
    const response = await axios.get(url, {
      params: {
        symbol: apiSymbol,
        interval: '5min',
        outputsize: 5,
        apikey: apiKey,
      },
      timeout: 12000,
      validateStatus: () => true // Allow handling of all status codes (400, 401, 429, etc.)
    });

    const status = response.status;
    const data = response.data;

    console.log(`    HTTP Status: ${status} ${response.statusText || ''}`);

    if (status === 400 || (data && data.code === 400)) {
      console.error(`    ❌ [HTTP 400 Bad Request]: ${data?.message || JSON.stringify(data)}`);
      return { success: false, status: 400, error: data?.message || 'Bad Request' };
    }

    if (status === 401 || (data && data.code === 401)) {
      console.error(`    ❌ [HTTP 401 Unauthorized]: ${data?.message || 'Invalid API Key'}`);
      return { success: false, status: 401, error: data?.message || 'Unauthorized' };
    }

    if (status === 429 || (data && data.code === 429)) {
      console.error(`    ❌ [HTTP 429 Rate Limit Exceeded]: ${data?.message || 'API rate limit reached'}`);
      return { success: false, status: 429, error: data?.message || 'Rate Limited' };
    }

    if (data && data.status === 'error') {
      console.error(`    ❌ [Twelve Data API Error]: ${data.message || JSON.stringify(data)}`);
      return { success: false, status, error: data.message || 'API Error' };
    }

    const symbolData = data.values ? data : (data[apiSymbol] || data[symbol]);

    if (!symbolData || !Array.isArray(symbolData.values) || symbolData.values.length === 0) {
      console.warn(`    ⚠️ [No Data / Symbol Not Found]: No candle values returned.`);
      console.log(`    Response Body:`, JSON.stringify(data, null, 2));
      return { success: false, status, error: 'Symbol not found or no values' };
    }

    const latest = symbolData.values[0];
    console.log(`    ✅ Success! Latest 5m Candle:`);
    console.log(`       Time:  ${latest.datetime}`);
    console.log(`       Open:  $${latest.open}`);
    console.log(`       High:  $${latest.high}`);
    console.log(`       Low:   $${latest.low}`);
    console.log(`       Close: $${latest.close}`);

    return { success: true, status: 200, latest };
  } catch (err) {
    console.error(`    ❌ [Network / Unexpected Error]:`, err.message || err);
    return { success: false, status: 500, error: err.message };
  }
}

async function runFullDiagnostic() {
  console.log('================================================================');
  console.log('            COMPREHENSIVE SYSTEM HEALTH DIAGNOSTIC              ');
  console.log('================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // -------------------------------------------------------------
  // PART 1: MongoDB Active / Open Trades Check
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' [1/2] MONGODB DATABASE HEALTH & ACTIVE TRADES CHECK            ');
  console.log('================================================================');
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error('❌ MONGODB_URI is not defined in .env or environment!');
  } else {
    try {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(mongoUri, { bufferCommands: false });
      console.log('✅ Connected to MongoDB successfully.');

      const activeTradesCount = await Trade.countDocuments({ status: 'ALERT_SENT' });
      const totalTradesCount = await Trade.countDocuments({});

      console.log(`\n>>> Active / Open Trades (status: 'ALERT_SENT'): ${activeTradesCount}`);
      console.log(`>>> Total Historic Trades in Collection:         ${totalTradesCount}`);

      if (activeTradesCount > 0) {
        console.log('\nDetails of Active Trades:');
        const activeTrades = await Trade.find({ status: 'ALERT_SENT' }).sort({ timestamp: -1 });
        activeTrades.forEach((t, idx) => {
          console.log(`  [${idx + 1}] ID: ${t._id} | Symbol: ${t.symbol} | Action: ${t.action} | Entry: $${t.entryPrice} | SL: $${t.sl} | TP: $${t.tp} | Opened: ${t.timestamp}`);
        });
      } else {
        console.log('ℹ️ No active open trades currently pending evaluation.');
      }
    } catch (dbErr) {
      console.error('❌ MongoDB Connection Failure:', dbErr.message || dbErr);
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        console.log('MongoDB connection closed.');
      }
    }
  }

  // -------------------------------------------------------------
  // PART 2: Twelve Data API Watchlist Check (XAU/USD, EUR/USD, IXIC)
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(' [2/2] TWELVE DATA API DIAGNOSTIC FOR WATCHLIST SYMBOLS         ');
  console.log('================================================================');

  const symbolsToTest = ['XAU/USD', 'EUR/USD', 'IXIC', 'QQQ'];
  const summary = {};

  for (const sym of symbolsToTest) {
    const res = await fetchLatestCandle(sym);
    summary[sym] = res;
  }

  console.log('\n================================================================');
  console.log('                  DIAGNOSTIC SUMMARY TABLE                      ');
  console.log('================================================================');
  console.table(Object.keys(summary).map(sym => ({
    Symbol: sym,
    Status: summary[sym].status,
    Success: summary[sym].success ? 'YES ✅' : 'NO ❌',
    Details: summary[sym].success ? `Close: $${summary[sym].latest?.close} (${summary[sym].latest?.datetime})` : summary[sym].error
  })));
  console.log('================================================================\n');
}

runFullDiagnostic().catch(err => {
  console.error('Fatal diagnostic error:', err);
  process.exit(1);
});

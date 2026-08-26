const fs = require('fs');
const path = require('path');
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

function normalizeTwelveDataSymbol(symbol) {
  if (symbol === '^IXIC' || symbol === 'IXIC') return 'IXIC';
  if (symbol === '^DJI' || symbol === 'DJI') return 'DJI';
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD') return 'XAU/USD';
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD') return 'BTC/USD';
  return symbol;
}

async function fetchTwelveData5mKlines(symbol = 'XAU/USD', interval = '5min', outputsize = 250) {
  try {
    const apiSymbol = normalizeTwelveDataSymbol(symbol);
    const apiKey = process.env.TWELVEDATA_API_KEY || '';
    const url = 'https://api.twelvedata.com/time_series';

    console.log(`\n--- Fetching Twelve Data candles for '${symbol}' (apiSymbol: '${apiSymbol}') ---`);
    console.log(`API Key set: ${apiKey ? 'Yes (' + apiKey.substring(0, 5) + '...)' : 'No'}`);

    const response = await axios.get(url, {
      params: {
        symbol: apiSymbol,
        interval,
        outputsize,
        apikey: apiKey,
      },
      timeout: 10000,
      validateStatus: () => true // Resolve on any HTTP status to inspect code
    });

    console.log(`HTTP Status Code: ${response.status} ${response.statusText}`);

    const data = response.data;

    if (!data) {
      console.warn(`Empty response returned from Twelve Data for '${symbol}'.`);
      return [];
    }

    if (data.status === 'error' || response.status >= 400) {
      console.error(`❌ Twelve Data API error for '${symbol}':`, data.message || data);
      return [];
    }

    const symbolData = data.values ? data : (data[apiSymbol] || data[symbol]);

    if (!symbolData || !Array.isArray(symbolData.values) || symbolData.values.length === 0) {
      console.warn(`⚠️ No candle values found in Twelve Data response for '${symbol}'.`);
      console.log('Response body:', JSON.stringify(data, null, 2));
      return [];
    }

    const rawValues = symbolData.values;

    const candles = rawValues
      .map((item) => {
        const open = parseFloat(item.open);
        const high = parseFloat(item.high);
        const low = parseFloat(item.low);
        const close = parseFloat(item.close);
        const volume = parseFloat(item.volume || '0');
        const openTime = new Date(item.datetime).getTime();
        const closeTime = openTime + 5 * 60 * 1000;

        if (isNaN(close) || isNaN(openTime)) {
          return null;
        }

        return {
          openTime,
          open: isNaN(open) ? close : open,
          high: isNaN(high) ? close : high,
          low: isNaN(low) ? close : low,
          close,
          volume: isNaN(volume) ? 0 : volume,
          closeTime,
        };
      })
      .filter((c) => c !== null);

    candles.reverse();

    console.log(`✅ Successfully fetched ${candles.length} candles for '${symbol}'.`);
    if (candles.length > 0) {
      console.log(`Latest candle for ${symbol}: Close = ${candles[candles.length - 1].close}, Time = ${new Date(candles[candles.length - 1].openTime).toISOString()}`);
    }

    return candles;
  } catch (error) {
    console.error(`❌ Error fetching Twelve Data 5m klines for '${symbol}':`, error?.response?.data || error?.message || error);
    return [];
  }
}

async function testPairs() {
  console.log('=== TWELVE DATA PAIRS DIAGNOSTIC TEST ===');

  const eurUsdCandles = await fetchTwelveData5mKlines('EUR/USD', '5min', 250);
  console.log(`Result EUR/USD candle count: ${eurUsdCandles.length}`);

  const xagUsdCandles = await fetchTwelveData5mKlines('XAG/USD', '5min', 250);
  console.log(`Result XAG/USD candle count: ${xagUsdCandles.length}`);

  console.log('\n=== DIAGNOSTIC TEST COMPLETED ===');
}

testPairs().catch((err) => {
  console.error('Fatal error running test_twelvedata_pairs.js:', err);
});

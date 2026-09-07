const fs = require('fs');
const path = require('path');
const axios = require('axios');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
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

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getCachePath(symbol) {
  const clean = symbol.replace(/[\/\^=\-]/g, '_').toLowerCase();
  return path.join(DATA_DIR, `${clean}_5m.json`);
}

async function fetchFromTwelveData(symbol, outputsize = 5000) {
  const apiKey = process.env.TWELVEDATA_API_KEY || 'demo';
  const url = 'https://api.twelvedata.com/time_series';

  console.log(`[Twelve Data] Requesting ${outputsize} candles for ${symbol}...`);
  const res = await axios.get(url, {
    params: {
      symbol,
      interval: '5min',
      outputsize,
      apikey: apiKey
    },
    timeout: 20000,
    validateStatus: () => true
  });

  if (res.status !== 200 || !res.data || res.data.status === 'error' || res.data.code) {
    const msg = res.data?.message || `HTTP ${res.status}`;
    console.warn(`[Twelve Data] Failed for ${symbol}: ${msg}`);
    return null;
  }

  const values = res.data.values;
  if (!Array.isArray(values) || values.length === 0) {
    console.warn(`[Twelve Data] No values returned for ${symbol}`);
    return null;
  }

  // Twelve Data returns reverse chronological (newest first). Reverse to oldest first.
  const candles = values
    .map(item => {
      const open = parseFloat(item.open);
      const high = parseFloat(item.high);
      const low = parseFloat(item.low);
      const close = parseFloat(item.close);
      const volume = parseFloat(item.volume || '0');
      const time = new Date(item.datetime).getTime();
      if (isNaN(close) || isNaN(time)) return null;
      return {
        time,
        datetime: item.datetime,
        open: isNaN(open) ? close : open,
        high: isNaN(high) ? close : high,
        low: isNaN(low) ? close : low,
        close,
        volume: isNaN(volume) ? 0 : volume
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  console.log(`[Twelve Data] Successfully fetched ${candles.length} candles for ${symbol}.`);
  return candles;
}

async function fetchFromYahooFinance(symbol) {
  // Map symbols to Yahoo Finance tickers
  let yfTicker = symbol;
  if (symbol === 'XAU/USD' || symbol === 'XAUUSD' || symbol === 'GOLD') yfTicker = 'GC=F';
  else if (symbol === 'EUR/USD' || symbol === 'EURUSD') yfTicker = 'EURUSD=X';
  else if (symbol === 'BTC/USD' || symbol === 'BTCUSD') yfTicker = 'BTC-USD';

  console.log(`[Yahoo Finance] Requesting 5m candles (range: 1mo) for ${symbol} via ticker ${yfTicker}...`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfTicker}`;

  const res = await axios.get(url, {
    params: {
      interval: '5m',
      range: '1mo'
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    },
    timeout: 20000,
    validateStatus: () => true
  });

  if (res.status !== 200 || !res.data?.chart?.result?.[0]) {
    console.error(`[Yahoo Finance] Failed for ${yfTicker}: HTTP ${res.status}`);
    return null;
  }

  const result = res.data.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const { open, high, low, close, volume } = quote;

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = close?.[i];
    const o = open?.[i];
    const h = high?.[i];
    const l = low?.[i];
    const v = volume?.[i] || 0;
    const t = timestamps[i] * 1000;

    if (c !== null && c !== undefined && !isNaN(c)) {
      candles.push({
        time: t,
        datetime: new Date(t).toISOString().replace('T', ' ').replace(/\..+/, ''),
        open: o !== null && !isNaN(o) ? o : c,
        high: h !== null && !isNaN(h) ? h : c,
        low: l !== null && !isNaN(l) ? l : c,
        close: c,
        volume: v
      });
    }
  }

  candles.sort((a, b) => a.time - b.time);
  console.log(`[Yahoo Finance] Successfully fetched ${candles.length} candles for ${symbol}.`);
  return candles;
}

/**
 * Loads 5-minute candles for symbol with caching
 */
async function loadCandles(symbol, forceRefresh = false) {
  const cacheFile = getCachePath(symbol);

  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const cached = JSON.parse(raw);
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`[Cache Hit] Loaded ${cached.length} candles for ${symbol} from ${cacheFile}`);
        return cached;
      }
    } catch (e) {
      console.warn(`Error reading cache for ${symbol}, fetching fresh...`);
    }
  }

  // 1. Try Twelve Data
  let candles = await fetchFromTwelveData(symbol, 5000);

  // 2. If Twelve Data fails, fallback to Yahoo Finance
  if (!candles || candles.length === 0) {
    console.log(`Twelve Data unavailable for ${symbol}. Falling back to Yahoo Finance...`);
    candles = await fetchFromYahooFinance(symbol);
  }

  if (candles && candles.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify(candles, null, 2), 'utf8');
    console.log(`Saved ${candles.length} candles to cache: ${cacheFile}`);
    return candles;
  }

  throw new Error(`Failed to load candles for ${symbol} from both Twelve Data and Yahoo Finance.`);
}

module.exports = {
  loadCandles,
  getCachePath
};

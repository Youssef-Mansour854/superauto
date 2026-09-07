const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function fetchExtendedYahoo(ticker, outFilename) {
  console.log(`[Extended Loader] Requesting 5m (range: 60d) for ${ticker}...`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=60d`;

  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    },
    timeout: 30000,
    validateStatus: () => true
  });

  if (res.status !== 200 || !res.data?.chart?.result?.[0]) {
    throw new Error(`Failed to fetch extended data for ${ticker}: HTTP ${res.status}`);
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
  const targetPath = path.join(DATA_DIR, outFilename);
  fs.writeFileSync(targetPath, JSON.stringify(candles, null, 2), 'utf8');
  console.log(`[Extended Loader] Successfully saved ${candles.length} candles to ${targetPath} (${candles[0]?.datetime} -> ${candles[candles.length - 1]?.datetime})`);
  return candles;
}

async function main() {
  await fetchExtendedYahoo('EURUSD=X', 'eur_usd_5m_extended.json');
  await fetchExtendedYahoo('GC=F', 'xau_usd_5m_extended.json');
  console.log('Done fetching extended datasets!');
}

main().catch(err => {
  console.error('Error fetching extended data:', err);
  process.exit(1);
});

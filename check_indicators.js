const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { EMA, RSI, ATR } = require('technicalindicators');

// Load .env
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

async function fetchLiveCandles(symbol, outputsize = 250) {
  const apiSymbol = normalizeTwelveDataSymbol(symbol);
  const apiKey = process.env.TWELVEDATA_API_KEY || 'demo';
  const url = 'https://api.twelvedata.com/time_series';

  console.log(`\n[DATA FETCH] Fetching live 5m candles for '${symbol}' (apiSymbol: '${apiSymbol}')...`);
  console.log(`             Using API Key: ${apiKey === 'demo' ? 'demo (Free demo tier)' : apiKey.substring(0, 5) + '...'}`);

  try {
    const response = await axios.get(url, {
      params: {
        symbol: apiSymbol,
        interval: '5min',
        outputsize,
        apikey: apiKey,
      },
      timeout: 15000,
      validateStatus: () => true
    });

    const status = response.status;
    const data = response.data;

    if (status !== 200 || data.status === 'error' || !data) {
      const errMsg = data?.message || (typeof data === 'string' ? data : `HTTP ${status}`);
      console.log(`[API RESPONSE] Twelve Data returned HTTP ${status}: ${errMsg}`);
      return { success: false, error: errMsg, status, candles: [] };
    }

    const symbolData = data.values ? data : (data[apiSymbol] || data[symbol]);
    if (!symbolData || !Array.isArray(symbolData.values) || symbolData.values.length === 0) {
      console.log(`[API RESPONSE] No candle values in response for '${symbol}'.`);
      return { success: false, error: 'No candle array returned', status, candles: [] };
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

        if (isNaN(close) || isNaN(openTime)) return null;

        return {
          datetime: item.datetime,
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

    // Reverse to chronological order (oldest first)
    candles.reverse();

    console.log(`[DATA FETCH] Successfully fetched ${candles.length} live candles for '${symbol}'.`);
    return { success: true, candles };
  } catch (err) {
    console.log(`[DATA FETCH] Network/unexpected error for '${symbol}': ${err.message}`);
    return { success: false, error: err.message, candles: [] };
  }
}

function calculateIndicators(symbol, candles) {
  if (!candles || candles.length < 100) {
    return {
      success: false,
      reason: `Insufficient candles (${candles ? candles.length : 0} available, minimum 100 required for EMA100)`
    };
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema100 = EMA.calculate({ period: 100, values: closes });
  const rsi14 = RSI.calculate({ period: 14, values: closes });
  const atr14 = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (ema20.length < 2 || ema100.length < 2 || rsi14.length < 2) {
    return {
      success: false,
      reason: 'Calculated indicator series contains fewer than 2 data points'
    };
  }

  // Latest 2 closed candles
  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  const currentClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  const currentEma20 = ema20[ema20.length - 1];
  const prevEma20 = ema20[ema20.length - 2];

  const currentEma100 = ema100[ema100.length - 1];
  const prevEma100 = ema100[ema100.length - 2];

  const currentRsi = rsi14[rsi14.length - 1];
  const prevRsi = rsi14[rsi14.length - 2];

  const currentAtr = atr14[atr14.length - 1];

  // Strategy Conditions (from app/api/scalp/route.ts):
  // 1. Trend Filter:
  //    - BUY: Close > EMA100 && Close > EMA20
  //    - SELL: Close < EMA100 && Close < EMA20
  const isBuyTrend = currentClose > currentEma100 && currentClose > currentEma20;
  const isSellTrend = currentClose < currentEma100 && currentClose < currentEma20;

  // 2. Momentum Trigger:
  //    - BUY Trigger: prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68
  //    - SELL Trigger: prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32
  const isBuyMomentum = prevRsi < 50 && currentRsi >= 50 && currentRsi <= 68;
  const isSellMomentum = prevRsi > 50 && currentRsi <= 50 && currentRsi >= 32;

  let signalVerdict = 'NO SIGNAL';
  const unmetReasons = [];

  if (isBuyTrend && isBuyMomentum) {
    signalVerdict = 'BUY SIGNAL TRIGGERED';
  } else if (isSellTrend && isSellMomentum) {
    signalVerdict = 'SELL SIGNAL TRIGGERED';
  } else {
    // Diagnose reasons
    if (!isBuyTrend && !isSellTrend) {
      unmetReasons.push(`Trend Neutral/Choppy: Close ($${currentClose.toFixed(2)}) is between EMA20 ($${currentEma20.toFixed(2)}) and EMA100 ($${currentEma100.toFixed(2)}).`);
    } else if (isBuyTrend) {
      if (prevRsi >= 50 && currentRsi >= 50) {
        unmetReasons.push(`No fresh upward RSI crossover: RSI was already above 50 on previous bar (${prevRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}). Must cross from <50 into [50, 68].`);
      } else if (currentRsi > 68) {
        unmetReasons.push(`Overbought protection: RSI is ${currentRsi.toFixed(2)} (> 68 ceiling).`);
      } else if (currentRsi < 50) {
        unmetReasons.push(`RSI below threshold: current RSI is ${currentRsi.toFixed(2)} (< 50).`);
      }
    } else if (isSellTrend) {
      if (prevRsi <= 50 && currentRsi <= 50) {
        unmetReasons.push(`No fresh downward RSI crossover: RSI was already below 50 on previous bar (${prevRsi.toFixed(2)} -> ${currentRsi.toFixed(2)}). Must cross from >50 into [32, 50].`);
      } else if (currentRsi < 32) {
        unmetReasons.push(`Oversold protection: RSI is ${currentRsi.toFixed(2)} (< 32 floor).`);
      } else if (currentRsi > 50) {
        unmetReasons.push(`RSI above threshold: current RSI is ${currentRsi.toFixed(2)} (> 50).`);
      }
    }
  }

  return {
    success: true,
    symbol,
    latestTime: currentCandle.datetime,
    prevTime: prevCandle.datetime,
    currentClose,
    prevClose,
    currentEma20,
    currentEma100,
    prevEma100,
    currentRsi,
    prevRsi,
    currentAtr,
    isBuyTrend,
    isSellTrend,
    isBuyMomentum,
    isSellMomentum,
    signalVerdict,
    unmetReasons
  };
}

function printAsciiTable(rows) {
  const headers = ['Symbol', 'Close Price', 'EMA(100)', 'EMA(20)', 'Prev RSI', 'Curr RSI', 'Trend Status', 'RSI Crossover', 'Verdict'];
  const keys = ['symbol', 'close', 'ema100', 'ema20', 'prevRsi', 'currRsi', 'trend', 'crossover', 'verdict'];

  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const r of rows) {
      const val = (r[keys[i]] || '').toString();
      if (val.length > max) max = val.length;
    }
    return max + 2;
  });

  const separator = '+' + colWidths.map(w => '-'.repeat(w)).join('+') + '+';

  console.log(separator);
  const headerLine = '|' + headers.map((h, i) => ' ' + h.padEnd(colWidths[i] - 1)).join('|') + '|';
  console.log(headerLine);
  console.log(separator);

  for (const r of rows) {
    const line = '|' + keys.map((k, i) => {
      const val = (r[k] || '').toString();
      return ' ' + val.padEnd(colWidths[i] - 1);
    }).join('|') + '|';
    console.log(line);
  }
  console.log(separator);
}

async function main() {
  console.log('================================================================================');
  console.log('            CHECK_INDICATORS: MATHEMATICAL DIAGNOSTIC FOR QQQ & XAU/USD         ');
  console.log('================================================================================');
  console.log(`Execution Timestamp: ${new Date().toISOString()}`);

  const targets = ['QQQ', 'XAU/USD'];
  const analyses = [];

  for (const sym of targets) {
    const fetchRes = await fetchLiveCandles(sym, 250);
    let candles = fetchRes.candles;
    let dataSource = 'Twelve Data Live API';

    // If API failed or returned 401 (e.g. Twelve Data demo key blocks Gold/XAU), fallback to cached historical dataset
    if (!fetchRes.success || candles.length < 100) {
      console.log(`\n[FALLBACK CHECK] Searching local cached dataset for '${sym}' to verify indicators...`);
      const candidates = [
        path.join(__dirname, 'data', `${sym.replace(/[\/\^=\-]/g, '_').toLowerCase()}_5m_extended.json`),
        path.join(__dirname, 'data', `${sym.replace(/[\/\^=\-]/g, '_').toLowerCase()}_5m.json`)
      ];

      for (const p of candidates) {
        if (fs.existsSync(p)) {
          try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(raw) && raw.length >= 100) {
              candles = raw;
              dataSource = `Local Cache (${path.basename(p)})`;
              console.log(`[FALLBACK SUCCESS] Loaded ${raw.length} 5m candles from ${path.basename(p)}`);
              break;
            }
          } catch (e) {}
        }
      }
    }

    if (candles && candles.length >= 100) {
      const result = calculateIndicators(sym, candles);
      result.dataSource = dataSource;
      result.apiLiveError = fetchRes.error || null;
      analyses.push(result);
    } else {
      analyses.push({
        success: false,
        symbol: sym,
        dataSource: 'None',
        error: fetchRes.error || 'No data could be retrieved from API or local cache.'
      });
    }
  }

  console.log('\n================================================================================');
  console.log('                         MATHEMATICAL INDICATORS TABLE                          ');
  console.log('================================================================================');

  const tableData = analyses.map((a) => {
    if (!a.success) {
      return {
        symbol: a.symbol,
        close: 'N/A',
        ema100: 'N/A',
        ema20: 'N/A',
        prevRsi: 'N/A',
        currRsi: 'N/A',
        trend: 'ERROR',
        crossover: 'ERROR',
        verdict: 'FETCH FAILED'
      };
    }

    let trendStr = 'NEUTRAL (MIXED)';
    if (a.isBuyTrend) trendStr = 'BULLISH (Close > EMA)';
    if (a.isSellTrend) trendStr = 'BEARISH (Close < EMA)';

    let crossStr = 'NO CROSSOVER';
    if (a.isBuyMomentum) crossStr = 'BULLISH CROSS';
    if (a.isSellMomentum) crossStr = 'BEARISH CROSS';

    return {
      symbol: a.symbol,
      close: `$${a.currentClose.toFixed(2)}`,
      ema100: `$${a.currentEma100.toFixed(2)}`,
      ema20: `$${a.currentEma20.toFixed(2)}`,
      prevRsi: a.prevRsi.toFixed(2),
      currRsi: a.currentRsi.toFixed(2),
      trend: trendStr,
      crossover: crossStr,
      verdict: a.signalVerdict
    };
  });

  printAsciiTable(tableData);

  console.log('\n================================================================================');
  console.log('                          DEEP MATHEMATICAL BREAKDOWN                           ');
  console.log('================================================================================');

  for (const a of analyses) {
    console.log(`\n--- Symbol: [${a.symbol}] ---`);
    console.log(`  * Data Source:           ${a.dataSource}`);
    if (a.apiLiveError) {
      console.log(`  * Live Twelve Data Note: ${a.apiLiveError}`);
    }

    if (!a.success) {
      console.log(`  * Status: FAILED - ${a.error || a.reason}`);
      continue;
    }

    console.log(`  * Bar [t-1] (Previous):  Time: ${a.prevTime} | Close: $${a.prevClose.toFixed(2)} | RSI(14): ${a.prevRsi.toFixed(2)}`);
    console.log(`  * Bar [t]   (Latest):    Time: ${a.latestTime} | Close: $${a.currentClose.toFixed(2)} | RSI(14): ${a.currentRsi.toFixed(2)}`);
    console.log(`  * EMA(100) on Bar [t]:   $${a.currentEma100.toFixed(3)} (Delta: $${(a.currentClose - a.currentEma100).toFixed(3)})`);
    console.log(`  * EMA(20)  on Bar [t]:   $${a.currentEma20.toFixed(3)} (Delta: $${(a.currentClose - a.currentEma20).toFixed(3)})`);
    console.log(`  * ATR(14)  on Bar [t]:   $${a.currentAtr.toFixed(3)}`);
    console.log(`  * Trend Shield Check:    ${a.isBuyTrend ? 'PASSED (BULLISH)' : (a.isSellTrend ? 'PASSED (BEARISH)' : 'FAILED (Price trapped between EMAs)')}`);
    console.log(`  * RSI Trigger Check:     ${a.isBuyMomentum || a.isSellMomentum ? 'PASSED (Fresh Cross into Zone)' : 'FAILED (No Fresh Crossover into Valid Zone)'}`);
    console.log(`  * Exact Unmet Reason(s):`);
    if (a.unmetReasons.length > 0) {
      a.unmetReasons.forEach((r) => console.log(`      -> ${r}`));
    } else {
      console.log(`      -> All conditions satisfied on this bar!`);
    }
  }

  console.log('\n================================================================================\n');
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});

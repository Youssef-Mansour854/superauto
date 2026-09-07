const { EMA, RSI, ATR } = require('technicalindicators');

/**
 * Default parameters matching app/api/scalp/route.ts
 */
const DEFAULT_CONFIG = {
  // Indicators
  emaFastPeriod: 20,
  emaSlowPeriod: 100,
  rsiPeriod: 14,
  atrPeriod: 14,

  // RSI Thresholds
  rsiBuyMin: 50,
  rsiBuyMax: 68,
  rsiSellMin: 32,
  rsiSellMax: 50,

  // SL / TP multipliers
  slAtrMultiplier: 1.5,
  tpAtrMultiplierForex: 2.0, // EUR/USD
  tpAtrMultiplierGold: 3.0,  // XAU/USD
  tpAtrMultiplierQQQ: 2.0,   // QQQ
  hardSlMultiplierGold: 3.0, // Hard stop on High/Low wick for Gold
  hardSlMultiplierQQQ: 2.5,  // Hard stop on High/Low wick for QQQ

  // Trade management
  breakevenThreshold: 0.5,   // Move SL to entry at 50% TP distance
  timeStopCandles: 24,       // 120 minutes / 5 = 24 candles
  weekendFilter: true,       // Skip Saturday/Sunday

  // Per-symbol Session Filter Configuration (Cairo time: Africa/Cairo / UTC+3)
  sessionFilters: {
    'EUR/USD': {
      enabled: true,            // Block Asian session 00:00 - 08:00 Cairo
      mode: 'BLOCK_BETWEEN',
      startHourCairo: 0,
      endHourCairo: 8,
      timezone: 'Africa/Cairo'
    },
    'XAU/USD': {
      enabled: false,           // 24 hours baseline for Gold
      mode: 'ALLOW_BETWEEN',
      startHourCairo: 0,
      endHourCairo: 24,
      timezone: 'Africa/Cairo'
    },
    'BTC/USD': {
      enabled: false,           // 24/7 baseline for Bitcoin
      mode: 'ALLOW_BETWEEN',
      startHourCairo: 0,
      endHourCairo: 24,
      timezone: 'Africa/Cairo'
    },
    'QQQ': {
      enabled: false,           // Disabled by default (US Session 16:30 - 23:00 Cairo)
      mode: 'ALLOW_BETWEEN',
      startHourCairo: 16.5,     // 16:30 Cairo (09:30 EST)
      endHourCairo: 23.0,       // 23:00 Cairo (16:00 EST)
      timezone: 'Africa/Cairo'
    },
    'IXIC': {
      enabled: false,           // Disabled by default (US Session 16:30 - 23:00 Cairo)
      mode: 'ALLOW_BETWEEN',
      startHourCairo: 16.5,     // 16:30 Cairo (09:30 EST)
      endHourCairo: 23.0,       // 23:00 Cairo (16:00 EST)
      timezone: 'Africa/Cairo'
    },
    'DJI': {
      enabled: false,           // Disabled by default (US Session 16:30 - 23:00 Cairo)
      mode: 'ALLOW_BETWEEN',
      startHourCairo: 16.5,     // 16:30 Cairo (09:30 EST)
      endHourCairo: 23.0,       // 23:00 Cairo (16:00 EST)
      timezone: 'Africa/Cairo'
    }
  },

  // Per-symbol Higher Timeframe (HTF) Trend Filter Configuration
  htfFilters: {
    'EUR/USD': {
      enabled: false,           // Toggle: true to enable HTF trend filter
      timeframe: '15m',         // '15m' or '1h'
      indicator: 'EMA',
      period: 50                // Period on HTF (e.g. 50 or 100)
    },
    'XAU/USD': {
      enabled: false,           // Gold left untouched
      timeframe: '15m',
      indicator: 'EMA',
      period: 50
    },
    'BTC/USD': {
      enabled: false            // Bitcoin left untouched
    },
    'QQQ': {
      enabled: false
    },
    'IXIC': {
      enabled: false
    },
    'DJI': {
      enabled: false
    }
  },

  // Global / fallback filters
  sessionFilter: null,
  htfFilter: null
};

function normalizeFilterSymbol(sym) {
  if (!sym) return '';
  const s = sym.toUpperCase().replace(/[-=^]/g, '');
  if (s.includes('EUR') && s.includes('USD')) return 'EUR/USD';
  if (s.includes('XAU') || s.includes('GOLD') || s.includes('GC')) return 'XAU/USD';
  if (s.includes('BTC')) return 'BTC/USD';
  if (s.includes('QQQ') || s.includes('IXIC') || s.includes('NAS') || s.includes('NDX')) return 'QQQ';
  if (s.includes('DJI') || s.includes('US30') || s.includes('DIA')) return 'DJI';
  return sym;
}

function isCryptoPair(symbol) {
  const s = (symbol || '').toUpperCase();
  return s.includes('BTC') || s.includes('ETH') || s.includes('SOL');
}

function getSessionFilter(symbol, config = DEFAULT_CONFIG) {
  if (config.sessionFilter && typeof config.sessionFilter.enabled === 'boolean') {
    return config.sessionFilter;
  }
  const norm = normalizeFilterSymbol(symbol);
  if (config.sessionFilters) {
    if (config.sessionFilters[norm]) return config.sessionFilters[norm];
    if (config.sessionFilters[symbol]) return config.sessionFilters[symbol];
  }
  return { enabled: false };
}

function getHtfFilter(symbol, config = DEFAULT_CONFIG) {
  if (config.htfFilter && typeof config.htfFilter.enabled === 'boolean') {
    return config.htfFilter;
  }
  const norm = normalizeFilterSymbol(symbol);
  if (config.htfFilters) {
    if (config.htfFilters[norm]) return config.htfFilters[norm];
    if (config.htfFilters[symbol]) return config.htfFilters[symbol];
  }
  return { enabled: false };
}

/**
 * Returns Cairo time as hour, minute, and decimalHour (e.g. 16:30 -> 16.5)
 */
function getCairoTime(timeMs) {
  const d = new Date(timeMs);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Cairo',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(d);
    let hour = 0;
    let minute = 0;
    for (const p of parts) {
      if (p.type === 'hour') hour = parseInt(p.value, 10);
      if (p.type === 'minute') minute = parseInt(p.value, 10);
    }
    return { hour, minute, decimalHour: hour + (minute / 60) };
  } catch (e) {
    const hour = (d.getUTCHours() + 3) % 24;
    const minute = d.getUTCMinutes();
    return { hour, minute, decimalHour: hour + (minute / 60) };
  }
}

function getCairoHour(timeMs) {
  return getCairoTime(timeMs).hour;
}

/**
 * Checks if a given timestamp is allowed by the session filter
 */
function isSessionAllowed(timeMs, filterConfig) {
  if (!filterConfig || !filterConfig.enabled) return true;

  const { decimalHour } = getCairoTime(timeMs);
  const mode = filterConfig.mode || 'ALLOW_BETWEEN';
  const start = filterConfig.startHourCairo !== undefined ? filterConfig.startHourCairo : 0;
  const end = filterConfig.endHourCairo !== undefined ? filterConfig.endHourCairo : 24;

  let isInside = false;
  if (start < end) {
    isInside = decimalHour >= start && decimalHour < end;
  } else {
    // Window spanning midnight (e.g. 22:00 to 06:00)
    isInside = decimalHour >= start || decimalHour < end;
  }

  if (mode === 'BLOCK_BETWEEN') {
    return !isInside;
  }

  return isInside;
}

function isForexPair(symbol) {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD') || s.includes('GC')) return false;
  if (s.includes('BTC') || s.includes('ETH') || s.includes('SOL')) return false;
  if (s.includes('QQQ') || s.includes('IXIC') || s.includes('DJI') || s.includes('NAS') || s.includes('US30')) return false;
  return true;
}

/**
 * Calculates all technical indicators across the full candle series
 */
function calculateIndicators(candles, config = DEFAULT_CONFIG) {
  if (!candles || candles.length < config.emaSlowPeriod) {
    return null;
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema20Values = EMA.calculate({ period: config.emaFastPeriod, values: closes });
  const ema100Values = EMA.calculate({ period: config.emaSlowPeriod, values: closes });
  const rsiValues = RSI.calculate({ period: config.rsiPeriod, values: closes });
  const atrValues = ATR.calculate({ period: config.atrPeriod, high: highs, low: lows, close: closes });

  // Map each candle index to its indicator values
  const indicatorMap = new Array(candles.length).fill(null);

  const ema20Offset = candles.length - ema20Values.length;
  const ema100Offset = candles.length - ema100Values.length;
  const rsiOffset = candles.length - rsiValues.length;
  const atrOffset = candles.length - atrValues.length;

  for (let i = 0; i < candles.length; i++) {
    const ema20Idx = i - ema20Offset;
    const ema100Idx = i - ema100Offset;
    const rsiIdx = i - rsiOffset;
    const atrIdx = i - atrOffset;

    if (ema20Idx >= 0 && ema100Idx >= 0 && rsiIdx >= 1 && atrIdx >= 0) {
      indicatorMap[i] = {
        close: closes[i],
        high: highs[i],
        low: lows[i],
        open: candles[i].open,
        time: candles[i].time,
        datetime: candles[i].datetime,
        ema20: ema20Values[ema20Idx],
        ema100: ema100Values[ema100Idx],
        rsi: rsiValues[rsiIdx],
        prevRsi: rsiValues[rsiIdx - 1],
        atr: atrValues[atrIdx]
      };
    }
  }

  return indicatorMap;
}

/**
 * Evaluates entry signal for candle at index `i`
 * Replicates app/api/scalp/route.ts lines 280-330
 */
function evaluateSignal(symbol, ind, config = DEFAULT_CONFIG, htfContext = null) {
  if (!ind) return null;

  // 1. Per-symbol Session Filter: Reject signal if outside allowed Cairo hours for this symbol
  const filter = getSessionFilter(symbol, config);
  if (filter && filter.enabled) {
    if (!isSessionAllowed(ind.time, filter)) {
      return null;
    }
  }

  // 2. Per-symbol Higher Timeframe (HTF) Trend Confirmation Filter
  const htfFilter = getHtfFilter(symbol, config);
  if (htfFilter && htfFilter.enabled) {
    if (!htfContext || !htfContext.trend || htfContext.trend === 'NEUTRAL') {
      return null;
    }
  }

  const { close, ema20, ema100, rsi, prevRsi, atr } = ind;
  const isForex = isForexPair(symbol);
  const normSym = normalizeFilterSymbol(symbol);
  const tpMultiplier = (normSym === 'QQQ' || normSym === 'IXIC') 
    ? (config.tpAtrMultiplierQQQ || 2.0) 
    : (isForex ? config.tpAtrMultiplierForex : config.tpAtrMultiplierGold);

  // Trend Rules:
  // BUY: close > ema100 && close > ema20
  // SELL: close < ema100 && close < ema20
  const isBuyTrend = close > ema100 && close > ema20;
  const isSellTrend = close < ema100 && close < ema20;

  // Momentum Trigger (RSI crossover):
  // BUY: prevRsi < 50 && rsi >= 50 && rsi <= 68
  // SELL: prevRsi > 50 && rsi <= 50 && rsi >= 32
  const isBuyMomentum = prevRsi < 50 && rsi >= config.rsiBuyMin && rsi <= config.rsiBuyMax;
  const isSellMomentum = prevRsi > 50 && rsi <= config.rsiSellMax && rsi >= config.rsiSellMin;

  if (isBuyTrend && isBuyMomentum) {
    // HTF Confirmation: Must be Bullish on HTF
    if (htfFilter && htfFilter.enabled && htfContext) {
      if (htfContext.trend !== 'BULLISH') {
        return null;
      }
    }

    const sl = close - (atr * config.slAtrMultiplier);
    const tp = close + (atr * tpMultiplier);
    return {
      action: 'BUY',
      symbol,
      entryPrice: close,
      sl,
      tp,
      originalSl: sl,
      atr,
      rsi,
      ema20,
      ema100,
      htfTrend: htfContext ? htfContext.trend : null
    };
  }

  if (isSellTrend && isSellMomentum) {
    // HTF Confirmation: Must be Bearish on HTF
    if (htfFilter && htfFilter.enabled && htfContext) {
      if (htfContext.trend !== 'BEARISH') {
        return null;
      }
    }

    const sl = close + (atr * config.slAtrMultiplier);
    const tp = close - (atr * tpMultiplier);
    return {
      action: 'SELL',
      symbol,
      entryPrice: close,
      sl,
      tp,
      originalSl: sl,
      atr,
      rsi,
      ema20,
      ema100,
      htfTrend: htfContext ? htfContext.trend : null
    };
  }

  return null;
}

/**
 * Evaluates active trade management on candle `c`
 * HYBRID SAFETY NET MODEL:
 * 1. Hard Catastrophic Stop (Wick on High/Low)
 * 2. Take Profit (Wick on High/Low)
 * 3. Soft Stop (Close Price): evaluated ONLY on candle CLOSE
 */
function evaluateTradeManagement(trade, currentCandle, candlesHeld, config = DEFAULT_CONFIG) {
  const currentPrice = currentCandle.close;
  const candleHigh = currentCandle.high !== undefined ? currentCandle.high : currentPrice;
  const candleLow = currentCandle.low !== undefined ? currentCandle.low : currentPrice;
  let closed = false;
  let status = null;
  let exitPrice = currentPrice;
  let exitReason = null;

  const normSym = normalizeFilterSymbol(trade.symbol);
  const hardSlMult = (normSym === 'QQQ' || normSym === 'IXIC') ? (config.hardSlMultiplierQQQ || 2.5) : (config.hardSlMultiplierGold || 3.0);
  const atrVal = trade.atr || Math.abs(trade.originalSl - trade.entryPrice) / (config.slAtrMultiplier || 1.5);
  const hardSl = trade.breakevenApplied ? trade.entryPrice : (trade.action === 'BUY' ? trade.entryPrice - (atrVal * hardSlMult) : trade.entryPrice + (atrVal * hardSlMult));

  // 1. Hybrid Exit Evaluation
  if (trade.action === 'BUY') {
    if (candleLow <= hardSl) {
      closed = true; status = 'LOSS'; exitPrice = hardSl; exitReason = 'HARD_SL_WICK';
    } else if (candleHigh >= trade.tp) {
      closed = true; status = 'WIN'; exitPrice = trade.tp; exitReason = 'TP';
    } else if (currentPrice <= trade.sl) {
      closed = true; status = trade.breakevenApplied ? 'BREAKEVEN' : 'LOSS'; exitPrice = trade.sl; exitReason = 'SOFT_SL_CLOSE';
    }
  } else if (trade.action === 'SELL') {
    if (candleHigh >= hardSl) {
      closed = true; status = 'LOSS'; exitPrice = hardSl; exitReason = 'HARD_SL_WICK';
    } else if (candleLow <= trade.tp) {
      closed = true; status = 'WIN'; exitPrice = trade.tp; exitReason = 'TP';
    } else if (currentPrice >= trade.sl) {
      closed = true; status = trade.breakevenApplied ? 'BREAKEVEN' : 'LOSS'; exitPrice = trade.sl; exitReason = 'SOFT_SL_CLOSE';
    }
  }

  if (closed) return { closed: true, status, exitPrice, exitReason, breakevenApplied: trade.breakevenApplied };

  // 2. Breakeven Logic (Move SL to Entry Price at >= 50% TP progress based on High/Low)
  if (!trade.breakevenApplied) {
    const tpDistance = Math.abs(trade.tp - trade.entryPrice);
    const beTriggerDist = tpDistance * (config.breakevenThresholdRatio || 0.5);
    if (trade.action === 'BUY' && candleHigh >= (trade.entryPrice + beTriggerDist)) {
      trade.sl = trade.entryPrice;
      trade.breakevenApplied = true;
    } else if (trade.action === 'SELL' && candleLow <= (trade.entryPrice - beTriggerDist)) {
      trade.sl = trade.entryPrice;
      trade.breakevenApplied = true;
    }
  }

  // 3. Smart Time Stop Logic (24 candles = 120 minutes: breakeven if in profit, close if in loss)
  if (candlesHeld >= (config.timeStopCandles || 24)) {
    const isProfit = trade.action === 'BUY'
      ? currentPrice > trade.entryPrice
      : currentPrice < trade.entryPrice;

    if (isProfit) {
      if (!trade.breakevenApplied || trade.sl !== trade.entryPrice) {
        trade.sl = trade.entryPrice;
        trade.breakevenApplied = true;
      }
    } else {
      // Floating in loss - close trade at current candle close
      return {
        closed: true,
        status: 'LOSS',
        exitPrice: currentPrice,
        exitReason: 'TIME_STOP_LOSS',
        breakevenApplied: trade.breakevenApplied
      };
    }
  }

  return {
    closed: false,
    trade
  };
}

module.exports = {
  DEFAULT_CONFIG,
  isForexPair,
  isCryptoPair,
  getCairoTime,
  getCairoHour,
  isSessionAllowed,
  getSessionFilter,
  getHtfFilter,
  calculateIndicators,
  evaluateSignal,
  evaluateTradeManagement
};

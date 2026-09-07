const path = require('path');
const fs = require('fs');
const { EMA } = require('technicalindicators');
const {
  DEFAULT_CONFIG,
  isForexPair,
  isCryptoPair,
  calculateIndicators,
  evaluateSignal,
  evaluateTradeManagement,
  getHtfFilter
} = require('./strategy');

function runBacktest(symbol, candles, userConfig = {}, htfCandlesMap = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  if (!candles || candles.length < config.emaSlowPeriod + 10) {
    throw new Error(`Insufficient candles (${candles?.length || 0}) for backtesting ${symbol}.`);
  }

  // Pre-calculate indicators across all candles
  const indicatorMap = calculateIndicators(candles, config);
  if (!indicatorMap) {
    throw new Error(`Indicator calculation failed for ${symbol}.`);
  }

  // 1. Prepare Higher Timeframe (HTF) trend series if enabled
  const htfFilter = getHtfFilter(symbol, config);
  let htfPoints = null;
  let htfDurationMs = 900000; // 15m default

  if (htfFilter && htfFilter.enabled) {
    const tf = htfFilter.timeframe || '15m';
    htfDurationMs = tf === '1h' ? 3600000 : 900000;

    let htfCandles = htfCandlesMap[tf];
    if (!htfCandles) {
      const cleanSymbol = symbol.replace(/[\/\^=\-]/g, '_').toLowerCase();
      const cachePath = path.join(__dirname, '..', 'data', `${cleanSymbol}_${tf}.json`);
      if (fs.existsSync(cachePath)) {
        htfCandles = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    }

    if (htfCandles && htfCandles.length > (htfFilter.period || 50)) {
      const htfCloses = htfCandles.map(c => c.close);
      const htfEma = EMA.calculate({ period: htfFilter.period || 50, values: htfCloses });
      const htfOffset = htfCandles.length - htfEma.length;

      htfPoints = [];
      for (let j = 0; j < htfCandles.length; j++) {
        const emaIdx = j - htfOffset;
        if (emaIdx >= 0) {
          const closeTime = htfCandles[j].time + htfDurationMs;
          const closePrice = htfCandles[j].close;
          const emaVal = htfEma[emaIdx];
          const trend = closePrice > emaVal ? 'BULLISH' : (closePrice < emaVal ? 'BEARISH' : 'NEUTRAL');
          htfPoints.push({
            openTime: htfCandles[j].time,
            closeTime,
            closePrice,
            emaVal,
            trend
          });
        }
      }
      htfPoints.sort((a, b) => a.closeTime - b.closeTime);
    }
  }

  const isForex = isForexPair(symbol);
  const trades = [];
  let activeTrade = null;
  let candlesHeld = 0;
  let htfIdx = 0;

  // Start from candle where indicators are valid
  const startIndex = config.emaSlowPeriod + 5;

  const startTimeMs = config.startDate ? new Date(config.startDate).getTime() : (config.startTime || null);
  const endTimeMs = config.endDate ? new Date(config.endDate).getTime() : (config.endTime || null);

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    const ind = indicatorMap[i];

    // Weekend Guard (UTC Day 0 = Sunday, 6 = Saturday)
    // Crypto pairs trade 24/7, so weekendFilter applies only to non-crypto (Forex, Metals, Indices)
    if (config.weekendFilter && !isCryptoPair(symbol)) {
      const utcDay = new Date(candle.time).getUTCDay();
      if (utcDay === 0 || utcDay === 6) {
        continue;
      }
    }

    // 1. Evaluate Active Trade if one exists
    if (activeTrade) {
      candlesHeld++;
      const result = evaluateTradeManagement(activeTrade, candle, candlesHeld, config);

      if (result.closed) {
        // Trade closed on this candle
        const pnl = activeTrade.action === 'BUY'
          ? (result.exitPrice - activeTrade.entryPrice)
          : (activeTrade.entryPrice - result.exitPrice);

        const pnlPoints = isForex ? (pnl / 0.0001) : pnl;

        const entryDate = new Date(activeTrade.entryTime);
        const exitDate = new Date(candle.time);

        trades.push({
          id: trades.length + 1,
          symbol,
          action: activeTrade.action,
          entryPrice: Number(activeTrade.entryPrice.toFixed(isForex ? 5 : 2)),
          exitPrice: Number(result.exitPrice.toFixed(isForex ? 5 : 2)),
          sl: Number(activeTrade.originalSl.toFixed(isForex ? 5 : 2)),
          finalSl: Number(activeTrade.sl.toFixed(isForex ? 5 : 2)),
          tp: Number(activeTrade.tp.toFixed(isForex ? 5 : 2)),
          status: result.status === 'WIN' ? 'WIN' : 'LOSS',
          rawStatus: result.status,
          exitReason: result.exitReason,
          breakevenApplied: activeTrade.breakevenApplied,
          pnl: Number(pnl.toFixed(5)),
          pnlPoints: Number(pnlPoints.toFixed(2)),
          entryTime: entryDate.toISOString(),
          exitTime: exitDate.toISOString(),
          durationMinutes: candlesHeld * 5,
          hourUtc: entryDate.getUTCHours(),
          hourEgypt: (entryDate.getUTCHours() + 3) % 24,
          dayOfWeek: entryDate.getUTCDay(), // 1 = Mon, 5 = Fri
          rsiAtEntry: Number(activeTrade.rsi.toFixed(2)),
          atrAtEntry: Number(activeTrade.atr.toFixed(isForex ? 5 : 2))
        });

        activeTrade = null;
        candlesHeld = 0;
      } else {
        // Trade is still open, keep updated state
        activeTrade = result.trade;
      }
    }

    // 2. If no active trade, look for new signal on candle close (within date window)
    const inDateWindow = (!startTimeMs || candle.time >= startTimeMs) &&
                         (!endTimeMs || candle.time <= endTimeMs);

    if (!activeTrade && ind && inDateWindow) {
      let htfContext = null;
      if (htfPoints && htfPoints.length > 0) {
        const candleCloseTime = candle.time + 300000; // 5min candle close
        while (htfIdx + 1 < htfPoints.length && htfPoints[htfIdx + 1].closeTime <= candleCloseTime) {
          htfIdx++;
        }
        if (htfPoints[htfIdx] && htfPoints[htfIdx].closeTime <= candleCloseTime) {
          htfContext = htfPoints[htfIdx];
        }
      }

      const signal = evaluateSignal(symbol, ind, config, htfContext);
      if (signal) {
        activeTrade = {
          symbol,
          action: signal.action,
          entryPrice: signal.entryPrice,
          sl: signal.sl,
          tp: signal.tp,
          originalSl: signal.originalSl,
          atr: signal.atr,
          rsi: signal.rsi,
          ema20: signal.ema20,
          ema100: signal.ema100,
          entryTime: candle.time,
          entryIndex: i,
          breakevenApplied: false
        };
        candlesHeld = 0;
      }
    }
  }

  // Compile Comprehensive Statistics
  return compileStats(symbol, trades, candles, isForex, config);
}

function compileStats(symbol, trades, candles, isForex, config = {}) {
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.status === 'WIN');
  const losses = trades.filter(t => t.status === 'LOSS');

  const winCount = wins.length;
  const lossCount = losses.length;
  const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;

  const totalPoints = trades.reduce((acc, t) => acc + t.pnlPoints, 0);
  const grossWinPoints = wins.reduce((acc, t) => acc + t.pnlPoints, 0);
  const grossLossPoints = Math.abs(losses.reduce((acc, t) => acc + t.pnlPoints, 0));

  const profitFactor = grossLossPoints > 0 ? (grossWinPoints / grossLossPoints) : (grossWinPoints > 0 ? 999 : 0);
  const avgWin = winCount > 0 ? (grossWinPoints / winCount) : 0;
  const avgLoss = lossCount > 0 ? (grossLossPoints / lossCount) : 0;
  const rewardRiskRealized = avgLoss > 0 ? (avgWin / avgLoss) : 0;

  // Max Drawdown calculation (in points)
  let peak = 0;
  let currentCum = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    currentCum += t.pnlPoints;
    if (currentCum > peak) peak = currentCum;
    const dd = peak - currentCum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Exit reasons breakdown
  const byExitReason = {};
  trades.forEach(t => {
    byExitReason[t.exitReason] = (byExitReason[t.exitReason] || 0) + 1;
  });

  // Hour-of-Day distribution (UTC & Egypt UTC+3)
  const byHour = {};
  for (let h = 0; h < 24; h++) {
    byHour[h] = {
      hourUtc: h,
      hourEgypt: (h + 3) % 24,
      total: 0,
      wins: 0,
      losses: 0,
      netPoints: 0
    };
  }

  trades.forEach(t => {
    const h = t.hourUtc;
    byHour[h].total++;
    if (t.status === 'WIN') byHour[h].wins++;
    else byHour[h].losses++;
    byHour[h].netPoints += t.pnlPoints;
  });

  for (let h = 0; h < 24; h++) {
    byHour[h].netPoints = Number(byHour[h].netPoints.toFixed(2));
    byHour[h].winRate = byHour[h].total > 0 ? Number(((byHour[h].wins / byHour[h].total) * 100).toFixed(1)) : 0;
  }

  // Day-of-Week distribution (0 = Sun, 6 = Sat)
  const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const byDay = {};
  for (let d = 0; d <= 6; d++) {
    byDay[d] = {
      dayIndex: d,
      dayName: dayNames[d],
      total: 0,
      wins: 0,
      losses: 0,
      netPoints: 0
    };
  }

  trades.forEach(t => {
    const d = t.dayOfWeek;
    if (byDay[d]) {
      byDay[d].total++;
      if (t.status === 'WIN') byDay[d].wins++;
      else byDay[d].losses++;
      byDay[d].netPoints += t.pnlPoints;
    }
  });

  for (let d = 0; d <= 6; d++) {
    byDay[d].netPoints = Number(byDay[d].netPoints.toFixed(2));
    byDay[d].winRate = byDay[d].total > 0 ? Number(((byDay[d].wins / byDay[d].total) * 100).toFixed(1)) : 0;
  }

  const startDate = config.startDate || candles[0]?.datetime || 'N/A';
  const endDate = config.endDate || candles[candles.length - 1]?.datetime || 'N/A';

  return {
    symbol,
    period: {
      start: startDate,
      end: endDate,
      candlesCount: candles.length
    },
    unit: isForex ? 'Pips' : '$',
    metrics: {
      totalTrades,
      winCount,
      lossCount,
      winRate: Number(winRate.toFixed(1)),
      netPoints: Number(totalPoints.toFixed(2)),
      grossWinPoints: Number(grossWinPoints.toFixed(2)),
      grossLossPoints: Number(grossLossPoints.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      rewardRiskRealized: Number(rewardRiskRealized.toFixed(2)),
      maxDrawdown: Number(maxDrawdown.toFixed(2))
    },
    byExitReason,
    byHour,
    byDay,
    trades
  };
}

module.exports = {
  runBacktest
};

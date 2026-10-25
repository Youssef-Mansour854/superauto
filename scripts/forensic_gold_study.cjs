const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Read .env
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(line => {
    const parts = line.trim().split('=');
    const key = parts[0]?.trim();
    const val = parts.slice(1).join('=').trim();
    if (key && !key.startsWith('#') && val) {
      process.env[key] = val;
    }
  });
}

function computeTradePnL(t) {
  if (typeof t.netPnLUSD === 'number' && !isNaN(t.netPnLUSD) && t.netPnLUSD !== 0) {
    return t.netPnLUSD;
  }
  if (typeof t.pnlUSD === 'number' && !isNaN(t.pnlUSD) && t.pnlUSD !== 0) {
    return t.pnlUSD;
  }
  if (t.entryPrice && t.exitPrice) {
    const lot = t.suggestedLotSize || 0.01;
    const diff = t.action === 'BUY' ? (t.exitPrice - t.entryPrice) : (t.entryPrice - t.exitPrice);
    return Number((diff * lot * 100).toFixed(2));
  }
  return 0;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const rawTrades = await db.collection('trade_history').find({ symbol: 'XAU/USD' }).sort({ entryTimestamp: 1 }).toArray();
  console.log(`Analyzing ${rawTrades.length} gold trades...`);

  const trades = rawTrades.map(t => {
    const pnl = computeTradePnL(t);
    const entryDate = new Date(t.entryTimestamp || t.closedAt);
    const closeDate = t.closedAt ? new Date(t.closedAt) : null;
    const cairoH = (entryDate.getUTCHours() + 3) % 24;
    const dayIdx = entryDate.getUTCDay(); // 0 Sun, 1 Mon, 2 Tue, 3 Wed, 4 Thu, 5 Fri, 6 Sat
    const durationMin = closeDate ? Math.round((closeDate.getTime() - entryDate.getTime()) / 60000) : null;
    const emaDist = (typeof t.entryPrice === 'number' && typeof t.ema20 === 'number') ? (t.entryPrice - t.ema20) : null;
    const isAboveEma200 = (typeof t.entryPrice === 'number' && typeof t.ema200 === 'number') ? (t.entryPrice > t.ema200) : null;
    const trendAligned = (t.action === 'BUY' && isAboveEma200 === true) || (t.action === 'SELL' && isAboveEma200 === false);

    return {
      ...t,
      pnl,
      entryDate,
      closeDate,
      cairoH,
      dayIdx,
      durationMin,
      emaDist,
      isAboveEma200,
      trendAligned
    };
  });

  // 1. THURSDAY DEEP DIVE (DayIdx = 4)
  const thuTrades = trades.filter(t => t.dayIdx === 4);
  console.log('\n=============================================================');
  console.log(`🔍 تشريح يوم الخميس بالتفصيل (إجمالي ${thuTrades.length} صفقة):`);
  console.log('=============================================================');

  const thuSessions = {
    asian: { name: 'آسيا (00:00 - 08:59)', total: 0, wins: 0, pnl: 0 },
    london: { name: 'لندن (09:00 - 14:59)', total: 0, wins: 0, pnl: 0 },
    newYork: { name: 'نيويورك (15:00 - 21:59)', total: 0, wins: 0, pnl: 0 },
    late: { name: 'متأخر (22:00 - 23:59)', total: 0, wins: 0, pnl: 0 }
  };

  const thuHours = {};
  for (let i = 0; i < 24; i++) thuHours[i] = { total: 0, wins: 0, pnl: 0 };

  const thuAction = {
    BUY: { total: 0, wins: 0, pnl: 0 },
    SELL: { total: 0, wins: 0, pnl: 0 }
  };

  thuTrades.forEach(t => {
    let sKey = 'asian';
    if (t.cairoH >= 9 && t.cairoH < 15) sKey = 'london';
    else if (t.cairoH >= 15 && t.cairoH < 22) sKey = 'newYork';
    else if (t.cairoH >= 22) sKey = 'late';

    thuSessions[sKey].total++;
    thuSessions[sKey].pnl += t.pnl;
    if (t.status === 'WIN') thuSessions[sKey].wins++;

    thuHours[t.cairoH].total++;
    thuHours[t.cairoH].pnl += t.pnl;
    if (t.status === 'WIN') thuHours[t.cairoH].wins++;

    if (t.action === 'BUY' || t.action === 'SELL') {
      thuAction[t.action].total++;
      thuAction[t.action].pnl += t.pnl;
      if (t.status === 'WIN') thuAction[t.action].wins++;
    }
  });

  console.log('\n--- جلسات يوم الخميس:');
  Object.values(thuSessions).forEach(s => {
    const wr = s.total ? ((s.wins / s.total) * 100).toFixed(1) : 0;
    console.log(`* ${s.name}: ${s.total} صفقة | فوز: ${wr}% | صافي: $${s.pnl.toFixed(2)}`);
  });

  console.log('\n--- ساعات يوم الخميس (بتوقيت القاهرة):');
  Object.entries(thuHours).forEach(([h, s]) => {
    if (s.total > 0) {
      const wr = ((s.wins / s.total) * 100).toFixed(1);
      console.log(`Hour ${h.padStart(2, '0')}:00 -> ${s.total} صفقات | فوز: ${wr}% | ربح: $${s.pnl.toFixed(2)}`);
    }
  });

  console.log('\n--- اتجاه صفقات يوم الخميس (BUY vs SELL):');
  console.log(`* BUY: ${thuAction.BUY.total} صفقات | فوز: ${thuAction.BUY.total ? ((thuAction.BUY.wins/thuAction.BUY.total)*100).toFixed(1) : 0}% | ربح: $${thuAction.BUY.pnl.toFixed(2)}`);
  console.log(`* SELL: ${thuAction.SELL.total} صفقات | فوز: ${thuAction.SELL.total ? ((thuAction.SELL.wins/thuAction.SELL.total)*100).toFixed(1) : 0}% | ربح: $${thuAction.SELL.pnl.toFixed(2)}`);

  // 2. OVERALL HOURLY BREAKDOWN FOR ALL 349 TRADES
  console.log('\n=============================================================');
  console.log('🕒 تفصيل الساعات الذهبية والساعات القاتلة (لكامل الـ 349 صفقة):');
  console.log('=============================================================');
  const allHours = {};
  for (let i = 0; i < 24; i++) allHours[i] = { total: 0, wins: 0, pnl: 0 };
  trades.forEach(t => {
    allHours[t.cairoH].total++;
    allHours[t.cairoH].pnl += t.pnl;
    if (t.status === 'WIN') allHours[t.cairoH].wins++;
  });

  console.log('Hour (Cairo) | Trades | Win Rate | Net PnL');
  console.log('-------------------------------------------');
  for (let h = 0; h < 24; h++) {
    const it = allHours[h];
    if (it.total > 0) {
      const wr = ((it.wins / it.total) * 100).toFixed(1);
      console.log(`  ${h.toString().padStart(2, '0')}:00       |   ${it.total.toString().padStart(2, ' ')}   |   ${wr.padStart(5, ' ')}% |  $${it.pnl.toFixed(2)}`);
    }
  }

  // 3. TREND ALIGNMENT (EMA200)
  console.log('\n=============================================================');
  console.log('📈 تأثير التوافق مع الاتجاه العام (EMA200):');
  console.log('=============================================================');
  const trendAlignedTrades = trades.filter(t => t.trendAligned === true);
  const counterTrendTrades = trades.filter(t => t.trendAligned === false);

  const calcStats = (arr) => {
    const total = arr.length;
    const wins = arr.filter(t => t.status === 'WIN').length;
    const pnl = arr.reduce((acc, t) => acc + t.pnl, 0);
    const wr = total ? ((wins / total) * 100).toFixed(1) : 0;
    return { total, wins, pnl: pnl.toFixed(2), wr: wr + '%' };
  };

  console.log('مع الاتجاه (شراء فوق EMA200 أو بيع تحت EMA200):', calcStats(trendAlignedTrades));
  console.log('عكس الاتجاه (شراء تحت EMA200 أو بيع فوق EMA200):', calcStats(counterTrendTrades));

  // 4. VOLATILITY / ATR REGIMES
  console.log('\n=============================================================');
  console.log('⚡ تأثير حجم التذبذب (ATR 14):');
  console.log('=============================================================');
  const atrBrackets = {
    'منخفض (ATR < 4.0)': trades.filter(t => t.atr && t.atr < 4.0),
    'متوسط (ATR 4.0 - 6.0)': trades.filter(t => t.atr && t.atr >= 4.0 && t.atr <= 6.0),
    'عالي جداً (ATR > 6.0)': trades.filter(t => t.atr && t.atr > 6.0),
  };
  Object.entries(atrBrackets).forEach(([k, arr]) => {
    console.log(`* ${k}:`, calcStats(arr));
  });

  // 5. DISTANCE FROM EMA20 (Entry Timing)
  console.log('\n=============================================================');
  console.log('🎯 توقيت الدخول وبعد السعر عن EMA20:');
  console.log('=============================================================');
  const nearEma = trades.filter(t => t.emaDist !== null && Math.abs(t.emaDist) <= (t.atr ? t.atr * 0.5 : 2.5));
  const farEma = trades.filter(t => t.emaDist !== null && Math.abs(t.emaDist) > (t.atr ? t.atr * 0.5 : 2.5));
  console.log('دخول قريب من EMA20 (ارتداد مثالي <= 0.5 ATR):', calcStats(nearEma));
  console.log('دخول بعيد عن EMA20 (مطاردة سعر > 0.5 ATR):', calcStats(farEma));

  // 6. DURATION ANALYSIS
  console.log('\n=============================================================');
  console.log('⏱️ مدة بقاء الصفقة (Trade Duration in Minutes):');
  console.log('=============================================================');
  const winDurations = trades.filter(t => t.status === 'WIN' && t.durationMin !== null).map(t => t.durationMin);
  const lossDurations = trades.filter(t => t.status === 'LOSS' && t.durationMin !== null).map(t => t.durationMin);
  const avgWinDur = winDurations.length ? (winDurations.reduce((a, b) => a + b, 0) / winDurations.length).toFixed(1) : 0;
  const avgLossDur = lossDurations.length ? (lossDurations.reduce((a, b) => a + b, 0) / lossDurations.length).toFixed(1) : 0;
  console.log(`متوسط مدة الصفقات الرابحة: ${avgWinDur} دقيقة`);
  console.log(`متوسط مدة الصفقات الخاسرة: ${avgLossDur} دقيقة`);

  await mongoose.disconnect();
}

run();

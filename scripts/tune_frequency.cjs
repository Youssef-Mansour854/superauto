const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

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
  if (typeof t.netPnLUSD === 'number' && !isNaN(t.netPnLUSD) && t.netPnLUSD !== 0) return t.netPnLUSD;
  if (typeof t.pnlUSD === 'number' && !isNaN(t.pnlUSD) && t.pnlUSD !== 0) return t.pnlUSD;
  if (t.entryPrice && t.exitPrice) {
    const lot = t.suggestedLotSize || 0.01;
    const diff = t.action === 'BUY' ? (t.exitPrice - t.entryPrice) : (t.entryPrice - t.exitPrice);
    return Number((diff * lot * 100).toFixed(2));
  }
  return 0;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const rawTrades = await db.collection('trade_history').find({ symbol: 'XAU/USD' }).sort({ entryTimestamp: 1 }).toArray();

  const trades = rawTrades.map(t => {
    const pnl = computeTradePnL(t);
    const entryDate = new Date(t.entryTimestamp || t.closedAt);
    const cairoH = (entryDate.getUTCHours() + 3) % 24;
    const cairoM = entryDate.getUTCMinutes();
    const dayIdx = entryDate.getUTCDay();
    const dStr = entryDate.toISOString().slice(0, 10);
    return { ...t, pnl, cairoH, cairoM, dayIdx, dStr };
  });

  const runTest = (config) => {
    let accepted = [];
    trades.forEach(t => {
      if (config.banFriday && t.dayIdx === 5) return;
      if (config.thuCutoff && t.dayIdx === 4) {
        if (t.cairoH > config.thuHour || (t.cairoH === config.thuHour && t.cairoM >= config.thuMin)) {
          if (!(config.allowThu18 && t.cairoH === 18)) return;
        }
      }
      if (config.toxicHours.includes(t.cairoH)) return;
      
      const emaTrend = t.ema100 || t.ema200;
      if (config.checkTrend && typeof emaTrend === 'number' && emaTrend > 0) {
        if (t.action === 'BUY' && t.entryPrice < emaTrend) return;
        if (t.action === 'SELL' && t.entryPrice > emaTrend) return;
      }

      if (typeof t.ema20 === 'number' && typeof t.atr === 'number' && t.atr > 0) {
        if (Math.abs(t.entryPrice - t.ema20) > (t.atr * config.maxEmaDist)) return;
      }

      if (typeof t.atr === 'number' && t.atr > config.maxAtr) return;

      if (typeof t.rsi === 'number') {
        if (t.action === 'BUY' && (t.rsi < config.buyRsiMin || t.rsi > config.buyRsiMax)) return;
        if (t.action === 'SELL' && (t.rsi > config.sellRsiMax || t.rsi < config.sellRsiMin)) return;
      }

      accepted.push(t);
    });

    const activeDays = new Set(accepted.map(t => t.dStr)).size;
    const avgPerDay = (accepted.length / (activeDays || 1)).toFixed(1);
    const wins = accepted.filter(t => t.status === 'WIN').length;
    const wr = ((wins / accepted.length) * 100).toFixed(1);
    
    let grossWins = 0, grossLosses = 0;
    accepted.forEach(t => {
      let pnl = t.pnl;
      if (t.status === 'BREAKEVEN') pnl = Math.max(pnl, 4.0);
      if (pnl > 0) grossWins += pnl;
      else grossLosses += Math.abs(pnl);
    });
    const pf = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : 99;
    const net = (grossWins - grossLosses).toFixed(2);

    return { total: accepted.length, activeDays, avgPerDay, wr, pf, net };
  };

  const variations = [
    { label: '1. الوضع الحالي V2 (Strict)', banFriday: true, thuCutoff: true, thuHour: 14, thuMin: 30, allowThu18: false, toxicHours: [9, 20, 21], checkTrend: true, maxEmaDist: 0.65, maxAtr: 6.5, buyRsiMin: 48, buyRsiMax: 62, sellRsiMin: 36, sellRsiMax: 55 },
    { label: '2. تعديل مسافة EMA20 إلى 0.85x ATR', banFriday: true, thuCutoff: true, thuHour: 14, thuMin: 30, allowThu18: false, toxicHours: [9, 20, 21], checkTrend: true, maxEmaDist: 0.85, maxAtr: 6.8, buyRsiMin: 46, buyRsiMax: 63, sellRsiMin: 36, sellRsiMax: 55 },
    { label: '3. توسيع نطاق RSI (45-64) + مسافة 0.85x', banFriday: true, thuCutoff: true, thuHour: 14, thuMin: 30, allowThu18: true, toxicHours: [9, 20, 21], checkTrend: true, maxEmaDist: 0.85, maxAtr: 7.0, buyRsiMin: 45, buyRsiMax: 64, sellRsiMin: 35, sellRsiMax: 56 },
    { label: '4. استهداف متوسط 6 صفقات باليوم (EMA 0.90x + رفع حظر الساعة 21:00)', banFriday: true, thuCutoff: true, thuHour: 14, thuMin: 30, allowThu18: true, toxicHours: [9, 20], checkTrend: true, maxEmaDist: 0.90, maxAtr: 7.0, buyRsiMin: 44, buyRsiMax: 65, sellRsiMin: 35, sellRsiMax: 58 },
    { label: '5. المعايرة الذهبية لـ 6 صفقات بدقة فائقة (EMA 0.85x + RSI 44-64 + الساعة 21:00 المربحة)', banFriday: true, thuCutoff: true, thuHour: 14, thuMin: 30, allowThu18: true, toxicHours: [9, 20], checkTrend: true, maxEmaDist: 0.85, maxAtr: 7.0, buyRsiMin: 44, buyRsiMax: 64, sellRsiMin: 35, sellRsiMax: 57 }
  ];

  variations.forEach(v => {
    const res = runTest(v);
    console.log(`[${v.label}]`);
    console.log(`  -> إجمالي الصفقات: ${res.total} | أيام التداول: ${res.activeDays} | المتوسط اليومي: ${res.avgPerDay} صفقة/يوم | نسبة الفوز: ${res.wr}% | معامل الربح: ${res.pf} | صافي الأرباح: $${res.net}\n`);
  });

  await mongoose.disconnect();
}
main();

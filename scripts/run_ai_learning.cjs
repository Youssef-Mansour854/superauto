const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');

// 1. Load environment variables from .env
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

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const MONGODB_URI = process.env.MONGODB_URI;

// Calculation helper for Gold PnL (0.01 lot = 1 oz, tick value $1 per $0.01 or standard 100 multiplier)
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
  console.log('\n=============================================================');
  console.log('🤖 محرك دراسة وتحليل صفقات الذهب الشاملة بالذكاء الاصطناعي (XAU/USD)');
  console.log('=============================================================\n');

  let trades = [];
  let mongoConnected = false;

  // 1. Connect to MongoDB and pull ALL Gold trades from trade_history
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      mongoConnected = true;
      console.log('✅ تم الاتصال بقاعدة بيانات MongoDB بنجاح.');

      const db = mongoose.connection.db;

      // Query from dedicated trade_history collection
      const histCursor = await db.collection('trade_history').find({
        symbol: 'XAU/USD'
      }).sort({ entryTimestamp: 1, closedAt: 1 }).toArray();

      console.log(`📊 تم العثور على ${histCursor.length} صفقة ذهب في سجل trade_history الحي في MongoDB.`);

      histCursor.forEach((t) => {
        const pnl = computeTradePnL(t);
        trades.push({
          id: t.tradeId || t._id.toString(),
          symbol: 'XAU/USD',
          action: t.action,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          sl: t.sl,
          tp: t.tp,
          status: t.status,
          pnlUSD: pnl,
          netPnLUSD: pnl,
          rsi: t.rsi,
          ema20: t.ema20,
          ema100: t.ema100 || t.ema200,
          atr: t.atr,
          openedAt: t.entryTimestamp || t.closedAt,
          closedAt: t.closedAt,
        });
      });

    } catch (err) {
      console.warn('⚠️ تعذر سحب البيانات من MongoDB:', err.message);
    }
  }

  // 2. Fallback to historical JSON file if MongoDB had 0 trades
  if (trades.length === 0) {
    const goldFilePath = path.resolve(__dirname, '../gold_trades_september_08_to_present.json');
    if (fs.existsSync(goldFilePath)) {
      try {
        const fileTrades = JSON.parse(fs.readFileSync(goldFilePath, 'utf8'));
        console.log(`📁 تم تحميل ${fileTrades.length} صفقة تاريخية مسجلة للذهب من ملف JSON.`);
        trades = fileTrades.map(t => ({
          symbol: 'XAU/USD',
          action: t.Action,
          entryPrice: t.EntryPrice,
          exitPrice: t.ExitPrice,
          sl: t.StopLoss,
          tp: t.TakeProfit,
          status: t.Status,
          pnlUSD: t.PnL_USD,
          netPnLUSD: t.PnL_USD,
          openedAt: t.OpenedAt_UTC,
          closedAt: t.ClosedAt_UTC,
          durationMin: t.Duration_Min
        }));
      } catch (e) {
        console.error('تحذير: تعذر قراءة ملف الصفقات التاريخية:', e.message);
      }
    }
  }

  if (trades.length === 0) {
    console.error('❌ لم يتم العثور على أي صفقات ذهب لتحليلها.');
    process.exit(1);
  }

  // Filter strictly for Gold
  trades = trades.filter(t => t.symbol === 'XAU/USD');

  console.log(`\n⏳ جاري تحليل وتصنيف إجمالي صفقات الذهب الحقيقية (${trades.length} صفقة)...`);

  let totalWins = 0;
  let totalLosses = 0;
  let totalBreakeven = 0;
  let netPnL = 0;
  let grossWins = 0;
  let grossLosses = 0;

  const sessions = {
    asian: { name: 'جلسة آسيا (00:00 - 08:59)', total: 0, wins: 0, losses: 0, pnl: 0 },
    london: { name: 'جلسة لندن (09:00 - 14:59)', total: 0, wins: 0, losses: 0, pnl: 0 },
    newYork: { name: 'جلسة نيويورك (15:00 - 21:59)', total: 0, wins: 0, losses: 0, pnl: 0 },
    lateNight: { name: 'جلسة متأخرة (22:00 - 23:59)', total: 0, wins: 0, losses: 0, pnl: 0 }
  };

  const days = {
    0: { name: 'الأحد', total: 0, wins: 0, losses: 0, pnl: 0 },
    1: { name: 'الاثنين', total: 0, wins: 0, losses: 0, pnl: 0 },
    2: { name: 'الثلاثاء', total: 0, wins: 0, losses: 0, pnl: 0 },
    3: { name: 'الأربعاء', total: 0, wins: 0, losses: 0, pnl: 0 },
    4: { name: 'الخميس', total: 0, wins: 0, losses: 0, pnl: 0 },
    5: { name: 'الجمعة', total: 0, wins: 0, losses: 0, pnl: 0 }
  };

  const actions = {
    BUY: { total: 0, wins: 0, losses: 0, pnl: 0 },
    SELL: { total: 0, wins: 0, losses: 0, pnl: 0 }
  };

  const rsiBuckets = {
    '< 40': { total: 0, wins: 0, losses: 0, pnl: 0 },
    '40 - 50': { total: 0, wins: 0, losses: 0, pnl: 0 },
    '50 - 60': { total: 0, wins: 0, losses: 0, pnl: 0 },
    '> 60': { total: 0, wins: 0, losses: 0, pnl: 0 }
  };

  trades.forEach(t => {
    const pnl = Number((t.netPnLUSD ?? t.pnlUSD ?? 0).toFixed(2));
    netPnL += pnl;

    if (t.status === 'WIN') {
      totalWins++;
      grossWins += pnl;
    } else if (t.status === 'LOSS') {
      totalLosses++;
      grossLosses += Math.abs(pnl);
    } else {
      totalBreakeven++;
    }

    if (t.action === 'BUY' || t.action === 'SELL') {
      actions[t.action].total++;
      actions[t.action].pnl += pnl;
      if (t.status === 'WIN') actions[t.action].wins++;
      else if (t.status === 'LOSS') actions[t.action].losses++;
    }

    const rawTime = t.openedAt || t.closedAt;
    if (rawTime) {
      const d = new Date(rawTime);
      if (!isNaN(d.getTime())) {
        const cairoH = (d.getUTCHours() + 3) % 24;
        let sKey = 'asian';
        if (cairoH >= 9 && cairoH < 15) sKey = 'london';
        else if (cairoH >= 15 && cairoH < 22) sKey = 'newYork';
        else if (cairoH >= 22) sKey = 'lateNight';

        sessions[sKey].total++;
        sessions[sKey].pnl += pnl;
        if (t.status === 'WIN') sessions[sKey].wins++;
        else if (t.status === 'LOSS') sessions[sKey].losses++;

        const dayIdx = d.getUTCDay();
        if (days[dayIdx]) {
          days[dayIdx].total++;
          days[dayIdx].pnl += pnl;
          if (t.status === 'WIN') days[dayIdx].wins++;
          else if (t.status === 'LOSS') days[dayIdx].losses++;
        }
      }
    }

    if (typeof t.rsi === 'number') {
      let rKey = '50 - 60';
      if (t.rsi < 40) rKey = '< 40';
      else if (t.rsi < 50) rKey = '40 - 50';
      else if (t.rsi <= 60) rKey = '50 - 60';
      else rKey = '> 60';

      rsiBuckets[rKey].total++;
      rsiBuckets[rKey].pnl += pnl;
      if (t.status === 'WIN') rsiBuckets[rKey].wins++;
      else if (t.status === 'LOSS') rsiBuckets[rKey].losses++;
    }
  });

  const winRate = Number(((totalWins / trades.length) * 100).toFixed(1));
  const profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : 99;

  console.log(`\n=============================================================`);
  console.log(`📊 الإحصائيات الكاملة لجميع صفقات الذهب (${trades.length} صفقة حقيقية):`);
  console.log(`=============================================================`);
  console.log(`- إجمالي صفقات الذهب: ${trades.length}`);
  console.log(`- نسبة الفوز (Win Rate): ${winRate}% (${totalWins} فوز | ${totalLosses} خسارة | ${totalBreakeven} تعادل/أخرى)`);
  console.log(`- صافي الأرباح الكلي: $${netPnL.toFixed(2)}`);
  console.log(`- معامل الربح (Profit Factor): ${profitFactor}`);

  console.log(`\n🕒 أداء جلسات التداول على الذهب (بتوقيت القاهرة):`);
  Object.values(sessions).forEach(s => {
    if (s.total > 0) {
      const wr = ((s.wins / s.total) * 100).toFixed(1);
      console.log(`  * ${s.name}: ${s.total} صفقة | نسبة فوز: ${wr}% | صافي: $${s.pnl.toFixed(2)}`);
    }
  });

  console.log(`\n📅 أداء الأيام على الذهب:`);
  Object.values(days).forEach(d => {
    if (d.total > 0) {
      const wr = ((d.wins / d.total) * 100).toFixed(1);
      console.log(`  * يوم ${d.name}: ${d.total} صفقة | نسبة فوز: ${wr}% | صافي: $${d.pnl.toFixed(2)}`);
    }
  });

  console.log(`\n📈 أداء الشراء مقابل البيع (BUY vs SELL):`);
  console.log(`  * صفقات الشراء (BUY): ${actions.BUY.total} صفقة | نسبة فوز: ${actions.BUY.total ? ((actions.BUY.wins/actions.BUY.total)*100).toFixed(1) : 0}% | صافي: $${actions.BUY.pnl.toFixed(2)}`);
  console.log(`  * صفقات البيع (SELL): ${actions.SELL.total} صفقة | نسبة فوز: ${actions.SELL.total ? ((actions.SELL.wins/actions.SELL.total)*100).toFixed(1) : 0}% | صافي: $${actions.SELL.pnl.toFixed(2)}`);

  console.log(`\n⚡ أداء مستويات مؤشر RSI عند الدخول:`);
  Object.entries(rsiBuckets).forEach(([k, v]) => {
    if (v.total > 0) {
      const wr = ((v.wins / v.total) * 100).toFixed(1);
      console.log(`  * RSI ${k}: ${v.total} صفقة | نسبة فوز: ${wr}% | صافي: $${v.pnl.toFixed(2)}`);
    }
  });

  // 3. Call Groq AI to extract Lessons & Negative Rules from the full 349 trades dataset
  console.log(`\n🧠 استدعاء الذكاء الاصطناعي (${GROQ_MODEL}) لتحليل الـ ${trades.length} صفقة واستخراج القواعد الذكية...`);

  const systemPrompt = `أنت كبير مدققي التداول الكمي وإدارة المخاطر (Lead Quantitative Trading Auditor) متخصص حصرياً في تداول الذهب (XAU/USD).
مهمتك دراسة التاريخ الكامل لصفقات الذهب (${trades.length} صفقة) واستخراج:
1. "toxicPatterns": الأنماط السامة أو الفترات التي تسبب خسائر متكررة على الذهب (الجلسات الضعيفة، الأيام السيئة، أخطاء RSI، الاتجاه).
2. "winningPatterns": أفضل الإعدادات التي حققت أعلى أرباح ونسبة فوز للذهب.
3. "negativeRules": من 3 إلى 5 قواعد صارمة ومحددة باللغة العربية للـ Gatekeeper لرفض الصفقات التي تشبه الصفقات الخاسرة لحماية الحساب وزيادة معامل الربح.
4. "summaryArabic": ملخص تنفيذي ذكي ودقيق لحالة بوت الذهب وما يجب فعله فوراً ليصبح أذكى.
أجب فقط بصيغة JSON:
{
  "toxicPatterns": [string],
  "winningPatterns": [string],
  "negativeRules": [string],
  "summaryArabic": string
}`;

  const userPrompt = `
بيانات تاريخ صفقات الذهب الحقيقية الكاملة (${trades.length} صفقة مسجلة):
- إجمالي الصفقات: ${trades.length}
- نسبة الفوز الكلية: ${winRate}% (فوز: ${totalWins} | خسارة: ${totalLosses} | تعادل: ${totalBreakeven})
- صافي الأرباح: $${netPnL.toFixed(2)}
- معامل الربح: ${profitFactor}

تفاصيل الجلسات:
${Object.values(sessions).map(s => `- ${s.name}: ${s.total} صفقة، نسبة الفوز ${s.total ? ((s.wins / s.total) * 100).toFixed(1) : 0}%، ربح: $${s.pnl.toFixed(2)}`).join('\n')}

تفاصيل الأيام:
${Object.values(days).filter(d => d.total > 0).map(d => `- يوم ${d.name}: ${d.total} صفقة، نسبة الفوز ${((d.wins / d.total) * 100).toFixed(1)}%، ربح: $${d.pnl.toFixed(2)}`).join('\n')}

أداء صفقات الشراء والبيع:
- شراء (BUY): ${actions.BUY.total} صفقة، فوز: ${actions.BUY.total ? ((actions.BUY.wins / actions.BUY.total) * 100).toFixed(1) : 0}%، ربح: $${actions.BUY.pnl.toFixed(2)}
- بيع (SELL): ${actions.SELL.total} صفقة، فوز: ${actions.SELL.total ? ((actions.SELL.wins / actions.SELL.total) * 100).toFixed(1) : 0}%، ربح: $${actions.SELL.pnl.toFixed(2)}

أداء مؤشر RSI:
${Object.entries(rsiBuckets).filter(([_, v]) => v.total > 0).map(([k, v]) => `- RSI ${k}: ${v.total} صفقة، فوز: ${((v.wins / v.total) * 100).toFixed(1)}%، ربح: $${v.pnl.toFixed(2)}`).join('\n')}

المطلوب: صياغة قواعد حاسمة وعملية جداً (negativeRules) تجعل البوت يرفض الصفقات التي تشبه الصفقات الخاسرة، ويركز على الصفقات الرابحة. أخرج كود JSON فقط.
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );

    const parsed = JSON.parse(response.data.choices[0].message.content);

    console.log('\n=============================================================');
    console.log('📑 تقرير تحليل الذكاء الاصطناعي لجميع صفقات الذهب:');
    console.log('=============================================================');
    console.log('\n📝 الملخص التنفيذي:');
    console.log(parsed.summaryArabic);

    console.log('\n⚠️ الأنماط السامة المسببة للخسارة (Toxic Patterns):');
    parsed.toxicPatterns.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

    console.log('\n🌟 أنماط النجاح والقوة على الذهب (Winning Patterns):');
    parsed.winningPatterns.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

    console.log('\n🛡️ القواعد الحاسمة للـ Gatekeeper لحماية صفقات الذهب القادمة (Negative Rules):');
    parsed.negativeRules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

    // Save updated memory to MongoDB
    if (mongoConnected) {
      const db = mongoose.connection.db;
      await db.collection('aitradememories').updateMany({ isActive: true }, { $set: { isActive: false } });

      const saveRes = await db.collection('aitradememories').insertOne({
        version: 2,
        createdAt: new Date(),
        source: 'LIVE_DATABASE',
        totalTradesAnalyzed: trades.length,
        winRate,
        netPnLUSD: Number(netPnL.toFixed(2)),
        profitFactor,
        toxicPatterns: parsed.toxicPatterns,
        winningPatterns: parsed.winningPatterns,
        negativeRules: parsed.negativeRules,
        summaryArabic: parsed.summaryArabic,
        isActive: true
      });

      console.log(`\n💾 تم حفظ الذاكرة المحدثة لـ ${trades.length} صفقة ذهب في قاعدة البيانات بنجاح (ID: ${saveRes.insertedId}).`);
    }

  } catch (err) {
    console.error('❌ خطأ أثناء استدعاء الذكاء الاصطناعي:', err.response?.data || err.message);
  } finally {
    if (mongoConnected) {
      await mongoose.disconnect();
      console.log('🔒 تم إغلاق اتصال MongoDB بأمان.\n');
    }
  }
}

run();

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

async function run() {
  console.log('\n=============================================================');
  console.log('🤖 بدء تشغيل محرك دراسة وتحليل الصفقات بالذكاء الاصطناعي');
  console.log('=============================================================\n');

  // 2. Load historical trades
  let trades = [];

  const goldFilePath = path.resolve(__dirname, '../gold_trades_september_08_to_present.json');
  if (fs.existsSync(goldFilePath)) {
    try {
      const fileTrades = JSON.parse(fs.readFileSync(goldFilePath, 'utf8'));
      console.log(`📁 تم تحميل ${fileTrades.length} صفقة تاريخية مسجلة للذهب من ملف JSON.`);
      trades = fileTrades.map(t => ({
        symbol: t.Symbol || 'XAU/USD',
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

  // 3. Connect to MongoDB and check for live trades
  let mongoConnected = false;
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      mongoConnected = true;
      console.log('✅ تم الاتصال بقاعدة بيانات MongoDB بنجاح.');

      const db = mongoose.connection.db;
      const dbTrades = await db.collection('trades').find({
        symbol: 'XAU/USD',
        status: { $in: ['WIN', 'LOSS', 'BREAKEVEN'] }
      }).toArray();

      if (dbTrades.length > 0) {
        console.log(`📊 تم العثور على ${dbTrades.length} صفقة مغلقة إضافية في MongoDB.`);
        dbTrades.forEach(t => {
          trades.push({
            symbol: t.symbol,
            action: t.action,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            sl: t.sl,
            tp: t.tp,
            status: t.status,
            pnlUSD: t.pnlUSD || t.netPnLUSD || 0,
            netPnLUSD: t.netPnLUSD || t.pnlUSD || 0,
            rsi: t.rsi,
            ema20: t.ema20,
            ema100: t.ema100,
            atr: t.atr,
            openedAt: t.timestamp,
            closedAt: t.closedAt
          });
        });
      }
    } catch (err) {
      console.warn('⚠️ تعذر الاتصال بـ MongoDB، سيتم استخدام الملفات التاريخية فقط:', err.message);
    }
  }

  if (trades.length === 0) {
    console.error('❌ لم يتم العثور على أي صفقات لتحليلها.');
    process.exit(1);
  }

  // 4. Calculate detailed quantitative metrics
  console.log(`\n⏳ جاري احتساب المؤشرات الإحصائية الكمية لـ ${trades.length} صفقة...`);

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
  });

  const winRate = Number(((totalWins / trades.length) * 100).toFixed(1));
  const profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : 99;

  console.log(`\n📈 الإحصائيات الأساسية:`);
  console.log(`- إجمالي الصفقات: ${trades.length}`);
  console.log(`- نسبة الفوز (Win Rate): ${winRate}% (${totalWins} فوز | ${totalLosses} خسارة | ${totalBreakeven} تعادل)`);
  console.log(`- صافي الربح: $${netPnL.toFixed(2)}`);
  console.log(`- معامل الربح (Profit Factor): ${profitFactor}`);

  console.log(`\n🕒 أداء الجلسات:`);
  Object.values(sessions).forEach(s => {
    if (s.total > 0) {
      const wr = ((s.wins / s.total) * 100).toFixed(1);
      console.log(`  * ${s.name}: ${s.total} صفقة | نسبة فوز: ${wr}% | أرباح: $${s.pnl.toFixed(2)}`);
    }
  });

  console.log(`\n📅 أداء الأيام:`);
  Object.values(days).forEach(d => {
    if (d.total > 0) {
      const wr = ((d.wins / d.total) * 100).toFixed(1);
      console.log(`  * يوم ${d.name}: ${d.total} صفقة | نسبة فوز: ${wr}% | أرباح: $${d.pnl.toFixed(2)}`);
    }
  });

  // 5. Call Groq AI to extract Lessons & Negative Rules
  console.log(`\n🧠 استدعاء موديل الذكاء الاصطناعي (${GROQ_MODEL}) لدراسة الأخطاء واستخراج القواعد...`);

  const systemPrompt = `أنت مدقق ومحلل مخاطر كمي خبير (Senior Quantitative Risk Auditor) متخصص في التداول الآلي وسكالبينج الذهب (XAU/USD).
مهمتك دراسة الإحصائيات والأخطاء لصفقات البوت واستخراج:
1. "toxicPatterns": الأنماط السامة أو الفترات التي تسبب خسائر متكررة (مثل أيام معينة، جلسات ضعيفة، شروط معينة).
2. "winningPatterns": أفضل الإعدادات التي حققت أعلى عائد ونسبة نجاح.
3. "negativeRules": من 3 إلى 5 قواعد صارمة ومحددة باللغة العربية للـ Gatekeeper لرفض الصفقات التي تشبه الصفقات الخاسرة لحماية الحساب.
4. "summaryArabic": ملخص تحليلي احترافي وشامل لحالة البوت مع نصيحة حاسمة لزيادة الربحية.
أجب فقط بصيغة JSON:
{
  "toxicPatterns": [string],
  "winningPatterns": [string],
  "negativeRules": [string],
  "summaryArabic": string
}`;

  const userPrompt = `
إليك بيانات ونتائج صفقات البوت الحقيقية:
- الإجمالي: ${trades.length} صفقة
- نسبة الفوز: ${winRate}%
- إجمالي الأرباح: $${netPnL.toFixed(2)}
- معامل الربح: ${profitFactor}

تفاصيل الجلسات:
${Object.values(sessions).map(s => `- ${s.name}: ${s.total} صفقة، نسبة الفوز ${s.total ? ((s.wins / s.total) * 100).toFixed(1) : 0}%، ربح: $${s.pnl.toFixed(2)}`).join('\n')}

تفاصيل الأيام:
${Object.values(days).filter(d => d.total > 0).map(d => `- يوم ${d.name}: ${d.total} صفقة، نسبة الفوز ${((d.wins / d.total) * 100).toFixed(1)}%، ربح: $${d.pnl.toFixed(2)}`).join('\n')}

أداء الصفقات حسب الاتجاه:
- صفقات الشراء (BUY): ${actions.BUY.total} صفقة، نسبة فوز: ${actions.BUY.total ? ((actions.BUY.wins / actions.BUY.total) * 100).toFixed(1) : 0}%، ربح: $${actions.BUY.pnl.toFixed(2)}
- صفقات البيع (SELL): ${actions.SELL.total} صفقة، نسبة فوز: ${actions.SELL.total ? ((actions.SELL.wins / actions.SELL.total) * 100).toFixed(1) : 0}%، ربح: $${actions.SELL.pnl.toFixed(2)}

المطلوب: استخراج القواعد السلبية الحاسمة (negativeRules) التي إذا طبقها البوت ستمنع الصفقات الفاشلة وتجعل البوت أذكى وأكثر تحفظاً. أخرج كود JSON فقط.
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
        timeout: 20000,
      }
    );

    const parsed = JSON.parse(response.data.choices[0].message.content);

    console.log('\n=============================================================');
    console.log('📑 تقرير تحليل الذكاء الاصطناعي والدروس المستفادة:');
    console.log('=============================================================');
    console.log('\n📝 الملخص التنفيذي:');
    console.log(parsed.summaryArabic);

    console.log('\n⚠️ الأنماط السامة المسببة للخسارة (Toxic Patterns):');
    parsed.toxicPatterns.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

    console.log('\n🌟 أنماط النجاح والقوة (Winning Patterns):');
    parsed.winningPatterns.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

    console.log('\n🛡️ القواعد الحاسمة للـ Gatekeeper لمنع الخسائر القادمة (Negative Rules):');
    parsed.negativeRules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

    // 6. Save to MongoDB AiTradeMemory if connected
    if (mongoConnected) {
      const db = mongoose.connection.db;
      await db.collection('aitradememories').updateMany({ isActive: true }, { $set: { isActive: false } });

      const saveRes = await db.collection('aitradememories').insertOne({
        version: 1,
        createdAt: new Date(),
        source: 'HISTORICAL_FILES',
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

      console.log(`\n💾 تم حفظ الذاكرة والقواعد الجديدة في قاعدة بيانات MongoDB بنجاح (ID: ${saveRes.insertedId}).`);
    }

  } catch (err) {
    console.error('❌ خطأ أثناء استدعاء Groq AI:', err.response?.data || err.message);
  } finally {
    if (mongoConnected) {
      await mongoose.disconnect();
      console.log('🔒 تم إغلاق اتصال MongoDB بأمان.\n');
    }
  }
}

run();

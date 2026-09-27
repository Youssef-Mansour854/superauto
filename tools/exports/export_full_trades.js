const fs = require('fs');
const mongoose = require('mongoose');

function loadEnv() {
  const envPath = require('path').join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...values] = trimmed.split('=');
        if (key) {
          process.env[key.trim()] = values.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    });
  }
}
loadEnv();

function formatCairoTime(date) {
  const cairoDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const yyyy = cairoDate.getUTCFullYear();
  const mm = String(cairoDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(cairoDate.getUTCDate()).padStart(2, '0');
  const hh = String(cairoDate.getUTCHours()).padStart(2, '0');
  const min = String(cairoDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(cairoDate.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

async function exportTrades() {
  const mongoUri = process.env.MONGODB_URI;
  await mongoose.connect(mongoUri, { bufferCommands: false });
  const historyColl = mongoose.connection.collection('trade_history');

  // Load existing 90 trades
  const existingJson = JSON.parse(fs.readFileSync('gold_trades_september_08_to_present.json', 'utf8'));
  const lastExistingTrade = existingJson[existingJson.length - 1]; // Trade 90
  const lastClosedUtc = new Date(lastExistingTrade.ClosedAt_UTC);

  // Fetch all subsequent Gold trades from DB
  const subsequentDbTrades = await historyColl.find({
    symbol: 'XAU/USD',
    entryTimestamp: { $gt: new Date(lastExistingTrade.OpenedAt_UTC) }
  }).sort({ entryTimestamp: 1 }).toArray();

  console.log(`Found ${subsequentDbTrades.length} subsequent Gold trades after Trade 90.`);

  // Build Gold Continuation (Trade 1 to 122)
  let cumPnL = lastExistingTrade.Cumulative_PnL_USD;
  const newGoldTrades = [];

  subsequentDbTrades.forEach((t, i) => {
    const openedAt = new Date(t.entryTimestamp || t.timestamp);
    const closedAt = new Date(t.closedAt || openedAt);
    const durationMin = Math.round((closedAt.getTime() - openedAt.getTime()) / (1000 * 60));

    const entryPrice = Number(t.entryPrice.toFixed(2));
    const exitPrice = Number(t.exitPrice.toFixed(2));
    const sl = Number((t.sl !== undefined ? t.sl : t.entryPrice).toFixed(2));
    const tp = Number((t.tp !== undefined ? t.tp : t.entryPrice).toFixed(2));

    const diff = t.action === 'BUY' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnlPoints = t.pnlPoints !== undefined ? Number(t.pnlPoints.toFixed(2)) : Number(diff.toFixed(2));
    const lotSize = t.suggestedLotSize !== undefined ? Number(t.suggestedLotSize.toFixed(2)) : 0.17;
    const contractSize = 100; // Gold standard specification placeholder
    const pnlUSD = t.pnlUSD !== undefined ? Number(t.pnlUSD.toFixed(2)) : Number((pnlPoints * lotSize * contractSize).toFixed(2));

    let status = 'BREAKEVEN';
    if (pnlPoints > 0.001) status = 'WIN';
    else if (pnlPoints < -0.001) status = 'LOSS';

    cumPnL = Number((cumPnL + pnlUSD).toFixed(2));

    const tradeNo = existingJson.length + i + 1;
    newGoldTrades.push({
      Trade_No: tradeNo,
      Original_ID: tradeNo, // continuing sequential ID
      Symbol: t.symbol,
      Action: t.action,
      Type: t.tradeType || 'SCALP',
      EntryPrice: entryPrice,
      ExitPrice: exitPrice,
      StopLoss: sl,
      TakeProfit: tp,
      OpenedAt_UTC: openedAt.toISOString(),
      ClosedAt_UTC: closedAt.toISOString(),
      OpenedAt_Cairo: formatCairoTime(openedAt),
      ClosedAt_Cairo: formatCairoTime(closedAt),
      Duration_Min: durationMin,
      Status: status,
      LotSize: lotSize,
      pnlPoints: pnlPoints,
      pnlUSD: pnlUSD,
      PnL_USD: pnlUSD, // backwards compatibility
      Cumulative_pnlUSD: cumPnL,
      Cumulative_PnL_USD: cumPnL
    });
  });

  const fullGoldTrades = [...existingJson, ...newGoldTrades];
  console.log(`Total Full Gold Trades (Sep 08 - Sep 25): ${fullGoldTrades.length}`);
  console.log(`Final Gold Cumulative PnL: $${fullGoldTrades[fullGoldTrades.length - 1].Cumulative_PnL_USD}`);

  // Save Full Gold CSV & JSON
  fs.writeFileSync('gold_trades_september_08_to_25_2026.json', JSON.stringify(fullGoldTrades, null, 2), 'utf8');

  // Also update gold_trades_september_08_to_present.csv and .json so existing files are up to date!
  fs.writeFileSync('gold_trades_september_08_to_present.json', JSON.stringify(fullGoldTrades, null, 2), 'utf8');

  const csvHeader = 'Trade_No,Original_ID,Symbol,Action,Type,EntryPrice,ExitPrice,StopLoss,TakeProfit,OpenedAt_UTC,ClosedAt_UTC,OpenedAt_Cairo,ClosedAt_Cairo,Duration_Min,Status,LotSize,pnlPoints,pnlUSD,Cumulative_pnlUSD\n';
  const csvRows = fullGoldTrades.map(t => [
    t.Trade_No,
    t.Original_ID,
    t.Symbol,
    t.Action,
    t.Type,
    t.EntryPrice,
    t.ExitPrice,
    t.StopLoss,
    t.TakeProfit,
    `"${t.OpenedAt_UTC}"`,
    `"${t.ClosedAt_UTC}"`,
    `"${t.OpenedAt_Cairo}"`,
    `"${t.ClosedAt_Cairo}"`,
    t.Duration_Min,
    t.Status,
    t.LotSize !== undefined ? t.LotSize : 0.17,
    t.pnlPoints !== undefined ? t.pnlPoints : t.PnL_USD,
    t.pnlUSD !== undefined ? t.pnlUSD : t.PnL_USD,
    t.Cumulative_pnlUSD !== undefined ? t.Cumulative_pnlUSD : t.Cumulative_PnL_USD
  ].join(',')).join('\n');

  fs.writeFileSync('gold_trades_september_08_to_25_2026.csv', csvHeader + csvRows, 'utf8');
  fs.writeFileSync('gold_trades_september_08_to_present.csv', csvHeader + csvRows, 'utf8');
  console.log('Saved gold_trades_september_08_to_25_2026.csv & gold_trades_september_08_to_present.csv');

  // Also export ALL TRADES (Gold + QQQ) from MongoDB
  const allSeptTrades = await historyColl.find({
    entryTimestamp: {
      $gte: new Date('2026-09-08T00:00:00.000Z'),
      $lte: new Date('2026-09-25T23:59:59.999Z')
    }
  }).sort({ entryTimestamp: 1 }).toArray();

  let allCumPnL = 0;
  const allFormatted = allSeptTrades.map((t, idx) => {
    const openedAt = new Date(t.entryTimestamp || t.timestamp);
    const closedAt = new Date(t.closedAt || openedAt);
    const durationMin = Math.round((closedAt.getTime() - openedAt.getTime()) / (1000 * 60));

    const entryPrice = Number(t.entryPrice.toFixed(2));
    const exitPrice = Number(t.exitPrice.toFixed(2));
    const sl = Number((t.sl !== undefined ? t.sl : t.entryPrice).toFixed(2));
    const tp = Number((t.tp !== undefined ? t.tp : t.entryPrice).toFixed(2));

    const diff = t.action === 'BUY' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnlPoints = t.pnlPoints !== undefined ? Number(t.pnlPoints.toFixed(2)) : Number(diff.toFixed(2));
    const isGold = (t.symbol && t.symbol.includes('XAU'));
    const isQQQ = (t.symbol && (t.symbol.includes('QQQ') || t.symbol.includes('IXIC')));
    const contractSize = isGold ? 100 : (isQQQ ? 1 : 100);
    const lotSize = t.suggestedLotSize !== undefined ? Number(t.suggestedLotSize.toFixed(2)) : (isGold ? 0.17 : 1.0);
    const pnlUSD = t.pnlUSD !== undefined ? Number(t.pnlUSD.toFixed(2)) : Number((pnlPoints * lotSize * contractSize).toFixed(2));

    let status = 'BREAKEVEN';
    if (pnlPoints > 0.001) status = 'WIN';
    else if (pnlPoints < -0.001) status = 'LOSS';

    allCumPnL = Number((allCumPnL + pnlUSD).toFixed(2));

    return {
      Trade_No: idx + 1,
      Symbol: t.symbol,
      Action: t.action,
      Type: t.tradeType || 'SCALP',
      EntryPrice: entryPrice,
      ExitPrice: exitPrice,
      StopLoss: sl,
      TakeProfit: tp,
      OpenedAt_UTC: openedAt.toISOString(),
      ClosedAt_UTC: closedAt.toISOString(),
      OpenedAt_Cairo: formatCairoTime(openedAt),
      ClosedAt_Cairo: formatCairoTime(closedAt),
      Duration_Min: durationMin,
      Status: status,
      LotSize: lotSize,
      pnlPoints: pnlPoints,
      pnlUSD: pnlUSD,
      PnL_USD: pnlUSD, // backwards compatibility
      Cumulative_pnlUSD: allCumPnL,
      Cumulative_PnL_USD: allCumPnL
    };
  });

  fs.writeFileSync('all_trades_september_08_to_25_2026.json', JSON.stringify(allFormatted, null, 2), 'utf8');
  const allCsvHeader = 'Trade_No,Symbol,Action,Type,EntryPrice,ExitPrice,StopLoss,TakeProfit,OpenedAt_UTC,ClosedAt_UTC,OpenedAt_Cairo,ClosedAt_Cairo,Duration_Min,Status,LotSize,pnlPoints,pnlUSD,Cumulative_pnlUSD\n';
  const allCsvRows = allFormatted.map(t => [
    t.Trade_No,
    t.Symbol,
    t.Action,
    t.Type,
    t.EntryPrice,
    t.ExitPrice,
    t.StopLoss,
    t.TakeProfit,
    `"${t.OpenedAt_UTC}"`,
    `"${t.ClosedAt_UTC}"`,
    `"${t.OpenedAt_Cairo}"`,
    `"${t.ClosedAt_Cairo}"`,
    t.Duration_Min,
    t.Status,
    t.LotSize !== undefined ? t.LotSize : 0.17,
    t.pnlPoints !== undefined ? t.pnlPoints : t.PnL_USD,
    t.pnlUSD !== undefined ? t.pnlUSD : t.PnL_USD,
    t.Cumulative_pnlUSD !== undefined ? t.Cumulative_pnlUSD : t.Cumulative_PnL_USD
  ].join(',')).join('\n');

  fs.writeFileSync('all_trades_september_08_to_25_2026.csv', allCsvHeader + allCsvRows, 'utf8');
  console.log(`Saved all_trades_september_08_to_25_2026.csv (${allFormatted.length} trades, Final Cumulative PnL: $${allCumPnL})`);

  await mongoose.disconnect();
}

exportTrades().catch(console.error);

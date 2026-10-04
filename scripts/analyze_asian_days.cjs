const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/hp/.gemini/antigravity/brain/722589f7-4d7f-4ae6-a8ab-e0241f6128b6/scratch/live_weekly_history.json', 'utf8'));
const trades = data.trades || [];
const goldTrades = trades.filter(t => t.symbol === 'XAU/USD');

console.log('Asian session (00:00 - 08:59 Cairo) by Day:');
const byDay = {};

goldTrades.forEach(t => {
  const d = new Date(t.closedAt || t.entryTimestamp);
  const dayStr = d.toISOString().split('T')[0];
  const cairoH = (d.getUTCHours() + 3) % 24;

  if (cairoH >= 0 && cairoH < 9) {
    if (!byDay[dayStr]) byDay[dayStr] = { total: 0, wins: 0, losses: 0, pnl: 0 };
    byDay[dayStr].total++;
    byDay[dayStr].pnl += (t.netPnLUSD || 0);
    if (t.status === 'WIN') byDay[dayStr].wins++;
    else byDay[dayStr].losses++;
  }
});

for (const [day, stats] of Object.entries(byDay)) {
  const wr = ((stats.wins / stats.total) * 100).toFixed(1);
  console.log(`${day}: Total=${stats.total}, Wins=${stats.wins}, Losses=${stats.losses}, WR=${wr}%, PnL=$${stats.pnl.toFixed(2)}`);
}

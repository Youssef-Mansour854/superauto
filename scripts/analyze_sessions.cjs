const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/hp/.gemini/antigravity/brain/722589f7-4d7f-4ae6-a8ab-e0241f6128b6/scratch/live_weekly_history.json', 'utf8'));
const trades = data.trades || [];
const goldTrades = trades.filter(t => t.symbol === 'XAU/USD');

const hours = {};
for (let i = 0; i < 24; i++) hours[i] = { total: 0, wins: 0, losses: 0, pnl: 0 };

goldTrades.forEach(t => {
  const d = new Date(t.closedAt || t.entryTimestamp);
  const cairoH = (d.getUTCHours() + 3) % 24;
  hours[cairoH].total++;
  hours[cairoH].pnl += (t.netPnLUSD || 0);
  if (t.status === 'WIN') hours[cairoH].wins++;
  else hours[cairoH].losses++;
});

console.log('Hourly performance (Cairo Time):');
for (let h = 0; h < 24; h++) {
  const item = hours[h];
  if (item.total > 0) {
    const wr = ((item.wins / item.total) * 100).toFixed(1);
    console.log(`Hour ${h.toString().padStart(2, '0')}:00 -> Total: ${item.total}, Wins: ${item.wins}, Losses: ${item.losses}, WR: ${wr}%, PnL: $${item.pnl.toFixed(2)}`);
  }
}

// Group into sessions
let asian = { total: 0, wins: 0, losses: 0, pnl: 0 }; // 00:00 to 08:59 Cairo
let london = { total: 0, wins: 0, losses: 0, pnl: 0 }; // 09:00 to 14:59 Cairo
let ny = { total: 0, wins: 0, losses: 0, pnl: 0 };     // 15:00 to 21:59 Cairo
let late = { total: 0, wins: 0, losses: 0, pnl: 0 };   // 22:00 to 23:59 Cairo

goldTrades.forEach(t => {
  const d = new Date(t.closedAt || t.entryTimestamp);
  const cairoH = (d.getUTCHours() + 3) % 24;
  let target = asian;
  if (cairoH >= 9 && cairoH < 15) target = london;
  else if (cairoH >= 15 && cairoH < 22) target = ny;
  else if (cairoH >= 22) target = late;

  target.total++;
  target.pnl += (t.netPnLUSD || 0);
  if (t.status === 'WIN') target.wins++;
  else target.losses++;
});

console.log('\n--- SESSION SUMMARY ---');
console.log('Asian (00:00 - 08:59 Cairo):', { ...asian, wr: ((asian.wins/asian.total)*100).toFixed(1) + '%' });
console.log('London (09:00 - 14:59 Cairo):', { ...london, wr: ((london.wins/london.total)*100).toFixed(1) + '%' });
console.log('New York (15:00 - 21:59 Cairo):', { ...ny, wr: ((ny.wins/ny.total)*100).toFixed(1) + '%' });
console.log('Late Night (22:00 - 23:59 Cairo):', { ...late, wr: late.total ? ((late.wins/late.total)*100).toFixed(1) + '%' : '0%' });

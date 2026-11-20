/** XLSX report: same family of sheets as the main report, plus Comparison. */
import fs from 'fs';
import path from 'path';
import {
  CAIRO_UTC_OFFSET_HOURS, EVALUATOR_VERSION, PARAMS_VERSION, STRATEGY_IDS
} from './config';
import { computeMetrics, correlationMatrix, Metrics } from './metrics';
import { connectToDatabase } from '../mongodb';
import { readTrades, ShadowPosition } from './store';
import { TradeRecord } from './types';

function loadExcelJS(): any {
  try { return require('exceljs'); } catch {
    return require('C:/Users/hp/AppData/Local/Temp/opencode/xlsxenv/node_modules/exceljs');
  }
}

function cairo(time: Date | string | number): string {
  const d = new Date(time);
  return new Date(d.getTime() + CAIRO_UTC_OFFSET_HOURS * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

function utc(time: Date | string | number): string {
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}

function title(ws: any, text: string, columns = 6): void {
  const row = ws.addRow([text]);
  row.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  ws.mergeCells(row.number, 1, row.number, columns);
  if (ws.views) ws.views = [{ rightToLeft: true }];
}

function heading(ws: any, values: string[]): void {
  const row = ws.addRow(values);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
}

function addRows(ws: any, rows: any[][]): void {
  for (const r of rows) ws.addRow(r);
}

function autoWidth(ws: any, widths: number[]): void {
  ws.columns = widths.map(width => ({ width }));
}

/** Main bot benchmark from the existing workbook, normalized to 0.01 lot. */
export async function loadMainTrades(workbookPath: string): Promise<TradeRecord[]> {
  const ExcelJS = loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);
  const ws = wb.getWorksheet('الصفقات');
  if (!ws) return [];
  const out: TradeRecord[] = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const cell = (c: number) => {
      const v = r.getCell(c).value as any;
      return v && v.result !== undefined ? v.result : v;
    };
    const parseCairo = (text: string): number => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2})$/.exec(text);
      if (!m) return NaN;
      return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z`) - 2 * 3600000;
    };
    const entryUtc = parseCairo(String(cell(2) || ''));
    const exitUtc = parseCairo(String(cell(3) || ''));
    if (!Number.isFinite(entryUtc)) continue;
    const lot = Number(cell(14) || 0.01);
    const net = Number(cell(19) || 0) * (0.01 / lot);
    const risk = Math.abs(Number(cell(9)) - Number(cell(10)));
    out.push({
      trade_id: `main:${i}`, strategy_id: 'main', params_version: PARAMS_VERSION,
      evaluator_version: 'main-touch-engine', signal_time_utc: new Date(entryUtc),
      entry_time_utc: new Date(entryUtc), exit_time_utc: new Date(Number.isFinite(exitUtc) ? exitUtc : entryUtc),
      direction: String(cell(4)) as any, entry_price: Number(cell(9)), stop: Number(cell(10)),
      target: Number(cell(11)), risk_usd_per_001lot: risk, atr14: 0, rsi14: null,
      session_bucket_utc: 'UNKNOWN', exit_type: String(cell(8)) as any, exit_price: Number(cell(13)),
      ambiguous: false, resolved_by: 'none', gross_units: Number(cell(17) || 0) * (0.01 / lot),
      cost_units: Math.abs(Number(cell(18) || 0)) * (0.01 / lot), net_units: net,
      R: Number(cell(20) || 0), mfe_units: Number(cell(21) || 0), mae_units: Number(cell(23) || 0),
      duration_minutes: Number(cell(25) || 0),
      source: 'live'
    });
  }
  return out;
}

export interface ReportOptions {
  since?: string;
  strategy: string;
  source?: 'live' | 'replay';
  split?: 'test';
  outPath?: string;
  workbookPath?: string;
}

function metricRows(metrics: Record<string, Metrics>, ids: string[]): any[][] {
  return ids.filter(id => metrics[id]).map(id => {
    const m = metrics[id];
    return [
      id, m.trades, m.wins, m.winRate, m.netUnits, m.meanR, m.sdR,
      m.tP === null ? '-' : Number(m.tP.toFixed(4)),
      `${m.ciTrade[0]} .. ${m.ciTrade[1]}`, `${m.ciDay[0]} .. ${m.ciDay[1]}`,
      m.profitFactor, m.maxDrawdown, m.costsPctGrossProfit, m.ambiguous,
      m.tradesPerDay, m.daysTo200, m.flags.join(',') || '-',
      m.evaluatorVersion, m.paramsVersion,
      m.correlationWithControl === null ? '-' : m.correlationWithControl
    ];
  });
}

const METRIC_HEADERS = [
  'استراتيجية', 'صفقات', 'رابحة', 'نسبة الفوز', 'صافي وحدات', 'متوسط R', 'انحراف R', 'p-value',
  'CI صفقات 95%', 'CI أيام 95%', 'profit factor', 'أقصى تراجع', 'تكاليف % من الربح', 'ملتبسة',
  'صفقات/يوم', 'أيام لـ200', 'flags', 'evaluator_version', 'params_version', 'ارتباط مع control'
];

export async function buildReport(options: ReportOptions): Promise<string> {
  const ExcelJS = loadExcelJS();
  await connectToDatabase();
  const source = options.source || 'live';
  const ids = options.strategy === 'all' ? [...STRATEGY_IDS] : [options.strategy];
  const since = options.since ? new Date(`${options.since}T00:00:00Z`) : undefined;
  const byStrategy: Record<string, TradeRecord[]> = {};
  for (const id of ids) {
    let trades = await readTrades(id, since);
    trades = trades.filter(t => (t.source || 'live') === source);
    if (options.split) trades = trades.filter(t => t.split === options.split);
    byStrategy[id] = trades;
  }
  let control = byStrategy.c0_random || [];
  if (!control.length && ids.length > 1) {
    control = (await readTrades('c0_random', since)).filter(t => (t.source || 'live') === source);
    if (options.split) control = control.filter(t => t.split === options.split);
  }

  const metrics: Record<string, Metrics> = {};
  for (const id of ids) metrics[id] = computeMetrics(byStrategy[id], control, EVALUATOR_VERSION, PARAMS_VERSION);
  const matrix = correlationMatrix(byStrategy);

  let mainMetrics: Metrics | null = null;
  try {
    const mainPath = options.workbookPath || path.join(process.cwd(), 'reports', 'bot-numbers-2026-11-19.xlsx');
    if (fs.existsSync(mainPath)) {
      const mainTrades = await loadMainTrades(mainPath);
      mainMetrics = computeMetrics(mainTrades, control, 'main-touch-engine', 1);
    }
  } catch {
    mainMetrics = null;
  }

  const openPositions = await ShadowPosition.find({ source }).lean().catch(() => []) as any[];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'shadow-strategies';
  wb.created = new Date();

  // 1. Read me first
  const ws0 = wb.addWorksheet('اقرأ أولاً', { properties: { tabColor: { argb: 'FFC00000' } } });
  title(ws0, 'تقرير الاستراتيجيات الظلية —كل الاستراتيجيات بنفس الحكم', 4);
  autoWidth(ws0, [110, 40, 30, 30]);
  heading(ws0, ['ملاحظة', 'القيمة', '', '']);
  addRows(ws0, [
    ['تاريخ التصدير (UTC)', new Date().toISOString().slice(0, 19).replace('T', ' '), '', ''],
    ['تاريخ التصدير (القاهرة)', cairo(new Date()), '', ''],
    ['evaluator_version', EVALUATOR_VERSION, '', ''],
    ['params_version', PARAMS_VERSION, '', ''],
    ['المصدر', source, options.split ? 'جزء الاختبار فقط (30%)' : 'كل الفترة', ''],
    ['قاعدة المقارنة', 'نفس الـ evaluator، تكلفة 0.30$/0.01 لوت، لوت ثابت 0.01، مفيش تحسين بارامترات', '', ''],
    ['تحذير', 'الصفقات الظلية ورقية ولا تُنفّذ أي أمر حقيقي. LOW_SAMPLE = أقل من 100 صفقة.', '', ''],
    ['ترتيب الأعمدة', 'كل timestamps في DB UTC؛ عمود القاهرة (UTC+2) بجانبه مباشرة في شيت الصفقات والتحليل', '', '']
  ]);

  // 2. Metrics
  const ws1 = wb.addWorksheet('ملخص');
  title(ws1, 'المقاييس — بنفس الدالة للكل', METRIC_HEADERS.length);
  autoWidth(ws1, [26, 10, 10, 11, 13, 11, 11, 11, 20, 20, 14, 14, 18, 10, 12, 12, 22, 22, 16, 18]);
  heading(ws1, METRIC_HEADERS);
  addRows(ws1, metricRows(metrics, ids));
  if (mainMetrics) {
    const row = ws1.addRow([
      'main (مرجع — معيّر 0.01 لوت)', mainMetrics.trades, mainMetrics.wins, mainMetrics.winRate, mainMetrics.netUnits,
      mainMetrics.meanR, mainMetrics.sdR, mainMetrics.tP === null ? '-' : Number(mainMetrics.tP.toFixed(4)),
      `${mainMetrics.ciTrade[0]} .. ${mainMetrics.ciTrade[1]}`, `${mainMetrics.ciDay[0]} .. ${mainMetrics.ciDay[1]}`,
      mainMetrics.profitFactor, mainMetrics.maxDrawdown, mainMetrics.costsPctGrossProfit, mainMetrics.ambiguous,
      mainMetrics.tradesPerDay, mainMetrics.daysTo200, mainMetrics.flags.join(',') || '-',
      'main-touch-engine', 1, '-'
    ]);
    row.font = { italic: true };
  }

  // 3. Trades (UTC then Cairo)
  const ws2 = wb.addWorksheet('الصفقات');
  const tradeHeaders = ['UTC', 'القاهرة (UTC+2)', 'استراتيجية', 'trade_id', 'اتجاه', 'دخول', 'وقف', 'هدف',
    'risk 0.01', 'ATR14', 'RSI14', 'جلسة UTC', 'خروج', 'سعر الخروج', 'ملتبس', 'resolved_by',
    'gross', 'cost', 'net', 'R', 'MFE', 'MAE', 'دقائق', 'source', 'split'];
  title(ws2, 'كل الصفقات (مفتوحة في شيت منفصل)', tradeHeaders.length);
  autoWidth(ws2, [18, 20, 22, 36, 9, 12, 12, 12, 11, 10, 10, 20, 12, 12, 10, 16, 10, 8, 10, 10, 10, 10, 10, 10, 10]);
  heading(ws2, tradeHeaders);
  for (const id of ids) {
    for (const t of byStrategy[id]) {
      ws2.addRow([
        utc(t.exit_time_utc), cairo(t.exit_time_utc), t.strategy_id, t.trade_id, t.direction,
        t.entry_price, t.stop, t.target, t.risk_usd_per_001lot, t.atr14, t.rsi14,
        t.session_bucket_utc, t.exit_type, t.exit_price, t.ambiguous ? 'نعم' : 'لا', t.resolved_by,
        t.gross_units, t.cost_units, t.net_units, t.R, t.mfe_units, t.mae_units,
        t.duration_minutes, t.source, t.split || '-'
      ]);
    }
  }

  // 4. Daily / sessions / directions
  const ws3 = wb.addWorksheet('التحليل');
  title(ws3, 'تحليل الأبعاد (UTC)', 8);
  autoWidth(ws3, [24, 22, 22, 24, 24, 20, 20, 20]);
  heading(ws3, ['استراتيجية', 'اليوم UTC', 'اليوم بالقاهرة', 'صافي وحدات', '', '', '', '']);
  for (const id of ids) {
    for (const [day, value] of Object.entries(metrics[id].dailyPnL)) {
      ws3.addRow([id, day, cairo(new Date(`${day}T00:00:00Z`)), value, '', '', '', '']);
    }
  }
  ws3.addRow([]);
  heading(ws3, ['استراتيجية', 'البعد', 'القيمة', 'عدد الصفقات', 'صافي وحدات', '', '', '']);
  for (const id of ids) {
    for (const [session, v] of Object.entries(metrics[id].sessions)) ws3.addRow([id, 'جلسة', session, v.trades, v.netUnits, '', '', '']);
    for (const [dir, v] of Object.entries(metrics[id].directions)) ws3.addRow([id, 'اتجاه', dir, v.trades, v.netUnits, '', '', '']);
  }

  // 5. Correlation matrix
  const ws4 = wb.addWorksheet('الارتباط');
  title(ws4, 'ارتباط صافي R اليومي بين الاستراتيجيات', ids.length + 1);
  autoWidth(ws4, [28, ...ids.map(() => 20)]);
  heading(ws4, ['', ...ids]);
  for (const a of ids) ws4.addRow([a, ...ids.map(b => matrix[a]?.[b] === null || matrix[a]?.[b] === undefined ? '-' : matrix[a][b])]);
  ws4.addRow([]);
  ws4.addRow(['الارتباط مع control معروض كمان في عمود «ارتباط مع control» في ملخص.']);

  // 6. Comparison
  const ws5 = wb.addWorksheet('Comparison');
  title(ws5, 'Comparison — same evaluator, no tuning', 12);
  autoWidth(ws5, [26, 12, 14, 14, 14, 18, 20, 20, 14, 22, 22, 18]);
  heading(ws5, ['استراتيجية', 'صفقات', 'صافي وحدات', 'متوسط R', 'p-value', 'CI صفقات', 'CI أيام', 'ارتباط بـcontrol', 'flags', 'evaluator', 'params', 'نتيجة أولية']);
  for (const id of ids) {
    const m = metrics[id];
    const verdict = m.flags.includes('NOT_COMPARABLE') ? 'NOT_COMPARABLE'
      : m.trades < 200 ? 'LOW_SAMPLE — لا ترقية'
      : (m.ciTrade[0] > 0 && m.tP !== null && m.tP < 0.05) ? 'مرشحة للمراجعة' : 'لا تفوق مؤكد';
    ws5.addRow([id, m.trades, m.netUnits, m.meanR, m.tP === null ? '-' : Number(m.tP.toFixed(4)),
      `${m.ciTrade[0]} .. ${m.ciTrade[1]}`, `${m.ciDay[0]} .. ${m.ciDay[1]}`,
      m.correlationWithControl === null ? '-' : m.correlationWithControl, m.flags.join(',') || '-',
      m.evaluatorVersion, m.paramsVersion, verdict]);
  }
  ws5.addRow([]);
  ws5.addRow(['قاعدة الترقية', '200–300 صفقة حقيقية على الأقل، وCI يستبعد الصفر بعد التكاليف. أي تغيير بارامتر = نسخة جديدة ونافذة جديدة.']);

  // 7. Open trades, separate
  const ws6 = wb.addWorksheet('الصفقات المفتوحة');
  title(ws6, 'صفقات مفتوحة — لا تُخلط بالنتيجة', 8);
  autoWidth(ws6, [24, 20, 24, 20, 12, 12, 12, 18]);
  heading(ws6, ['استراتيجية', 'signal UTC', 'القاهرة', 'اتجاه', 'دخول', 'وقف', 'هدف', 'source']);
  for (const p of openPositions) {
    const s = p.signal || {};
    ws6.addRow([p.strategy_id, utc(new Date(s.signalTime || 0)), cairo(new Date(s.signalTime || 0)),
      s.direction, s.entryPrice, s.stop, s.target, p.source]);
  }
  if (openPositions.length === 0) ws6.addRow(['لا توجد صفقات مفتوحة']);

  // 8. Notes
  const ws7 = wb.addWorksheet('التعديلات');
  title(ws7, 'قواعد وأفتراضات — اقرأ قبل التحليل', 4);
  autoWidth(ws7, [24, 90, 50, 50]);
  heading(ws7, ['البند', 'القاعدة', 'السبب', 'التأثير']);
  addRows(ws7, [
    ['المصدر', 'كل الصفقات هنا ظلية/ورقية ما عدا سطر main المرجعي', 'مفيش أوامر حقيقية', 'مفيش تأثير على الرصيد'],
    ['الحكم', `evaluator_version=${EVALUATOR_VERSION}`, ' evaluator واحد للكل', 'مقارنة عادلة'],
    ['التكلفة', '0.30$ لكل 0.01 لوت لكل صفقة', 'نفس تكلفة البوت', 'إلزامية لكل الاستراتيجيات'],
    ['اللوت', '0.01 ثابت، مفيش مضاعفة', 'عزل النتائج', 'قابل للمقارنة'],
    ['ال timestamps', 'UTC في DB، والقاهرة كعمود تاني', 'توحيد', 'مفيش لبس في الجلسات'],
    ['LOW_SAMPLE', 'أقل من 100 صفقة', 'عينة صغيرة', 'ممنوع الترقية'],
    ['NOT_COMPARABLE', 'اختلاف إصدار حكم أو بارامترات', 'نافذة مقارنة مختلفة', 'ممنوع المقارنة المباشرة'],
    ['Parity', 'انحرافات محاكاة البوت موثّقة في tests/shadowParity.test.cjs', 'الحكم الجديد مختلف عن القديم', 'لا تعديل لصفقات قديمة']
  ]);

  const out = options.outPath || path.join(process.cwd(), 'reports',
    `shadow-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  return out;
}

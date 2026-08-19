import { EMA, RSI, ATR } from 'technicalindicators';
import { Candle } from './binance';

export interface IndicatorResults {
  closes: number[];
  ema20: number[];
  rsi14: number[];
  atr14: number[];
  currentClose: number;
  prevClose: number;
  currentEma20: number;
  currentRsi: number;
  prevRsi: number;
  currentAtr: number;
}

export function calculateScalpIndicators(candles: Candle[]): IndicatorResults | null {
  if (!candles || candles.length < 30) {
    console.warn(`Insufficient candle data length (${candles?.length || 0}) for indicator calculations.`);
    return null;
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const rsi14 = RSI.calculate({ period: 14, values: closes });
  const atr14 = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (ema20.length < 2 || rsi14.length < 2 || atr14.length < 1) {
    console.warn('Computed indicators returned insufficient data points.');
    return null;
  }

  const currentClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  const currentEma20 = ema20[ema20.length - 1];
  const currentRsi = rsi14[rsi14.length - 1];
  const prevRsi = rsi14[rsi14.length - 2];
  const currentAtr = atr14[atr14.length - 1];

  return {
    closes,
    ema20,
    rsi14,
    atr14,
    currentClose,
    prevClose,
    currentEma20,
    currentRsi,
    prevRsi,
    currentAtr,
  };
}

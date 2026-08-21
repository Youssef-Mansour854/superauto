import axios from 'axios';
import { Candle } from './binance';

export function normalizeTwelveDataSymbol(symbol: string): string {
  if (symbol === '^IXIC' || symbol === 'IXIC') return 'IXIC';
  if (symbol === '^DJI' || symbol === 'DJI') return 'DJI';
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD') return 'XAU/USD';
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD') return 'BTC/USD';
  return symbol;
}

export async function fetchTwelveData5mKlines(
  symbol: string = 'XAU/USD',
  interval: string = '5min',
  outputsize: number = 100
): Promise<Candle[]> {
  try {
    const apiSymbol = normalizeTwelveDataSymbol(symbol);
    const apiKey = process.env.TWELVEDATA_API_KEY || '';
    const url = `https://api.twelvedata.com/time_series`;

    const response = await axios.get(url, {
      params: {
        symbol: apiSymbol,
        interval,
        outputsize,
        apikey: apiKey,
      },
      timeout: 10000,
    });

    const data = response.data;

    if (!data) {
      console.warn(`Empty response returned from Twelve Data for '${symbol}'.`);
      return [];
    }

    if (data.status === 'error') {
      console.error(`Twelve Data API error for '${symbol}':`, data.message || data);
      return [];
    }

    // Support single symbol or nested symbol object in response
    const symbolData = data.values ? data : (data[apiSymbol] || data[symbol]);

    if (!symbolData || !Array.isArray(symbolData.values) || symbolData.values.length === 0) {
      console.warn(`No candle values found in Twelve Data response for '${symbol}'.`);
      return [];
    }

    const rawValues = symbolData.values;

    const candles: Candle[] = rawValues
      .map((item: any) => {
        const open = parseFloat(item.open);
        const high = parseFloat(item.high);
        const low = parseFloat(item.low);
        const close = parseFloat(item.close);
        const volume = parseFloat(item.volume || '0');
        const openTime = new Date(item.datetime).getTime();
        const closeTime = openTime + 5 * 60 * 1000;

        if (isNaN(close) || isNaN(openTime)) {
          return null;
        }

        return {
          openTime,
          open: isNaN(open) ? close : open,
          high: isNaN(high) ? close : high,
          low: isNaN(low) ? close : low,
          close,
          volume: isNaN(volume) ? 0 : volume,
          closeTime,
        };
      })
      .filter((c: Candle | null): c is Candle => c !== null);

    // Twelve Data returns candles in reverse chronological order (newest first).
    // Technical indicators (EMA, RSI, ATR) require chronological order (oldest first).
    candles.reverse();

    return candles;
  } catch (error: any) {
    console.error(`Error fetching Twelve Data 5m klines for '${symbol}':`, error?.response?.data || error?.message || error);
    return [];
  }
}

export async function fetchTwelveDataBatch5mKlines(
  symbols: string[] = ['XAU/USD', 'BTC/USD'],
  interval: string = '5min',
  outputsize: number = 100
): Promise<Record<string, Candle[]>> {
  const result: Record<string, Candle[]> = {};
  symbols.forEach((s) => (result[s] = []));

  try {
    const apiKey = process.env.TWELVEDATA_API_KEY || '';
    const url = `https://api.twelvedata.com/time_series`;

    const response = await axios.get(url, {
      params: {
        symbol: symbols.join(','),
        interval,
        outputsize,
        apikey: apiKey,
      },
      timeout: 12000,
    });

    const data = response.data;
    if (!data) return result;

    for (const sym of symbols) {
      const symData = data[sym] || (data.meta?.symbol === sym ? data : null);
      if (symData && Array.isArray(symData.values)) {
        const rawValues = symData.values;
        const candles: Candle[] = rawValues
          .map((item: any) => {
            const open = parseFloat(item.open);
            const high = parseFloat(item.high);
            const low = parseFloat(item.low);
            const close = parseFloat(item.close);
            const volume = parseFloat(item.volume || '0');
            const openTime = new Date(item.datetime).getTime();
            const closeTime = openTime + 5 * 60 * 1000;

            if (isNaN(close) || isNaN(openTime)) return null;

            return {
              openTime,
              open: isNaN(open) ? close : open,
              high: isNaN(high) ? close : high,
              low: isNaN(low) ? close : low,
              close,
              volume: isNaN(volume) ? 0 : volume,
              closeTime,
            };
          })
          .filter((c: Candle | null): c is Candle => c !== null);

        candles.reverse();
        result[sym] = candles;
      }
    }

    return result;
  } catch (error: any) {
    console.error(`Error fetching Twelve Data batch 5m klines:`, error?.response?.data || error?.message || error);
    return result;
  }
}

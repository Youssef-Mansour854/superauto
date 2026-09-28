import axios from 'axios';
import { Candle } from './binance';

export function normalizeTwelveDataSymbol(symbol: string): string {
  if (symbol === '^IXIC' || symbol === 'IXIC') return 'IXIC';
  if (symbol === '^DJI' || symbol === 'DJI') return 'DJI';
  if (symbol === 'XAUUSD=X' || symbol === 'XAUUSD') return 'XAU/USD';
  if (symbol === 'BTC-USD' || symbol === 'BTCUSD') return 'BTC/USD';
  return symbol;
}

export interface CandleFetchResult {
  candles: Candle[];
  httpStatus: number;
  errorMessage: string | null;
  candleCount: number;
}

/**
 * Sanitizes any text to guarantee that the API key is never exposed or logged.
 */
function sanitizeApiKey(text: string, apiKey: string): string {
  if (!text) return '';
  if (!apiKey || apiKey.length < 3) return text;
  return text.split(apiKey).join('[REDACTED_KEY]');
}

export async function fetchTwelveData5mKlines(
  symbol: string = 'XAU/USD',
  interval: string = '5min',
  outputsize: number = 100
): Promise<CandleFetchResult> {
  const apiSymbol = normalizeTwelveDataSymbol(symbol);
  const apiKey = process.env.TWELVEDATA_API_KEY || '';
  const url = `https://api.twelvedata.com/time_series`;

  try {
    const response = await axios.get(url, {
      params: {
        symbol: apiSymbol,
        interval,
        outputsize,
        apikey: apiKey,
      },
      timeout: 10000,
      validateStatus: () => true // Handle 4xx/5xx status gracefully to capture exact HTTP code
    });

    const httpStatus = response.status;
    const data = response.data;

    if (!data) {
      return {
        candles: [],
        httpStatus,
        errorMessage: 'Empty response payload from Twelve Data',
        candleCount: 0
      };
    }

    if (httpStatus >= 400 || data.status === 'error') {
      const rawMsg = data.message || (typeof data === 'string' ? data : JSON.stringify(data));
      const cleanMsg = sanitizeApiKey(rawMsg, apiKey);
      return {
        candles: [],
        httpStatus,
        errorMessage: cleanMsg,
        candleCount: 0
      };
    }

    // Support single symbol or nested symbol object in response
    const symbolData = data.values ? data : (data[apiSymbol] || data[symbol]);

    if (!symbolData || !Array.isArray(symbolData.values) || symbolData.values.length === 0) {
      const rawMsg = data.message || 'No candle values found in Twelve Data response';
      return {
        candles: [],
        httpStatus,
        errorMessage: sanitizeApiKey(rawMsg, apiKey),
        candleCount: 0
      };
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

    return {
      candles,
      httpStatus,
      errorMessage: null,
      candleCount: candles.length
    };
  } catch (error: any) {
    const httpStatus = error?.response?.status || 500;
    const rawMsg = error?.response?.data?.message || error?.message || 'Network / Axios request failed';
    const cleanMsg = sanitizeApiKey(rawMsg, apiKey);
    return {
      candles: [],
      httpStatus,
      errorMessage: cleanMsg,
      candleCount: 0
    };
  }
}

export async function fetchTwelveDataBatch5mKlines(
  symbols: string[] = ['XAU/USD', 'EUR/USD'],
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

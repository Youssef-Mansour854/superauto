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

const DEFAULT_TWELVEDATA_KEYS = '29d676f8d5874b54bc16c98f1698e528,dc0cbdc826a24e76a81ae1d115f9d14d';

export function getTwelveDataApiKeys(): string[] {
  const rawKeyString = process.env.TWELVEDATA_API_KEY || DEFAULT_TWELVEDATA_KEYS;
  return rawKeyString
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
}

export async function fetchTwelveData5mKlines(
  symbol: string = 'XAU/USD',
  interval: string = '5min',
  outputsize: number = 100
): Promise<CandleFetchResult> {
  const apiSymbol = normalizeTwelveDataSymbol(symbol);
  const apiKeys = getTwelveDataApiKeys();
  if (apiKeys.length === 0) {
    return {
      candles: [],
      httpStatus: 0,
      errorMessage: 'TWELVEDATA_API_KEY is not configured',
      candleCount: 0
    };
  }

  let lastResult: CandleFetchResult = {
    candles: [],
    httpStatus: 0,
    errorMessage: null,
    candleCount: 0
  };

  const url = `https://api.twelvedata.com/time_series`;

  // Distribute requests across all keys (rotates starting key every minute to load balance evenly)
  const startOffset = Math.floor(Date.now() / 60000) % apiKeys.length;

  for (let step = 0; step < apiKeys.length; step++) {
    const i = (startOffset + step) % apiKeys.length;
    const apiKey = apiKeys[i];
    try {
      const response = await axios.get(url, {
        params: {
          symbol: apiSymbol,
          interval,
          outputsize,
          apikey: apiKey,
          timezone: 'UTC',
        },
        timeout: 10000,
        validateStatus: () => true // Handle 4xx/5xx status gracefully to capture exact HTTP code
      });

      const httpStatus = response.status;
      const data = response.data;

      if (!data) {
        lastResult = {
          candles: [],
          httpStatus,
          errorMessage: 'Empty response payload from Twelve Data',
          candleCount: 0
        };
        continue;
      }

      if (httpStatus === 429 || data.code === 429 || (data.message && String(data.message).includes('run out of API credits'))) {
        console.warn(`Twelve Data key ${i + 1}/${apiKeys.length} reached daily rate limit (429). Trying fallback key if available...`);
        lastResult = {
          candles: [],
          httpStatus: 429,
          errorMessage: sanitizeApiKey(data.message || 'Daily limit reached', apiKey),
          candleCount: 0
        };
        continue;
      }

      if (httpStatus >= 400 || data.status === 'error') {
        const rawMsg = data.message || (typeof data === 'string' ? data : JSON.stringify(data));
        const cleanMsg = sanitizeApiKey(rawMsg, apiKey);
        lastResult = {
          candles: [],
          httpStatus,
          errorMessage: cleanMsg,
          candleCount: 0
        };
        continue;
      }

      // Support single symbol or nested symbol object in response
      const symbolData = data.values ? data : (data[apiSymbol] || data[symbol]);

      if (!symbolData || !Array.isArray(symbolData.values) || symbolData.values.length === 0) {
        const rawMsg = data.message || 'No candle values found in Twelve Data response';
        lastResult = {
          candles: [],
          httpStatus,
          errorMessage: sanitizeApiKey(rawMsg, apiKey),
          candleCount: 0
        };
        continue;
      }

      const rawValues = symbolData.values;

      const candles: Candle[] = rawValues
        .map((item: any) => {
          const open = parseFloat(item.open);
          const high = parseFloat(item.high);
          const low = parseFloat(item.low);
          const close = parseFloat(item.close);
          const volume = parseFloat(item.volume || '0');
          const rawDateTime = String(item.datetime);
          const utcDateTime = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawDateTime) ? rawDateTime : `${rawDateTime}Z`;
          const openTime = new Date(utcDateTime).getTime();
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
      lastResult = {
        candles: [],
        httpStatus,
        errorMessage: cleanMsg,
        candleCount: 0
      };
    }
  }

  return lastResult;
}

export async function fetchTwelveDataBatch5mKlines(
  symbols: string[] = ['XAU/USD', 'EUR/USD'],
  interval: string = '5min',
  outputsize: number = 100
): Promise<Record<string, Candle[]>> {
  const result: Record<string, Candle[]> = {};
  symbols.forEach((s) => (result[s] = []));

  const apiKeys = getTwelveDataApiKeys();
  if (apiKeys.length === 0) return result;

  const url = `https://api.twelvedata.com/time_series`;
  const startOffset = Math.floor(Date.now() / 60000) % apiKeys.length;

  for (let step = 0; step < apiKeys.length; step++) {
    const i = (startOffset + step) % apiKeys.length;
    const apiKey = apiKeys[i];
    try {
      const response = await axios.get(url, {
        params: {
          symbol: symbols.join(','),
          interval,
          outputsize,
          apikey: apiKey,
        },
        timeout: 12000,
        validateStatus: () => true
      });

      const data = response.data;
      if (!data) continue;

      if (response.status === 429 || data.code === 429 || (data.message && String(data.message).includes('run out of API credits'))) {
        console.warn(`Twelve Data batch key ${i + 1}/${apiKeys.length} reached daily rate limit (429). Trying fallback key...`);
        continue;
      }

      if (response.status >= 400 || data.status === 'error') {
        continue;
      }

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
      console.error(`Error fetching Twelve Data batch 5m klines with key ${i + 1}:`, error?.response?.data || error?.message || error);
    }
  }

  return result;
}

import YahooFinance from 'yahoo-finance2';
import { Candle } from './binance';

const yahooFinance = new (YahooFinance as any)();

export async function fetchYahoo5mKlines(symbol: string): Promise<Candle[]> {
  try {
    const period1 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days back
    const result: any = await yahooFinance.chart(symbol, {
      period1,
      interval: '5m',
    });

    if (!result || !result.quotes || result.quotes.length === 0) {
      console.warn(`No 5m candles returned from Yahoo Finance for '${symbol}'.`);
      return [];
    }

    const candles: Candle[] = result.quotes
      .filter((q: any) => q.close !== null && q.close !== undefined)
      .map((q: any) => {
        const timeMs = q.date instanceof Date ? q.date.getTime() : new Date(q.date).getTime();
        return {
          openTime: timeMs,
          open: q.open || q.close!,
          high: q.high || q.close!,
          low: q.low || q.close!,
          close: q.close!,
          volume: q.volume || 0,
          closeTime: timeMs + 300000,
        };
      });

    return candles;
  } catch (error: any) {
    console.error(`Error fetching Yahoo 5m klines for '${symbol}':`, error?.message || error);
    return [];
  }
}

export async function fetchYahooHistorical(
  symbol: string,
  interval: '1wk' | '1mo' = '1wk',
  periodDays: number = 730
): Promise<Candle[]> {
  try {
    const period1 = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const result: any = await yahooFinance.chart(symbol, {
      period1,
      interval,
    });

    if (!result || !result.quotes || result.quotes.length === 0) {
      console.warn(`No historical ${interval} candles returned for '${symbol}'.`);
      return [];
    }

    const candles: Candle[] = result.quotes
      .filter((q: any) => q.close !== null && q.close !== undefined)
      .map((q: any) => {
        const timeMs = q.date instanceof Date ? q.date.getTime() : new Date(q.date).getTime();
        return {
          openTime: timeMs,
          open: q.open || q.close!,
          high: q.high || q.close!,
          low: q.low || q.close!,
          close: q.close!,
          volume: q.volume || 0,
          closeTime: timeMs,
        };
      });

    return candles;
  } catch (error: any) {
    console.error(`Error fetching Yahoo historical (${interval}) for '${symbol}':`, error?.message || error);
    return [];
  }
}

export async function fetchStockNewsHeadlines(symbol: string, limit: number = 5): Promise<string[]> {
  try {
    const searchResult: any = await yahooFinance.search(symbol, { newsCount: limit });
    if (!searchResult || !searchResult.news || searchResult.news.length === 0) {
      return [`No recent news headlines found for ${symbol}.`];
    }

    const headlines = searchResult.news
      .slice(0, limit)
      .map((n: any) => (n.title || '').trim())
      .filter(Boolean);

    return headlines.length > 0 ? headlines : [`No recent news headlines available for ${symbol}.`];
  } catch (error: any) {
    console.error(`Error fetching news headlines for '${symbol}':`, error?.message || error);
    return [`Unable to retrieve news headlines for ${symbol} at this time.`];
  }
}

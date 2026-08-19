import axios from 'axios';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export async function fetchBinanceKlines(
  symbol: string = 'BTCUSDT',
  interval: string = '5m',
  limit: number = 100
): Promise<Candle[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines`;
    const response = await axios.get(url, {
      params: {
        symbol: symbol.toUpperCase(),
        interval,
        limit,
      },
      timeout: 8000,
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Unexpected response format from Binance API for ${symbol}`);
    }

    const candles: Candle[] = response.data.map((item: any[]) => ({
      openTime: item[0],
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
      closeTime: item[6],
    }));

    return candles;
  } catch (error: any) {
    console.error(`Error fetching Binance klines for ${symbol}:`, error?.message || error);
    throw error;
  }
}

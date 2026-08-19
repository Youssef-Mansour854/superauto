import os
import sys
import time
import csv
import logging
from datetime import datetime, timezone, time as dt_time
from typing import Optional, Dict, Any, List
import pandas as pd
import pandas_ta as ta
import requests
import yfinance as yf
import schedule
from dotenv import load_dotenv

# Configure stdout to UTF-8 if available on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Configure logging for clear, structured output
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("TradingNotifier")

# Step 1: Set up environment loading using python-dotenv
load_dotenv()

# Watchlist symbols formatted for Yahoo Finance
WATCHLIST_SYMBOLS = ["GC=F", "EURUSD=X", "BTC-USD"]


def fetch_market_data(symbol: str, timeframe: str = "15m", limit: int = 500) -> Optional[pd.DataFrame]:
    """
    Fetches live candle data strictly using the yfinance library.

    :param symbol: Yahoo Finance ticker symbol (e.g. 'GC=F', 'EURUSD=X', 'BTC-USD').
    :param timeframe: Candle interval ('15m', '1h', '4h', '1d'). Defaults to '15m'.
    :param limit: Number of candles to fetch. Defaults to 500.
    :return: Pandas DataFrame with datetime index and OHLCV columns, or None on failure.
    """
    try:
        period_map = {
            "1m": "7d",
            "5m": "60d",
            "15m": "60d",
            "30m": "60d",
            "1h": "730d",
            "4h": "max",
            "1d": "max"
        }
        period = period_map.get(timeframe, "60d")

        ticker = yf.Ticker(symbol)
        df = ticker.history(period=period, interval=timeframe)

        if df is None or df.empty:
            logger.warning(f"No candle data returned for symbol '{symbol}' via yfinance.")
            return None

        # Standardize required OHLCV columns
        required_cols = ["Open", "High", "Low", "Close", "Volume"]
        available_cols = [col for col in required_cols if col in df.columns]
        df = df[available_cols].copy()

        if limit and len(df) > limit:
            df = df.tail(limit)

        logger.info(f"Successfully fetched {len(df)} candles for '{symbol}' from Yahoo Finance.")
        return df

    except Exception as e:
        logger.error(f"Error fetching market data for '{symbol}' via yfinance: {e}")
        return None


def calculate_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Appends technical indicators (EMA 50, EMA 200, RSI 14, MACD, ATR 14) to the DataFrame
    using pandas-ta and drops any rows with NaN values.

    :param df: Input DataFrame containing OHLCV candle data.
    :return: Updated DataFrame with indicator columns and no NaN values.
    """
    if df is None or df.empty:
        logger.warning("Empty DataFrame passed to calculate_indicators.")
        return pd.DataFrame()

    df_calculated = df.copy()

    try:
        df_calculated.ta.ema(length=50, append=True)
        df_calculated.ta.ema(length=200, append=True)
        df_calculated.ta.rsi(length=14, append=True)
        df_calculated.ta.macd(fast=12, slow=26, signal=9, append=True)
        df_calculated.ta.atr(length=14, append=True)

        initial_rows = len(df_calculated)
        df_calculated.dropna(inplace=True)
        final_rows = len(df_calculated)

        logger.info(f"Calculated indicators successfully. Active rows: {final_rows}/{initial_rows}.")
        return df_calculated

    except Exception as e:
        logger.error(f"Error occurred during indicator calculation: {e}")
        return df


def check_trading_signals(df: pd.DataFrame, symbol: str, ignore_time_guard: bool = False) -> Optional[Dict[str, Any]]:
    """
    Evaluates strict algorithmic trading rules across two strategies (Hybrid System):

    1. Time Guard: Returns signal only if current UTC time is between 12:00 PM and 16:00 PM.

    2. Strategy 1: Sniper (Mean Reversion)
       - BUY: Close > EMA 200 AND EMA 50 > EMA 200 AND RSI crosses above 30 AND MACD line crosses above Signal line
       - SELL: Close < EMA 200 AND EMA 50 < EMA 200 AND RSI crosses below 70 AND MACD line crosses below Signal line

    3. Strategy 2: Rocket (Momentum Breakout)
       - BUY: EMA 50 > EMA 200 AND Close > EMA 50 AND RSI crosses above 60 AND MACD > Signal
       - SELL: EMA 50 < EMA 200 AND Close < EMA 50 AND RSI crosses below 40 AND MACD < Signal

    4. Dynamic SL & TP:
       - BUY: SL = Close - (1.5 * ATR), TP = Close + (3.0 * ATR)
       - SELL: SL = Close + (1.5 * ATR), TP = Close - (3.0 * ATR)

    :param df: DataFrame with technical indicators.
    :param symbol: Asset ticker symbol.
    :param ignore_time_guard: If True, bypasses 12:00-16:00 UTC time guard check.
    :return: Signal dictionary if conditions met, otherwise None.
    """
    if df is None or len(df) < 2:
        logger.warning(f"Insufficient candle data ({len(df) if df is not None else 0} rows) for symbol '{symbol}'.")
        return None

    if not ignore_time_guard:
        now_utc = datetime.now(timezone.utc).time()
        start_time = dt_time(12, 0, 0)
        end_time = dt_time(16, 0, 0)
        if not (start_time <= now_utc <= end_time):
            logger.info(f"Time Guard Active: Current UTC time ({now_utc.strftime('%H:%M:%S')}) is outside 12:00 - 16:00 UTC window.")
            return None

    prev = df.iloc[-2]
    curr = df.iloc[-1]

    atr_col = "ATRr_14" if "ATRr_14" in df.columns else "ATR_14" if "ATR_14" in df.columns else None
    if not atr_col:
        logger.error("ATR indicator column not found in DataFrame.")
        return None

    close_curr = curr["Close"]
    ema50_curr = curr["EMA_50"]
    ema200_curr = curr["EMA_200"]

    rsi_prev = prev["RSI_14"]
    rsi_curr = curr["RSI_14"]

    macd_prev = prev["MACD_12_26_9"]
    macd_curr = curr["MACD_12_26_9"]
    signal_prev = prev["MACDs_12_26_9"]
    signal_curr = curr["MACDs_12_26_9"]

    atr_curr = curr[atr_col]

    # --- STRATEGY 1: Sniper (Mean Reversion) ---
    s1_buy_trend = (close_curr > ema200_curr) and (ema50_curr > ema200_curr)
    s1_buy_rsi_trigger = (rsi_prev <= 30) and (rsi_curr > 30)
    s1_buy_macd_trigger = (macd_prev <= signal_prev) and (macd_curr > signal_curr)

    if s1_buy_trend and s1_buy_rsi_trigger and s1_buy_macd_trigger:
        sl = close_curr - (atr_curr * 1.5)
        tp = close_curr + (atr_curr * 3.0)
        risk = close_curr - sl
        reward = tp - close_curr
        rr_ratio = round(reward / risk, 2) if risk > 0 else 2.0

        signal = {
            "symbol": symbol,
            "type": "BUY",
            "strategy_name": "Sniper (Mean Reversion)",
            "entry_price": float(round(close_curr, 4)),
            "sl": float(round(sl, 4)),
            "tp": float(round(tp, 4)),
            "risk_reward": float(rr_ratio),
            "timestamp": str(curr.name)
        }
        logger.info(f"BUY Signal (Sniper Mean Reversion) Triggered for {symbol}: Entry=${signal['entry_price']}, SL=${signal['sl']}, TP=${signal['tp']}")
        return signal

    s1_sell_trend = (close_curr < ema200_curr) and (ema50_curr < ema200_curr)
    s1_sell_rsi_trigger = (rsi_prev >= 70) and (rsi_curr < 70)
    s1_sell_macd_trigger = (macd_prev >= signal_prev) and (macd_curr < signal_curr)

    if s1_sell_trend and s1_sell_rsi_trigger and s1_sell_macd_trigger:
        sl = close_curr + (atr_curr * 1.5)
        tp = close_curr - (atr_curr * 3.0)
        risk = sl - close_curr
        reward = close_curr - tp
        rr_ratio = round(reward / risk, 2) if risk > 0 else 2.0

        signal = {
            "symbol": symbol,
            "type": "SELL",
            "strategy_name": "Sniper (Mean Reversion)",
            "entry_price": float(round(close_curr, 4)),
            "sl": float(round(sl, 4)),
            "tp": float(round(tp, 4)),
            "risk_reward": float(rr_ratio),
            "timestamp": str(curr.name)
        }
        logger.info(f"SELL Signal (Sniper Mean Reversion) Triggered for {symbol}: Entry=${signal['entry_price']}, SL=${signal['sl']}, TP=${signal['tp']}")
        return signal

    # --- STRATEGY 2: Rocket (Momentum Breakout) ---
    s2_buy_cond = (
        (ema50_curr > ema200_curr) and
        (close_curr > ema50_curr) and
        (rsi_prev <= 60 and rsi_curr > 60) and
        (macd_curr > signal_curr)
    )

    if s2_buy_cond:
        sl = close_curr - (atr_curr * 1.5)
        tp = close_curr + (atr_curr * 3.0)
        risk = close_curr - sl
        reward = tp - close_curr
        rr_ratio = round(reward / risk, 2) if risk > 0 else 2.0

        signal = {
            "symbol": symbol,
            "type": "BUY",
            "strategy_name": "Rocket (Momentum Breakout)",
            "entry_price": float(round(close_curr, 4)),
            "sl": float(round(sl, 4)),
            "tp": float(round(tp, 4)),
            "risk_reward": float(rr_ratio),
            "timestamp": str(curr.name)
        }
        logger.info(f"BUY Signal (Rocket Momentum Breakout) Triggered for {symbol}: Entry=${signal['entry_price']}, SL=${signal['sl']}, TP=${signal['tp']}")
        return signal

    s2_sell_cond = (
        (ema50_curr < ema200_curr) and
        (close_curr < ema50_curr) and
        (rsi_prev >= 40 and rsi_curr < 40) and
        (macd_curr < signal_curr)
    )

    if s2_sell_cond:
        sl = close_curr + (atr_curr * 1.5)
        tp = close_curr - (atr_curr * 3.0)
        risk = sl - close_curr
        reward = close_curr - tp
        rr_ratio = round(reward / risk, 2) if risk > 0 else 2.0

        signal = {
            "symbol": symbol,
            "type": "SELL",
            "strategy_name": "Rocket (Momentum Breakout)",
            "entry_price": float(round(close_curr, 4)),
            "sl": float(round(sl, 4)),
            "tp": float(round(tp, 4)),
            "risk_reward": float(rr_ratio),
            "timestamp": str(curr.name)
        }
        logger.info(f"SELL Signal (Rocket Momentum Breakout) Triggered for {symbol}: Entry=${signal['entry_price']}, SL=${signal['sl']}, TP=${signal['tp']}")
        return signal

    logger.info(f"No trading signal triggered for symbol '{symbol}'.")
    return None


def send_telegram_alert(
    message: str,
    bot_token: Optional[str] = None,
    chat_id: Optional[str] = None,
    parse_mode: str = "HTML"
) -> bool:
    """
    Sends a notification message to a Telegram Bot.

    :param message: The text message to send (supports HTML formatting).
    :param bot_token: Optional bot token. Reads TELEGRAM_BOT_TOKEN from .env if None.
    :param chat_id: Optional chat ID. Reads TELEGRAM_CHAT_ID from .env if None.
    :param parse_mode: Formatting mode ("HTML" or "MarkdownV2"). Defaults to "HTML".
    :return: True if the message was sent successfully, False otherwise.
    """
    token = bot_token or os.getenv("TELEGRAM_BOT_TOKEN")
    target_chat_id = chat_id or os.getenv("TELEGRAM_CHAT_ID")

    if not token or token == "your_telegram_bot_token_here":
        logger.error("TELEGRAM_BOT_TOKEN is not configured in .env file.")
        return False

    if not target_chat_id or target_chat_id == "your_telegram_chat_id_here":
        logger.error("TELEGRAM_CHAT_ID is not configured in .env file.")
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": target_chat_id,
        "text": message,
        "parse_mode": parse_mode
    }

    try:
        response = requests.post(url, json=payload, timeout=10)
        response.raise_for_status()

        result = response.json()
        if result.get("ok"):
            logger.info("Telegram alert sent successfully.")
            return True
        else:
            description = result.get("description", "Unknown error")
            logger.error(f"Telegram API returned failure: {description}")
            return False

    except requests.exceptions.Timeout:
        logger.error("Request timed out while trying to reach Telegram API.")
        return False
    except requests.exceptions.HTTPError as http_err:
        logger.error(f"HTTP error occurred while sending Telegram alert: {http_err}")
        return False
    except requests.exceptions.RequestException as req_err:
        logger.error(f"Network error occurred while sending Telegram alert: {req_err}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error sending Telegram alert: {e}")
        return False


def format_signal_message(signal: Dict[str, Any]) -> str:
    """
    Formats a trading signal into a highly readable Telegram alert message.

    :param signal: Signal dictionary with symbol, type, strategy_name, entry_price, sl, tp, risk_reward.
    :return: Formatted HTML string for Telegram.
    """
    action_icon = "🟢 BUY" if signal["type"] == "BUY" else "🔴 SELL"
    symbol = signal["symbol"]
    strategy_name = signal.get("strategy_name", "Standard")

    message = (
        f"🚨 <b>TRADING SIGNAL ALERT</b> 🚨\n\n"
        f"<b>Strategy:</b> {strategy_name}\n"
        f"<b>Asset Symbol:</b> {symbol}\n"
        f"<b>Signal Type:</b> {action_icon}\n"
        f"<b>Entry Price:</b> ${signal['entry_price']:,.4f}\n\n"
        f"🛡 <b>Stop Loss (SL):</b> ${signal['sl']:,.4f}\n"
        f"🎯 <b>Take Profit (TP):</b> ${signal['tp']:,.4f}\n"
        f"<b>Risk:Reward Ratio:</b> 1:{signal['risk_reward']}\n\n"
        f"<i>Timestamp: {signal.get('timestamp', 'N/A')} UTC</i>"
    )

    return message


def log_trade(signal: Dict[str, Any], status: str = "ALERT_SENT", filename: str = "trades_log.csv") -> bool:
    """
    Appends trade details to a CSV log file.

    :param signal: Dictionary with trade details (symbol, type, entry_price, sl, tp, risk_reward, timestamp).
    :param status: Status string (defaults to 'ALERT_SENT').
    :param filename: Target CSV log filename. Defaults to 'trades_log.csv'.
    :return: True if successfully written, False otherwise.
    """
    fieldnames = ["Timestamp", "Symbol", "Action", "Entry_Price", "SL", "TP", "Risk_Reward", "Status"]

    timestamp = signal.get("timestamp", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
    symbol = signal.get("symbol", "UNKNOWN")
    action = signal.get("type", "UNKNOWN")
    entry_price = signal.get("entry_price", 0.0)
    sl = signal.get("sl", 0.0)
    tp = signal.get("tp", 0.0)
    risk_reward = signal.get("risk_reward", 0.0)

    row = {
        "Timestamp": timestamp,
        "Symbol": symbol,
        "Action": action,
        "Entry_Price": entry_price,
        "SL": sl,
        "TP": tp,
        "Risk_Reward": risk_reward,
        "Status": status
    }

    try:
        file_exists = os.path.exists(filename) and os.path.getsize(filename) > 0

        with open(filename, mode="a", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames, extrasaction="ignore")
            if not file_exists:
                writer.writeheader()
            writer.writerow(row)

        logger.info(f"Trade successfully logged to '{filename}' for {symbol} ({action}) - Status: {status}.")
        return True

    except (IOError, OSError, PermissionError) as io_err:
        logger.error(f"Permission or I/O error writing to trade log file '{filename}': {io_err}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error logging trade to CSV: {e}")
        return False


def update_pending_trades(filename: str = "trades_log.csv") -> bool:
    """
    Scans trades_log.csv for rows with Status == 'ALERT_SENT', fetches current prices via yfinance,
    evaluates whether SL or TP was reached, updates the CSV, and dispatches Telegram notifications.

    :param filename: CSV log file path. Defaults to 'trades_log.csv'.
    :return: True if process completed successfully, False on error.
    """
    if not os.path.exists(filename) or os.path.getsize(filename) == 0:
        logger.info(f"No trade log file found at '{filename}' to update pending trades.")
        return True

    try:
        rows = []
        fieldnames = ["Timestamp", "Symbol", "Action", "Entry_Price", "SL", "TP", "Risk_Reward", "Status"]

        with open(filename, mode="r", newline="", encoding="utf-8") as csvfile:
            reader = csv.DictReader(csvfile)
            rows = list(reader)

        if not rows:
            return True

        has_pending = any(row.get("Status") == "ALERT_SENT" for row in rows)
        if not has_pending:
            logger.info("No pending trades with status 'ALERT_SENT' to evaluate.")
            return True

        logger.info("Evaluating pending trades with status 'ALERT_SENT'...")
        updated = False

        # Legacy MT5 symbol mapping fallback
        legacy_symbol_map = {
            "XAUUSD": "GC=F",
            "EURUSD": "EURUSD=X",
            "BTCUSD": "BTC-USD"
        }

        for row in rows:
            if row.get("Status") != "ALERT_SENT":
                continue

            symbol = row.get("Symbol")
            action = str(row.get("Action", "")).upper()

            try:
                entry_price = float(row.get("Entry_Price", 0.0))
                sl = float(row.get("SL", 0.0))
                tp = float(row.get("TP", 0.0))
            except (ValueError, TypeError) as parse_err:
                logger.error(f"Invalid price data in CSV row for {symbol}: {parse_err}")
                continue

            if not symbol or sl <= 0 or tp <= 0:
                continue

            fetch_symbol = legacy_symbol_map.get(symbol.upper(), symbol)

            # Fetch current market price via yfinance
            try:
                ticker = yf.Ticker(fetch_symbol)
                history = ticker.history(period="1d")
                if history is None or history.empty:
                    logger.warning(f"Unable to fetch current price for {symbol} ({fetch_symbol}) to check pending trade.")
                    continue
                current_price = float(history["Close"].iloc[-1])
            except Exception as yf_err:
                logger.error(f"Network error fetching current price for {symbol} via yfinance: {yf_err}")
                continue

            new_status = None

            if action == "BUY":
                if current_price >= tp:
                    new_status = "WIN"
                elif current_price <= sl:
                    new_status = "LOSS"
            elif action == "SELL":
                if current_price <= tp:
                    new_status = "WIN"
                elif current_price >= sl:
                    new_status = "LOSS"

            if new_status:
                row["Status"] = new_status
                updated = True
                logger.info(f"Pending Trade Closed for {symbol} ({action}) -> Outcome: {new_status} (Current Price: ${current_price:,.4f})")

                # Dispatch Telegram alert for closed trade
                if new_status == "WIN":
                    alert_text = (
                        f"🎯 <b>TRADE WON!</b> {symbol} has reached Take Profit.\n\n"
                        f"<b>Asset Symbol:</b> {symbol}\n"
                        f"<b>Action:</b> {action}\n"
                        f"<b>Entry Price:</b> ${entry_price:,.4f}\n"
                        f"<b>Exit Price:</b> ${current_price:,.4f}\n"
                        f"<b>Take Profit (TP):</b> ${tp:,.4f}"
                    )
                else:
                    alert_text = (
                        f"🛡 <b>TRADE LOST.</b> {symbol} hit Stop Loss.\n\n"
                        f"<b>Asset Symbol:</b> {symbol}\n"
                        f"<b>Action:</b> {action}\n"
                        f"<b>Entry Price:</b> ${entry_price:,.4f}\n"
                        f"<b>Exit Price:</b> ${current_price:,.4f}\n"
                        f"<b>Stop Loss (SL):</b> ${sl:,.4f}"
                    )

                send_telegram_alert(alert_text)

        if updated:
            with open(filename, mode="w", newline="", encoding="utf-8") as csvfile:
                writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)
            logger.info(f"Successfully updated outcomes in '{filename}'.")

        return True

    except (IOError, OSError, PermissionError) as io_err:
        logger.error(f"File locking/IO error while updating pending trades in '{filename}': {io_err}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error in update_pending_trades: {e}", exc_info=True)
        return False


def main_job(symbols: Optional[List[str]] = None, ignore_time_guard: bool = False):
    """
    Automated scan job that iterates over watchlist symbols, fetches yfinance data, calculates indicators,
    evaluates signals, logs alert status to CSV, and dispatches Telegram alerts.
    """
    # Step 1: Update outcomes of any pending trades before scanning for new signals
    try:
        update_pending_trades()
    except Exception as e:
        logger.error(f"Error running update_pending_trades in main_job cycle: {e}")

    target_symbols = symbols or WATCHLIST_SYMBOLS
    logger.info(f"--- Starting Automated Scan for Symbols: {target_symbols} ---")

    for symbol in target_symbols:
        try:
            logger.info(f"Processing symbol: {symbol}")
            df_raw = fetch_market_data(symbol, timeframe="5m", limit=500)
            if df_raw is None or df_raw.empty:
                continue

            df_indicators = calculate_indicators(df_raw)
            if df_indicators.empty:
                continue

            signal = check_trading_signals(df_indicators, symbol, ignore_time_guard=ignore_time_guard)
            if signal:
                log_trade(signal, status="ALERT_SENT")
                alert_text = format_signal_message(signal)
                send_telegram_alert(alert_text)

        except Exception as err:
            logger.error(f"Error processing symbol '{symbol}': {err}", exc_info=True)

    logger.info("--- Automated Scan Completed ---")


def start_engine():
    """
    Starts the notification-only trading signal engine.
    """
    logger.info("==========================================================")
    logger.info(" Starting Notification-Only Trading Signal Engine ")
    logger.info("==========================================================")
    logger.info(f"Watchlist: {WATCHLIST_SYMBOLS}")
    logger.info("Interval: Every 5 Minutes")

    main_job()
    schedule.every(5).minutes.do(main_job)

    logger.info("Scheduler active. Waiting for next 5-minute cycle... (Press Ctrl+C to exit)")

    while True:
        try:
            schedule.run_pending()
            time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Trading Signal Engine stopped by user.")
            break
        except Exception as e:
            logger.error(f"Error in main execution loop: {e}", exc_info=True)
            time.sleep(5)


if __name__ == "__main__":
    start_engine()

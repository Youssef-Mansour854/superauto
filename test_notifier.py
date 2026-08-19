import os
import unittest
from unittest.mock import patch, MagicMock
import pandas as pd
import numpy as np
import tempfile
import csv

# Import functions to test
from notifier import (
    fetch_market_data,
    calculate_indicators,
    check_trading_signals,
    send_telegram_alert,
    format_signal_message,
    log_trade,
    update_pending_trades,
    main_job
)


class TestTradingNotifier(unittest.TestCase):

    def setUp(self):
        """Generate synthetic OHLCV candle data for testing indicators and signals."""
        dates = pd.date_range(start="2026-01-01", periods=300, freq="15min")
        np.random.seed(42)
        close = 100 + np.cumsum(np.random.randn(300))
        high = close + np.abs(np.random.randn(300))
        low = close - np.abs(np.random.randn(300))
        open_p = close + np.random.randn(300)
        volume = np.random.randint(1000, 50000, size=300)

        self.sample_df = pd.DataFrame({
            "Open": open_p,
            "High": high,
            "Low": low,
            "Close": close,
            "Volume": volume
        }, index=dates)

    @patch("notifier.yf.Ticker")
    def test_fetch_market_data_yfinance_success(self, mock_ticker):
        """Test fetch_market_data fetches yfinance rates and constructs DataFrame correctly."""
        mock_instance = MagicMock()
        mock_instance.history.return_value = self.sample_df
        mock_ticker.return_value = mock_instance

        df = fetch_market_data("GC=F", timeframe="15m", limit=300)

        self.assertIsNotNone(df)
        self.assertFalse(df.empty)
        self.assertEqual(len(df), 300)

    def test_calculate_indicators(self):
        """Test calculate_indicators appends required indicators and drops NaN values."""
        df_ind = calculate_indicators(self.sample_df)

        self.assertFalse(df_ind.empty)
        required_cols = ["EMA_50", "EMA_200", "RSI_14", "MACD_12_26_9", "ATRr_14"]
        for col in required_cols:
            self.assertIn(col, df_ind.columns, f"Missing required column: {col}")

        self.assertEqual(df_ind.isnull().sum().sum(), 0)

    def test_format_signal_message(self):
        """Test format_signal_message outputs correct alert formatting including strategy name."""
        signal = {
            "symbol": "GC=F",
            "type": "BUY",
            "strategy_name": "Rocket (Momentum Breakout)",
            "entry_price": 2500.0,
            "sl": 2480.0,
            "tp": 2540.0,
            "risk_reward": 2.0,
            "timestamp": "2026-08-15 14:30:00"
        }

        msg = format_signal_message(signal)
        self.assertIn("🚨 <b>TRADING SIGNAL ALERT</b> 🚨", msg)
        self.assertIn("<b>Strategy:</b> Rocket (Momentum Breakout)", msg)
        self.assertIn("<b>Asset Symbol:</b> GC=F", msg)
        self.assertIn("<b>Entry Price:</b> $2,500.0000", msg)

    def test_log_trade(self):
        """Test log_trade writes alert record with status ALERT_SENT to CSV file and ignores extra keys."""
        signal = {
            "symbol": "EURUSD=X",
            "type": "BUY",
            "strategy_name": "Rocket (Momentum Breakout)",
            "entry_price": 1.0850,
            "sl": 1.0800,
            "tp": 1.0950,
            "risk_reward": 2.0,
            "timestamp": "2026-08-15 14:30:00"
        }

        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as tmp:
            tmp_path = tmp.name

        try:
            success = log_trade(signal, status="ALERT_SENT", filename=tmp_path)
            self.assertTrue(success)
            with open(tmp_path, "r", encoding="utf-8") as f:
                content = f.read()
                self.assertIn("EURUSD=X", content)
                self.assertIn("ALERT_SENT", content)
                # Verify header contains exact original schema
                header = content.splitlines()[0]
                self.assertEqual(header, "Timestamp,Symbol,Action,Entry_Price,SL,TP,Risk_Reward,Status")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_check_trading_signals_strategy1_mean_reversion(self):
        """Test check_trading_signals triggers Strategy 1 (Sniper Mean Reversion) BUY signal."""
        df_data = pd.DataFrame({
            "Close": [100.0, 105.0],
            "EMA_50": [102.0, 103.0],
            "EMA_200": [90.0, 91.0],
            "RSI_14": [28.0, 35.0],  # RSI crosses above 30
            "MACD_12_26_9": [0.1, 0.5],
            "MACDs_12_26_9": [0.2, 0.4],  # MACD crosses above Signal
            "ATRr_14": [2.0, 2.0]
        }, index=pd.date_range("2026-08-15 12:00", periods=2, freq="15min"))

        signal = check_trading_signals(df_data, "BTC-USD", ignore_time_guard=True)
        self.assertIsNotNone(signal)
        self.assertEqual(signal["type"], "BUY")
        self.assertEqual(signal["strategy_name"], "Sniper (Mean Reversion)")

    def test_check_trading_signals_strategy2_momentum_breakout_buy(self):
        """Test check_trading_signals triggers Strategy 2 (Rocket Momentum Breakout) BUY signal."""
        df_data = pd.DataFrame({
            "Close": [100.0, 110.0],  # close > ema50 (110 > 105)
            "EMA_50": [102.0, 105.0],  # ema50 > ema200 (105 > 90)
            "EMA_200": [90.0, 90.0],
            "RSI_14": [58.0, 65.0],  # rsi_prev <= 60 and rsi_curr > 60
            "MACD_12_26_9": [0.5, 0.8],
            "MACDs_12_26_9": [0.3, 0.4],  # macd > signal (0.8 > 0.4)
            "ATRr_14": [2.0, 2.0]
        }, index=pd.date_range("2026-08-15 12:00", periods=2, freq="15min"))

        signal = check_trading_signals(df_data, "BTC-USD", ignore_time_guard=True)
        self.assertIsNotNone(signal)
        self.assertEqual(signal["type"], "BUY")
        self.assertEqual(signal["strategy_name"], "Rocket (Momentum Breakout)")

    def test_check_trading_signals_strategy2_momentum_breakout_sell(self):
        """Test check_trading_signals triggers Strategy 2 (Rocket Momentum Breakout) SELL signal."""
        df_data = pd.DataFrame({
            "Close": [100.0, 85.0],  # close < ema50 (85 < 95)
            "EMA_50": [98.0, 95.0],  # ema50 < ema200 (95 < 110)
            "EMA_200": [110.0, 110.0],
            "RSI_14": [42.0, 35.0],  # rsi_prev >= 40 and rsi_curr < 40
            "MACD_12_26_9": [-0.5, -0.8],
            "MACDs_12_26_9": [-0.3, -0.4],  # macd < signal (-0.8 < -0.4)
            "ATRr_14": [2.0, 2.0]
        }, index=pd.date_range("2026-08-15 12:00", periods=2, freq="15min"))

        signal = check_trading_signals(df_data, "BTC-USD", ignore_time_guard=True)
        self.assertIsNotNone(signal)
        self.assertEqual(signal["type"], "SELL")
        self.assertEqual(signal["strategy_name"], "Rocket (Momentum Breakout)")

    @patch("notifier.send_telegram_alert")
    @patch("notifier.yf.Ticker")
    def test_update_pending_trades_win_and_loss(self, mock_ticker, mock_send_alert):
        """Test update_pending_trades correctly updates status to WIN and LOSS based on market prices."""
        fieldnames = ["Timestamp", "Symbol", "Action", "Entry_Price", "SL", "TP", "Risk_Reward", "Status"]

        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".csv", newline="", encoding="utf-8") as tmp:
            tmp_path = tmp.name
            writer = csv.DictWriter(tmp, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerow({
                "Timestamp": "2026-08-15 12:00:00",
                "Symbol": "BTC-USD",
                "Action": "BUY",
                "Entry_Price": "60000.0",
                "SL": "59000.0",
                "TP": "62000.0",
                "Risk_Reward": "2.0",
                "Status": "ALERT_SENT"
            })
            writer.writerow({
                "Timestamp": "2026-08-15 12:15:00",
                "Symbol": "EURUSD=X",
                "Action": "SELL",
                "Entry_Price": "1.0800",
                "SL": "1.0850",
                "TP": "1.0700",
                "Risk_Reward": "2.0",
                "Status": "ALERT_SENT"
            })

        # Mock price return for BTC-USD (reaches TP=62000 -> WIN)
        mock_btc_hist = pd.DataFrame({"Close": [62500.0]})
        # Mock price return for EURUSD=X (reaches SL=1.0850 -> LOSS)
        mock_eur_hist = pd.DataFrame({"Close": [1.0860]})

        def ticker_side_effect(symbol):
            mock_inst = MagicMock()
            if symbol == "BTC-USD":
                mock_inst.history.return_value = mock_btc_hist
            else:
                mock_inst.history.return_value = mock_eur_hist
            return mock_inst

        mock_ticker.side_effect = ticker_side_effect

        try:
            result = update_pending_trades(filename=tmp_path)
            self.assertTrue(result)

            with open(tmp_path, "r", encoding="utf-8") as f:
                reader = list(csv.DictReader(f))
                self.assertEqual(reader[0]["Status"], "WIN")
                self.assertEqual(reader[1]["Status"], "LOSS")

            self.assertEqual(mock_send_alert.call_count, 2)

        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)


if __name__ == "__main__":
    unittest.main()


import sys
import MetaTrader5 as mt5
from notifier import initialize_mt5

# Configure stdout for safe console printing
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

print("===================================")
print(" Testing Active MT5 Connection ")
print("===================================")

# Connect to MetaTrader 5 using project initialize_mt5()
if not initialize_mt5():
    err = mt5.last_error()
    print("❌ Connection Failed! Error code:", err)
    print("\n👉 Diagnostic Tips:")
    print("1. Make sure MetaTrader 5 Terminal application is open on your PC.")
    print("2. Check the 'Algo Trading' button in MT5 (make sure it shows green 🟢).")
    print("3. Verify MT5_LOGIN, MT5_PASSWORD, and MT5_SERVER in your .env file.")
else:
    print("✅ SUCCESS! Connected to MetaTrader 5.")
    account_info = mt5.account_info()
    term_info = mt5.terminal_info()
    if account_info is not None:
        print(f"Logged in Account: {account_info.login}")
        print(f"Broker Server:   {account_info.server}")
        print(f"Account Balance: {account_info.balance} {account_info.currency}")
        print(f"Company:         {account_info.company}")
    if term_info is not None:
        print(f"Terminal Path:   {term_info.path}")
        print(f"Connected State: {term_info.connected}")

    mt5.shutdown()

print("===================================")

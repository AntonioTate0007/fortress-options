import yfinance as yf
import pandas as pd
import requests
import schedule
import time
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# Tickers to monitor
WATCHLIST = ['SPY', 'QQQ', 'AAPL', 'AMZN', 'MSFT', 'GOOGL']

def send_telegram_alert(message):
    """Sends a trade alert to the designated Telegram chat."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram credentials missing in .env file. Could not send alert.")
        print(message)
        return
        
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown"
    }
    
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        print("Success: Telegram alert sent.")
    except Exception as e:
        print(f"Failed to send Telegram alert: {e}")

def has_earnings_before_expiration(ticker_obj, expiration_date_str):
    """
    Check if the stock has an upcoming earnings report before the expiration date.
    Returns True if an earnings date is found before expiration.
    """
    return False # yfinance earnings data can be unreliable for free APIs. Returning false for now.
    
def scan_ticker(symbol):
    """Scans a single ticker for high-probability put credit spreads."""
    print(f"Scanning {symbol}...")
    try:
        ticker = yf.Ticker(symbol)
        
        # Get current price
        todays_data = ticker.history(period='1d')
        if todays_data.empty:
            print(f"Could not fetch price for {symbol}")
            return
            
        current_price = todays_data['Close'].iloc[0]
        
        # Get available expiration dates
        options = ticker.options
        if not options:
            return
            
        today = datetime.now()
        target_min_date = today + timedelta(days=7)
        target_max_date = today + timedelta(days=14)
        
        # Filter for expirations 7-14 days out
        valid_expirations = []
        for exp in options:
            exp_date = datetime.strptime(exp, '%Y-%m-%d')
            if target_min_date <= exp_date <= target_max_date:
                valid_expirations.append((exp, exp_date))
                
        if not valid_expirations:
            return
            
        for exp_str, exp_date in valid_expirations:
            dte = (exp_date - today).days
            
            # Simplified Earnings filter check (usually skip for ETFs)
            if symbol not in ['SPY', 'QQQ']:
                # Note: yf earnings dates are often missing in free tier. In production, 
                # you might want to use a more reliable earnings calendar API here.
                pass
            
            # Get the option chain for this expiration
            chain = ticker.option_chain(exp_str)
            puts = chain.puts
            
            # Drop illiquid options (no bid/ask)
            puts = puts[(puts['bid'] > 0) & (puts['ask'] > 0)]
            
            if puts.empty:
                continue

            # Identify valid short put strikes (5% to 8% below current price)
            min_strike = current_price * 0.92  # 8% below
            max_strike = current_price * 0.95  # 5% below
            
            # Filter puts in this safety zone
            candidate_short_puts = puts[(puts['strike'] >= min_strike) & (puts['strike'] <= max_strike)]
            
            for _, short_put in candidate_short_puts.iterrows():
                short_strike = short_put['strike']
                short_bid = short_put['bid']
                
                # The long put strike must be exactly $5 below the short strike
                long_strike = short_strike - 5.0
                
                # Find the corresponding long put
                long_put_match = puts[puts['strike'] == long_strike]
                
                if long_put_match.empty:
                    continue
                    
                long_put = long_put_match.iloc[0]
                long_ask = long_put['ask']
                
                # Calculate estimated credit
                # We sell at the bid, buy at the ask to be conservative with fills
                est_credit = short_bid - long_ask
                
                # Check if premium meets our criteria ($0.35 to $0.80)
                if 0.35 <= est_credit <= 0.80:
                    buffer_pct = ((current_price - short_strike) / current_price) * 100
                    buffer_amt = current_price - short_strike
                    max_risk = 5.0 - est_credit
                    
                    message = (
                        f"🏰 **FORTRESS PLAY FOUND** 🏰\n"
                        f"Ticker: ${symbol}\n"
                        f"Current Price: ${current_price:.2f}\n"
                        f"Expiration: {exp_date.strftime('%B %d')} ({dte} DTE)\n"
                        f"🟢 **SELL:** ${short_strike} Put\n"
                        f"🔴 **BUY:** ${long_strike} Put\n"
                        f"Buffer: ${buffer_amt:.2f} ({buffer_pct:.1f}% out of the money)\n"
                        f"Estimated Credit: ${est_credit:.2f} (${est_credit * 100:.0f} cash)\n"
                        f"Max Risk: ${max_risk * 100:.0f}"
                    )
                    
                    send_telegram_alert(message)
                    
    except Exception as e:
        print(f"Error scanning {symbol}: {e}")

def run_scanner():
    """Main scanning routine."""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting Fortress Options Scan...")
    for symbol in WATCHLIST:
        scan_ticker(symbol)
    print("Scan complete.")

if __name__ == "__main__":
    # Run once immediately upon starting
    run_scanner()
    
    # Schedule the scan daily at 10:00 AM EST
    # Note: If running on a server outside EST, you'll need to adjust the time string 
    # to your server's local equivalent, or use the `pytz` timezone library.
    schedule.every().day.at("10:00").do(run_scanner)
    
    print("Scanner scheduler running. Press Ctrl+C to exit.")
    while True:
        schedule.run_pending()
        time.sleep(60)

"""
Standalone Fortress Options scanner — the original prototype from rules.md.
The production scanner lives in backend/api.py; this file is kept as a simple
script you can run on a desktop or VPS without FastAPI.

  python scanner.py   # runs once now, then every day at 10:00 AM (local time)

Env vars (see .env.example):
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHAT_ID
"""
import logging
import os
import sys
import time
from datetime import datetime, timedelta

import pandas as pd  # noqa: F401  (yfinance pulls it in; keep explicit for clarity)
import requests
import schedule
import yfinance as yf
from dotenv import load_dotenv

# Make the shared earnings module importable regardless of CWD
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
from earnings import has_earnings_in_window  # noqa: E402

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("scanner")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

WATCHLIST = ["SPY", "QQQ", "AAPL", "AMZN", "MSFT", "GOOGL"]
MIN_DTE = 7
MAX_DTE = 14
OTM_BUFFER_MIN = 0.05   # 5% below price
OTM_BUFFER_MAX = 0.08   # 8% below price
PREMIUM_MIN = 0.35
PREMIUM_MAX = 0.80
SPREAD_WIDTH = 5.0


def send_telegram_alert(message: str) -> None:
    """Send a trade alert to the designated Telegram chat."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.warning("Telegram credentials missing in .env — printing instead:\n%s", message)
        return

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "Markdown"}

    try:
        response = requests.post(url, json=payload, timeout=10)
        response.raise_for_status()
        log.info("Telegram alert sent.")
    except Exception as e:
        log.error("Failed to send Telegram alert: %s", e)


def scan_ticker(symbol: str) -> None:
    """Scan a single ticker for high-probability put credit spreads."""
    log.info("Scanning %s...", symbol)
    try:
        ticker = yf.Ticker(symbol)

        todays_data = ticker.history(period="1d")
        if todays_data.empty:
            log.warning("No price data for %s", symbol)
            return
        current_price = float(todays_data["Close"].iloc[0])

        expirations = ticker.options or []
        if not expirations:
            return

        today = datetime.now()
        target_min = today + timedelta(days=MIN_DTE)
        target_max = today + timedelta(days=MAX_DTE)

        valid_expirations = []
        for exp in expirations:
            exp_date = datetime.strptime(exp, "%Y-%m-%d")
            if target_min <= exp_date <= target_max:
                valid_expirations.append((exp, exp_date))

        if not valid_expirations:
            return

        # Earnings filter — shared logic. ETFs (SPY/QQQ) bypass automatically.
        has_earn, earn_date = has_earnings_in_window(symbol, MAX_DTE)
        if has_earn:
            log.info("  %s: earnings on %s — skipping", symbol, earn_date)
            return

        for exp_str, exp_date in valid_expirations:
            dte = (exp_date - today).days

            chain = ticker.option_chain(exp_str)
            puts = chain.puts
            puts = puts[(puts["bid"] > 0) & (puts["ask"] > 0)]
            if puts.empty:
                continue

            min_strike = current_price * (1 - OTM_BUFFER_MAX)  # 8% below
            max_strike = current_price * (1 - OTM_BUFFER_MIN)  # 5% below

            candidate_shorts = puts[
                (puts["strike"] >= min_strike) & (puts["strike"] <= max_strike)
            ]

            for _, short_put in candidate_shorts.iterrows():
                short_strike = float(short_put["strike"])
                long_strike = short_strike - SPREAD_WIDTH

                long_match = puts[puts["strike"] == long_strike]
                if long_match.empty:
                    continue
                long_put = long_match.iloc[0]

                # Conservative fill assumption: sell at bid, buy at ask
                est_credit = float(short_put["bid"]) - float(long_put["ask"])

                if not (PREMIUM_MIN <= est_credit <= PREMIUM_MAX):
                    continue

                buffer_pct = ((current_price - short_strike) / current_price) * 100
                buffer_amt = current_price - short_strike
                max_risk = SPREAD_WIDTH - est_credit

                message = (
                    f"🏰 **FORTRESS PLAY FOUND** 🏰\n"
                    f"Ticker: ${symbol}\n"
                    f"Current Price: ${current_price:.2f}\n"
                    f"Expiration: {exp_date.strftime('%B %d')} ({dte} DTE)\n"
                    f"🟢 **SELL:** ${short_strike:.0f} Put\n"
                    f"🔴 **BUY:** ${long_strike:.0f} Put\n"
                    f"Buffer: ${buffer_amt:.2f} ({buffer_pct:.1f}% out of the money)\n"
                    f"Estimated Credit: ${est_credit:.2f} (${est_credit * 100:.0f} cash)\n"
                    f"Max Risk: ${max_risk * 100:.0f}"
                )
                send_telegram_alert(message)

    except Exception as e:
        log.exception("Error scanning %s: %s", symbol, e)


def run_scanner() -> None:
    """Main scanning routine."""
    log.info("[%s] Starting Fortress Options scan…", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    for symbol in WATCHLIST:
        scan_ticker(symbol)
    log.info("Scan complete.")


if __name__ == "__main__":
    run_scanner()

    # Schedule daily 10:00 (local server time — use pytz / cron for strict ET)
    schedule.every().day.at("10:00").do(run_scanner)

    log.info("Scanner scheduler running. Ctrl+C to exit.")
    try:
        while True:
            schedule.run_pending()
            time.sleep(60)
    except KeyboardInterrupt:
        log.info("Scanner stopped by user.")

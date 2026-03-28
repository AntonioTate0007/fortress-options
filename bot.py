import os
import time
import threading
import schedule
import requests
import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta
from dotenv import load_dotenv
from PIL import Image, ImageDraw
from infi.systray import SysTrayIcon

load_dotenv()

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

WATCHLIST = ['SPY', 'QQQ', 'AAPL', 'AMZN', 'MSFT', 'GOOGL']
SPREAD_WIDTH = 5.0
MIN_DTE = 7
MAX_DTE = 14
OTM_BUFFER_MIN = 0.05
OTM_BUFFER_MAX = 0.08
PREMIUM_MIN = 0.35
PREMIUM_MAX = 0.80

# Special watches — scanned separately with custom conditions
# Format: { symbol: { 'max_price': float, ... } }
SPECIAL_WATCH = {
    'SERV': {'max_price': 9.50},
}

# Track already-alerted plays to avoid spam (resets daily)
_alerted_today = set()


def send_telegram_message(message):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("Error: Telegram credentials missing in .env")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "Markdown"}
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
    except Exception as e:
        print(f"Failed to send Telegram message: {e}")


def is_trading_day():
    """Returns True if today is Monday–Friday."""
    return datetime.now().weekday() < 5


def is_market_open():
    """Returns True during approximate market hours 9:30–16:00."""
    now = datetime.now()
    return now.weekday() < 5 and (
        now.replace(hour=9, minute=30, second=0) <= now <= now.replace(hour=16, minute=0, second=0)
    )


def get_earnings_date(ticker_symbol):
    """Returns the next earnings date as a datetime, or None."""
    if ticker_symbol in ['SPY', 'QQQ']:
        return None
    try:
        ticker = yf.Ticker(ticker_symbol)
        calendar = ticker.calendar
        if calendar is not None and not calendar.empty:
            if isinstance(calendar, dict):
                ed = calendar.get('Earnings Date', [None])[0]
            else:
                ed = calendar.iloc[0, 0]
            if ed:
                return pd.Timestamp(ed).to_pydatetime().replace(tzinfo=None)
    except Exception:
        pass
    return None


def get_price(symbol):
    """Returns current price or None."""
    try:
        ticker = yf.Ticker(symbol)
        price = ticker.fast_info['last_price']
        return round(price, 2)
    except Exception:
        return None


# ─── MORNING BRIEFING ────────────────────────────────────────────────────────

def send_morning_briefing():
    if not is_trading_day():
        return
    print(f"[{datetime.now()}] Sending morning briefing...")

    lines = ["☀️ *FORTRESS MORNING BRIEFING*", f"📅 {datetime.now().strftime('%A, %B %d %Y')} | 8:30 AM\n"]

    # Market overview
    lines.append("📊 *Market Snapshot*")
    for sym in ['SPY', 'QQQ', 'VIX']:
        price = get_price(sym)
        if price:
            lines.append(f"  • {sym}: ${price}")

    # Upcoming earnings on watchlist
    lines.append("\n📣 *Upcoming Earnings (Watchlist)*")
    any_earnings = False
    for sym in WATCHLIST:
        ed = get_earnings_date(sym)
        if ed:
            days_away = (ed - datetime.now()).days
            if 0 <= days_away <= 7:
                lines.append(f"  • {sym}: {ed.strftime('%b %d')} ({days_away}d away)")
                any_earnings = True
    if not any_earnings:
        lines.append("  None in the next 7 days")

    # SERV special watch status
    serv_price = get_price('SERV')
    if serv_price:
        status = f"✅ ${serv_price:.2f} — UNDER $9.50, watching for setups" if serv_price < 9.50 else f"⏸ ${serv_price:.2f} — above $9.50, not scanning"
        lines.append(f"\n👀 *SERV Watch*: {status}")

    lines.append("\n🔍 *Running Fortress scan now...*")
    send_telegram_message("\n".join(lines))

    # Run the full scan right after
    scan_fortress_plays(source="morning")
    scan_special_watches()


# ─── EARNINGS PLAYS SCANNER ──────────────────────────────────────────────────

def scan_earnings_plays():
    """
    Looks for stocks with earnings in 1–3 days and finds short-dated
    credit spread setups to sell elevated IV before the announcement.
    """
    if not is_trading_day():
        return
    print(f"[{datetime.now()}] Scanning earnings plays...")

    for symbol in WATCHLIST:
        if symbol in ['SPY', 'QQQ']:
            continue
        try:
            ed = get_earnings_date(symbol)
            if not ed:
                continue
            days_to_earnings = (ed - datetime.now()).days
            if not (1 <= days_to_earnings <= 3):
                continue

            ticker = yf.Ticker(symbol)
            current_price = ticker.fast_info['last_price']
            expirations = ticker.options
            today = datetime.now()

            # Look for expiration 0–3 DTE (before earnings)
            target_exp = None
            for exp in expirations:
                exp_date = datetime.strptime(exp, '%Y-%m-%d')
                diff = (exp_date - today).days
                if 0 <= diff <= days_to_earnings:
                    target_exp = (exp, exp_date, diff)
                    break

            if not target_exp:
                continue

            exp_str, exp_date, dte = target_exp
            chain = ticker.option_chain(exp_str)
            puts = chain.puts
            puts = puts[(puts['bid'] > 0) & (puts['ask'] > 0)]
            if puts.empty:
                continue

            lower_bound = current_price * 0.92
            upper_bound = current_price * 0.95
            candidates = puts[(puts['strike'] >= lower_bound) & (puts['strike'] <= upper_bound)]

            for _, short_put in candidates.iterrows():
                short_strike = short_put['strike']
                long_strike = short_strike - SPREAD_WIDTH
                long_put_row = puts[puts['strike'] == long_strike]
                if long_put_row.empty:
                    continue

                long_put = long_put_row.iloc[0]
                short_mid = (short_put['bid'] + short_put['ask']) / 2
                long_mid = (long_put['bid'] + long_put['ask']) / 2
                net_credit = short_mid - long_mid

                if net_credit >= PREMIUM_MIN:
                    alert_key = f"EARNINGS_{symbol}_{short_strike}_{exp_str}"
                    if alert_key in _alerted_today:
                        break

                    buffer_pct = ((current_price - short_strike) / current_price) * 100
                    max_risk = (SPREAD_WIDTH * 100) - (net_credit * 100)

                    alert = (
                        "📣 *EARNINGS PLAY ALERT* 📣\n"
                        f"Ticker: ${symbol}\n"
                        f"⚠️ Earnings in *{days_to_earnings} day(s)* ({ed.strftime('%b %d')})\n"
                        f"Current Price: ${current_price:.2f}\n"
                        f"Expiration: {exp_str} ({dte} DTE — *expires before earnings*)\n"
                        f"🟢 *SELL:* ${short_strike} Put\n"
                        f"🔴 *BUY:* ${long_strike} Put\n"
                        f"Buffer: {buffer_pct:.1f}% OTM\n"
                        f"Estimated Credit: ${net_credit:.2f} (${net_credit*100:.0f} cash)\n"
                        f"Max Risk: ${max_risk:.0f}\n"
                        f"_Selling IV before earnings announcement_"
                    )
                    send_telegram_message(alert)
                    _alerted_today.add(alert_key)
                    print(f"Earnings play alert sent for {symbol}")
                    break

        except Exception as e:
            print(f"Error scanning earnings play for {symbol}: {e}")


# ─── FORTRESS SCAN ───────────────────────────────────────────────────────────

def scan_fortress_plays(source="intraday"):
    print(f"[{datetime.now()}] Starting Fortress scan ({source})...")
    found_plays = 0

    for symbol in WATCHLIST:
        try:
            ticker = yf.Ticker(symbol)
            current_price = ticker.fast_info['last_price']
            earnings_date = get_earnings_date(symbol)
            expirations = ticker.options
            today = datetime.now()

            target_date = None
            dte = 0
            for exp in expirations:
                exp_date = datetime.strptime(exp, '%Y-%m-%d')
                diff = (exp_date - today).days
                if MIN_DTE <= diff <= MAX_DTE:
                    if earnings_date and earnings_date <= exp_date:
                        print(f"Skipping {symbol} – earnings {earnings_date.date()} before exp {exp}")
                        continue
                    target_date = exp
                    dte = diff
                    break

            if not target_date:
                continue

            opt_chain = ticker.option_chain(target_date)
            puts = opt_chain.puts
            puts = puts[(puts['bid'] > 0) & (puts['ask'] > 0)]

            lower_bound = current_price * (1 - OTM_BUFFER_MAX)
            upper_bound = current_price * (1 - OTM_BUFFER_MIN)
            candidates = puts[(puts['strike'] >= lower_bound) & (puts['strike'] <= upper_bound)]

            for _, short_put in candidates.iterrows():
                short_strike = short_put['strike']
                long_strike = short_strike - SPREAD_WIDTH
                long_put_row = puts[puts['strike'] == long_strike]
                if long_put_row.empty:
                    continue

                long_put = long_put_row.iloc[0]
                short_mid = (short_put['bid'] + short_put['ask']) / 2
                long_mid = (long_put['bid'] + long_put['ask']) / 2
                net_credit = short_mid - long_mid

                if PREMIUM_MIN <= net_credit <= PREMIUM_MAX:
                    alert_key = f"{symbol}_{short_strike}_{target_date}"
                    if alert_key in _alerted_today:
                        break  # already sent today

                    buffer_amt = current_price - short_strike
                    buffer_pct = (buffer_amt / current_price) * 100
                    max_risk = (SPREAD_WIDTH * 100) - (net_credit * 100)

                    alert = (
                        "🏰 *FORTRESS PLAY FOUND* 🏰\n"
                        f"Ticker: ${symbol}\n"
                        f"Current Price: ${current_price:.2f}\n"
                        f"Expiration: {target_date} ({dte} DTE)\n"
                        f"🟢 *SELL:* ${short_strike} Put\n"
                        f"🔴 *BUY:* ${long_strike} Put\n"
                        f"Buffer: ${buffer_amt:.2f} ({buffer_pct:.1f}% OTM)\n"
                        f"Estimated Credit: ${net_credit:.2f} (${net_credit*100:.0f} cash)\n"
                        f"Max Risk: ${max_risk:.0f}"
                    )

                    send_telegram_message(alert)
                    _alerted_today.add(alert_key)
                    print(f"Alert sent for {symbol} ${short_strike}/${long_strike}")
                    found_plays += 1
                    break

        except Exception as e:
            print(f"Error scanning {symbol}: {e}")

    if found_plays == 0 and source == "morning":
        send_telegram_message("🔍 Morning scan complete — no Fortress plays found right now.")

    print(f"Scan complete. Found {found_plays} plays.")


def send_10am_followup():
    """
    10:00 AM follow-up scan — market has opened and settled for ~30 min.
    Collects all current plays and sends a single summary, ignoring the
    morning dedup so you see what's live right now.
    """
    if not is_trading_day():
        return
    print(f"[{datetime.now()}] Running 10 AM follow-up scan...")

    plays = []
    earnings_plays = []

    # ── Fortress plays ────────────────────────────────────────────────────────
    for symbol in WATCHLIST:
        try:
            ticker = yf.Ticker(symbol)
            current_price = ticker.fast_info['last_price']
            earnings_date = get_earnings_date(symbol)
            expirations = ticker.options
            today = datetime.now()

            target_date = None
            dte = 0
            for exp in expirations:
                exp_date = datetime.strptime(exp, '%Y-%m-%d')
                diff = (exp_date - today).days
                if MIN_DTE <= diff <= MAX_DTE:
                    if earnings_date and earnings_date <= exp_date:
                        continue
                    target_date = exp
                    dte = diff
                    break

            if not target_date:
                continue

            opt_chain = ticker.option_chain(target_date)
            puts = opt_chain.puts
            puts = puts[(puts['bid'] > 0) & (puts['ask'] > 0)]

            lower_bound = current_price * (1 - OTM_BUFFER_MAX)
            upper_bound = current_price * (1 - OTM_BUFFER_MIN)
            candidates = puts[(puts['strike'] >= lower_bound) & (puts['strike'] <= upper_bound)]

            for _, short_put in candidates.iterrows():
                short_strike = short_put['strike']
                long_strike = short_strike - SPREAD_WIDTH
                long_put_row = puts[puts['strike'] == long_strike]
                if long_put_row.empty:
                    continue

                long_put = long_put_row.iloc[0]
                short_mid = (short_put['bid'] + short_put['ask']) / 2
                long_mid = (long_put['bid'] + long_put['ask']) / 2
                net_credit = short_mid - long_mid

                if PREMIUM_MIN <= net_credit <= PREMIUM_MAX:
                    buffer_pct = ((current_price - short_strike) / current_price) * 100
                    max_risk = (SPREAD_WIDTH * 100) - (net_credit * 100)
                    plays.append(
                        f"🏰 *{symbol}* — ${short_strike}/{long_strike} Put Spread\n"
                        f"   Price: ${current_price:.2f} | Exp: {target_date} ({dte} DTE)\n"
                        f"   Credit: ${net_credit:.2f} | Buffer: {buffer_pct:.1f}% OTM | Risk: ${max_risk:.0f}"
                    )
                    # Also update main dedup so intraday doesn't double-alert
                    _alerted_today.add(f"{symbol}_{short_strike}_{target_date}")
                    break

        except Exception as e:
            print(f"10AM scan error ({symbol}): {e}")

    # ── Earnings plays ────────────────────────────────────────────────────────
    for symbol in WATCHLIST:
        if symbol in ['SPY', 'QQQ']:
            continue
        try:
            ed = get_earnings_date(symbol)
            if not ed:
                continue
            days_to_earnings = (ed - datetime.now()).days
            if not (1 <= days_to_earnings <= 3):
                continue

            ticker = yf.Ticker(symbol)
            current_price = ticker.fast_info['last_price']
            expirations = ticker.options
            today = datetime.now()

            target_exp = None
            for exp in expirations:
                exp_date = datetime.strptime(exp, '%Y-%m-%d')
                diff = (exp_date - today).days
                if 0 <= diff <= days_to_earnings:
                    target_exp = (exp, exp_date, diff)
                    break

            if not target_exp:
                continue

            exp_str, exp_date, dte = target_exp
            chain = ticker.option_chain(exp_str)
            puts = chain.puts
            puts = puts[(puts['bid'] > 0) & (puts['ask'] > 0)]
            if puts.empty:
                continue

            lower_bound = current_price * 0.92
            upper_bound = current_price * 0.95
            candidates = puts[(puts['strike'] >= lower_bound) & (puts['strike'] <= upper_bound)]

            for _, short_put in candidates.iterrows():
                short_strike = short_put['strike']
                long_strike = short_strike - SPREAD_WIDTH
                long_put_row = puts[puts['strike'] == long_strike]
                if long_put_row.empty:
                    continue

                long_put = long_put_row.iloc[0]
                net_credit = (short_put['bid'] + short_put['ask']) / 2 - (long_put['bid'] + long_put['ask']) / 2

                if net_credit >= PREMIUM_MIN:
                    buffer_pct = ((current_price - short_strike) / current_price) * 100
                    earnings_plays.append(
                        f"📣 *{symbol}* — Earnings in {days_to_earnings}d ({ed.strftime('%b %d')})\n"
                        f"   ${short_strike}/{long_strike} Put Spread | Exp: {exp_str} ({dte} DTE)\n"
                        f"   Credit: ${net_credit:.2f} | Buffer: {buffer_pct:.1f}% OTM"
                    )
                    _alerted_today.add(f"EARNINGS_{symbol}_{short_strike}_{exp_str}")
                    break

        except Exception as e:
            print(f"10AM earnings scan error ({symbol}): {e}")

    # ── Build & send summary ──────────────────────────────────────────────────
    lines = [
        "⏰ *10:00 AM OPEN CHECK*",
        f"Market settled — here's what looks good right now:\n"
    ]

    if plays:
        lines.append("*Fortress Plays:*")
        lines.extend(plays)
    else:
        lines.append("🔍 No Fortress plays at current prices.")

    if earnings_plays:
        lines.append("\n*Earnings Plays:*")
        lines.extend(earnings_plays)

    # SERV status at 10 AM
    serv_price = get_price('SERV')
    if serv_price:
        if serv_price < 9.50:
            lines.append(f"\n👀 *SERV*: ${serv_price:.2f} — under $9.50, running watch scan...")
        else:
            lines.append(f"\n👀 *SERV*: ${serv_price:.2f} — above $9.50, not scanning")

    send_telegram_message("\n".join(lines))
    if serv_price and serv_price < 9.50:
        scan_special_watches()
    print(f"10 AM follow-up sent. Fortress: {len(plays)}, Earnings: {len(earnings_plays)}")


def scan_special_watches():
    """
    Scans SPECIAL_WATCH tickers with custom price conditions.
    Alerts when price is under max_price and a valid setup exists.
    """
    if not is_trading_day():
        return

    for symbol, conditions in SPECIAL_WATCH.items():
        try:
            ticker = yf.Ticker(symbol)
            current_price = ticker.fast_info['last_price']
            max_price = conditions.get('max_price')

            # Only scan when price condition is met
            if max_price and current_price >= max_price:
                continue

            expirations = ticker.options
            today = datetime.now()

            # Look for nearest expiration with options (low-price stocks, use wider DTE)
            target_date = None
            dte = 0
            for exp in expirations:
                exp_date = datetime.strptime(exp, '%Y-%m-%d')
                diff = (exp_date - today).days
                if 3 <= diff <= 30:       # wider window for low-price stocks
                    target_date = exp
                    dte = diff
                    break

            if not target_date:
                continue

            opt_chain = ticker.option_chain(target_date)
            calls = opt_chain.calls
            calls = calls[(calls['bid'] > 0) & (calls['ask'] > 0)]

            # For a low-price stock under $9.50 look for cheap call options
            # as a directional play, or OTM put credit spreads if available
            alert_key = f"SERV_WATCH_{current_price:.2f}_{target_date}"

            # ── Call option setups (long calls on dip) ──────────────────────
            atm_calls = calls[
                (calls['strike'] >= current_price * 0.97) &
                (calls['strike'] <= current_price * 1.08)
            ]

            call_alerts = []
            for _, row in atm_calls.iterrows():
                mid = (row['bid'] + row['ask']) / 2
                if 0.05 <= mid <= 0.75:   # affordable premiums for low-price stock
                    iv = row.get('impliedVolatility', 0)
                    call_alerts.append(
                        f"  📞 ${row['strike']:.2f} Call | Mid: ${mid:.2f} | IV: {iv*100:.0f}% | {dte} DTE"
                    )
                    if len(call_alerts) >= 3:
                        break

            # ── Put credit spread setups ─────────────────────────────────────
            puts = opt_chain.puts
            puts = puts[(puts['bid'] > 0) & (puts['ask'] > 0)]
            spread_w = 1.0   # tighter spread for low-price stock
            put_alerts = []

            lower_bound = current_price * 0.88
            upper_bound = current_price * 0.95
            candidates = puts[(puts['strike'] >= lower_bound) & (puts['strike'] <= upper_bound)]

            for _, short_put in candidates.iterrows():
                short_strike = short_put['strike']
                long_strike = round(short_strike - spread_w, 2)
                long_put_row = puts[abs(puts['strike'] - long_strike) < 0.01]
                if long_put_row.empty:
                    continue
                long_put = long_put_row.iloc[0]
                net_credit = (short_put['bid'] + short_put['ask']) / 2 - (long_put['bid'] + long_put['ask']) / 2
                if net_credit >= 0.05:
                    buffer_pct = ((current_price - short_strike) / current_price) * 100
                    put_alerts.append(
                        f"  🟢 Sell ${short_strike} / 🔴 Buy ${long_strike} Put | Credit: ${net_credit:.2f} | Buffer: {buffer_pct:.1f}%"
                    )
                    if len(put_alerts) >= 2:
                        break

            if not call_alerts and not put_alerts:
                continue

            # Deduplicate — only alert once per price level per day
            if alert_key in _alerted_today:
                continue
            _alerted_today.add(alert_key)

            lines = [
                f"👀 *SERV WATCH ALERT*",
                f"Price: ${current_price:.2f} ✅ (under ${max_price})",
                f"Exp: {target_date} ({dte} DTE)\n",
            ]
            if call_alerts:
                lines.append("*Call Setups:*")
                lines.extend(call_alerts)
            if put_alerts:
                lines.append("\n*Put Credit Spreads:*")
                lines.extend(put_alerts)

            send_telegram_message("\n".join(lines))
            print(f"SERV watch alert sent — price ${current_price:.2f}")

        except Exception as e:
            print(f"Error scanning special watch {symbol}: {e}")


def intraday_scan():
    """Runs during market hours only."""
    if not is_market_open():
        return
    scan_fortress_plays(source="intraday")
    scan_earnings_plays()
    scan_special_watches()


def reset_daily_alerts():
    """Clears the alert dedup set each morning."""
    global _alerted_today
    _alerted_today = set()
    print(f"[{datetime.now()}] Daily alert cache reset.")


# ─── SCHEDULER ───────────────────────────────────────────────────────────────

# Reset alert cache at midnight
schedule.every().day.at("00:01").do(reset_daily_alerts)

# 8:30 AM morning briefing (Mon–Fri check inside function)
schedule.every().day.at("08:30").do(send_morning_briefing)

# 10:00 AM follow-up — market open + 30 min settled
schedule.every().day.at("10:00").do(send_10am_followup)

# Intraday scans every 30 minutes during market hours
schedule.every(30).minutes.do(intraday_scan)


# ─── SYSTEM TRAY ─────────────────────────────────────────────────────────────

ICO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fortress.ico")

_bot_status = {"running": True, "last_scan": "Never"}


def tray_run_scan(systray):
    threading.Thread(target=scan_fortress_plays, kwargs={"source": "manual"}, daemon=True).start()
    threading.Thread(target=scan_earnings_plays, daemon=True).start()


def tray_status(systray):
    threading.Thread(target=lambda: send_telegram_message(
        f"*Bot Status*\n"
        f"Status: Running\n"
        f"Last scan: {_bot_status['last_scan']}"
    ), daemon=True).start()


def run_scheduler():
    while True:
        schedule.run_pending()
        time.sleep(30)


if __name__ == "__main__":
    print("Fortress Options Bot started.")

    threading.Thread(target=run_scheduler, daemon=True).start()

    threading.Thread(target=lambda: send_telegram_message(
        "Fortress Bot Online\n"
        "Scheduled alerts:\n"
        "8:30 AM daily briefing\n"
        "Intraday scans every 30 min\n"
        "Earnings play alerts active"
    ), daemon=True).start()

    menu = (
        ("Run Scan Now", None, tray_run_scan),
        ("Send Status to Telegram", None, tray_status),
    )

    print("Loading tray icon...")
    systray = SysTrayIcon(ICO_PATH, "Fortress Options Bot", menu)
    systray.start()
    print("Tray icon running. Press Ctrl+C to exit.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        systray.shutdown()
        print("Bot stopped.")

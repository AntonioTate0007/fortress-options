"""
Fortress Options API — FastAPI backend.
Runs the scanner on a schedule, ranks plays, tracks positions, and serves
the React app as static files.

Start: python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000 --reload
"""
import json
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

import stripe
import schedule as sch
import uvicorn

# ─── Firebase / FCM ──────────────────────────────────────────────────────────
try:
    import firebase_admin
    from firebase_admin import credentials, messaging as fcm_messaging

    _firebase_key = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if _firebase_key and not firebase_admin._apps:
        import json as _json
        _cred = credentials.Certificate(_json.loads(_firebase_key))
        firebase_admin.initialize_app(_cred)
        print("[FCM] Firebase Admin initialized.")
    else:
        print("[FCM] FIREBASE_SERVICE_ACCOUNT_JSON not set — push disabled.")
except ImportError:
    fcm_messaging = None
    print("[FCM] firebase-admin not installed — push disabled.")
import yfinance as yf
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# Allow `backend/` imports when run as a package or directly
sys.path.insert(0, os.path.dirname(__file__))
from db import get_db, init_db
from ranker import get_exit_recommendation, score_play
from auth import (require_api_key, optional_api_key, create_subscriber,
                  cancel_subscriber, send_api_key_email, create_checkout_session,
                  send_blast_email, STRIPE_WEBHOOK_SECRET, TIERS)
from telegram_bot import start_polling_thread, send_elite_alert

# ─── Config ──────────────────────────────────────────────────────────────────

WATCHLIST = ["SPY", "QQQ", "AAPL", "AMZN", "MSFT", "GOOGL", "TSLA", "NVDA"]
SPREAD_WIDTH = 5.0
MIN_DTE = 5
MAX_DTE = 21
OTM_BUFFER_MIN = 0.03
OTM_BUFFER_MAX = 0.10
PREMIUM_MIN = 0.15
PREMIUM_MAX = 2.00

_scan_lock = threading.Lock()
_is_scanning = False


def send_fcm_to_all(title: str, body: str, data: dict = None):
    """Send a push notification to every registered FCM token."""
    if fcm_messaging is None:
        return
    with get_db() as conn:
        rows = conn.execute("SELECT DISTINCT token FROM fcm_tokens").fetchall()
    tokens = [r["token"] for r in rows]
    if not tokens:
        return
    for token in tokens:
        try:
            msg = fcm_messaging.Message(
                notification=fcm_messaging.Notification(title=title, body=body),
                data={k: str(v) for k, v in (data or {}).items()},
                android=fcm_messaging.AndroidConfig(
                    priority="high",
                    notification=fcm_messaging.AndroidNotification(
                        sound="fortress_alert",
                        channel_id="fortress_plays",
                        color="#10b981",
                    ),
                ),
                token=token,
            )
            fcm_messaging.send(msg)
        except Exception as e:
            print(f"[FCM] Send failed for token {token[:20]}...: {e}")


def is_market_hours() -> bool:
    """Returns True if US equity market is currently open (Mon-Fri 9:30–16:00 ET)."""
    et = ZoneInfo("America/New_York")
    now = datetime.now(et)
    if now.weekday() >= 5:  # Sat=5, Sun=6
        return False
    market_open = now.replace(hour=9, minute=30, second=0, microsecond=0)
    market_close = now.replace(hour=16, minute=0, second=0, microsecond=0)
    return market_open <= now <= market_close

# ─── WebSocket Manager ────────────────────────────────────────────────────────


class ConnectionManager:
    def __init__(self):
        self.connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, data: dict):
        dead = []
        for ws in self.connections:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


# ─── Scanner ─────────────────────────────────────────────────────────────────


def scan_and_save(force: bool = False):
    global _is_scanning
    if not _scan_lock.acquire(blocking=False):
        return
    _is_scanning = True
    try:
        if not force and not is_market_hours():
            print(f"[{datetime.now():%H:%M:%S}] Market closed — skipping scan.")
            return

        print(f"[{datetime.now():%H:%M:%S}] Running Fortress scan...")
        with get_db() as conn:
            conn.execute("UPDATE plays SET is_active = 0 WHERE is_active = 1")
            conn.commit()

        for symbol in WATCHLIST:
            try:
                ticker = yf.Ticker(symbol)
                current_price = float(ticker.fast_info["last_price"])
                expirations = ticker.options
                today = datetime.now()

                # Collect all expirations in the DTE window (try each until a play is found)
                valid_exps = []
                for exp in expirations:
                    diff = (datetime.strptime(exp, "%Y-%m-%d") - today).days
                    if MIN_DTE <= diff <= MAX_DTE:
                        valid_exps.append((exp, diff))

                if not valid_exps:
                    nearest = expirations[0] if expirations else "none"
                    print(f"  {symbol}: no exp in {MIN_DTE}-{MAX_DTE}d window (nearest={nearest})")
                    continue

                found = False
                for target_date, dte in valid_exps:
                    if found:
                        break

                    opt_chain = ticker.option_chain(target_date)
                    puts = opt_chain.puts
                    puts = puts[(puts["bid"] > 0) & (puts["ask"] > 0)]

                    lower = current_price * (1 - OTM_BUFFER_MAX)
                    upper = current_price * (1 - OTM_BUFFER_MIN)
                    candidates = puts[(puts["strike"] >= lower) & (puts["strike"] <= upper)]

                    if candidates.empty:
                        print(f"  {symbol} {target_date}: 0 OTM candidates "
                              f"(price={current_price:.2f}, need ${lower:.0f}-${upper:.0f}, live_puts={len(puts)})")
                        continue

                    best_credit = 0.0
                    has_long = False
                    for _, short_put in candidates.iterrows():
                        short_strike = float(short_put["strike"])
                        long_strike = short_strike - SPREAD_WIDTH
                        long_row = puts[puts["strike"] == long_strike]
                        if long_row.empty:
                            continue
                        has_long = True

                        long_put = long_row.iloc[0]
                        short_mid = (float(short_put["bid"]) + float(short_put["ask"])) / 2
                        long_mid = (float(long_put["bid"]) + float(long_put["ask"])) / 2
                        net_credit = short_mid - long_mid
                        best_credit = max(best_credit, net_credit)

                        if PREMIUM_MIN <= net_credit <= PREMIUM_MAX:
                            buffer_pct = ((current_price - short_strike) / current_price) * 100
                            max_risk = (SPREAD_WIDTH * 100) - (net_credit * 100)
                            iv = float(short_put.get("impliedVolatility") or 0)
                            volume = int(short_put.get("volume") or 0)
                            oi = int(short_put.get("openInterest") or 0)

                            play = {
                                "symbol": symbol,
                                "short_strike": short_strike,
                                "long_strike": long_strike,
                                "expiration": target_date,
                                "dte": dte,
                                "current_price": current_price,
                                "net_credit": net_credit,
                                "max_risk": max_risk,
                                "spread_width": SPREAD_WIDTH,
                                "buffer_pct": buffer_pct,
                                "volume": volume,
                                "open_interest": oi,
                                "iv": iv,
                            }
                            score, breakdown = score_play(play)

                            with get_db() as conn:
                                conn.execute(
                                    """INSERT INTO plays
                                    (symbol, play_type, short_strike, long_strike, expiration, dte,
                                     current_price, net_credit, max_risk, spread_width, buffer_pct,
                                     score, score_breakdown, volume, open_interest, iv, is_active)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                                    (
                                        symbol, "fortress", short_strike, long_strike, target_date, dte,
                                        round(current_price, 2), round(net_credit, 2), round(max_risk, 2),
                                        SPREAD_WIDTH, round(buffer_pct, 2), score, json.dumps(breakdown),
                                        volume, oi, round(iv, 4),
                                    ),
                                )
                                conn.commit()
                            print(f"  Found: {symbol} ${short_strike:.0f}/{long_strike:.0f} "
                                  f"exp={target_date} | Score {score}/10 | Credit ${net_credit:.2f}")
                            found = True
                            break

                    if not found:
                        if not has_long:
                            print(f"  {symbol} {target_date}: no ${SPREAD_WIDTH:.0f}-wide long put available")
                        elif best_credit < PREMIUM_MIN:
                            print(f"  {symbol} {target_date}: best credit ${best_credit:.2f} < min ${PREMIUM_MIN}")
                        else:
                            print(f"  {symbol} {target_date}: best credit ${best_credit:.2f} > max ${PREMIUM_MAX}")

                time.sleep(1)  # yfinance rate limit buffer

            except Exception as e:
                print(f"  Scan error {symbol}: {e}")

        print(f"[{datetime.now():%H:%M:%S}] Scan complete.")

        # Send FCM push for newly found plays
        with get_db() as conn:
            new_plays = conn.execute(
                "SELECT symbol, score, net_credit, short_strike, long_strike, buffer_pct "
                "FROM plays WHERE is_active=1 ORDER BY score DESC"
            ).fetchall()
        if new_plays:
            top = new_plays[0]
            count = len(new_plays)
            emoji = "🔥" if top["score"] >= 8 else "⚡"
            title = f"{emoji} {count} new play{'s' if count > 1 else ''} — {top['symbol']} scores {top['score']}/10"
            body = (f"${top['short_strike']:.0f}/{top['long_strike']:.0f} put spread · "
                    f"${top['net_credit']:.2f} credit · {top['buffer_pct']:.1f}% buffer")
            send_fcm_to_all(title, body, {"play_id": str(top["score"]), "tab": "plays"})
    finally:
        _is_scanning = False
        _scan_lock.release()


def update_positions():
    """Refresh P&L on all open tracked positions every 5 min."""
    with get_db() as conn:
        positions = conn.execute(
            "SELECT * FROM tracked_positions WHERE status = 'open'"
        ).fetchall()
        positions = [dict(p) for p in positions]

    for pos in positions:
        try:
            ticker = yf.Ticker(pos["symbol"])
            current_price = float(ticker.fast_info["last_price"])

            try:
                chain = ticker.option_chain(pos["expiration"])
                puts = chain.puts
                short_row = puts[puts["strike"] == pos["short_strike"]]
                long_row = puts[puts["strike"] == pos["long_strike"]]

                if not short_row.empty and not long_row.empty:
                    short_mid = (float(short_row.iloc[0]["bid"]) + float(short_row.iloc[0]["ask"])) / 2
                    long_mid = (float(long_row.iloc[0]["bid"]) + float(long_row.iloc[0]["ask"])) / 2
                    current_spread = short_mid - long_mid
                    entry = pos["entry_credit"]
                    pnl_pct = ((entry - current_spread) / entry * 100) if entry > 0 else 0

                    with get_db() as conn:
                        conn.execute(
                            """UPDATE tracked_positions
                               SET current_mid=?, current_price=?, pnl_pct=?, last_updated=datetime('now')
                               WHERE id=?""",
                            (round(current_spread, 2), round(current_price, 2), round(pnl_pct, 1), pos["id"]),
                        )
                        conn.commit()

                    # Threshold alerts
                    prev_pnl = pos.get("pnl_pct") or 0
                    if pnl_pct >= 20 and prev_pnl < 20:
                        alert_msg = f"{pos['symbol']} ${pos['short_strike']:.0f}/{pos['long_strike']:.0f} hit {pnl_pct:.0f}% profit"
                        with get_db() as conn:
                            conn.execute(
                                "INSERT INTO alerts (position_id, alert_type, message) VALUES (?,?,?)",
                                (pos["id"], "profit", alert_msg),
                            )
                            conn.commit()
                        send_elite_alert("profit", alert_msg)
                    elif pnl_pct <= -10 and prev_pnl > -10:
                        alert_msg = f"{pos['symbol']} ${pos['short_strike']:.0f}/{pos['long_strike']:.0f} down {abs(pnl_pct):.0f}%"
                        with get_db() as conn:
                            conn.execute(
                                "INSERT INTO alerts (position_id, alert_type, message) VALUES (?,?,?)",
                                (pos["id"], "loss", alert_msg),
                            )
                            conn.commit()
                        send_elite_alert("loss", alert_msg)
                else:
                    # Option chain no longer has the strikes (near expiry or expired)
                    with get_db() as conn:
                        conn.execute(
                            "UPDATE tracked_positions SET current_price=?, last_updated=datetime('now') WHERE id=?",
                            (round(current_price, 2), pos["id"]),
                        )
                        conn.commit()

            except Exception:
                # Expiration passed or option data unavailable
                with get_db() as conn:
                    conn.execute(
                        "UPDATE tracked_positions SET current_price=?, last_updated=datetime('now') WHERE id=?",
                        (round(current_price, 2), pos["id"]),
                    )
                    conn.commit()

        except Exception as e:
            print(f"Position update error {pos['id']}: {e}")


# ─── Weekly Earnings Briefing ────────────────────────────────────────────────


def send_weekly_earnings_briefing():
    """
    Runs Friday ~8:30 AM ET.  Scans the watchlist for the highest-profile
    earnings report coming up in the next 5 trading days, then sends a
    3-strategy Telegram briefing (Safe / Aggressive / Neutral) to all Elite
    subscribers who have linked Telegram.
    """
    from telegram_bot import send_message as tg_send
    import datetime as dt

    et = ZoneInfo("America/New_York")
    today = dt.date.today()
    window_end = today + dt.timedelta(days=7)

    print(f"[{datetime.now():%H:%M:%S}] Running weekly earnings briefing scan…")

    # ── Find the best earnings candidate in the watchlist ─────────────────────
    best = None          # (symbol, date, market_cap, price, beta, timing)
    for symbol in WATCHLIST:
        try:
            tk = yf.Ticker(symbol)
            info = tk.info or {}
            price = info.get("regularMarketPrice") or info.get("currentPrice", 0)
            mktcap = info.get("marketCap", 0)
            beta = info.get("beta", 1.0) or 1.0

            # yfinance earnings dates
            df = tk.get_earnings_dates(limit=8)
            if df is None or df.empty:
                continue
            for idx in df.index:
                edate = idx.date() if hasattr(idx, "date") else idx
                if today < edate <= window_end:
                    timing = "Before Market Open" if idx.hour < 12 else "After Market Close"
                    if best is None or mktcap > best[2]:
                        best = (symbol, edate, mktcap, price, beta, timing)
                    break
        except Exception as e:
            print(f"  Earnings scan {symbol}: {e}")

    if best is None:
        print("[Briefing] No earnings found in watchlist this week.")
        # Still send a "quiet week" notice
        msg = (
            "📅 <b>Fortress Weekly Briefing</b>\n\n"
            "No major earnings this week for our 8 watched tickers.\n"
            "The scanner will run as normal Mon–Fri 9:30 AM – 4:00 PM ET.\n\n"
            "<i>Happy trading! 🏰</i>"
        )
    else:
        symbol, edate, mktcap, price, beta, timing = best
        if not price or price <= 0:
            print(f"[Briefing] No price for {symbol}, skipping.")
            return

        # ── Calculate strikes ─────────────────────────────────────────────────
        # Safe: put credit spread ~10% OTM
        safe_short = round(price * 0.90 / 5) * 5
        safe_long  = safe_short - SPREAD_WIDTH

        # Aggressive: call credit spread just above price
        agg_short = round(price * 1.03 / 5) * 5
        agg_long  = agg_short + SPREAD_WIDTH

        # Neutral condor: combine both
        condor_put_short = safe_short
        condor_put_long  = safe_long
        condor_call_short = round(price * 1.08 / 5) * 5
        condor_call_long  = condor_call_short + SPREAD_WIDTH

        # ── Market sentiment ──────────────────────────────────────────────────
        try:
            spy = yf.Ticker("SPY")
            spy_hist = spy.history(period="5d")
            if len(spy_hist) >= 2:
                spy_chg = (spy_hist["Close"].iloc[-1] / spy_hist["Close"].iloc[0] - 1) * 100
            else:
                spy_chg = 0.0
        except Exception:
            spy_chg = 0.0

        if spy_chg >= 1:
            sentiment = "🟢 Risk-On — market trending up"
            rec = "Strategy 1 (Safe Put Spread)"
        elif spy_chg <= -1:
            sentiment = "🔴 Risk-Off — market in a downtrend"
            rec = "Strategy 2 (Aggressive Bear Call Spread)"
        else:
            sentiment = "🟡 Neutral — choppy market"
            rec = "Strategy 3 (Iron Condor)"

        beta_label = "low-beta (stable)" if beta < 0.8 else "high-beta (volatile)" if beta > 1.3 else "mid-beta"
        day_name = edate.strftime("%A, %b ") + str(edate.day)

        msg = (
            f"📅 <b>Fortress Weekly Earnings Briefing</b>\n\n"
            f"<b>Top Play:</b> <code>{symbol}</code>\n"
            f"Reports <b>{day_name}</b> — {timing}\n"
            f"Current price: <b>${price:.2f}</b>  ·  Beta: {beta:.2f} ({beta_label})\n\n"
            f"<b>Market Sentiment:</b> {sentiment}\n"
            f"SPY 5-day move: {spy_chg:+.1f}%\n\n"
            "─────────────────\n"
            "✅ <b>Strategy 1 — Safe (Put Credit Spread)</b>\n"
            f"Sell <b>${safe_short:.0f}P</b> / Buy <b>${safe_long:.0f}P</b>  ·  10% OTM cushion\n"
            f"Best when: confident the stock won't crash through ${safe_short:.0f}\n\n"
            "⚡ <b>Strategy 2 — Aggressive (Bear Call Spread)</b>\n"
            f"Sell <b>${agg_short:.0f}C</b> / Buy <b>${agg_long:.0f}C</b>  ·  just above price\n"
            f"Best when: expecting 'sell the news' after earnings\n\n"
            "⚖️ <b>Strategy 3 — Neutral (Iron Condor)</b>\n"
            f"Puts: Sell <b>${condor_put_short:.0f}P</b> / Buy <b>${condor_put_long:.0f}P</b>\n"
            f"Calls: Sell <b>${condor_call_short:.0f}C</b> / Buy <b>${condor_call_long:.0f}C</b>\n"
            f"Best when: expecting a boring post-earnings drift\n\n"
            "─────────────────\n"
            f"⚠️ <b>Fortress Warning:</b> Earnings week = elevated IV. "
            f"Reduce size if you're in multiple positions.\n\n"
            f"🏆 <b>My Recommendation:</b> {rec}\n\n"
            "<i>Open the app to scan for live plays. 🏰</i>"
        )

    # ── Broadcast to Elite Telegram subscribers ───────────────────────────────
    with get_db() as conn:
        rows = conn.execute(
            "SELECT telegram_chat_id FROM subscribers "
            "WHERE tier='elite' AND status='active' AND telegram_chat_id IS NOT NULL"
        ).fetchall()
    sent = 0
    for row in rows:
        if tg_send(row["telegram_chat_id"], msg):
            sent += 1
    print(f"[Briefing] Sent to {sent} Elite subscriber(s).")


# ─── Background Thread ────────────────────────────────────────────────────────


def background_loop():
    sch.every(30).minutes.do(scan_and_save)
    sch.every(5).minutes.do(update_positions)

    # Weekly earnings briefing — Fridays at 8:30 AM ET
    et = ZoneInfo("America/New_York")
    sch.every().friday.at("08:30").do(send_weekly_earnings_briefing)

    # Run immediately on startup
    scan_and_save()
    update_positions()

    while True:
        sch.run_pending()
        time.sleep(30)


# ─── App Lifespan ────────────────────────────────────────────────────────────


def seed_accounts():
    """Ensure owner accounts survive ephemeral DB resets on Render."""
    seeds = [
        {
            "email": "antonio@fortress-options.com",
            "api_key": os.getenv("OWNER_API_KEY", "frt_IyX69zER4dj4TYNevSUdJ8iSBANMX6L0dPyLKJMaCzU"),
            "tier": "elite",
        },
    ]
    with get_db() as conn:
        for s in seeds:
            exists = conn.execute(
                "SELECT id FROM subscribers WHERE api_key=?", (s["api_key"],)
            ).fetchone()
            if not exists:
                conn.execute(
                    "INSERT OR IGNORE INTO subscribers (email, api_key, tier, status) VALUES (?,?,?,'active')",
                    (s["email"], s["api_key"], s["tier"]),
                )
        conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_accounts()
    threading.Thread(target=background_loop, daemon=True).start()
    start_polling_thread()
    yield


app = FastAPI(title="Fortress Options API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request Models ───────────────────────────────────────────────────────────


class TrackRequest(BaseModel):
    play_id: int
    contracts: int = 1
    notes: Optional[str] = None


class CloseRequest(BaseModel):
    exit_credit: float
    reason: str = "manual"


class SubscribeRequest(BaseModel):
    email: str
    tier: str = "basic"
    success_url: str = "https://fortress-options.com/success"
    cancel_url: str = "https://fortress-options.com/#pricing"


# ─── API Routes ───────────────────────────────────────────────────────────────


@app.get("/api/status")
def get_status():
    with get_db() as conn:
        plays_count = conn.execute("SELECT COUNT(*) FROM plays WHERE is_active=1").fetchone()[0]
        pos_count = conn.execute("SELECT COUNT(*) FROM tracked_positions WHERE status='open'").fetchone()[0]
        alert_count = conn.execute("SELECT COUNT(*) FROM alerts WHERE acknowledged=0").fetchone()[0]
        subs_count = conn.execute("SELECT COUNT(*) FROM subscribers WHERE status='active'").fetchone()[0]
    return {
        "status": "online",
        "plays_available": plays_count,
        "open_positions": pos_count,
        "unread_alerts": alert_count,
        "active_subscribers": subs_count,
        "scanning": _is_scanning,
        "timestamp": datetime.now().isoformat(),
    }


# ─── Subscription Routes ──────────────────────────────────────────────────────

@app.post("/api/subscribe")
def subscribe(req: SubscribeRequest):
    """Create a Stripe Checkout session and return the payment URL."""
    if not req.tier in TIERS:
        raise HTTPException(400, f"Invalid tier. Choose: {list(TIERS.keys())}")
    try:
        url = create_checkout_session(req.email, req.tier, req.success_url, req.cancel_url)
        return {"checkout_url": url}
    except Exception as e:
        raise HTTPException(500, f"Stripe error: {e}")


@app.post("/api/stripe/webhook")
async def stripe_webhook(request: Request):
    """Stripe sends events here. Generates API key on successful payment."""
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except stripe.error.SignatureVerificationError:
        raise HTTPException(400, "Invalid Stripe signature")

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        email = session.get("customer_email") or session.get("customer_details", {}).get("email", "")
        tier = session.get("metadata", {}).get("tier", "basic")
        customer_id = session.get("customer")
        sub_id = session.get("subscription")

        if email:
            api_key = create_subscriber(email, tier, customer_id, sub_id)
            send_api_key_email(email, api_key, tier)

    elif event["type"] in ("customer.subscription.deleted", "customer.subscription.paused"):
        sub = event["data"]["object"]
        cancel_subscriber(sub["id"])

    return {"received": True}


@app.post("/api/admin/grant")
def admin_grant(email: str, tier: str = "pro", admin_key: str = "", api_key: str = ""):
    """Admin endpoint to manually grant access. Optionally supply a specific api_key."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    if api_key:
        # Use the supplied key — insert or update without generating a new one
        with get_db() as conn:
            existing = conn.execute("SELECT id FROM subscribers WHERE email=?", (email,)).fetchone()
            if existing:
                conn.execute(
                    "UPDATE subscribers SET api_key=?, tier=?, status='active' WHERE email=?",
                    (api_key, tier, email),
                )
            else:
                conn.execute(
                    "INSERT INTO subscribers (email, api_key, tier, status) VALUES (?,?,?,'active')",
                    (email, api_key, tier),
                )
            conn.commit()
    else:
        api_key = create_subscriber(email, tier)
    return {"email": email, "tier": tier, "api_key": api_key}


@app.post("/api/admin/notify")
def admin_notify(message: str, admin_key: str = ""):
    """Admin: send a Telegram message to all Elite subscribers with Telegram linked."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    from telegram_bot import send_message as tg_send
    with get_db() as conn:
        rows = conn.execute(
            "SELECT telegram_chat_id FROM subscribers WHERE tier='elite' AND status='active' AND telegram_chat_id IS NOT NULL"
        ).fetchall()
    sent = 0
    for row in rows:
        if tg_send(row["telegram_chat_id"], message):
            sent += 1
    return {"sent": sent, "total_elite_linked": len(rows)}


@app.post("/api/admin/earnings-briefing")
def trigger_earnings_briefing(admin_key: str = ""):
    """Admin: manually trigger the weekly earnings briefing (for testing)."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    t = threading.Thread(target=send_weekly_earnings_briefing, daemon=True)
    t.start()
    return {"message": "Earnings briefing started"}


@app.get("/api/auth/verify")
def verify_key(sub: dict = Depends(require_api_key)):
    """Check if an API key is valid and return subscriber info."""
    return {"valid": True, "email": sub["email"], "tier": sub["tier"]}


@app.get("/api/subscribers")
def list_subscribers(admin_key: str = ""):
    """Admin: list all subscribers."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, email, api_key, tier, status, created_at FROM subscribers ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


class BlastRequest(BaseModel):
    admin_key: str
    subject: str
    version: str = ""
    message: str = ""
    apk_url: str = "https://github.com/AntonioTate0007/fortress-options/releases/latest/download/fortress-options.apk"


@app.post("/api/admin/blast")
def blast_email(req: BlastRequest):
    """Admin: send update announcement to all active subscribers."""
    if req.admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")

    with get_db() as conn:
        rows = conn.execute(
            "SELECT email FROM subscribers WHERE status='active'"
        ).fetchall()

    emails = [r["email"] for r in rows]
    if not emails:
        return {"sent": 0, "failed": 0, "message": "No active subscribers"}

    version_line = f"<p style='font-size:13px;color:#a1a1aa'>Version: <strong style='color:#10B981'>{req.version}</strong></p>" if req.version else ""
    message_line = f"<p>{req.message}</p>" if req.message else ""

    html = f"""
    <div style="font-family:monospace;background:#0A0A0B;color:#e4e4e7;padding:32px;border-radius:12px;max-width:540px;margin:0 auto">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <div style="width:40px;height:40px;background:#10B981;border-radius:10px;font-size:20px;display:flex;align-items:center;justify-content:center">🏰</div>
        <h2 style="margin:0;color:#10B981">Fortress Options</h2>
      </div>
      <h3 style="color:#e4e4e7;margin:0 0 12px">{req.subject}</h3>
      {version_line}
      {message_line}
      <div style="margin:24px 0">
        <a href="{req.apk_url}" style="background:#10B981;color:#003918;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">⬇ Download Update</a>
      </div>
      <hr style="border-color:#27272a;margin:24px 0">
      <p style="font-size:12px;color:#52525b">You're receiving this because you're a Fortress Options subscriber. Reply to unsubscribe.</p>
    </div>
    """

    result = send_blast_email(emails, req.subject, html)
    return {**result, "total_subscribers": len(emails)}


# ─── Protected Play Routes ───────────────────────────────────────────────────

@app.get("/api/plays")
def get_plays(sub: dict = Depends(require_api_key)):
    """Returns plays filtered by subscriber tier."""
    tier_symbols = TIERS.get(sub.get("tier", "basic"), TIERS["basic"])["symbols"]
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM plays WHERE is_active=1 AND expiration >= date('now') ORDER BY score DESC, net_credit DESC"
        ).fetchall()
    plays = [dict(r) for r in rows]
    # Filter by tier (Basic only gets SPY/QQQ)
    if sub.get("tier") != "elite" and sub.get("tier") != "pro":
        plays = [p for p in plays if p["symbol"] in tier_symbols]
    return plays


@app.post("/api/scan")
def trigger_scan():
    t = threading.Thread(target=lambda: scan_and_save(force=True), daemon=True)
    t.start()
    return {"message": "Scan started"}


@app.post("/api/fcm/register")
def register_fcm_token(token: str, sub: dict = Depends(require_api_key)):
    """Register or update an FCM device token for the authenticated subscriber."""
    with get_db() as conn:
        conn.execute(
            """INSERT INTO fcm_tokens (api_key, token, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(token) DO UPDATE SET api_key=excluded.api_key, updated_at=excluded.updated_at""",
            (sub["api_key"], token),
        )
        conn.commit()
    return {"message": "FCM token registered"}


@app.delete("/api/fcm/unregister")
def unregister_fcm_token(token: str, sub: dict = Depends(require_api_key)):
    """Remove an FCM token (e.g. on logout)."""
    with get_db() as conn:
        conn.execute("DELETE FROM fcm_tokens WHERE token=? AND api_key=?", (token, sub["api_key"]))
        conn.commit()
    return {"message": "FCM token removed"}


@app.post("/api/track")
def track_play(req: TrackRequest):
    with get_db() as conn:
        play = conn.execute("SELECT * FROM plays WHERE id=?", (req.play_id,)).fetchone()
        if not play:
            raise HTTPException(404, "Play not found")
        play = dict(play)

    with get_db() as conn:
        pos_id = conn.execute(
            """INSERT INTO tracked_positions
               (symbol, play_type, short_strike, long_strike, expiration, dte_at_entry,
                entry_price, entry_credit, contracts, max_risk, buffer_pct_at_entry, score_at_entry, entry_notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                play["symbol"], play["play_type"], play["short_strike"], play["long_strike"],
                play["expiration"], play["dte"], play["current_price"], play["net_credit"],
                req.contracts, play["max_risk"], play["buffer_pct"], play["score"], req.notes,
            ),
        ).lastrowid
        conn.commit()
    return {"id": pos_id, "message": "Trade tracked"}


@app.get("/api/positions")
def get_positions():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM tracked_positions WHERE status='open' ORDER BY tracked_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/positions/history")
def get_history():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM tracked_positions WHERE status='closed' ORDER BY closed_at DESC LIMIT 50"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/positions/{pos_id}/close")
def close_position(pos_id: int, req: CloseRequest):
    with get_db() as conn:
        pos = conn.execute("SELECT * FROM tracked_positions WHERE id=?", (pos_id,)).fetchone()
        if not pos:
            raise HTTPException(404, "Position not found")
        pos = dict(pos)

    entry = pos["entry_credit"]
    final_pnl = ((entry - req.exit_credit) / entry * 100) if entry > 0 else 0

    with get_db() as conn:
        conn.execute(
            """UPDATE tracked_positions
               SET status='closed', exit_credit=?, exit_reason=?, closed_at=datetime('now'), pnl_pct=?
               WHERE id=?""",
            (req.exit_credit, req.reason, round(final_pnl, 1), pos_id),
        )
        conn.commit()
    return {"message": "Position closed", "final_pnl_pct": round(final_pnl, 1)}


@app.get("/api/recommend/{symbol}")
def recommend(symbol: str, short_strike: float, long_strike: float, entry_credit: float, pnl_pct: float = 0):
    return get_exit_recommendation(symbol, {
        "short_strike": short_strike,
        "long_strike": long_strike,
        "entry_credit": entry_credit,
        "pnl_pct": pnl_pct,
    })


@app.get("/api/alerts")
def get_alerts():
    with get_db() as conn:
        rows = conn.execute(
            """SELECT a.*, p.symbol FROM alerts a
               LEFT JOIN tracked_positions p ON a.position_id = p.id
               ORDER BY a.triggered_at DESC LIMIT 30"""
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/alerts/{alert_id}/ack")
def ack_alert(alert_id: int):
    with get_db() as conn:
        conn.execute("UPDATE alerts SET acknowledged=1 WHERE id=?", (alert_id,))
        conn.commit()
    return {"message": "Acknowledged"}


@app.delete("/api/alerts/{alert_id}")
def delete_alert(alert_id: int, api_key: str = Depends(require_api_key)):
    with get_db() as conn:
        conn.execute("DELETE FROM alerts WHERE id=?", (alert_id,))
        conn.commit()
    return {"message": "Deleted"}


@app.delete("/api/alerts")
def clear_all_alerts(api_key: str = Depends(require_api_key)):
    with get_db() as conn:
        conn.execute("DELETE FROM alerts")
        conn.commit()
    return {"message": "All alerts cleared"}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)


# ─── Serve React App ─────────────────────────────────────────────────────────

DIST_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "dist")
if os.path.exists(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="static")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8001))
    uvicorn.run("backend.api:app", host="0.0.0.0", port=port, reload=False)

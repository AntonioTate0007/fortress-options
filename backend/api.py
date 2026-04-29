"""
Fortress Options API — FastAPI backend.
Runs the scanner on a schedule, ranks plays, tracks positions, and serves
the React app as static files.

Start: python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000 --reload
"""
import json
import logging
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

# Configure logging once at module load. Level is overridable via LOG_LEVEL env.
# We keep the format short so it interleaves cleanly with the existing print()
# calls (which we leave in place to avoid a giant rewrite).
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("fortress.api")

import stripe
import schedule as sch
import uvicorn

# ─── Firebase / FCM ──────────────────────────────────────────────────────────
fcm_messaging = None  # None = push disabled
try:
    import firebase_admin
    from firebase_admin import credentials, messaging as _fcm_messaging_module

    _firebase_key = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if _firebase_key:
        if not firebase_admin._apps:
            import json as _json
            _cred = credentials.Certificate(_json.loads(_firebase_key))
            firebase_admin.initialize_app(_cred)
        fcm_messaging = _fcm_messaging_module
        print("[FCM] Firebase Admin initialized — push enabled.")
    else:
        print("[FCM] FIREBASE_SERVICE_ACCOUNT_JSON not set — push disabled.")
except ImportError:
    print("[FCM] firebase-admin not installed — push disabled.")
except Exception as _fcm_init_err:
    print(f"[FCM] Init error: {_fcm_init_err} — push disabled.")
import yfinance as yf
try:
    from curl_cffi import requests as _curl_requests
    _curl_cffi_available = True
    print("[yfinance] curl_cffi available — will use chrome124 session per scan.")
except Exception:
    _curl_cffi_available = False
    print("[yfinance] curl_cffi not available — using default session.")

def _make_yf_session():
    """Return a fresh curl_cffi session impersonating a recent Chrome build."""
    if _curl_cffi_available:
        return _curl_requests.Session(impersonate="chrome124")
    return None

_yf_session = _make_yf_session()
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
from earnings import (
    has_earnings_in_window,
    get_upcoming_earnings,
    is_etf as _is_etf,
)
import anthropic as _anthropic
from auth import (require_api_key, optional_api_key, create_subscriber,
                  cancel_subscriber, send_api_key_email, create_checkout_session,
                  send_blast_email, STRIPE_WEBHOOK_SECRET, TIERS)
from telegram_bot import start_polling_thread, send_elite_alert

# ─── Config ──────────────────────────────────────────────────────────────────

DEFAULT_WATCHLIST = ["SPY", "QQQ", "AAPL", "AMZN", "MSFT", "GOOGL", "TSLA", "NVDA"]
WATCHLIST = DEFAULT_WATCHLIST  # kept for backwards compat; scanner uses get_watchlist()
SPREAD_WIDTH = 5.0


def get_watchlist() -> list[str]:
    """Return the current watchlist from DB; fall back to DEFAULT_WATCHLIST if empty."""
    try:
        with get_db() as conn:
            rows = conn.execute("SELECT symbol FROM watchlist ORDER BY symbol").fetchall()
        symbols = [r["symbol"] for r in rows]
        return symbols if symbols else DEFAULT_WATCHLIST
    except Exception:
        return DEFAULT_WATCHLIST


def get_all_scanned_symbols() -> list[str]:
    """The full set of symbols the scanner should look at: the global watchlist
    plus every distinct symbol any user has added to their personal watchlist.

    Why: previously scan_and_save() only iterated the global watchlist, so a
    user could add e.g. BABA to their personal feed and the scanner would
    never look at it — they'd see no plays for it forever. We dedupe and
    sort here so the scan is deterministic.
    """
    symbols: set[str] = set(get_watchlist())
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT DISTINCT symbol FROM user_watchlist"
            ).fetchall()
        for r in rows:
            sym = (r["symbol"] or "").upper().strip()
            if sym:
                symbols.add(sym)
    except Exception as e:
        # user_watchlist may not exist on a brand-new install; don't break the
        # scan over it.
        try:
            log.warning("user_watchlist union failed: %s", e)
        except NameError:
            pass
    return sorted(symbols)
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


def generate_play_analysis(play: dict) -> str:
    """Use Claude to generate rich Fortress-style analysis for a play."""
    try:
        client = _anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
        prompt = f"""You are the Fortress Options AI analyst. Generate a concise, punchy analysis for this options play.

Play data:
- Symbol: {play['symbol']}
- Strategy: Bull Put Spread (Fortress Play)
- Short Strike: ${play['short_strike']:.0f} / Long Strike: ${play['long_strike']:.0f}
- Expiration: {play['expiration']} ({play['dte']} days)
- Current Price: ${play['current_price']:.2f}
- Net Credit: ${play['net_credit']:.2f} per share (${play['net_credit']*100:.0f} per contract)
- Max Risk: ${play['max_risk']:.0f} per contract
- Safety Buffer: {play['buffer_pct']:.1f}% below current price
- IV: {play.get('iv', 0)*100:.0f}%
- Score: {play['score']}/10

Write 3 short sections (2-3 sentences each):
1. **The Opportunity** — Why this play makes sense right now (mention IV, buffer, risk/reward)
2. **The Fortress Warning** ⚠️ — One key risk to watch for this specific stock/sector
3. **My Recommendation** — Clear action (Bull Put Spread) with the specific strikes and why

Keep it under 200 words. Be direct, confident, like a sharp options trader briefing a client. No fluff."""

        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )
        return msg.content[0].text.strip()
    except Exception as e:
        log.warning("AI analysis fallback for %s: %s", play.get("symbol"), e)
        # Fallback: mechanical summary so the play card always renders something useful.
        return (
            f"**The Opportunity**\n${play['short_strike']:.0f}/${play['long_strike']:.0f} put spread "
            f"collects ${play['net_credit']:.2f} credit with a {play['buffer_pct']:.1f}% safety buffer. "
            f"Score {play['score']}/10.\n\n"
            f"**The Fortress Warning** ⚠️\nMonitor price action near ${play['short_strike']:.0f}.\n\n"
            f"**My Recommendation**\nSell the ${play['short_strike']:.0f}/${play['long_strike']:.0f} "
            f"put spread expiring {play['expiration']} for ${play['net_credit']:.2f} credit."
        )


def send_fcm_to_pro_elite(title: str, body: str, analysis: str = "", data: dict = None):
    """Send rich push notifications only to pro and elite tier subscribers."""
    if fcm_messaging is None:
        return
    with get_db() as conn:
        rows = conn.execute(
            """SELECT ft.token FROM fcm_tokens ft
               JOIN subscribers s ON ft.api_key = s.api_key
               WHERE s.tier IN ('pro', 'elite') AND s.status = 'active'"""
        ).fetchall()
    tokens = [r["token"] for r in rows]
    if not tokens:
        # Fall back to sending to all registered tokens if no tier-filtered ones
        send_fcm_to_all(title, body, data)
        return
    for token in tokens:
        try:
            msg = fcm_messaging.Message(
                notification=fcm_messaging.Notification(title=title, body=body),
                data={**(data or {}), "analysis": analysis[:900] if analysis else ""},
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
            print(f"[FCM] Pro/Elite send failed for {token[:20]}...: {e}")


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
        # Fresh session each scan so Yahoo Finance sees a new TLS fingerprint
        scan_session = _make_yf_session()
        # Capture scan-start in UTC so we can deactivate plays from previous
        # runs *after* the new plays have been inserted. This avoids the
        # mid-scan window where users would see an empty feed because we'd
        # blow away is_active=1 first and only insert replacements one symbol
        # at a time over the next ~4 minutes.
        from datetime import datetime as _dt_atomic, timezone as _tz_atomic
        scan_start_utc = _dt_atomic.now(_tz_atomic.utc).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")

        # Scan the union of the global watchlist + every user's personal
        # watchlist so user-added tickers actually get plays.
        scan_symbols = get_all_scanned_symbols()
        print(f"  scanning {len(scan_symbols)} symbols: {', '.join(scan_symbols[:20])}"
              + (f" (+{len(scan_symbols)-20} more)" if len(scan_symbols) > 20 else ""))

        for symbol in scan_symbols:
            try:
                ticker = yf.Ticker(symbol, session=scan_session)
                current_price = float(ticker.fast_info["last_price"])
                expirations = ticker.options
                today = datetime.now()

                # Collect all expirations in the DTE window
                valid_exps = []
                for exp in expirations:
                    diff = (datetime.strptime(exp, "%Y-%m-%d") - today).days
                    if MIN_DTE <= diff <= MAX_DTE:
                        valid_exps.append((exp, diff))

                if not valid_exps:
                    nearest = expirations[0] if expirations else "none"
                    print(f"  {symbol}: no exp in {MIN_DTE}-{MAX_DTE}d window (nearest={nearest})")
                    continue

                # ── Earnings check — skip if earnings land within the DTE window ──
                # ETFs bypass (no earnings reports). Errors are logged but not fatal:
                # a missing earnings feed shouldn't block the whole scanner.
                has_earnings, earn_date = has_earnings_in_window(
                    symbol, MAX_DTE, session=scan_session
                )
                if has_earnings:
                    days_to_earn = (earn_date - today.date()).days
                    print(f"  {symbol}: earnings on {earn_date} ({days_to_earn}d) — skipping scan")
                    time.sleep(0.5)
                    continue

                # Track found leg data for iron condor detection
                _put_play: dict | None = None
                _put_exp: str | None = None
                _call_play: dict | None = None
                _call_exp: str | None = None

                # ── Bull Put Spread scan ──────────────────────────────────────
                found_put = False
                for target_date, dte in valid_exps:
                    if found_put:
                        break

                    opt_chain = ticker.option_chain(target_date)
                    puts = opt_chain.puts
                    puts = puts[(puts["bid"] > 0) & (puts["ask"] > 0)]

                    lower = current_price * (1 - OTM_BUFFER_MAX)
                    upper = current_price * (1 - OTM_BUFFER_MIN)
                    candidates = puts[(puts["strike"] >= lower) & (puts["strike"] <= upper)]

                    if candidates.empty:
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
                            play["score"] = score
                            ai_analysis = generate_play_analysis(play)

                            with get_db() as conn:
                                conn.execute(
                                    """INSERT INTO plays
                                    (symbol, play_type, short_strike, long_strike, expiration, dte,
                                     current_price, net_credit, max_risk, spread_width, buffer_pct,
                                     score, score_breakdown, volume, open_interest, iv, is_active, ai_analysis)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)""",
                                    (
                                        symbol, "bull_put", short_strike, long_strike, target_date, dte,
                                        round(current_price, 2), round(net_credit, 2), round(max_risk, 2),
                                        SPREAD_WIDTH, round(buffer_pct, 2), score, json.dumps(breakdown),
                                        volume, oi, round(iv, 4), ai_analysis,
                                    ),
                                )
                                conn.commit()
                            print(f"  Bull Put: {symbol} ${short_strike:.0f}/{long_strike:.0f} "
                                  f"exp={target_date} | Score {score}/10 | Credit ${net_credit:.2f}")
                            # Store for iron condor detection
                            _put_play = {**play, "score": score, "breakdown": breakdown}
                            _put_exp = target_date
                            found_put = True
                            break

                # ── Bear Call Spread scan ─────────────────────────────────────
                found_call = False
                for target_date, dte in valid_exps:
                    if found_call:
                        break

                    opt_chain = ticker.option_chain(target_date)
                    calls = opt_chain.calls
                    calls = calls[(calls["bid"] > 0) & (calls["ask"] > 0)]

                    # Short call: 3-10% above current price (OTM)
                    lower_c = current_price * (1 + OTM_BUFFER_MIN)
                    upper_c = current_price * (1 + OTM_BUFFER_MAX)
                    candidates_c = calls[(calls["strike"] >= lower_c) & (calls["strike"] <= upper_c)]

                    if candidates_c.empty:
                        continue

                    for _, short_call in candidates_c.iterrows():
                        short_strike = float(short_call["strike"])
                        long_strike = short_strike + SPREAD_WIDTH  # long call is higher
                        long_row = calls[calls["strike"] == long_strike]
                        if long_row.empty:
                            continue

                        long_call = long_row.iloc[0]
                        short_mid = (float(short_call["bid"]) + float(short_call["ask"])) / 2
                        long_mid = (float(long_call["bid"]) + float(long_call["ask"])) / 2
                        net_credit = short_mid - long_mid

                        if PREMIUM_MIN <= net_credit <= PREMIUM_MAX:
                            buffer_pct = ((short_strike - current_price) / current_price) * 100
                            max_risk = (SPREAD_WIDTH * 100) - (net_credit * 100)
                            iv = float(short_call.get("impliedVolatility") or 0)
                            volume = int(short_call.get("volume") or 0)
                            oi = int(short_call.get("openInterest") or 0)

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
                            play["score"] = score
                            ai_analysis = generate_play_analysis(play)

                            with get_db() as conn:
                                conn.execute(
                                    """INSERT INTO plays
                                    (symbol, play_type, short_strike, long_strike, expiration, dte,
                                     current_price, net_credit, max_risk, spread_width, buffer_pct,
                                     score, score_breakdown, volume, open_interest, iv, is_active, ai_analysis)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)""",
                                    (
                                        symbol, "bear_call", short_strike, long_strike, target_date, dte,
                                        round(current_price, 2), round(net_credit, 2), round(max_risk, 2),
                                        SPREAD_WIDTH, round(buffer_pct, 2), score, json.dumps(breakdown),
                                        volume, oi, round(iv, 4), ai_analysis,
                                    ),
                                )
                                conn.commit()
                            print(f"  Bear Call: {symbol} ${short_strike:.0f}/{long_strike:.0f} "
                                  f"exp={target_date} | Score {score}/10 | Credit ${net_credit:.2f}")
                            # Store for iron condor detection
                            _call_play = {**play, "score": score, "breakdown": breakdown}
                            _call_exp = target_date
                            found_call = True
                            break

                # ── Iron Condor: both legs found on same expiration ───────────
                if _put_play and _call_play and _put_exp == _call_exp:
                    combined_credit = round(_put_play["net_credit"] + _call_play["net_credit"], 2)
                    combined_risk = round((SPREAD_WIDTH * 2 * 100) - (combined_credit * 100), 2)
                    ic_buffer = _put_play["buffer_pct"]  # downside buffer (put side)
                    ic_breakdown = {
                        **_put_play["breakdown"],
                        "put_long": _put_play["long_strike"],
                        "call_short": _call_play["short_strike"],
                        "call_long": _call_play["long_strike"],
                        "put_credit": round(_put_play["net_credit"], 2),
                        "call_credit": round(_call_play["net_credit"], 2),
                    }
                    ic_play = {
                        "symbol": symbol,
                        "short_strike": _put_play["short_strike"],   # put short (lower boundary)
                        "long_strike": _call_play["short_strike"],   # call short (upper boundary)
                        "expiration": _put_exp,
                        "dte": _put_play["dte"],
                        "current_price": current_price,
                        "net_credit": combined_credit,
                        "max_risk": combined_risk,
                        "spread_width": SPREAD_WIDTH,
                        "buffer_pct": ic_buffer,
                        "volume": _put_play.get("volume", 0),
                        "open_interest": _put_play.get("open_interest", 0),
                        "iv": _put_play.get("iv", 0),
                    }
                    ic_score, _ = score_play(ic_play)
                    ic_analysis = generate_play_analysis(ic_play)
                    with get_db() as conn:
                        conn.execute(
                            """INSERT INTO plays
                            (symbol, play_type, short_strike, long_strike, expiration, dte,
                             current_price, net_credit, max_risk, spread_width, buffer_pct,
                             score, score_breakdown, volume, open_interest, iv, is_active, ai_analysis)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)""",
                            (
                                symbol, "iron_condor",
                                _put_play["short_strike"], _call_play["short_strike"],
                                _put_exp, _put_play["dte"],
                                round(current_price, 2), combined_credit, combined_risk,
                                SPREAD_WIDTH, round(ic_buffer, 2), ic_score,
                                json.dumps(ic_breakdown),
                                _put_play.get("volume", 0), _put_play.get("open_interest", 0),
                                round(_put_play.get("iv", 0), 4), ic_analysis,
                            ),
                        )
                        conn.commit()
                    print(f"  Iron Condor: {symbol} "
                          f"${_put_play['short_strike']:.0f}/{_call_play['short_strike']:.0f} "
                          f"exp={_put_exp} | Score {ic_score}/10 | Credit ${combined_credit:.2f}")

                time.sleep(1)  # yfinance rate limit buffer

            except Exception as e:
                print(f"  Scan error {symbol}: {e}")

        print(f"[{datetime.now():%H:%M:%S}] Scan complete.")

        # Check whether the scan actually inserted any new plays before deciding
        # to deactivate old ones. If the scan found nothing (all symbols blocked
        # by earnings filter, score threshold, etc.) we must NOT wipe the
        # previous scan's plays — users would be left with an empty feed until
        # the next successful scan. Only rotate when we have replacements.
        with get_db() as conn:
            new_plays = conn.execute(
                "SELECT symbol, score, net_credit, short_strike, long_strike, buffer_pct, ai_analysis "
                "FROM plays WHERE is_active=1 AND found_at >= ? ORDER BY score DESC",
                (scan_start_utc,),
            ).fetchall()

        if new_plays:
            # New plays found — atomically retire the previous scan's plays now
            # that fresh replacements are in. This is safe because we already
            # have the new rows committed above.
            with get_db() as conn:
                conn.execute(
                    "UPDATE plays SET is_active = 0 "
                    "WHERE is_active = 1 AND found_at < ?",
                    (scan_start_utc,),
                )
                conn.commit()
            print(f"[{datetime.now():%H:%M:%S}] Rotated plays — {len(new_plays)} new, previous deactivated.")
        else:
            print(f"[{datetime.now():%H:%M:%S}] Scan found no new plays — keeping previous plays active.")

        if new_plays:
            top = new_plays[0]
            count = len(new_plays)
            emoji = "🔥" if top["score"] >= 8 else "⚡"
            title = f"{emoji} {count} new play{'s' if count > 1 else ''} — {top['symbol']} scores {top['score']}/10"
            body = (f"${top['short_strike']:.0f}/{top['long_strike']:.0f} put spread · "
                    f"${top['net_credit']:.2f} credit · {top['buffer_pct']:.1f}% buffer")
            analysis = top["ai_analysis"] or ""
            # Rich push for pro/elite; basic push for all (basic tier)
            send_fcm_to_pro_elite(title, body, analysis, {"tab": "plays"})
            send_fcm_to_all(title, body, {"tab": "plays"})
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
            ticker = yf.Ticker(pos["symbol"], session=_yf_session)
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
                    if pnl_pct >= 50 and prev_pnl < 50:  # 50% of max profit = standard close target
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
    # Uses the cached earnings lookup so we don't refetch on every call and so
    # ETFs (SPY/QQQ/etc.) are cleanly excluded. Includes per-user watchlist
    # additions so stocks users care about can become the briefing pick.
    best = None          # (symbol, date, market_cap, price, beta, timing)
    for symbol in get_all_scanned_symbols():
        if _is_etf(symbol):
            continue
        try:
            tk = yf.Ticker(symbol, session=_yf_session)
            info = tk.info or {}
            price = info.get("regularMarketPrice") or info.get("currentPrice", 0)
            mktcap = info.get("marketCap", 0) or 0
            beta = info.get("beta", 1.0) or 1.0

            upcoming = get_upcoming_earnings(symbol, session=_yf_session)
            if not upcoming:
                continue

            # Find the first earnings date inside the window
            edate = next((d for d in upcoming if today < d <= window_end), None)
            if edate is None:
                continue

            # yfinance doesn't always give us the report time — default to AMC
            # (After Market Close), which is the more common cadence.
            timing = "After Market Close"
            try:
                df = tk.get_earnings_dates(limit=8)
                if df is not None and not df.empty:
                    for idx in df.index:
                        if getattr(idx, "date", lambda: None)() == edate:
                            timing = "Before Market Open" if idx.hour < 12 else "After Market Close"
                            break
            except Exception as e:
                print(f"  Earnings timing lookup {symbol}: {e}")

            if best is None or mktcap > best[2]:
                best = (symbol, edate, mktcap, price, beta, timing)
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
            spy = yf.Ticker("SPY", session=_yf_session)
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


def _keep_alive_ping():
    """Self-ping every 14 minutes to prevent Render free-tier cold starts."""
    import urllib.request
    # Try public URL first, fall back to localhost
    public_url = os.getenv("RENDER_EXTERNAL_URL", "")
    port = int(os.getenv("PORT", 8001))
    urls = [f"{public_url}/api/status"] if public_url else []
    urls.append(f"http://localhost:{port}/api/status")
    for url in urls:
        try:
            urllib.request.urlopen(url, timeout=5)
            break
        except Exception as e:
            log.debug("keep-alive ping to %s failed: %s", url, e)


_MARKET_HOLIDAYS_2026 = {
    __import__('datetime').date(2026, 1, 1),
    __import__('datetime').date(2026, 1, 19),
    __import__('datetime').date(2026, 2, 16),
    __import__('datetime').date(2026, 4, 3),
    __import__('datetime').date(2026, 5, 25),
    __import__('datetime').date(2026, 7, 3),
    __import__('datetime').date(2026, 9, 7),
    __import__('datetime').date(2026, 11, 26),
    __import__('datetime').date(2026, 12, 25),
}


def _is_market_day(now_et=None):
    """Return True if today is a trading day (Mon–Fri, not a holiday)."""
    if now_et is None:
        now_et = datetime.now(ZoneInfo("America/New_York"))
    return now_et.weekday() < 5 and now_et.date() not in _MARKET_HOLIDAYS_2026


def send_good_morning():
    """8:30 AM ET — Good morning wake-up push."""
    now_et = datetime.now(ZoneInfo("America/New_York"))
    if not _is_market_day(now_et):
        return
    send_fcm_to_all(
        "Good Morning ☀️",
        "Markets open in 1 hour. Fortress Bot is online and warming up.",
        {"tab": "plays"},
    )
    print(f"[{now_et:%H:%M:%S}] Good morning notification sent.")


def send_pre_scan_ready():
    """9:00 AM ET — Pre-scan 'getting things ready' push."""
    now_et = datetime.now(ZoneInfo("America/New_York"))
    if not _is_market_day(now_et):
        return
    send_fcm_to_all(
        "Pre-Market Scan 🔍",
        "30 minutes to open. Running pre-market analysis — getting plays ready.",
        {"tab": "plays"},
    )
    print(f"[{now_et:%H:%M:%S}] Pre-scan notification sent.")


def send_market_open_scanning():
    """9:30 AM ET — Market open, scanning for plays."""
    now_et = datetime.now(ZoneInfo("America/New_York"))
    if not _is_market_day(now_et):
        return
    send_fcm_to_all(
        "Markets Open — Scanning 🚀",
        "Bell just rang. Fortress Bot is scanning for high-probability plays now.",
        {"tab": "plays"},
    )
    # Kick off an immediate scan at market open
    threading.Thread(target=scan_and_save, daemon=True).start()
    print(f"[{now_et:%H:%M:%S}] Market open notification sent + scan triggered.")


# Track which morning notifications have fired today to avoid duplicates
_morning_fired: dict = {}


def _morning_routine_tick():
    """Called every minute. Fires morning notifications at the right ET times.
    Uses a 5-minute window per event so a slow/delayed tick doesn't miss the slot."""
    now_et = datetime.now(ZoneInfo("America/New_York"))
    today = now_et.date()
    total_minutes = now_et.hour * 60 + now_et.minute

    # Reset fired flags each new day
    if _morning_fired.get("date") != today:
        _morning_fired.clear()
        _morning_fired["date"] = today

    def _in_window(h, m):
        target = h * 60 + m
        return target <= total_minutes < target + 5

    if _in_window(8, 30) and not _morning_fired.get("good_morning"):
        _morning_fired["good_morning"] = True
        send_good_morning()

    if _in_window(9, 0) and not _morning_fired.get("pre_scan"):
        _morning_fired["pre_scan"] = True
        send_pre_scan_ready()

    if _in_window(9, 30) and not _morning_fired.get("market_open"):
        _morning_fired["market_open"] = True
        send_market_open_scanning()

    # Friday 8:30 — also fire weekly earnings briefing
    if _in_window(8, 30) and now_et.weekday() == 4 and not _morning_fired.get("earnings_briefing"):
        _morning_fired["earnings_briefing"] = True
        threading.Thread(target=send_weekly_earnings_briefing, daemon=True).start()


def _prune_stale_plays():
    """
    Every 30 min during market hours: deactivate plays where the opportunity
    has passed.  A play is considered stale if:
      - Bull-put spread: underlying has dropped below the short (put) strike
        (trade is now in-the-money — entry window closed).
      - Bear-call spread: underlying has risen above the short (call) strike.
    Also deactivates plays found more than 5.5 hours ago — well past any
    intraday entry window.
    """
    import yfinance as yf
    from zoneinfo import ZoneInfo
    now_et = datetime.now(ZoneInfo("America/New_York"))
    # Only run during market hours Mon–Fri 9:30–16:00 ET
    if now_et.weekday() >= 5 or not (9 * 60 + 30 <= now_et.hour * 60 + now_et.minute <= 16 * 60):
        return

    with get_db() as conn:
        plays = conn.execute(
            "SELECT id, symbol, play_type, short_strike, found_at FROM plays WHERE is_active=1"
        ).fetchall()

    if not plays:
        return

    # Group by symbol to minimise yfinance calls
    by_symbol: dict = {}
    for p in plays:
        by_symbol.setdefault(p["symbol"], []).append(p)

    deactivated = 0
    with get_db() as conn:
        for symbol, sym_plays in by_symbol.items():
            try:
                price = float(yf.Ticker(symbol).fast_info["last_price"])
            except Exception:
                continue
            for p in sym_plays:
                stale = False
                pt = (p["play_type"] or "").lower()
                ss = p["short_strike"]
                # Stale if in-the-money
                if "call" in pt and ss and price > ss * 1.005:
                    stale = True
                elif "put" in pt and ss and price < ss * 0.995:
                    stale = True
                # Stale if play is more than 5.5 hours old
                try:
                    found = datetime.fromisoformat(p["found_at"].replace("Z", "+00:00"))
                    age_hours = (datetime.now(found.tzinfo or None) - found).total_seconds() / 3600
                    if age_hours > 5.5:
                        stale = True
                except Exception:
                    pass
                if stale:
                    conn.execute("UPDATE plays SET is_active=-1 WHERE id=?", (p["id"],))
                    deactivated += 1
        if deactivated:
            conn.commit()
            print(f"[Prune] Deactivated {deactivated} stale play(s)")


def background_loop():
    sch.every(30).minutes.do(scan_and_save)
    sch.every(30).minutes.do(_prune_stale_plays)
    sch.every(5).minutes.do(update_positions)
    sch.every(14).minutes.do(_keep_alive_ping)
    sch.every(1).minutes.do(_morning_routine_tick)

    # Run immediately on startup
    scan_and_save()
    update_positions()

    while True:
        sch.run_pending()
        time.sleep(30)


# ─── App Lifespan ────────────────────────────────────────────────────────────


def seed_accounts():
    """Ensure owner accounts survive DB resets, and sync all active Stripe subscribers."""
    # Always seed the owner account with a known key
    owner_key = os.getenv("OWNER_API_KEY", "frt_IyX69zER4dj4TYNevSUdJ8iSBANMX6L0dPyLKJMaCzU")
    owner_email = os.getenv("OWNER_EMAIL", "antonio@fortress-options.com")
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM subscribers WHERE email=?", (owner_email,)).fetchone()
        if existing:
            conn.execute(
                "UPDATE subscribers SET api_key=?, tier='elite', status='active' WHERE email=?",
                (owner_key, owner_email),
            )
        else:
            conn.execute(
                "INSERT INTO subscribers (email, api_key, tier, status) VALUES (?,?,'elite','active')",
                (owner_email, owner_key),
            )
        conn.commit()

    # Sync all active Stripe subscribers into DB
    if not stripe.api_key:
        return
    try:
        for sub in stripe.Subscription.list(status="active", limit=100).auto_paging_iter():
            try:
                customer = stripe.Customer.retrieve(sub["customer"])
                email = customer.get("email", "").strip().lower()
                if not email:
                    continue
                amount = sub["items"]["data"][0]["price"]["unit_amount"]
                if amount <= 3000:
                    tier = "basic"
                elif amount <= 6000:
                    tier = "pro"
                else:
                    tier = "elite"
                with get_db() as conn:
                    row = conn.execute("SELECT id, api_key FROM subscribers WHERE email=?", (email,)).fetchone()
                    if row:
                        # Keep their existing key, just ensure status is active
                        conn.execute(
                            "UPDATE subscribers SET tier=?, status='active', stripe_customer_id=?, stripe_subscription_id=? WHERE email=?",
                            (tier, sub["customer"], sub["id"], email),
                        )
                    else:
                        new_key = generate_api_key()
                        conn.execute(
                            "INSERT INTO subscribers (email, api_key, tier, status, stripe_customer_id, stripe_subscription_id) VALUES (?,?,?,?,?,?)",
                            (email, new_key, tier, "active", sub["customer"], sub["id"]),
                        )
                    conn.commit()
            except Exception:
                continue
        print("[seed] Stripe subscriber sync complete")
    except Exception as e:
        print(f"[seed] Stripe sync failed (non-fatal): {e}")


def _recover_active_plays():
    """Re-activate the most recent scan's plays if a bad empty-scan deactivated
    everything. This is a one-time recovery that runs on startup; after the
    deactivation-guard fix it should never be needed again."""
    with get_db() as conn:
        active = conn.execute("SELECT COUNT(*) FROM plays WHERE is_active=1").fetchone()[0]
        if active == 0:
            # Find the most recent scan batch (latest found_at group)
            latest = conn.execute(
                "SELECT found_at FROM plays ORDER BY found_at DESC LIMIT 1"
            ).fetchone()
            if latest:
                # Re-activate everything from that scan (same minute window)
                batch_ts = latest["found_at"][:16]  # "YYYY-MM-DD HH:MM"
                conn.execute(
                    "UPDATE plays SET is_active=1 WHERE found_at LIKE ?",
                    (batch_ts + "%",),
                )
                conn.commit()
                print(f"[startup] Recovered active plays from batch {batch_ts}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_accounts()
    _recover_active_plays()
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
    billing: str = "monthly"  # "monthly" or "annual"
    success_url: str = "https://fortress-options.com/success"
    cancel_url: str = "https://fortress-options.com/#pricing"


# ─── API Routes ───────────────────────────────────────────────────────────────


def _plays_visible_thresholds():
    """Return (today_iso, cutoff_24h) — the same date thresholds /api/plays uses.
    Centralized so /api/status, /api/plays, and the admin debug endpoint stay
    aligned. UTC-based to match how the DB stores datetime('now')/NOW().
    """
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz
    now_utc = _dt.now(_tz.utc).replace(tzinfo=None)
    return (
        now_utc.strftime("%Y-%m-%d"),
        (now_utc - _td(hours=24)).strftime("%Y-%m-%d %H:%M:%S"),
    )


@app.get("/api/status")
def get_status():
    """
    Status snapshot for the home screen. The plays_available count uses the
    *same* filter as /api/plays so the badge can never drift from what the
    user actually sees in their feed (the cause of the "16 plays but app
    shows nothing" report).
    """
    today_iso, cutoff_24h = _plays_visible_thresholds()
    with get_db() as conn:
        plays_count = conn.execute(
            """SELECT COUNT(*) FROM plays
               WHERE expiration >= ?
               AND found_at >= ?
               AND is_active >= 0""",
            (today_iso, cutoff_24h),
        ).fetchone()[0]
        plays_total = conn.execute(
            "SELECT COUNT(*) FROM plays WHERE is_active=1"
        ).fetchone()[0]
        pos_count = conn.execute(
            "SELECT COUNT(*) FROM tracked_positions WHERE status='open'"
        ).fetchone()[0]
        alert_count = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE acknowledged=0"
        ).fetchone()[0]
        subs_count = conn.execute(
            "SELECT COUNT(*) FROM subscribers WHERE status='active'"
        ).fetchone()[0]
    return {
        "status": "online",
        "plays_available": plays_count,        # what the UI will actually render
        "plays_total_in_db": plays_total,      # diagnostic: every is_active=1 row
        "open_positions": pos_count,
        "unread_alerts": alert_count,
        "active_subscribers": subs_count,
        "scanning": _is_scanning,
        "timestamp": datetime.now().isoformat(),
    }


@app.get("/api/diagnostics")
def get_diagnostics(sub: dict = Depends(require_api_key)):
    """
    Per-user diagnostic so support can immediately see why a feed is empty.
    Reports: raw row counts at each filter step, the user's tier, the
    thresholds used, and a sample of the most recent plays.
    """
    today_iso, cutoff_24h = _plays_visible_thresholds()
    tier = (sub.get("tier") or "basic").lower()

    with get_db() as conn:
        rows_total = conn.execute("SELECT COUNT(*) FROM plays").fetchone()[0]
        rows_active = conn.execute(
            "SELECT COUNT(*) FROM plays WHERE is_active >= 0"
        ).fetchone()[0]
        rows_in_window = conn.execute(
            """SELECT COUNT(*) FROM plays
               WHERE expiration >= ? AND found_at >= ? AND is_active >= 0""",
            (today_iso, cutoff_24h),
        ).fetchone()[0]
        sample = conn.execute(
            """SELECT symbol, play_type, expiration, found_at, is_active, score
               FROM plays ORDER BY found_at DESC LIMIT 10"""
        ).fetchall()

    return {
        "tier": tier,
        "thresholds": {"today": today_iso, "cutoff_24h_utc": cutoff_24h},
        "row_counts": {
            "all_rows": rows_total,
            "is_active_gte_0": rows_active,
            "in_24h_window": rows_in_window,
        },
        "scanning": _is_scanning,
        "market_open": is_market_hours(),
        "recent_plays": [dict(r) for r in sample],
    }


# ─── Subscription Routes ──────────────────────────────────────────────────────

@app.post("/api/subscribe")
def subscribe(req: SubscribeRequest):
    """Create a Stripe Checkout session and return the payment URL."""
    if not req.tier in TIERS:
        raise HTTPException(400, f"Invalid tier. Choose: {list(TIERS.keys())}")
    try:
        url = create_checkout_session(req.email, req.tier, req.success_url, req.cancel_url, req.billing)
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


@app.post("/api/billing-portal")
def billing_portal(sub: dict = Depends(require_api_key)):
    """Create a Stripe Customer Portal session so the user can manage or cancel their subscription."""
    customer_id = sub.get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(400, "No billing account found for this API key.")
    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url="https://fortress-options.com/",
        )
        return {"url": session.url}
    except Exception as e:
        raise HTTPException(500, f"Stripe error: {e}")


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


# ─── Dynamic earnings calendar ────────────────────────────────────────────────
# Why: the EarningsScreen used to fetch a static website/earnings.json, which
# only updated when the admin panel was used (and even that wrote to Render's
# disk, never to the Vercel-hosted file). End result: the list went stale by
# over a year. This endpoint computes the upcoming-earnings list live from
# yfinance for every symbol the scanner sees (global watchlist + every user's
# personal additions), with a small TTL cache so we don't hammer yfinance.

_EARNINGS_RESPONSE_CACHE: tuple[float, dict] | None = None
_EARNINGS_RESPONSE_TTL = 30 * 60  # 30 min — earnings dates rarely move
_EARNINGS_COMPANY_CACHE: dict[str, str] = {}


def _company_name(symbol: str) -> str:
    """Best-effort yfinance long/short name lookup with an in-process cache.
    Falls back to the ticker symbol if yfinance can't tell us anything."""
    if symbol in _EARNINGS_COMPANY_CACHE:
        return _EARNINGS_COMPANY_CACHE[symbol]
    name = symbol
    try:
        info = yf.Ticker(symbol, session=_yf_session).info or {}
        name = info.get("longName") or info.get("shortName") or symbol
    except Exception as e:
        log.info("company-name lookup failed for %s: %s", symbol, e)
    _EARNINGS_COMPANY_CACHE[symbol] = name
    return name


def _fetch_finnhub_calendar(api_key: str, days_ahead: int = 30) -> list[dict]:
    """One-shot Finnhub earnings calendar pull. Returns the raw list (each
    item has symbol/date/hour/...). Empty list on any failure.

    Why one call: Finnhub's /calendar/earnings without a `symbol` param
    returns the entire universe in the date range — much cheaper than
    looping per ticker, and well under the 60/min free-tier ceiling.
    """
    import requests as _requests
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    cutoff = today + _td(days=days_ahead)
    url = "https://finnhub.io/api/v1/calendar/earnings"
    params = {
        "from": today.isoformat(),
        "to": cutoff.isoformat(),
        "token": api_key,
    }
    try:
        r = _requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        return r.json().get("earningsCalendar") or []
    except Exception as e:
        log.warning("Finnhub earnings fetch failed: %s", e)
        return []


@app.get("/api/earnings")
def get_earnings_calendar():
    """Public earnings calendar. Returns upcoming earnings for every symbol
    currently scanned (global + user watchlists), 30 days ahead, sorted by
    date. ETFs are excluded automatically. No auth — same surface as the
    legacy static earnings.json.

    Data sources, in priority order:
      1. Finnhub (if FINNHUB_API_KEY env var is set) — reliable, one bulk
         call covers all symbols, separate rate-limit pool from Yahoo.
      2. yfinance via earnings.py — fallback for installs without Finnhub
         configured. Yahoo aggressively throttles its earnings endpoints,
         so this often returns [] on a hot Render IP.
    """
    from datetime import date, timedelta
    from earnings import get_upcoming_earnings, is_etf

    global _EARNINGS_RESPONSE_CACHE
    now = time.time()
    if _EARNINGS_RESPONSE_CACHE and (now - _EARNINGS_RESPONSE_CACHE[0]) < _EARNINGS_RESPONSE_TTL:
        return _EARNINGS_RESPONSE_CACHE[1]

    today = date.today()
    cutoff = today + timedelta(days=30)
    scanned = {s.upper() for s in get_all_scanned_symbols() if not is_etf(s)}
    events: list[dict] = []

    # ── Path A: Finnhub ──────────────────────────────────────────────────
    finnhub_key = (os.getenv("FINNHUB_API_KEY") or "").strip()
    if finnhub_key:
        cal = _fetch_finnhub_calendar(finnhub_key, days_ahead=30)
        log.info("/api/earnings finnhub returned %d total entries", len(cal))
        for item in cal:
            sym = (item.get("symbol") or "").upper()
            if not sym or sym not in scanned:
                continue
            try:
                d = date.fromisoformat(item["date"])
            except Exception:
                continue
            if not (today <= d <= cutoff):
                continue
            hour = (item.get("hour") or "").lower()
            time_label = {
                "amc": "After Close",
                "bmo": "Before Open",
                "dmh": "During Market",
            }.get(hour, "After Close")
            events.append({
                "ticker": sym,
                # Finnhub's calendar response doesn't include company name;
                # fall back to our cached lookup which uses yfinance.info
                # but only for symbols we've never seen before.
                "company": _company_name(sym),
                "date": (
                    d.strftime("%b %#d, %Y") if os.name == "nt"
                    else d.strftime("%b %-d, %Y")
                ),
                "iso_date": d.isoformat(),
                "time": time_label,
            })

    # ── Path B: yfinance fallback ────────────────────────────────────────
    if not events:
        symbols = sorted(scanned)
        for i, symbol in enumerate(symbols):
            if i > 0:
                time.sleep(0.25)  # pace to dodge burst rate limit
            upcoming = get_upcoming_earnings(symbol, session=_yf_session)
            edate = next((d for d in upcoming if today <= d <= cutoff), None)
            if not edate:
                continue
            events.append({
                "ticker": symbol,
                "company": _company_name(symbol),
                "date": (
                    edate.strftime("%b %#d, %Y") if os.name == "nt"
                    else edate.strftime("%b %-d, %Y")
                ),
                "iso_date": edate.isoformat(),
                "time": "After Close",
            })

    # Sort by ISO date so consumers can rely on order regardless of locale.
    events.sort(key=lambda e: e["iso_date"])
    response = {"updated": today.isoformat(), "events": events}
    # Only cache populated responses — same reasoning as earnings.py: an empty
    # list almost always means a transient upstream failure, and we don't
    # want to serve [] for 30 min once one bad call lands.
    if events:
        _EARNINGS_RESPONSE_CACHE = (now, response)
    return response


@app.get("/api/auth/verify")
def verify_key(sub: dict = Depends(require_api_key)):
    """Check if an API key is valid and return subscriber info."""
    return {"valid": True, "email": sub["email"], "tier": sub["tier"]}


@app.post("/api/auth/recover")
def recover_key(email: str):
    """Re-issue API key for an existing Stripe subscriber.
    Looks up active Stripe subscription by email and re-seeds the account."""
    email = email.strip().lower()
    if not email:
        raise HTTPException(400, "Email required")

    # Check if already in DB with active subscription
    with get_db() as conn:
        existing = conn.execute(
            "SELECT api_key, tier, status FROM subscribers WHERE email=?", (email,)
        ).fetchone()
        if existing and existing["status"] == "active":
            send_api_key_email(email, existing["api_key"], existing["tier"])
            return {"message": "API key sent to your email"}

    # Look up in Stripe
    if not stripe.api_key:
        raise HTTPException(503, "Stripe not configured")
    try:
        customers = stripe.Customer.list(email=email, limit=1)
        if not customers.data:
            raise HTTPException(404, "No subscription found for that email")
        customer = customers.data[0]
        subs = stripe.Subscription.list(customer=customer.id, status="active", limit=1)
        if not subs.data:
            # Try trialing
            subs = stripe.Subscription.list(customer=customer.id, status="trialing", limit=1)
        if not subs.data:
            raise HTTPException(404, "No active subscription found for that email")
        sub = subs.data[0]
        # Determine tier from price amount
        amount = sub["items"]["data"][0]["price"]["unit_amount"]
        if amount <= 3000:
            tier = "basic"
        elif amount <= 6000:
            tier = "pro"
        else:
            tier = "elite"
        api_key = create_subscriber(email, tier, customer.id, sub.id)
        send_api_key_email(email, api_key, tier)
        return {"message": "API key sent to your email"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Recovery failed: {str(e)}")


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
    """Returns all plays found in the last 24h whose expiration is still in
    the future, latest scan first.

    Visibility rules:
      - elite / pro:   see *every* play the scanner finds (their tier is
                       "full access" — the per-user watchlist is for
                       reference only and must NOT shrink their feed).
      - basic:         see plays for symbols in their tier, plus anything
                       they've explicitly added to their user_watchlist.

    Implementation note: the date thresholds are computed in Python and bound
    as parameters so the same SQL works on SQLite and Postgres. The previous
    inline `datetime('now', '-24 hours')` SQLite-only syntax wasn't translated
    by db.py's Postgres shim and silently returned zero rows on Render.
    """
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz

    tier = (sub.get("tier") or "basic").lower()
    tier_symbols = set(TIERS.get(tier, TIERS["basic"])["symbols"])
    api_key = sub.get("api_key", "")

    # Bind UTC thresholds — both SQLite (datetime('now')) and Postgres (NOW())
    # use UTC, so comparing against ISO-8601 UTC strings works in both.
    now_utc = _dt.now(_tz.utc).replace(tzinfo=None)
    cutoff_24h = (now_utc - _td(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    today_iso = now_utc.strftime("%Y-%m-%d")

    with get_db() as conn:
        rows = conn.execute(
            """SELECT * FROM plays
               WHERE expiration >= ?
               AND found_at >= ?
               AND is_active >= 0
               ORDER BY found_at DESC, score DESC, net_credit DESC""",
            (today_iso, cutoff_24h),
        ).fetchall()
        # Personal watchlist symbols for this user (basic tier only).
        uw_rows = conn.execute(
            "SELECT symbol FROM user_watchlist WHERE api_key=?", (api_key,)
        ).fetchall()

    plays = [dict(r) for r in rows]
    log.info(
        "/api/plays tier=%s rows=%d cutoff=%s today=%s",
        tier, len(plays), cutoff_24h, today_iso,
    )

    if tier in ("elite", "pro"):
        # Full access — never filter. This was a longstanding bug where elite
        # users would silently lose plays for symbols outside their seeded
        # user_watchlist (e.g. anything added to the global scanner watchlist).
        return plays

    user_symbols = {r["symbol"] for r in uw_rows}
    allowed = tier_symbols | user_symbols
    return [p for p in plays if p["symbol"] in allowed]


@app.post("/api/scan")
def trigger_scan():
    t = threading.Thread(target=lambda: scan_and_save(force=True), daemon=True)
    t.start()
    return {"message": "Scan started"}


# ─── Watchlist endpoints ──────────────────────────────────────────────────────

@app.get("/api/watchlist")
def api_get_watchlist(sub: dict = Depends(require_api_key)):
    symbols = get_watchlist()
    return {"symbols": symbols, "is_custom": bool(
        next(iter([1]), None) and
        len(symbols) != len(DEFAULT_WATCHLIST)
    )}


class WatchlistItem(BaseModel):
    symbol: str


@app.post("/api/watchlist/add")
def api_watchlist_add(item: WatchlistItem, sub: dict = Depends(require_api_key)):
    sym = item.symbol.upper().strip()
    if not sym or len(sym) > 10:
        raise HTTPException(400, "Invalid symbol")
    # Seed DB with defaults if empty before adding
    with get_db() as conn:
        existing = conn.execute("SELECT symbol FROM watchlist").fetchall()
        if not existing:
            for s in DEFAULT_WATCHLIST:
                conn.execute("INSERT OR IGNORE INTO watchlist (symbol) VALUES (?)", (s,))
        conn.execute("INSERT OR IGNORE INTO watchlist (symbol) VALUES (?)", (sym,))
        conn.commit()
    return {"symbols": get_watchlist()}


@app.delete("/api/watchlist/{symbol}")
def api_watchlist_remove(symbol: str, sub: dict = Depends(require_api_key)):
    sym = symbol.upper().strip()
    with get_db() as conn:
        existing = conn.execute("SELECT symbol FROM watchlist").fetchall()
        if not existing:
            # Seed defaults first so user can remove from a full list
            for s in DEFAULT_WATCHLIST:
                conn.execute("INSERT OR IGNORE INTO watchlist (symbol) VALUES (?)", (s,))
        conn.execute("DELETE FROM watchlist WHERE symbol=?", (sym,))
        conn.commit()
    return {"symbols": get_watchlist()}


# ─── Personal watchlist (per-user) ───────────────────────────────────────────

@app.get("/api/user-watchlist")
def api_user_watchlist_get(sub: dict = Depends(require_api_key)):
    """Return the calling user's personal watchlist symbols, seeding defaults on first use."""
    api_key = sub.get("api_key", "")
    with get_db() as conn:
        rows = conn.execute(
            "SELECT symbol FROM user_watchlist WHERE api_key=? ORDER BY symbol", (api_key,)
        ).fetchall()
        if not rows:
            # First time — seed with the default watchlist
            for sym in DEFAULT_WATCHLIST:
                conn.execute(
                    "INSERT OR IGNORE INTO user_watchlist (api_key, symbol) VALUES (?,?)",
                    (api_key, sym)
                )
            conn.commit()
            rows = conn.execute(
                "SELECT symbol FROM user_watchlist WHERE api_key=? ORDER BY symbol", (api_key,)
            ).fetchall()
    return {"symbols": [r["symbol"] for r in rows]}


@app.post("/api/user-watchlist")
def api_user_watchlist_add(item: WatchlistItem, sub: dict = Depends(require_api_key)):
    """Add a symbol to the calling user's personal watchlist."""
    sym = item.symbol.upper().strip()
    if not sym or len(sym) > 10 or not sym.isalpha():
        raise HTTPException(400, "Invalid symbol")
    api_key = sub.get("api_key", "")
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO user_watchlist (api_key, symbol) VALUES (?,?)",
            (api_key, sym)
        )
        conn.commit()
        rows = conn.execute(
            "SELECT symbol FROM user_watchlist WHERE api_key=? ORDER BY symbol", (api_key,)
        ).fetchall()
    return {"symbols": [r["symbol"] for r in rows]}


@app.delete("/api/user-watchlist/{symbol}")
def api_user_watchlist_remove(symbol: str, sub: dict = Depends(require_api_key)):
    """Remove a symbol from the calling user's personal watchlist."""
    sym = symbol.upper().strip()
    api_key = sub.get("api_key", "")
    with get_db() as conn:
        conn.execute(
            "DELETE FROM user_watchlist WHERE api_key=? AND symbol=?", (api_key, sym)
        )
        conn.commit()
        rows = conn.execute(
            "SELECT symbol FROM user_watchlist WHERE api_key=? ORDER BY symbol", (api_key,)
        ).fetchall()
    return {"symbols": [r["symbol"] for r in rows]}


# ─── Stats endpoint ───────────────────────────────────────────────────────────

@app.get("/api/stats")
def api_stats(sub: dict = Depends(require_api_key)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT pnl_pct FROM tracked_positions WHERE status='closed'"
        ).fetchall()
    closed = [r["pnl_pct"] or 0 for r in rows]
    total = len(closed)
    if total == 0:
        return {"total_trades": 0, "win_rate": 0.0, "avg_pnl": 0.0, "best_trade": 0.0}
    wins = sum(1 for p in closed if p >= 30)  # captured 30%+ of max credit = win
    return {
        "total_trades": total,
        "win_rate": round((wins / total) * 100, 1),
        "avg_pnl": round(sum(closed) / total, 1),
        "best_trade": round(max(closed), 1),
    }


# ─── Stock Splits endpoint ───────────────────────────────────────────────────

@app.get("/api/splits")
def api_splits(sub: dict = Depends(require_api_key)):
    """
    Return upcoming and recent stock splits for symbols the user can access.
    - Checks splits in a ±60-day window around today using yfinance.
    - Returns list of {symbol, ratio, date, days_away, type: 'upcoming'|'recent'}.
    """
    from datetime import date, timedelta
    import pandas as pd

    tier = sub.get("tier", "basic")
    tier_info = TIERS.get(tier, TIERS["basic"])
    symbols = tier_info["symbols"]

    today = date.today()
    window_past  = today - timedelta(days=14)   # show splits up to 14 days ago
    window_future = today + timedelta(days=60)   # show splits up to 60 days ahead

    results = []
    for symbol in symbols:
        try:
            ticker = yf.Ticker(symbol, session=_yf_session)
            splits = ticker.splits  # pandas Series, index = DatetimeIndex, values = ratio

            if splits is None or splits.empty:
                continue

            for split_date, ratio in splits.items():
                d = split_date.date() if hasattr(split_date, 'date') else split_date
                if window_past <= d <= window_future and ratio != 1.0:
                    days_away = (d - today).days
                    results.append({
                        "symbol": symbol,
                        "ratio": float(ratio),
                        "date": d.isoformat(),
                        "days_away": days_away,
                        "type": "upcoming" if days_away >= 0 else "recent",
                    })
        except Exception:
            continue

    # Sort: upcoming first (soonest first), then recent (most recent first)
    results.sort(key=lambda x: x["days_away"] if x["days_away"] >= 0 else 999 - x["days_away"])
    return {"splits": results}


@app.get("/api/admin/scan-now")
def scan_now_sync(admin_key: str = ""):
    """Admin: run full scan synchronously and return per-symbol results."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    today = datetime.now()
    results = []
    for symbol in WATCHLIST:
        r = {"symbol": symbol}
        try:
            ticker = yf.Ticker(symbol, session=_yf_session)
            price = float(ticker.fast_info["last_price"])
            r["price"] = round(price, 2)
            exps = ticker.options
            valid = [(e, (datetime.strptime(e, "%Y-%m-%d") - today).days) for e in exps
                     if MIN_DTE <= (datetime.strptime(e, "%Y-%m-%d") - today).days <= MAX_DTE]
            if not valid:
                r["status"] = "no_exp_in_window"
                results.append(r)
                continue
            exp, dte = valid[0]
            r["exp"] = exp
            r["dte"] = dte
            chain = ticker.option_chain(exp)
            puts = chain.puts
            puts = puts[(puts["bid"] > 0) & (puts["ask"] > 0)]
            lower = price * (1 - OTM_BUFFER_MAX)
            upper = price * (1 - OTM_BUFFER_MIN)
            cands = puts[(puts["strike"] >= lower) & (puts["strike"] <= upper)]
            r["candidates"] = len(cands)
            best = 0.0
            qualifying = []
            for _, row in cands.iterrows():
                ss = float(row["strike"])
                ls = ss - SPREAD_WIDTH
                lr = puts[puts["strike"] == ls]
                if not lr.empty:
                    c = round(((float(row["bid"]) + float(row["ask"])) / 2) -
                               ((float(lr.iloc[0]["bid"]) + float(lr.iloc[0]["ask"])) / 2), 2)
                    best = max(best, c)
                    if PREMIUM_MIN <= c <= PREMIUM_MAX:
                        qualifying.append({"short": ss, "long": ls, "credit": c})
            r["best_credit"] = round(best, 2)
            r["qualifying_count"] = len(qualifying)
            r["qualifying"] = qualifying[:3]
            r["status"] = "found" if qualifying else ("low_credit" if best > 0 else "no_spread")
        except Exception as e:
            r["status"] = "error"
            r["error"] = str(e)
        results.append(r)
    # Also show what's in DB right now
    with get_db() as conn:
        db_plays = conn.execute("SELECT symbol, short_strike, net_credit, is_active, found_at FROM plays ORDER BY found_at DESC LIMIT 10").fetchall()
    return {
        "scan_results": results,
        "db_plays": [dict(p) for p in db_plays],
        "market_open": is_market_hours()
    }


@app.get("/api/admin/debug-scan")
def debug_scan(admin_key: str = ""):
    """Admin: run a single-symbol scan synchronously and return diagnostic output."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    import io, contextlib
    results = []
    today = datetime.now()
    for symbol in WATCHLIST:
        sym_result = {"symbol": symbol}
        try:
            ticker = yf.Ticker(symbol, session=_yf_session)
            price = float(ticker.fast_info["last_price"])
            exps = ticker.options
            sym_result["price"] = round(price, 2)
            valid_exps = [(e, (datetime.strptime(e, "%Y-%m-%d") - today).days) for e in exps
                          if MIN_DTE <= (datetime.strptime(e, "%Y-%m-%d") - today).days <= MAX_DTE]
            if not valid_exps:
                sym_result["status"] = "no_valid_exp"
                results.append(sym_result)
                continue
            exp, dte = valid_exps[0]
            chain = ticker.option_chain(exp)
            puts = chain.puts
            puts_with_bid = puts[(puts["bid"] > 0) & (puts["ask"] > 0)]
            lower = price * (1 - OTM_BUFFER_MAX)
            upper = price * (1 - OTM_BUFFER_MIN)
            cands = puts_with_bid[(puts_with_bid["strike"] >= lower) & (puts_with_bid["strike"] <= upper)]
            best_credit = 0.0
            qualifying = []
            for _, row in cands.iterrows():
                short_s = float(row["strike"])
                long_s = short_s - SPREAD_WIDTH
                long_row = puts_with_bid[puts_with_bid["strike"] == long_s]
                if not long_row.empty:
                    credit = round(((float(row["bid"]) + float(row["ask"])) / 2) -
                                   ((float(long_row.iloc[0]["bid"]) + float(long_row.iloc[0]["ask"])) / 2), 2)
                    best_credit = max(best_credit, credit)
                    if PREMIUM_MIN <= credit <= PREMIUM_MAX:
                        qualifying.append({"short": short_s, "long": long_s, "credit": credit, "dte": dte})
            sym_result["exp"] = exp
            sym_result["dte"] = dte
            sym_result["best_credit"] = best_credit
            sym_result["qualifies"] = len(qualifying) > 0
            sym_result["qualifying"] = qualifying[:3]
        except Exception as e:
            sym_result["error"] = str(e)
        results.append(sym_result)
    return {"debug": results, "settings": {"MIN_DTE": MIN_DTE, "MAX_DTE": MAX_DTE, "PREMIUM_MIN": PREMIUM_MIN, "PREMIUM_MAX": PREMIUM_MAX, "OTM_BUFFER": f"{OTM_BUFFER_MIN}-{OTM_BUFFER_MAX}"}}


@app.get("/api/admin/debug-fcm")
def debug_fcm(admin_key: str = ""):
    """Admin: show FCM init status, registered tokens, and attempt a test push."""
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    import firebase_admin as _fa
    firebase_initialized = bool(_fa._apps)
    with get_db() as conn:
        rows = conn.execute("SELECT api_key, token, updated_at FROM fcm_tokens").fetchall()
    tokens = [{"api_key": r["api_key"][:12] + "...", "token": r["token"][:20] + "...", "updated_at": r["updated_at"]} for r in rows]
    # Attempt test send to each token
    test_results = []
    if firebase_initialized and rows:
        for r in rows:
            try:
                msg = fcm_messaging.Message(
                    notification=fcm_messaging.Notification(title="🔔 FCM Test", body="Push is working!"),
                    data={"tab": "plays"},
                    android=fcm_messaging.AndroidConfig(priority="high"),
                    token=r["token"],
                )
                resp = fcm_messaging.send(msg)
                test_results.append({"token": r["token"][:20] + "...", "result": "sent", "message_id": resp})
            except Exception as e:
                test_results.append({"token": r["token"][:20] + "...", "result": "failed", "error": str(e)})
    return {
        "firebase_initialized": firebase_initialized,
        "firebase_service_account_set": bool(os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")),
        "registered_tokens": tokens,
        "token_count": len(tokens),
        "test_sends": test_results,
    }


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


# ─── Admin Panel ─────────────────────────────────────────────────────────────

EARNINGS_JSON_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "website", "earnings.json")

class EarningsUpdateRequest(BaseModel):
    admin_key: str
    events: list  # list of {ticker, company, date, time}

@app.get("/api/admin/earnings")
def get_earnings(admin_key: str = ""):
    if admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    if os.path.exists(EARNINGS_JSON_PATH):
        with open(EARNINGS_JSON_PATH) as f:
            return json.load(f)
    return {"events": []}

@app.post("/api/admin/earnings")
def update_earnings(req: EarningsUpdateRequest):
    if req.admin_key != os.getenv("ADMIN_KEY", "fortress_admin"):
        raise HTTPException(403, "Unauthorized")
    from datetime import date
    data = {"updated": date.today().isoformat(), "events": req.events}
    with open(EARNINGS_JSON_PATH, "w") as f:
        json.dump(data, f, indent=2)
    return {"ok": True, "count": len(req.events)}

_ADMIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fortress Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0A0A0B;color:#e4e4e7;font-family:system-ui,sans-serif;padding:24px;max-width:760px;margin:0 auto}
h1{font-size:1.4rem;font-weight:700;color:#10b981;margin-bottom:24px}
h2{font-size:1rem;font-weight:600;color:#a1a1aa;margin-bottom:12px;margin-top:28px}
input,select{background:#18181b;border:1px solid #3f3f46;border-radius:8px;color:#e4e4e7;padding:8px 12px;font-size:14px;width:100%}
input:focus,select:focus{outline:none;border-color:#10b981}
button{background:#10b981;color:#003918;font-weight:700;padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px}
button:hover{background:#34d399}
button.del{background:#3f3f46;color:#e4e4e7;padding:6px 12px;font-size:12px}
button.del:hover{background:#ef4444;color:#fff}
.row{display:grid;grid-template-columns:80px 1fr 110px 120px 60px;gap:8px;align-items:center;margin-bottom:8px}
.row.header{color:#71717a;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
#status{margin-top:16px;padding:10px 14px;background:#18181b;border-radius:8px;font-size:13px;color:#10b981;display:none}
.key-row{display:flex;gap:8px;margin-bottom:24px}
.key-row input{max-width:300px}
</style>
</head>
<body>
<h1>Fortress Options Admin</h1>

<div class="key-row">
  <input id="adminKey" type="password" placeholder="Admin key" />
  <button onclick="load()">Load</button>
</div>

<h2>Upcoming Earnings</h2>
<div class="row header">
  <span>Ticker</span><span>Company</span><span>Date</span><span>Time</span><span></span>
</div>
<div id="events"></div>
<button onclick="addRow()" style="background:#3f3f46;color:#e4e4e7;margin-top:8px">+ Add Row</button>

<br/><br/>
<button onclick="save()">Save & Publish</button>
<div id="status"></div>

<script>
const API = window.location.origin;

function load() {
  const key = document.getElementById('adminKey').value;
  fetch(`${API}/api/admin/earnings?admin_key=${encodeURIComponent(key)}`)
    .then(r => r.json())
    .then(data => {
      const container = document.getElementById('events');
      container.innerHTML = '';
      (data.events || []).forEach(e => addRow(e));
    })
    .catch(() => alert('Failed - check admin key'));
}

function addRow(e = {}) {
  const container = document.getElementById('events');
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <input placeholder="AAPL" value="${e.ticker||''}" />
    <input placeholder="Apple Inc." value="${e.company||''}" />
    <input placeholder="May 1, 2025" value="${e.date||''}" />
    <select>
      <option value="After Close" ${e.time==='After Close'?'selected':''}>After Close</option>
      <option value="Before Open" ${e.time==='Before Open'?'selected':''}>Before Open</option>
    </select>
    <button class="del" onclick="this.parentElement.remove()">x</button>
  `;
  container.appendChild(row);
}

function save() {
  const key = document.getElementById('adminKey').value;
  const rows = document.querySelectorAll('#events .row');
  const events = Array.from(rows).map(row => {
    const inputs = row.querySelectorAll('input,select');
    return { ticker: inputs[0].value.trim().toUpperCase(), company: inputs[1].value.trim(), date: inputs[2].value.trim(), time: inputs[3].value };
  }).filter(e => e.ticker);

  fetch(`${API}/api/admin/earnings`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ admin_key: key, events })
  })
  .then(r => r.json())
  .then(data => {
    const s = document.getElementById('status');
    s.style.display = 'block';
    s.textContent = data.ok ? `Saved ${data.count} events - live immediately` : 'Error saving';
    setTimeout(() => s.style.display = 'none', 4000);
  });
}
</script>
</body>
</html>"""

@app.get("/admin", include_in_schema=False)
def admin_panel():
    from fastapi.responses import HTMLResponse
    return HTMLResponse(_ADMIN_HTML)


# --- Serve React App ----------------------------------------------------------

DIST_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "dist")
if os.path.exists(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="static")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8001))
    uvicorn.run("backend.api:app", host="0.0.0.0", port=port, reload=False)

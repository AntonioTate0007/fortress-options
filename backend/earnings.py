"""
Earnings filter — centralized earnings-date lookups with caching, ETF bypass,
and robust error handling.

Used by:
  - scan_and_save()            : skip symbols with earnings inside the DTE window
  - send_weekly_earnings_briefing() : pick the highest-profile earnings next week
  - scanner.py (standalone)    : keep the prototype consistent with production
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional

log = logging.getLogger("fortress.earnings")

# ETFs don't report earnings; always bypass.
ETF_SYMBOLS: set[str] = {
    "SPY", "QQQ", "IWM", "DIA", "VTI", "VOO", "VXUS", "SCHD",
    "XLF", "XLK", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XRE",
    "ARKK", "GLD", "SLV", "TLT", "HYG", "LQD",
}

# Cache: symbol -> (fetched_at_epoch, list[date])  — one entry per symbol
_CACHE: dict[str, tuple[float, list[date]]] = {}
_CACHE_TTL = 6 * 3600  # 6 hours is plenty — earnings dates don't change hourly
_CACHE_LOCK = threading.Lock()


def _to_date(obj) -> Optional[date]:
    """Best-effort coercion of a yfinance earnings-date index value into a date."""
    if obj is None:
        return None
    if isinstance(obj, date) and not isinstance(obj, datetime):
        return obj
    if isinstance(obj, datetime):
        # Drop timezone to compare to naive `today`
        return obj.date()
    # Pandas Timestamp, etc. — they expose .date()
    if hasattr(obj, "date"):
        try:
            return obj.date()
        except Exception:
            return None
    return None


def is_etf(symbol: str) -> bool:
    return (symbol or "").upper() in ETF_SYMBOLS


def _fetch_earnings_dates(symbol: str, session=None, limit: int = 8) -> list[date]:
    """
    Ask yfinance for upcoming earnings dates. Returns a de-duplicated, sorted
    list of dates (earliest first). Returns [] on any error or missing data.

    Strategy: try Ticker.calendar first (a small dict including the next
    earnings date — most stable API surface), then fall back to
    Ticker.get_earnings_dates() for historical context. Recent yfinance
    releases (~0.2.40+) have a parser regression where get_earnings_dates()
    raises KeyError(['Earnings Date']) for many tickers, so calendar is
    actually the more reliable source for the *upcoming* date.

    Rate-limit handling: Yahoo aggressively throttles bursts ("Too Many
    Requests"). We retry once with a longer backoff before giving up — the
    second attempt usually succeeds since the throttle is short-lived.
    Callers should still pace bulk lookups (sleep between symbols) so the
    first attempt has a fighting chance.
    """
    try:
        import yfinance as yf
    except ImportError:
        log.warning("yfinance not installed — earnings filter disabled")
        return []

    kwargs = {"session": session} if session is not None else {}
    dates: list[date] = []

    def _is_rate_limited(err: Exception) -> bool:
        s = str(err).lower()
        return "too many requests" in s or "rate limit" in s or "429" in s

    # ── Path 1: Ticker.calendar — returns a small dict with the next earnings
    # date(s). Stable across recent yfinance versions.
    for attempt in (0, 1):
        try:
            tk = yf.Ticker(symbol, **kwargs)
            cal = tk.calendar
            # cal can be a DataFrame (older yfinance) or a dict (newer). Handle
            # both. The earnings date(s) live under a key whose name varies slightly.
            cal_dates = None
            if isinstance(cal, dict):
                cal_dates = cal.get("Earnings Date") or cal.get("earnings_date")
            elif cal is not None and hasattr(cal, "loc"):
                try:
                    cal_dates = cal.loc["Earnings Date"].tolist()
                except Exception:
                    pass
            if cal_dates:
                if not isinstance(cal_dates, (list, tuple)):
                    cal_dates = [cal_dates]
                for v in cal_dates:
                    d = _to_date(v)
                    if d is not None:
                        dates.append(d)
            break  # success or empty cal — don't retry
        except Exception as e:
            if attempt == 0 and _is_rate_limited(e):
                log.info("calendar rate-limited for %s, retrying in 3s", symbol)
                time.sleep(3.0)
                continue
            log.info("calendar lookup failed for %s: %s", symbol, e)
            break

    # ── Path 2: Ticker.get_earnings_dates() — historical + future. Often
    # works; tolerate failure since calendar already gave us the upcoming.
    try:
        tk = yf.Ticker(symbol, **kwargs)
        df = tk.get_earnings_dates(limit=limit)
        if df is not None and not df.empty:
            for idx in df.index:
                d = _to_date(idx)
                if d is not None:
                    dates.append(d)
    except Exception as e:
        log.info("get_earnings_dates failed for %s: %s", symbol, e)

    return sorted(set(dates))


def get_upcoming_earnings(symbol: str, session=None, use_cache: bool = True) -> list[date]:
    """
    Return a list of upcoming earnings dates for the symbol (today or later),
    earliest first. Empty list if none/unknown.

    Uses a small in-process TTL cache so repeated scans don't hammer yfinance.
    Empty results are NOT cached — yfinance occasionally returns nothing under
    rate-limit / network blips, and a stuck-empty cache used to lock the
    /api/earnings feed at zero events for hours.
    """
    sym = (symbol or "").upper()
    if not sym:
        return []
    if is_etf(sym):
        return []  # fast path — ETFs don't report

    now = time.time()
    if use_cache:
        with _CACHE_LOCK:
            entry = _CACHE.get(sym)
        if entry and (now - entry[0]) < _CACHE_TTL:
            all_dates = entry[1]
        else:
            all_dates = _fetch_earnings_dates(sym, session=session)
            # Only cache positive results. An empty list usually means "we got
            # rate limited / lxml not installed yet / yfinance hiccup", and
            # we want the next call to retry instead of serving []  for 6h.
            if all_dates:
                with _CACHE_LOCK:
                    _CACHE[sym] = (now, all_dates)
    else:
        all_dates = _fetch_earnings_dates(sym, session=session)

    today = date.today()
    return [d for d in all_dates if d >= today]


def has_earnings_in_window(
    symbol: str,
    window_days: int,
    session=None,
) -> tuple[bool, Optional[date]]:
    """
    Return (True, earnings_date) if the symbol has an earnings report within
    the next `window_days` days (inclusive). ETFs always return (False, None).

    Failures to fetch data are treated as "no earnings known" — we prefer to
    scan and let the user decide than to skip everything when yfinance is flaky.
    """
    if is_etf(symbol):
        return (False, None)
    upcoming = get_upcoming_earnings(symbol, session=session)
    if not upcoming:
        return (False, None)

    today = date.today()
    limit = today + timedelta(days=window_days)
    for d in upcoming:
        if today <= d <= limit:
            return (True, d)
    return (False, None)


def clear_cache() -> None:
    """Drop all cached earnings data (useful for tests and manual refreshes)."""
    with _CACHE_LOCK:
        _CACHE.clear()

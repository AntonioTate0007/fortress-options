import yfinance as yf


def score_play(play: dict) -> tuple[int, dict]:
    """Score a play from 1-10. Returns (score, breakdown)."""
    pts = {}

    # 1. Premium/risk ratio (0-3 pts) — credit as % of spread width
    ratio = play["net_credit"] / play["spread_width"]
    pts["premium_ratio"] = 3 if ratio >= 0.14 else 2 if ratio >= 0.09 else 1 if ratio >= 0.07 else 0

    # 2. Safety buffer (0-2 pts) — how far OTM the short strike is
    buf = play["buffer_pct"]
    pts["buffer"] = 2 if buf >= 7.0 else 1 if buf >= 5.5 else 0

    # 3. Liquidity (0-2 pts) — volume + open interest at the short strike
    vol = play.get("volume") or 0
    oi = play.get("open_interest") or 0
    pts["liquidity"] = 2 if (vol > 500 or oi > 2000) else 1 if (vol > 100 or oi > 500) else 0

    # 4. DTE quality (0-2 pts) — sweet spot 9-12 days
    dte = play["dte"]
    pts["dte"] = 2 if 9 <= dte <= 12 else 1 if 7 <= dte <= 14 else 0

    # 5. IV factor (0-1 pt) — moderate-high IV is good for selling premium
    iv = play.get("iv") or 0
    pts["iv"] = 1 if iv >= 0.20 else 0

    total = sum(pts.values())  # max possible: 10
    score = max(1, min(10, total))
    return score, pts


def get_exit_recommendation(symbol: str, position: dict) -> dict:
    """RSI + buffer analysis for exit decision."""
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="1mo", interval="1d")

        if len(hist) < 14:
            return {"recommendation": "hold", "summary": "Not enough data", "rsi": None,
                    "current_price": 0, "buffer_pct": 0, "reasons": ["Insufficient price history"], "exit_signals": 0}

        # RSI-14
        delta = hist["Close"].diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / loss
        rsi = float(100 - (100 / (1 + rs.iloc[-1])))

        current_price = float(hist["Close"].iloc[-1])
        short_strike = position["short_strike"]
        buffer_pct = ((current_price - short_strike) / current_price) * 100

        reasons = []
        exit_signals = 0

        if rsi < 35:
            exit_signals += 2
            reasons.append(f"RSI {rsi:.0f} — strong bearish momentum, stock approaching strikes")
        elif rsi < 45:
            exit_signals += 1
            reasons.append(f"RSI {rsi:.0f} — weakening momentum, monitor closely")
        else:
            reasons.append(f"RSI {rsi:.0f} — neutral to bullish, favorable for put spreads")

        if buffer_pct < 2.0:
            exit_signals += 2
            reasons.append(f"Buffer only {buffer_pct:.1f}% — dangerously close to short strike ${short_strike}")
        elif buffer_pct < 3.5:
            exit_signals += 1
            reasons.append(f"Buffer {buffer_pct:.1f}% — tightening, consider closing early")
        else:
            reasons.append(f"Buffer {buffer_pct:.1f}% — comfortable distance from short strike")

        pnl = position.get("pnl_pct") or 0
        if pnl >= 50:
            reasons.append(f"Already at {pnl:.0f}% of max profit — consider locking in gains")
            exit_signals += 1

        if exit_signals >= 3:
            rec, summary = "exit", "EXIT — Multiple warning signals active"
        elif exit_signals >= 2:
            rec, summary = "caution", "CAUTION — Consider reducing or closing"
        else:
            rec, summary = "hold", "HOLD — Position looks healthy"

        return {
            "recommendation": rec,
            "summary": summary,
            "rsi": round(rsi, 1),
            "current_price": round(current_price, 2),
            "buffer_pct": round(buffer_pct, 1),
            "reasons": reasons,
            "exit_signals": exit_signals,
        }

    except Exception as e:
        return {"recommendation": "hold", "summary": f"Error fetching data", "rsi": None,
                "current_price": 0, "buffer_pct": 0, "reasons": [str(e)], "exit_signals": 0}

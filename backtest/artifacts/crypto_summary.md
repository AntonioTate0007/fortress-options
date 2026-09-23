# Crypto Majors Backtest Results
**Generated:** 2026-09-23 01:07:02

## Executive Summary

### 🎯 Recommendation for Next Session (Wed Sep 23, 2026)
**WAIT**

---

## Backtest Configuration

- **Period:** 2024-09-23 to 2026-09-23
- **Underlyings:** BTC, ETH
- **Strategy:** Pullback-to-MA + Breakout Momentum
- **Allocation:** 50% of book per trade (~$1,000 on $2,000 book)
- **Fee Model:** Robinhood-style 0.50% per side (1.00% round-trip)

---

## Strategy Rules

### Entry Signals (Either triggers entry)

**Rule 1: Pullback-to-MA Bounce**
- Price pulls back to 20-day MA (within 1%)
- Bounce candle: close > open
- MA reclaim signal

**Rule 2: Breakout Momentum**
- Price breaks above 10-day high
- Volume spike: >1.2x average volume
- Momentum continuation

### Exit Rules
- **Profit Target:** 3% gain
- **Stop Loss:** 2% loss
- **Max Hold:** 7 days
- **Risk:Reward:** 1.5:1 (3% target / 2% stop)

---

## Performance Metrics

### Full Period (Full backtest)
- **Total Trades:** 129
- **Win Rate:** 45.7% (59W / 70L)
- **Avg R-Multiple:** -35.65R (after fees)
- **Total P&L:** $-919.76
- **Avg P&L per Trade:** $-7.13
- **Max Drawdown:** $-1,057.50
- **Total Fees Paid:** $1,288.69

### Last 90 Days (Last 90 days)
- **Total Trades:** 18
- **Win Rate:** 50.0% (9W / 9L)
- **Avg R-Multiple:** -24.91R
- **Total P&L:** $-89.68
- **Avg P&L per Trade:** $-4.98
- **Max Drawdown:** $-168.60

### Last 30 Days (Last 30 days)
- **Total Trades:** 4
- **Win Rate:** 50.0% (2W / 2L)
- **Avg R-Multiple:** -25.12R
- **Total P&L:** $-20.10
- **Avg P&L per Trade:** $-5.02
- **Max Drawdown:** $-29.78

---

## Best & Worst Trades

**Best Trade:**  
BTC Breakout | 2024-10-14 → 2024-10-16 | $66,046.12 → $68,027.51 | P&L: $19.73 (2.0%) | 98.63R | Exit: Target

**Worst Trade:**  
ETH Breakout | 2024-10-14 → 2024-10-15 | $2,628.90 → $2,576.32 | P&L: $-29.78 (-3.0%) | -148.88R | Exit: Stop

---

## Fee Model (Robinhood-Style)

### Fee Structure
- **Per-side fee:** 0.50% of position value
- **Round-trip cost:** 1.00% (entry + exit)
- **Calculation:** 
  - Entry fee = Position size × 0.50%
  - Exit fee = Exit value × 0.50%
  - Net P&L = Exit value - Entry cost - Entry fee - Exit fee

### Example on $1,000 position:
- Entry fee: $5.00
- Exit fee: $5.00
- Total round-trip fees: $10.00

**All P&L figures reported are NET of fees.**

---

## Recommendation Logic

### Decision Criteria
- **GO:** 30d win rate ≥60% AND 30d avg R ≥0.5 AND 30d max DD > -$200 AND ≥3 trades
- **WAIT:** Otherwise (insufficient recent performance or sample size)

### Applied to Recent Results
- 30d Win Rate: 50.0%
- 30d Avg R: -25.12R
- 30d Max Drawdown: $-29.78
- 30d Trades: 4

**Verdict:** WAIT


### Next Session Playbook
Recent 30-day performance does not meet GO criteria. Recommended actions:
1. Monitor signals but do NOT take positions tonight
2. Wait for improved 30-day metrics (win rate, R-multiple, drawdown)
3. Re-evaluate after additional data points
4. Preserve capital until trend improves

---

## Potential Failures & Mitigations

### 1. Fee Impact Underestimation
**Break Mode:** Robinhood fees may vary or increase; slippage not modeled.

**Impact:** Real-world P&L may be 0.5-1% lower per trade than backtest.

**Fix:** Monitor actual fees in Robinhood statements; adjust fee_pct parameter if needed. Add slippage buffer (0.1-0.2%) for volatile periods.

### 2. Signal Overfitting to Historical Data
**Break Mode:** Pullback/breakout rules calibrated to past 2 years may not persist.

**Impact:** Future win rate and R-multiple may degrade if market regime changes.

**Fix:** Monitor 30d/90d rolling metrics. Stop trading if 30d win rate drops below 50% or avg R drops below 0. Recalibrate rules quarterly.

### 3. Gap Risk (24/7 Crypto Markets)
**Break Mode:** Crypto trades 24/7; stop losses may not execute at exact price due to gaps or flash crashes.

**Impact:** Actual stop loss may be >2% in extreme volatility events.

**Fix:** Use limit orders for profit targets and market orders for stops (accept slippage). Avoid trading during known high-volatility events (major news, Fed announcements).

### 4. Overnight Holding Risk
**Break Mode:** Max 7-day hold exposes positions to multi-day adverse moves.

**Impact:** Drawdown may exceed -2% stop if crypto experiences extended selloff.

**Fix:** Consider tightening stop loss to 1.5% or reducing max hold to 3-5 days. Monitor correlations (BTC/ETH often move together; avoid concurrent positions if correlation >0.8).

### 5. Data Quality (yfinance)
**Break Mode:** yfinance crypto data may have gaps or delayed updates for historical dates.

**Impact:** Backtest signals may not exactly match live signal generation.

**Fix:** For live trading, use Robinhood API or CoinGecko/CoinMarketCap for real-time price/volume data. Verify signal generation logic against live data before trading.

---

## Files Generated
- `crypto_trades.csv` — Individual trade log with fees and R-multiples
- `crypto_results.json` — Full metrics in JSON format
- `crypto_summary.md` — This report

---

**Backtest Engine:** Crypto Majors v1.0  
**Strategy:** Pullback-to-MA + Breakout Momentum  
**Fee Model:** Robinhood-style 0.50% per side (1.00% round-trip)  
**Disclaimer:** Past performance is not indicative of future results. Crypto markets are highly volatile. This is a simulated backtest. Use for research purposes only.

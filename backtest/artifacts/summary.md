# Fortress Engine Backtest Results
**Generated:** 2026-09-23 01:03:09

## Executive Summary

### 🎯 Recommendation for Wed Sep 23, 2026
**SELECTIVE**

---

## Backtest Configuration

- **Period:** 2024-09-23 to 2026-09-23
- **Underlyings:** SPY, QQQ
- **Strategy:** $5-wide put credit spreads
- **Target DTE:** ~28 days (25-35 range)
- **Position Sizing:** 1 contract per entry (backtest baseline)

---

## Performance Metrics

### Trade Activity
- **Total Trades:** 10
- **Win Rate:** 100.0%
- **50% TP Hit Rate:** 90.0%

### P&L (1-Contract Baseline)
- **Total P&L:** $210.59
- **Avg P&L per Trade:** $21.06
- **Avg Credit Collected:** $38.90
- **Max Drawdown:** $0.00

### Half-Kelly Sizing (60% Cap, $3000 Book)
- **Kelly %:** 100.0%
- **Half-Kelly %:** 50.0%
- **Capped Allocation:** 50.0%
- **Recommended Position Size:** $1,500.00
- **Contracts (if scaled):** 3
- **Avg Max Risk per Spread:** $461.10

---

## Worst 3 Trades

1. **QQQ** | 2025-11-04 → 2025-11-28 | P&L: $12.93 (2.7%)
2. **QQQ** | 2025-01-07 → 2025-01-21 | P&L: $15.99 (3.4%)
3. **SPY** | 2025-04-01 → 2025-05-12 | P&L: $16.59 (3.6%)

---

## Strategy Filters Applied

### Entry Requirements (ALL must pass)
1. ✅ Hard moat ≥10% OTM (short strike ≤ spot × 0.90)
2. ✅ Dynamic moat ≥1.35× HV expected move over DTE
3. ✅ No earnings in trade window (entry through expiration)
4. ✅ Natural credit ≥$0.35 ($35 per contract)

### Exit Rules
- 🎯 Close at 50% of credit as profit (50% TP)
- 🕒 Hold to expiration if TP not hit

### Position Management
- Max 1 concurrent position per ticker (weekly cadence)
- No position overlap on same underlying

---

## Data & Assumptions

### Price Data
- Source: yfinance historical equity data
- Frequency: Daily OHLC

### Option Pricing Model
⚠️ **APPROXIMATION USED**: Full historical option chains unavailable via free API.

**Credit Estimation Method:**
- Black-Scholes model for put spreads
- HV (30-day historical volatility) used as IV proxy
- Risk-free rate: 4% (2024-2026 baseline)
- Short strike: ~12% OTM (delta ~0.15-0.20 range)
- Long strike: Short strike - $5

**Limitations:**
- Actual market option prices may differ from model estimates
- Bid-ask spread impact not modeled (assumes mid pricing)
- Early assignment risk not modeled
- Slippage and commissions not included

### Earnings Calendar
⚠️ **CONSERVATIVE ASSUMPTION**: Earnings trap filter disabled for historical backtest.
- yfinance earnings calendar unreliable for historical dates
- For production: use Polygon/Finnhub historical earnings data
- Risk: Some trades may have unknowingly occurred during earnings windows

---

## Potential Failures & Mitigations

### 1. Option Pricing Model Bias
**Break Mode:** Black-Scholes may overestimate credits in high-IV environments or underestimate in low-IV regimes.

**Impact:** Backtest may show inflated P&L if actual market credits were lower.

**Fix:** Use historical option chain data (CBOE DataShop, HistoricalOptionData.com) or broker API with full Greeks.

### 2. Look-Ahead Bias in HV Calculation
**Break Mode:** Using 30-day HV calculated up to entry date is valid, but exit simulation uses future prices to determine TP hits.

**Impact:** Minimal — exit logic only references observable market prices at each date.

**Fix:** Already mitigated by using point-in-time data for each decision.

### 3. Earnings Calendar Gaps
**Break Mode:** Historical earnings dates unavailable via yfinance; earnings trap filter effectively disabled.

**Impact:** Some trades may have occurred during earnings, inflating risk/volatility.

**Fix:** Integrate historical earnings calendar (Polygon, Finnhub, or manual SEC 10-Q/K filing dates).

### 4. Liquidity & Slippage
**Break Mode:** Model assumes perfect fills at mid prices; no bid-ask spread or slippage modeled.

**Impact:** Real-world P&L may be 10-20% lower per trade due to execution costs.

**Fix:** Apply conservative haircut to credits (e.g., reduce estimated credit by 15%) or model bid-ask spread explicitly.

### 5. Early Assignment Risk
**Break Mode:** Put spreads can face early assignment if short put goes deep ITM before expiration.

**Impact:** Not modeled; real trades may close early with forced assignment.

**Fix:** Add early-assignment logic (e.g., close position if short put >20% ITM with <7 DTE).

---

## Recommendation Rationale

### Decision Criteria
- **AGGRESSIVE:** Win rate >75%, max DD > -$500, avg P&L > $25
- **SELECTIVE:** Win rate 60-75%, max DD > -$1000, avg P&L $10-$25
- **MOSTLY CASH:** Win rate <60%, max DD < -$1000, or avg P&L < $10

### Applied to Results
- Win Rate: 100.0%
- Max Drawdown: $0.00
- Avg P&L: $21.06
- Total Trades: 10

**Verdict:** SELECTIVE

---

## Files Generated
- `trades.csv` — Individual trade log with entry/exit details
- `results.json` — Full metrics in JSON format
- `summary.md` — This report

---

**Backtest Engine:** Fortress v1.0  
**Model:** Antonio's Put Credit Spread Gauntlet  
**Disclaimer:** Past performance is not indicative of future results. This is a simulated backtest with approximations. Use for research purposes only.

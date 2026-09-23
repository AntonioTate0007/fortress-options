# Fortress Engine Backtest

Historical backtest of Antonio's Fortress put-credit-spread gauntlet strategy on SPY and QQQ.

## Overview

This backtest implements the complete Fortress strategy rules:
- **Underlyings:** SPY and QQQ only
- **Structure:** $5-wide put credit spreads
- **Target DTE:** ~28 days (monthly options, 25-35 DTE range)
- **Entry filters:** Hard moat ≥10% OTM, dynamic moat ≥1.35× HV expected move, no earnings, min credit $0.35
- **Exit:** 50% profit target OR hold to expiration
- **Position sizing:** 1 contract baseline + half-Kelly 60% cap on $3000 book

## Requirements

```bash
pip install yfinance pandas numpy scipy
```

## Usage

### Run the backtest

```bash
cd backtest
python fortress_backtest.py
```

The script will:
1. Fetch ~2 years of historical data for SPY and QQQ
2. Scan for trade opportunities using the Fortress filters
3. Simulate trades from entry through exit (50% TP or expiration)
4. Generate performance metrics and recommendation
5. Save results to `artifacts/`

### Output files

- **`artifacts/trades.csv`** — Individual trade log with entry/exit details
- **`artifacts/results.json`** — Full metrics in JSON format
- **`artifacts/summary.md`** — Executive summary with recommendation

## Backtest Timeline

- **Start:** ~2 years before run date
- **End:** Most recent data available from yfinance
- **Frequency:** Daily scans for new entries

## Strategy Rules (Exact Implementation)

### Entry Filters (ALL must pass)
1. **Hard moat:** Short strike ≤ spot × 0.90 (≥10% OTM)
2. **Dynamic moat:** Moat ≥ 1.35× HV expected move over DTE
3. **Earnings trap:** Skip if earnings fall in trade window
4. **Minimum credit:** Natural credit ≥ $0.35 ($35 per contract)

### Exit Rules
- Close at 50% of credit taken as profit
- Hold to expiration if profit target not hit

### Position Management
- Max 1 concurrent position per ticker (weekly cadence)
- No overlapping positions on same underlying

## Data Sources & Approximations

### ⚠️ Important: Option Pricing Model

Full historical option chains are **not available** via free APIs. This backtest uses a **Black-Scholes approximation**:

- **Short put:** ~12% OTM (delta ~0.15-0.20 range)
- **Long put:** Short strike - $5
- **IV proxy:** 30-day historical volatility (HV)
- **Risk-free rate:** 4% (2024-2026 baseline)

**Limitations:**
- Actual market option prices may differ from model estimates
- Bid-ask spread impact not modeled (assumes mid pricing)
- Slippage and commissions not included
- Results are **approximate** and labeled as such in the output

### Earnings Calendar

The earnings trap filter is **disabled** for historical backtests due to unreliable historical earnings data from yfinance.

For production, integrate:
- Polygon.io historical earnings
- Finnhub earnings calendar
- Manual SEC 10-Q/K filing dates

## Metrics Reported

### Trade Activity
- Total trades taken
- Win rate
- 50% TP hit rate vs hold-to-expiry outcomes

### P&L (1-Contract Baseline)
- Total P&L
- Avg P&L per trade
- Avg credit collected
- Max drawdown

### Half-Kelly Sizing (60% Cap, $3000 Book)
- Kelly %
- Half-Kelly % (50% of full Kelly)
- Capped allocation (max 60%)
- Recommended position size
- Contracts (if scaled)

### Worst Trades
- Top 3 losing trades with details

## Recommendation Logic

The backtest generates one of three recommendations:

- **AGGRESSIVE:** Win rate >75%, max DD > -$500, avg P&L > $25
- **SELECTIVE:** Win rate 60-75%, max DD > -$1000, avg P&L $10-$25
- **MOSTLY CASH:** Win rate <60%, max DD < -$1000, or avg P&L < $10

## Potential Failures & Fixes

### 1. Option Pricing Model Bias
- **Break mode:** Black-Scholes may overestimate credits in high-IV or underestimate in low-IV
- **Fix:** Use historical option chain data (CBOE DataShop, HistoricalOptionData.com)

### 2. Earnings Calendar Gaps
- **Break mode:** Historical earnings dates unavailable; filter disabled
- **Fix:** Integrate Polygon/Finnhub historical earnings calendar

### 3. Liquidity & Slippage
- **Break mode:** Model assumes perfect fills at mid prices
- **Fix:** Apply conservative haircut to credits (e.g., -15%) or model bid-ask spread

### 4. Early Assignment Risk
- **Break mode:** Deep ITM short puts may face early assignment
- **Fix:** Add early-assignment logic (close if short put >20% ITM with <7 DTE)

## Reference

Original gauntlet selection logic: `uploads/FortressEngine_0140.py`

## Disclaimer

This is a **simulated backtest with approximations**. Past performance is not indicative of future results. Use for research purposes only. Do not place live orders based solely on backtest results.

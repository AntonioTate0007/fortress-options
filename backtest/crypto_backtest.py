#!/usr/bin/env python3
"""
Crypto Majors Backtest - BTC & ETH
Simple, tradeable rules for nightly market-night digests

Strategy: Pullback-to-MA Bounce + Breakout Momentum
- Rule 1 (Pullback): Buy when price pulls back to 20-day MA and bounces
- Rule 2 (Breakout): Buy when price breaks above recent high after consolidation
- Fee model: Robinhood-style 0.50% per trade (in/out = 1.00% round-trip)
- Hold period: 1-7 days (exit at target or stop)
- Targets: 3% profit, 2% stop loss (R = 1.5:1)
"""

import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional
import json

class CryptoBacktest:
    def __init__(self, tickers: List[str], start_date: str, end_date: str,
                 initial_capital: float = 2000.0):
        self.tickers = tickers
        self.start_date = pd.to_datetime(start_date)
        self.end_date = pd.to_datetime(end_date)
        self.initial_capital = initial_capital
        
        # Fee model: Robinhood-style 0.50% per side (1.00% round-trip)
        self.fee_pct = 0.005
        
        # Strategy parameters
        self.ma_period = 20
        self.profit_target_pct = 0.03
        self.stop_loss_pct = 0.02
        self.max_hold_days = 7
        self.breakout_lookback = 10
        self.allocation_per_trade = 0.50
        
        self.price_data = {}
        self.trades = []
        self.equity_curve = []
        self.cash = initial_capital
        
    def fetch_historical_data(self):
        """Fetch historical crypto price data."""
        print("Fetching crypto data...")
        for ticker in self.tickers:
            print(f"  Loading {ticker}...")
            
            crypto_ticker = f"{ticker}-USD"
            stock = yf.Ticker(crypto_ticker)
            hist = stock.history(start=self.start_date, end=self.end_date, interval='1d')
            
            if hist.empty:
                raise ValueError(f"No data for {ticker}")
            
            hist.index = hist.index.tz_localize(None)
            self.price_data[ticker] = hist
            
        print(f"Data loaded: {len(self.price_data)} tickers\n")
    
    def calculate_ma(self, prices: pd.Series, period: int) -> pd.Series:
        """Calculate moving average."""
        return prices.rolling(window=period).mean()
    
    def identify_pullback_signal(self, hist: pd.DataFrame, current_date: pd.Timestamp) -> bool:
        """
        Pullback-to-MA signal: Price pulls back to 20-day MA and bounces.
        
        Criteria:
        - Price crossed below MA in last 2 days
        - Today's close is within 1% of MA
        - Today's close > today's open (bounce candle)
        """
        if current_date not in hist.index:
            return False
        
        idx = hist.index.get_loc(current_date)
        if idx < self.ma_period + 2:
            return False
        
        hist_slice = hist.iloc[:idx+1].copy()
        hist_slice['MA'] = self.calculate_ma(hist_slice['Close'], self.ma_period)
        
        if len(hist_slice) < 3:
            return False
        
        today = hist_slice.iloc[-1]
        yesterday = hist_slice.iloc[-2]
        
        if pd.isna(today['MA']) or pd.isna(yesterday['MA']):
            return False
        
        price_to_ma_ratio = today['Close'] / today['MA']
        
        crossed_below = (yesterday['Close'] < yesterday['MA']) or (hist_slice.iloc[-3]['Close'] < hist_slice.iloc[-3]['MA'])
        
        near_ma = 0.99 <= price_to_ma_ratio <= 1.02
        
        bounce_candle = today['Close'] > today['Open']
        
        return crossed_below and near_ma and bounce_candle
    
    def identify_breakout_signal(self, hist: pd.DataFrame, current_date: pd.Timestamp) -> bool:
        """
        Breakout signal: Price breaks above recent high after consolidation.
        
        Criteria:
        - Today's close > highest high of last 10 days (excluding today)
        - Volume spike: today's volume > 1.2x average volume (10-day)
        """
        if current_date not in hist.index:
            return False
        
        idx = hist.index.get_loc(current_date)
        if idx < self.breakout_lookback + 1:
            return False
        
        hist_slice = hist.iloc[:idx+1].copy()
        
        if len(hist_slice) < self.breakout_lookback + 1:
            return False
        
        today = hist_slice.iloc[-1]
        lookback_window = hist_slice.iloc[-(self.breakout_lookback+1):-1]
        
        recent_high = lookback_window['High'].max()
        avg_volume = lookback_window['Volume'].mean()
        
        breakout = today['Close'] > recent_high
        volume_spike = today['Volume'] > (avg_volume * 1.2)
        
        return breakout and volume_spike
    
    def simulate_trade(self, ticker: str, entry_date: pd.Timestamp, entry_price: float,
                       signal_type: str) -> Optional[Dict]:
        """
        Simulate trade from entry to exit.
        Exit: 3% profit target, 2% stop loss, or 7-day max hold.
        """
        hist = self.price_data[ticker]
        
        trade_window = hist[entry_date:]
        if trade_window.empty or len(trade_window) < 2:
            return None
        
        position_size = self.initial_capital * self.allocation_per_trade
        
        entry_fee = position_size * self.fee_pct
        net_position = position_size - entry_fee
        shares = net_position / entry_price
        
        profit_target_price = entry_price * (1 + self.profit_target_pct)
        stop_loss_price = entry_price * (1 - self.stop_loss_pct)
        
        exit_date = None
        exit_price = None
        exit_reason = None
        
        for i, (date, row) in enumerate(trade_window.iterrows()):
            if date == entry_date:
                continue
            
            days_held = (date - entry_date).days
            
            if row['High'] >= profit_target_price:
                exit_date = date
                exit_price = profit_target_price
                exit_reason = 'Target'
                break
            
            if row['Low'] <= stop_loss_price:
                exit_date = date
                exit_price = stop_loss_price
                exit_reason = 'Stop'
                break
            
            if days_held >= self.max_hold_days:
                exit_date = date
                exit_price = row['Close']
                exit_reason = 'MaxHold'
                break
        
        if exit_date is None:
            exit_date = trade_window.index[-1]
            exit_price = trade_window.iloc[-1]['Close']
            exit_reason = 'EOD'
        
        exit_value = shares * exit_price
        exit_fee = exit_value * self.fee_pct
        net_exit_value = exit_value - exit_fee
        
        pnl = net_exit_value - position_size
        pnl_pct = (pnl / position_size) * 100
        
        days_held = (exit_date - entry_date).days
        
        r_multiple = pnl_pct / self.stop_loss_pct if self.stop_loss_pct > 0 else 0
        
        return {
            'ticker': ticker,
            'signal_type': signal_type,
            'entry_date': entry_date.strftime('%Y-%m-%d'),
            'exit_date': exit_date.strftime('%Y-%m-%d'),
            'days_held': days_held,
            'entry_price': round(entry_price, 2),
            'exit_price': round(exit_price, 2),
            'exit_reason': exit_reason,
            'position_size': round(position_size, 2),
            'shares': round(shares, 6),
            'entry_fee': round(entry_fee, 2),
            'exit_fee': round(exit_fee, 2),
            'total_fees': round(entry_fee + exit_fee, 2),
            'pnl': round(pnl, 2),
            'pnl_pct': round(pnl_pct, 2),
            'r_multiple': round(r_multiple, 2)
        }
    
    def run_backtest(self):
        """Run historical backtest with pullback and breakout rules."""
        print("Running crypto backtest...\n")
        print("Strategy Rules:")
        print("  - Underlyings: BTC, ETH")
        print("  - Rule 1 (Pullback): Buy when price pulls back to 20-MA and bounces")
        print("  - Rule 2 (Breakout): Buy when price breaks above recent high + volume spike")
        print("  - Profit Target: 3%")
        print("  - Stop Loss: 2%")
        print("  - Max Hold: 7 days")
        print("  - Fees: Robinhood-style 0.50% per side (1.00% round-trip)")
        print("  - Allocation: 50% of book per trade\n")
        
        self.fetch_historical_data()
        
        active_positions = {ticker: None for ticker in self.tickers}
        
        all_dates = set()
        for ticker in self.tickers:
            all_dates.update(self.price_data[ticker].index)
        backtest_dates = sorted(list(all_dates))
        
        trades_taken = 0
        signals_generated = 0
        
        for current_date in backtest_dates:
            for ticker in self.tickers:
                hist = self.price_data[ticker]
                
                if current_date not in hist.index:
                    continue
                
                if active_positions[ticker] is not None:
                    active_exit = active_positions[ticker]
                    if current_date >= active_exit:
                        active_positions[ticker] = None
                
                if active_positions[ticker] is not None:
                    continue
                
                entry_price = hist.loc[current_date, 'Close']
                
                pullback_signal = self.identify_pullback_signal(hist, current_date)
                breakout_signal = self.identify_breakout_signal(hist, current_date)
                
                signal_type = None
                if pullback_signal:
                    signal_type = 'Pullback'
                    signals_generated += 1
                elif breakout_signal:
                    signal_type = 'Breakout'
                    signals_generated += 1
                
                if signal_type is None:
                    continue
                
                trade = self.simulate_trade(ticker, current_date, entry_price, signal_type)
                
                if trade is not None:
                    self.trades.append(trade)
                    trades_taken += 1
                    
                    exit_date = pd.to_datetime(trade['exit_date'])
                    active_positions[ticker] = exit_date + timedelta(days=1)
                    
                    print(f"[{current_date.strftime('%Y-%m-%d')}] {ticker} {signal_type} entry @ ${entry_price:,.2f}")
        
        print(f"\n{'='*60}")
        print(f"Backtest Complete!")
        print(f"{'='*60}")
        print(f"Signals generated: {signals_generated}")
        print(f"Trades taken: {trades_taken}")
        print(f"{'='*60}\n")
    
    def analyze_results(self, lookback_days: Optional[int] = None) -> Dict:
        """Analyze backtest results, optionally for a specific recent period."""
        if not self.trades:
            return {
                'period': f'Last {lookback_days} days' if lookback_days else 'Full backtest',
                'total_trades': 0,
                'win_rate': 0,
                'avg_r': 0,
                'total_pnl': 0,
                'avg_pnl': 0,
                'max_drawdown': 0,
                'total_fees': 0,
                'winners': 0,
                'losers': 0,
                'best_trade': None,
                'worst_trade': None
            }
        
        df = pd.DataFrame(self.trades)
        
        if lookback_days:
            cutoff_date = self.end_date - timedelta(days=lookback_days)
            df['entry_date_dt'] = pd.to_datetime(df['entry_date'])
            df = df[df['entry_date_dt'] >= cutoff_date].copy()
            
            if df.empty:
                return {
                    'period': f'Last {lookback_days} days',
                    'total_trades': 0,
                    'win_rate': 0,
                    'avg_r': 0,
                    'total_pnl': 0,
                    'avg_pnl': 0,
                    'max_drawdown': 0,
                    'total_fees': 0,
                    'winners': 0,
                    'losers': 0,
                    'best_trade': None,
                    'worst_trade': None
                }
        
        winners = df[df['pnl'] > 0]
        losers = df[df['pnl'] <= 0]
        win_rate = len(winners) / len(df) * 100 if len(df) > 0 else 0
        
        avg_r = df['r_multiple'].mean()
        total_pnl = df['pnl'].sum()
        avg_pnl = df['pnl'].mean()
        total_fees = df['total_fees'].sum()
        
        cumulative_pnl = df['pnl'].cumsum()
        running_max = cumulative_pnl.cummax()
        drawdown = cumulative_pnl - running_max
        max_drawdown = drawdown.min()
        
        best_trade_df = df.nlargest(1, 'pnl')
        worst_trade_df = df.nsmallest(1, 'pnl')
        
        best_trade = best_trade_df.to_dict('records')[0] if len(best_trade_df) > 0 else None
        worst_trade = worst_trade_df.to_dict('records')[0] if len(worst_trade_df) > 0 else None
        
        if best_trade and 'entry_date_dt' in best_trade:
            del best_trade['entry_date_dt']
        if worst_trade and 'entry_date_dt' in worst_trade:
            del worst_trade['entry_date_dt']
        
        return {
            'period': f'Last {lookback_days} days' if lookback_days else 'Full backtest',
            'total_trades': len(df),
            'win_rate': round(win_rate, 1),
            'avg_r': round(avg_r, 2),
            'total_pnl': round(total_pnl, 2),
            'avg_pnl': round(avg_pnl, 2),
            'max_drawdown': round(max_drawdown, 2),
            'total_fees': round(total_fees, 2),
            'winners': len(winners),
            'losers': len(losers),
            'best_trade': best_trade,
            'worst_trade': worst_trade,
            'cumulative_pnl': cumulative_pnl.tolist() if not cumulative_pnl.empty else []
        }
    
    def generate_recommendation(self, metrics_30d: Dict, metrics_90d: Dict) -> str:
        """
        Generate GO/WAIT recommendation for next session.
        
        Decision criteria:
        - GO: 30d win rate >60%, 30d avg R >0.5, 30d max DD > -$200
        - WAIT: Otherwise
        """
        win_rate_30d = metrics_30d['win_rate']
        avg_r_30d = metrics_30d['avg_r']
        max_dd_30d = metrics_30d['max_drawdown']
        trades_30d = metrics_30d['total_trades']
        
        if trades_30d < 3:
            return "WAIT"
        
        if win_rate_30d >= 60 and avg_r_30d >= 0.5 and max_dd_30d > -200:
            return "GO"
        else:
            return "WAIT"
    
    def save_results(self, output_dir: str = "artifacts"):
        """Save crypto backtest results to files."""
        import os
        os.makedirs(output_dir, exist_ok=True)
        
        metrics_full = self.analyze_results()
        metrics_90d = self.analyze_results(lookback_days=90)
        metrics_30d = self.analyze_results(lookback_days=30)
        
        recommendation = self.generate_recommendation(metrics_30d, metrics_90d)
        
        df = pd.DataFrame(self.trades)
        df.to_csv(f"{output_dir}/crypto_trades.csv", index=False)
        
        results = {
            'backtest_period': {
                'start': self.start_date.strftime('%Y-%m-%d'),
                'end': self.end_date.strftime('%Y-%m-%d')
            },
            'fee_model': {
                'type': 'Robinhood-style',
                'fee_per_side_pct': self.fee_pct * 100,
                'round_trip_pct': self.fee_pct * 2 * 100
            },
            'metrics_full': metrics_full,
            'metrics_90d': metrics_90d,
            'metrics_30d': metrics_30d,
            'recommendation': recommendation
        }
        
        with open(f"{output_dir}/crypto_results.json", 'w') as f:
            json.dump(results, f, indent=2)
        
        self.generate_summary_report(metrics_full, metrics_90d, metrics_30d, recommendation, output_dir)
        
        print(f"\nCrypto results saved to {output_dir}/")
        print(f"  - crypto_trades.csv: {len(self.trades)} trades")
        print(f"  - crypto_results.json: full metrics")
        print(f"  - crypto_summary.md: final report\n")
    
    def generate_summary_report(self, metrics_full: Dict, metrics_90d: Dict,
                               metrics_30d: Dict, recommendation: str, output_dir: str):
        """Generate markdown summary report."""
        report = f"""# Crypto Majors Backtest Results
**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Executive Summary

### 🎯 Recommendation for Next Session (Wed Sep 23, 2026)
**{recommendation}**

---

## Backtest Configuration

- **Period:** {self.start_date.strftime('%Y-%m-%d')} to {self.end_date.strftime('%Y-%m-%d')}
- **Underlyings:** {', '.join(self.tickers)}
- **Strategy:** Pullback-to-MA + Breakout Momentum
- **Allocation:** {self.allocation_per_trade*100:.0f}% of book per trade (~${self.initial_capital * self.allocation_per_trade:,.0f} on ${self.initial_capital:,.0f} book)
- **Fee Model:** Robinhood-style {self.fee_pct*100:.2f}% per side ({self.fee_pct*2*100:.2f}% round-trip)

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

### Full Period ({metrics_full['period']})
- **Total Trades:** {metrics_full['total_trades']}
- **Win Rate:** {metrics_full['win_rate']}% ({metrics_full['winners']}W / {metrics_full['losers']}L)
- **Avg R-Multiple:** {metrics_full['avg_r']}R (after fees)
- **Total P&L:** ${metrics_full['total_pnl']:,.2f}
- **Avg P&L per Trade:** ${metrics_full['avg_pnl']:.2f}
- **Max Drawdown:** ${metrics_full['max_drawdown']:,.2f}
- **Total Fees Paid:** ${metrics_full['total_fees']:,.2f}

### Last 90 Days ({metrics_90d['period']})
- **Total Trades:** {metrics_90d['total_trades']}
- **Win Rate:** {metrics_90d['win_rate']}% ({metrics_90d['winners']}W / {metrics_90d['losers']}L)
- **Avg R-Multiple:** {metrics_90d['avg_r']}R
- **Total P&L:** ${metrics_90d['total_pnl']:,.2f}
- **Avg P&L per Trade:** ${metrics_90d['avg_pnl']:.2f}
- **Max Drawdown:** ${metrics_90d['max_drawdown']:,.2f}

### Last 30 Days ({metrics_30d['period']})
- **Total Trades:** {metrics_30d['total_trades']}
- **Win Rate:** {metrics_30d['win_rate']}% ({metrics_30d['winners']}W / {metrics_30d['losers']}L)
- **Avg R-Multiple:** {metrics_30d['avg_r']}R
- **Total P&L:** ${metrics_30d['total_pnl']:,.2f}
- **Avg P&L per Trade:** ${metrics_30d['avg_pnl']:.2f}
- **Max Drawdown:** ${metrics_30d['max_drawdown']:,.2f}

---

## Best & Worst Trades
"""
        
        if metrics_full['best_trade']:
            bt = metrics_full['best_trade']
            report += f"\n**Best Trade:**  \n"
            report += f"{bt['ticker']} {bt['signal_type']} | {bt['entry_date']} → {bt['exit_date']} | "
            report += f"${bt['entry_price']:,.2f} → ${bt['exit_price']:,.2f} | "
            report += f"P&L: ${bt['pnl']:.2f} ({bt['pnl_pct']:.1f}%) | {bt['r_multiple']:.2f}R | Exit: {bt['exit_reason']}\n"
        
        if metrics_full['worst_trade']:
            wt = metrics_full['worst_trade']
            report += f"\n**Worst Trade:**  \n"
            report += f"{wt['ticker']} {wt['signal_type']} | {wt['entry_date']} → {wt['exit_date']} | "
            report += f"${wt['entry_price']:,.2f} → ${wt['exit_price']:,.2f} | "
            report += f"P&L: ${wt['pnl']:.2f} ({wt['pnl_pct']:.1f}%) | {wt['r_multiple']:.2f}R | Exit: {wt['exit_reason']}\n"
        
        report += f"""
---

## Fee Model (Robinhood-Style)

### Fee Structure
- **Per-side fee:** {self.fee_pct*100:.2f}% of position value
- **Round-trip cost:** {self.fee_pct*2*100:.2f}% (entry + exit)
- **Calculation:** 
  - Entry fee = Position size × {self.fee_pct*100:.2f}%
  - Exit fee = Exit value × {self.fee_pct*100:.2f}%
  - Net P&L = Exit value - Entry cost - Entry fee - Exit fee

### Example on ${self.initial_capital * self.allocation_per_trade:,.0f} position:
- Entry fee: ${self.initial_capital * self.allocation_per_trade * self.fee_pct:.2f}
- Exit fee: ${self.initial_capital * self.allocation_per_trade * self.fee_pct:.2f}
- Total round-trip fees: ${self.initial_capital * self.allocation_per_trade * self.fee_pct * 2:.2f}

**All P&L figures reported are NET of fees.**

---

## Recommendation Logic

### Decision Criteria
- **GO:** 30d win rate ≥60% AND 30d avg R ≥0.5 AND 30d max DD > -$200 AND ≥3 trades
- **WAIT:** Otherwise (insufficient recent performance or sample size)

### Applied to Recent Results
- 30d Win Rate: {metrics_30d['win_rate']}%
- 30d Avg R: {metrics_30d['avg_r']}R
- 30d Max Drawdown: ${metrics_30d['max_drawdown']:,.2f}
- 30d Trades: {metrics_30d['total_trades']}

**Verdict:** {recommendation}

"""
        
        if recommendation == "GO":
            report += """
### Next Session Playbook
1. Monitor BTC and ETH for pullback-to-MA or breakout signals
2. Enter positions when signals trigger (50% of book per trade)
3. Set profit target at +3% and stop loss at -2%
4. Max hold 7 days; exit at target/stop/max hold
5. Track fees: expect ~1% round-trip cost per trade

"""
        else:
            report += """
### Next Session Playbook
Recent 30-day performance does not meet GO criteria. Recommended actions:
1. Monitor signals but do NOT take positions tonight
2. Wait for improved 30-day metrics (win rate, R-multiple, drawdown)
3. Re-evaluate after additional data points
4. Preserve capital until trend improves

"""
        
        report += f"""---

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
"""
        
        with open(f"{output_dir}/crypto_summary.md", 'w') as f:
            f.write(report)


def main():
    print("="*60)
    print("CRYPTO MAJORS BACKTEST")
    print("BTC & ETH - Pullback-to-MA + Breakout Momentum")
    print("="*60)
    print()
    
    end_date = datetime.now()
    start_date = end_date - timedelta(days=730)
    
    backtest = CryptoBacktest(
        tickers=['BTC', 'ETH'],
        start_date=start_date.strftime('%Y-%m-%d'),
        end_date=end_date.strftime('%Y-%m-%d'),
        initial_capital=2000.0
    )
    
    backtest.run_backtest()
    backtest.save_results(output_dir='artifacts')
    
    print("✅ Crypto backtest complete! Check artifacts/ for results.")


if __name__ == '__main__':
    main()

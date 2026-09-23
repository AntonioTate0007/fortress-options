#!/usr/bin/env python3
"""Debug script to see why no trades are passing filters."""

import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def calculate_hv(hist, lookback_days=30):
    if len(hist) < lookback_days:
        lookback_days = len(hist)
    recent = hist['Close'].tail(lookback_days)
    log_returns = np.log(recent / recent.shift(1)).dropna()
    if len(log_returns) < 2:
        return 0.20
    return log_returns.std() * np.sqrt(252)

end_date = datetime.now()
start_date = end_date - timedelta(days=730)

for ticker in ['SPY', 'QQQ']:
    print(f"\n{'='*60}")
    print(f"Analyzing {ticker}")
    print(f"{'='*60}")
    
    stock = yf.Ticker(ticker)
    hist = stock.history(start=start_date, end=end_date)
    
    test_dates = hist.index[-10:]
    
    for date in test_dates:
        spot = hist.loc[date, 'Close']
        hv = calculate_hv(hist[:date], lookback_days=30)
        
        dte = 28
        em = spot * hv * np.sqrt(dte / 365.0)
        em_pct = em / spot
        
        short_strike = round(spot * 0.88)
        long_strike = short_strike - 5
        moat_pct = (spot - short_strike) / spot
        
        dynamic_moat_req = em_pct * 1.35
        
        print(f"\n{date.strftime('%Y-%m-%d')}:")
        print(f"  Spot: ${spot:.2f}")
        print(f"  HV: {hv*100:.1f}%")
        print(f"  Short strike: ${short_strike:.0f}")
        print(f"  Moat: {moat_pct*100:.1f}%")
        print(f"  Expected move: {em_pct*100:.1f}%")
        print(f"  Dynamic req: {dynamic_moat_req*100:.1f}%")
        print(f"  Hard moat: {'✅ PASS' if moat_pct >= 0.10 else '❌ FAIL'}")
        print(f"  Dynamic moat: {'✅ PASS' if moat_pct >= dynamic_moat_req else '❌ FAIL'}")

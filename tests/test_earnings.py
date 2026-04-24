"""
Unit tests for backend/earnings.py.

These tests are fully offline — we monkeypatch the yfinance fetch so we never
hit the network. They cover the three things that matter:
  1. ETFs always bypass the earnings check
  2. Earnings inside the DTE window flag the symbol
  3. Earnings outside the window do NOT flag the symbol
  4. The TTL cache is honored (a second call with the same symbol uses cached data)
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

# Make the backend package importable when running `pytest` from the project root.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))

import earnings as earnings_mod  # noqa: E402


def setup_function(_func) -> None:
    """Reset the in-process cache before each test for isolation."""
    earnings_mod.clear_cache()


def test_etf_bypass_returns_false_without_fetch(monkeypatch):
    calls = {"n": 0}

    def fake_fetch(*_args, **_kwargs):
        calls["n"] += 1
        return [date.today() + timedelta(days=3)]

    monkeypatch.setattr(earnings_mod, "_fetch_earnings_dates", fake_fetch)

    has, when = earnings_mod.has_earnings_in_window("SPY", window_days=14)
    assert has is False
    assert when is None
    # The fetcher should never have been called for an ETF.
    assert calls["n"] == 0


def test_earnings_inside_window_returns_true(monkeypatch):
    earn_date = date.today() + timedelta(days=5)
    monkeypatch.setattr(earnings_mod, "_fetch_earnings_dates", lambda *a, **kw: [earn_date])

    has, when = earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    assert has is True
    assert when == earn_date


def test_earnings_outside_window_returns_false(monkeypatch):
    earn_date = date.today() + timedelta(days=30)
    monkeypatch.setattr(earnings_mod, "_fetch_earnings_dates", lambda *a, **kw: [earn_date])

    has, when = earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    assert has is False
    assert when is None


def test_no_earnings_data_treats_as_safe_to_scan(monkeypatch):
    """yfinance flakiness shouldn't block scanning — treat 'unknown' as 'no earnings'."""
    monkeypatch.setattr(earnings_mod, "_fetch_earnings_dates", lambda *a, **kw: [])

    has, when = earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    assert has is False
    assert when is None


def test_past_earnings_are_filtered_out(monkeypatch):
    past = date.today() - timedelta(days=10)
    future = date.today() + timedelta(days=20)
    monkeypatch.setattr(
        earnings_mod, "_fetch_earnings_dates", lambda *a, **kw: [past, future]
    )

    upcoming = earnings_mod.get_upcoming_earnings("AAPL")
    assert past not in upcoming
    assert future in upcoming


def test_cache_avoids_refetching_within_ttl(monkeypatch):
    calls = {"n": 0}

    def fake_fetch(*_a, **_kw):
        calls["n"] += 1
        return [date.today() + timedelta(days=3)]

    monkeypatch.setattr(earnings_mod, "_fetch_earnings_dates", fake_fetch)

    earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    assert calls["n"] == 1, "second call should hit the cache"


def test_clear_cache_forces_refetch(monkeypatch):
    calls = {"n": 0}

    def fake_fetch(*_a, **_kw):
        calls["n"] += 1
        return [date.today() + timedelta(days=3)]

    monkeypatch.setattr(earnings_mod, "_fetch_earnings_dates", fake_fetch)

    earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    earnings_mod.clear_cache()
    earnings_mod.has_earnings_in_window("AAPL", window_days=14)
    assert calls["n"] == 2

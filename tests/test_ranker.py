"""
Unit tests for backend/ranker.score_play.

Pure logic — no network, no DB. Anchors the scoring rubric so future tweaks
don't silently shift what counts as a "hot" play.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))

import ranker  # noqa: E402


def _play(**overrides) -> dict:
    base = {
        "net_credit": 0.50,
        "spread_width": 5.0,
        "buffer_pct": 6.0,
        "volume": 200,
        "open_interest": 800,
        "dte": 10,
        "iv": 0.25,
    }
    base.update(overrides)
    return base


def test_top_score_when_all_categories_max_out():
    score, breakdown = ranker.score_play(
        _play(net_credit=0.80, buffer_pct=8.0, volume=1000, open_interest=3000, dte=10, iv=0.30)
    )
    assert score == 10
    assert breakdown == {
        "premium_ratio": 3,
        "buffer": 2,
        "liquidity": 2,
        "dte": 2,
        "iv": 1,
    }


def test_minimum_score_clamped_to_one():
    score, _ = ranker.score_play(
        _play(net_credit=0.10, buffer_pct=4.0, volume=10, open_interest=50, dte=20, iv=0.05)
    )
    # All categories zero → clamped to 1, not 0
    assert score == 1


def test_dte_sweet_spot_scores_higher():
    in_sweet, _ = ranker.score_play(_play(dte=10))
    edge, _ = ranker.score_play(_play(dte=14))
    assert in_sweet > edge


def test_buffer_below_threshold_loses_points():
    safe, _ = ranker.score_play(_play(buffer_pct=8.0))
    risky, _ = ranker.score_play(_play(buffer_pct=4.0))
    assert safe > risky


def test_liquidity_uses_max_of_volume_or_oi():
    high_vol, _ = ranker.score_play(_play(volume=1000, open_interest=0))
    high_oi, _ = ranker.score_play(_play(volume=0, open_interest=3000))
    assert high_vol == high_oi

import sqlite3
import os
from contextlib import contextmanager

# Use DB_PATH env var if set (cloud volume mount), otherwise local file
DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(__file__), "fortress.db"))


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS plays (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol          TEXT NOT NULL,
            play_type       TEXT DEFAULT 'fortress',
            short_strike    REAL,
            long_strike     REAL,
            expiration      TEXT,
            dte             INTEGER,
            current_price   REAL,
            net_credit      REAL,
            max_risk        REAL,
            spread_width    REAL,
            buffer_pct      REAL,
            score           INTEGER,
            score_breakdown TEXT,
            volume          INTEGER,
            open_interest   INTEGER,
            iv              REAL,
            found_at        TEXT DEFAULT (datetime('now')),
            is_active       INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS tracked_positions (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol               TEXT NOT NULL,
            play_type            TEXT DEFAULT 'fortress',
            short_strike         REAL,
            long_strike          REAL,
            expiration           TEXT,
            dte_at_entry         INTEGER,
            entry_price          REAL,
            entry_credit         REAL,
            contracts            INTEGER DEFAULT 1,
            max_risk             REAL,
            buffer_pct_at_entry  REAL,
            score_at_entry       INTEGER,
            entry_notes          TEXT,
            tracked_at           TEXT DEFAULT (datetime('now')),
            current_mid          REAL,
            current_price        REAL,
            pnl_pct              REAL,
            last_updated         TEXT,
            status               TEXT DEFAULT 'open',
            exit_credit          REAL,
            exit_reason          TEXT,
            closed_at            TEXT
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            position_id   INTEGER,
            alert_type    TEXT,
            message       TEXT,
            triggered_at  TEXT DEFAULT (datetime('now')),
            acknowledged  INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS subscribers (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            email                   TEXT UNIQUE NOT NULL,
            api_key                 TEXT UNIQUE NOT NULL,
            tier                    TEXT DEFAULT 'basic',
            stripe_customer_id      TEXT,
            stripe_subscription_id  TEXT,
            status                  TEXT DEFAULT 'active',
            created_at              TEXT DEFAULT (datetime('now')),
            expires_at              TEXT,
            telegram_chat_id        TEXT
        );
        """)
        conn.commit()
        # Migration: add telegram_chat_id if upgrading from older schema
        try:
            conn.execute("ALTER TABLE subscribers ADD COLUMN telegram_chat_id TEXT")
            conn.commit()
        except Exception:
            pass  # Column already exists

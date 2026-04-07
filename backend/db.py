import sqlite3
import os
from contextlib import contextmanager

# PostgreSQL support: set DATABASE_URL env var to use Postgres, otherwise falls back to SQLite
DATABASE_URL = os.getenv("DATABASE_URL", "")
DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(__file__), "fortress.db"))

_USE_POSTGRES = bool(DATABASE_URL)

if _USE_POSTGRES:
    try:
        import psycopg2
        import psycopg2.extras
        print(f"[DB] Using PostgreSQL: {DATABASE_URL[:30]}...")
    except ImportError:
        print("[DB] psycopg2 not installed — falling back to SQLite")
        _USE_POSTGRES = False


class _PgRow(dict):
    """Dict subclass that mimics sqlite3.Row's [] access by column name."""
    def __getitem__(self, key):
        return super().__getitem__(key)
    def keys(self):
        return super().keys()


@contextmanager
def get_db():
    if _USE_POSTGRES:
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
        conn.autocommit = False
        try:
            yield _PgWrapper(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()


class _PgWrapper:
    """Thin wrapper around psycopg2 connection to match sqlite3 interface used in the codebase."""
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        # Translate SQLite ? placeholders → Postgres %s
        pg_sql = sql.replace("?", "%s")
        # Translate SQLite datetime('now') → NOW()
        pg_sql = pg_sql.replace("datetime('now')", "NOW()")
        # Translate SQLite date('now') → CURRENT_DATE
        pg_sql = pg_sql.replace("date('now')", "CURRENT_DATE")
        cur = self._conn.cursor()
        cur.execute(pg_sql, params)
        return _PgCursor(cur)

    def executescript(self, sql):
        # executescript runs DDL; translate and run each statement
        pg_sql = sql.replace("?", "%s")
        pg_sql = pg_sql.replace("datetime('now')", "NOW()")
        pg_sql = pg_sql.replace("date('now')", "CURRENT_DATE")
        pg_sql = pg_sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        # Postgres doesn't support IF NOT EXISTS for columns — migrations handle it separately
        cur = self._conn.cursor()
        for stmt in pg_sql.split(";"):
            stmt = stmt.strip()
            if stmt:
                try:
                    cur.execute(stmt)
                except Exception as e:
                    if "already exists" not in str(e).lower():
                        raise

    def commit(self):
        self._conn.commit()


class _PgCursor:
    """Wraps psycopg2 RealDictCursor to mimic sqlite3.Cursor."""
    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        row = self._cur.fetchone()
        return dict(row) if row else None

    def fetchall(self):
        rows = self._cur.fetchall()
        return [dict(r) for r in rows]

    def __getitem__(self, key):
        return self._cur[key]

    @property
    def lastrowid(self):
        # psycopg2 doesn't expose lastrowid — use RETURNING id if needed
        return None


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
        # fcm_tokens — one row per device, keyed by api_key
        conn.execute("""
        CREATE TABLE IF NOT EXISTS fcm_tokens (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            api_key    TEXT NOT NULL,
            token      TEXT NOT NULL UNIQUE,
            updated_at TEXT DEFAULT (datetime('now'))
        )
        """)
        conn.commit()

        # Migration: add telegram_chat_id if upgrading from older schema
        try:
            conn.execute("ALTER TABLE subscribers ADD COLUMN telegram_chat_id TEXT")
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Migration: add ai_analysis column to plays
        try:
            conn.execute("ALTER TABLE plays ADD COLUMN ai_analysis TEXT")
            conn.commit()
        except Exception:
            pass

        # Watchlist table — user-editable list of symbols to scan
        conn.execute("""
        CREATE TABLE IF NOT EXISTS watchlist (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT UNIQUE NOT NULL
        )
        """)
        conn.commit()

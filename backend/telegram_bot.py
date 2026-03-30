"""
Telegram bot for Fortress Options Elite alerts.

Flow:
  1. Elite subscriber opens Telegram, finds the bot, sends /start frt_theirkey
  2. Bot verifies the key, stores their chat_id in the subscribers table
  3. When profit/loss alerts fire, the backend calls send_elite_alert()
"""
import os
import threading
import time

import requests

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
_BASE = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"


# ── Send ─────────────────────────────────────────────────────────────────────

def send_message(chat_id: str, text: str) -> bool:
    """Send an HTML-formatted message to a Telegram chat."""
    if not TELEGRAM_TOKEN or not chat_id:
        return False
    try:
        r = requests.post(
            f"{_BASE}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
        return r.status_code == 200
    except Exception as e:
        print(f"[Telegram] Send error: {e}")
        return False


def send_elite_alert(alert_type: str, message: str):
    """
    Broadcast an alert to all Elite subscribers that have linked Telegram.
    Called from update_positions() when a profit/loss threshold is crossed.
    """
    if not TELEGRAM_TOKEN:
        return
    emoji = "📈" if alert_type == "profit" else "📉"
    text = (
        f"{emoji} <b>Fortress Options Alert</b>\n\n"
        f"{message}\n\n"
        f"<i>Open the app to review your position.</i>"
    )
    from db import get_db
    with get_db() as conn:
        rows = conn.execute(
            """SELECT telegram_chat_id FROM subscribers
               WHERE tier='elite' AND status='active'
               AND telegram_chat_id IS NOT NULL""",
        ).fetchall()
    for row in rows:
        send_message(row["telegram_chat_id"], text)


# ── /start handler ────────────────────────────────────────────────────────────

def _handle_update(update: dict):
    from db import get_db

    msg = update.get("message", {})
    text = (msg.get("text") or "").strip()
    chat_id = str(msg.get("chat", {}).get("id", ""))

    if not chat_id:
        return

    # ── Only respond to /start — ignore everything else silently ──────────────
    # This prevents prompt injection, info fishing, and social engineering.
    if not text.startswith("/start"):
        send_message(
            chat_id,
            "ℹ️ This bot only responds to <code>/start YOUR_API_KEY</code>.\n"
            "It does not answer questions or share any account information.",
        )
        return

    parts = text.split()
    if len(parts) < 2:
        send_message(
            chat_id,
            "👋 <b>Welcome to Fortress Options!</b>\n\n"
            "To link your Elite account send:\n"
            "<code>/start YOUR_API_KEY</code>\n\n"
            "Find your key in the app under ⚙ Settings → Connection.",
        )
        return

    api_key = parts[1].strip()

    # ── Validate key format — must start with frt_ ────────────────────────────
    if not api_key.startswith("frt_") or len(api_key) < 20:
        send_message(chat_id, "❌ Invalid API key format.")
        return

    with get_db() as conn:
        sub = conn.execute(
            "SELECT id, email, tier, status FROM subscribers WHERE api_key=? AND status='active'",
            (api_key,),
        ).fetchone()

    if not sub:
        send_message(chat_id, "❌ API key not found or inactive. Double-check in the app under Settings → Connection.")
        return

    sub = dict(sub)

    if sub.get("tier") != "elite":
        send_message(
            chat_id,
            "⚠️ Telegram alerts are an <b>Elite</b> feature.\n"
            "Upgrade at fortress-options.com to unlock.",
        )
        return

    # ── Check if this chat_id is already linked to a DIFFERENT account ────────
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM subscribers WHERE telegram_chat_id=? AND api_key!=?",
            (chat_id, api_key),
        ).fetchone()
        if existing:
            # Unlink from old account before linking to new one
            conn.execute(
                "UPDATE subscribers SET telegram_chat_id=NULL WHERE telegram_chat_id=? AND api_key!=?",
                (chat_id, api_key),
            )
            conn.commit()

    with get_db() as conn:
        conn.execute(
            "UPDATE subscribers SET telegram_chat_id=? WHERE api_key=?",
            (chat_id, api_key),
        )
        conn.commit()

    # ── Never expose email or account details in confirmation ─────────────────
    send_message(
        chat_id,
        "✅ <b>Fortress Options Elite connected!</b>\n\n"
        "You'll now receive instant alerts when:\n"
        "• 📈 A position hits <b>+20% profit</b>\n"
        "• 📉 A position drops <b>−10% loss</b>\n\n"
        "Happy trading! 🏰",
    )


# ── Long-poll loop ────────────────────────────────────────────────────────────

def _poll_loop():
    offset = 0
    print("[Telegram] Bot polling started.")
    while True:
        try:
            r = requests.get(
                f"{_BASE}/getUpdates",
                params={"offset": offset, "timeout": 30},
                timeout=35,
            )
            if r.status_code == 200:
                for update in r.json().get("result", []):
                    try:
                        _handle_update(update)
                    except Exception as e:
                        print(f"[Telegram] Handler error: {e}")
                    offset = update["update_id"] + 1
        except Exception as e:
            print(f"[Telegram] Poll error: {e}")
            time.sleep(5)


def start_polling_thread():
    """Start the Telegram polling loop in a daemon thread."""
    if not TELEGRAM_TOKEN:
        print("[Telegram] TELEGRAM_BOT_TOKEN not set — bot disabled.")
        return
    t = threading.Thread(target=_poll_loop, daemon=True)
    t.start()

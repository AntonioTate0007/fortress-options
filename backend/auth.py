"""
API key authentication and Stripe subscription management.
"""
import os
import secrets
import smtplib
import stripe
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from fastapi import HTTPException, Header
from typing import Optional

from db import get_db

# ── Stripe config ────────────────────────────────────────────────────────────
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")

# ── Tier definitions ─────────────────────────────────────────────────────────
TIERS = {
    "basic": {
        "name": "Basic",
        "price": 2900,        # cents ($29/mo)
        "description": "SPY & QQQ plays only",
        "symbols": ["SPY", "QQQ"],
    },
    "pro": {
        "name": "Pro",
        "price": 5900,        # cents ($59/mo)
        "description": "Full watchlist + earnings plays",
        "symbols": ["SPY", "QQQ", "AAPL", "AMZN", "MSFT", "GOOGL"],
    },
    "elite": {
        "name": "Elite",
        "price": 9900,        # cents ($99/mo)
        "description": "Full access + Telegram alerts",
        "symbols": ["SPY", "QQQ", "AAPL", "AMZN", "MSFT", "GOOGL"],
        "telegram": True,
    },
}

# ── API Key helpers ───────────────────────────────────────────────────────────

def generate_api_key() -> str:
    return "frt_" + secrets.token_urlsafe(32)


def create_subscriber(email: str, tier: str, stripe_customer_id: str = None,
                       stripe_subscription_id: str = None) -> str:
    """Create a subscriber and return their new API key."""
    api_key = generate_api_key()
    with get_db() as conn:
        # Upsert — if email already exists, update their key and tier
        existing = conn.execute("SELECT id FROM subscribers WHERE email=?", (email,)).fetchone()
        if existing:
            conn.execute(
                """UPDATE subscribers SET api_key=?, tier=?, status='active',
                   stripe_customer_id=?, stripe_subscription_id=?
                   WHERE email=?""",
                (api_key, tier, stripe_customer_id, stripe_subscription_id, email),
            )
        else:
            conn.execute(
                """INSERT INTO subscribers (email, api_key, tier, stripe_customer_id, stripe_subscription_id)
                   VALUES (?,?,?,?,?)""",
                (email, api_key, tier, stripe_customer_id, stripe_subscription_id),
            )
        conn.commit()
    return api_key


def cancel_subscriber(stripe_subscription_id: str):
    """Mark a subscriber as cancelled when Stripe subscription ends."""
    with get_db() as conn:
        conn.execute(
            "UPDATE subscribers SET status='cancelled' WHERE stripe_subscription_id=?",
            (stripe_subscription_id,),
        )
        conn.commit()


# ── FastAPI Auth Dependency ───────────────────────────────────────────────────

def require_api_key(x_api_key: str = Header(default=None)):
    """Dependency: raises 401 if API key is missing or invalid."""
    if not x_api_key:
        raise HTTPException(401, detail="API key required. Subscribe at https://fortress-options.com")
    with get_db() as conn:
        sub = conn.execute(
            "SELECT * FROM subscribers WHERE api_key=? AND status='active'",
            (x_api_key,),
        ).fetchone()
    if not sub:
        raise HTTPException(401, detail="Invalid or expired API key")
    return dict(sub)


def optional_api_key(x_api_key: str = Header(default=None)):
    """Dependency: returns subscriber info if key provided, None otherwise (for free endpoints)."""
    if not x_api_key:
        return None
    with get_db() as conn:
        sub = conn.execute(
            "SELECT * FROM subscribers WHERE api_key=? AND status='active'",
            (x_api_key,),
        ).fetchone()
    return dict(sub) if sub else None


# ── Stripe Checkout ───────────────────────────────────────────────────────────

def create_checkout_session(email: str, tier: str, success_url: str, cancel_url: str) -> str:
    """Create a Stripe Checkout session and return the URL."""
    tier_info = TIERS.get(tier)
    if not tier_info:
        raise ValueError(f"Unknown tier: {tier}")

    session = stripe.checkout.Session.create(
        customer_email=email,
        payment_method_types=["card"],
        line_items=[{
            "price_data": {
                "currency": "usd",
                "unit_amount": tier_info["price"],
                "recurring": {"interval": "month"},
                "product_data": {
                    "name": f"Fortress Options — {tier_info['name']}",
                    "description": tier_info["description"],
                },
            },
            "quantity": 1,
        }],
        mode="subscription",
        subscription_data={"trial_period_days": 3},
        success_url=success_url + "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url=cancel_url,
        metadata={"tier": tier},
    )
    return session.url


# ── Email ─────────────────────────────────────────────────────────────────────

def send_api_key_email(email: str, api_key: str, tier: str):
    """Send the API key to the new subscriber via email."""
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        # Fallback: print to console (owner can email manually)
        print(f"\n{'='*60}")
        print(f"NEW SUBSCRIBER: {email} | Tier: {tier}")
        print(f"API KEY: {api_key}")
        print(f"{'='*60}\n")
        return

    tier_info = TIERS.get(tier, TIERS["basic"])

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Your Fortress Options API Key"
    msg["From"] = smtp_user
    msg["To"] = email

    html = f"""
    <div style="font-family:monospace;background:#0A0A0B;color:#e4e4e7;padding:32px;border-radius:12px;max-width:540px;margin:0 auto">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <div style="width:40px;height:40px;background:#10B981;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px">🏰</div>
        <h2 style="margin:0;color:#10B981">Fortress Options</h2>
      </div>
      <p>Welcome to <strong>{tier_info['name']}</strong>! Your 3-day free trial is active — your card won't be charged until day 4.</p>
      <div style="background:#161618;border:1px solid #27272a;border-radius:8px;padding:16px;margin:20px 0">
        <p style="margin:0 0 8px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:1px">Your API Key</p>
        <code style="color:#10B981;font-size:13px;word-break:break-all">{api_key}</code>
      </div>
      <p style="font-size:13px;color:#a1a1aa">Open the Fortress Options app → ⚙ Settings → paste this key in the <em>API Key</em> field.</p>
      <hr style="border-color:#27272a;margin:24px 0">
      <p style="font-size:12px;color:#52525b">Questions? Reply to this email. Never share your API key.</p>
    </div>
    """
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, email, msg.as_string())
        print(f"API key emailed to {email}")
    except Exception as e:
        print(f"Email failed ({e}). Key for {email}: {api_key}")


def send_blast_email(emails: list, subject: str, body_html: str) -> dict:
    """Send a broadcast email to a list of addresses. Returns {sent, failed}."""
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        print("SMTP not configured — blast email skipped")
        return {"sent": 0, "failed": len(emails)}

    sent, failed = 0, 0
    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            for email in emails:
                try:
                    msg = MIMEMultipart("alternative")
                    msg["Subject"] = subject
                    msg["From"] = f"Fortress Options <{smtp_user}>"
                    msg["To"] = email
                    msg.attach(MIMEText(body_html, "html"))
                    server.sendmail(smtp_user, email, msg.as_string())
                    sent += 1
                    print(f"Blast sent to {email}")
                except Exception as e:
                    print(f"Blast failed for {email}: {e}")
                    failed += 1
    except Exception as e:
        print(f"Blast SMTP connection failed: {e}")
        failed = len(emails)

    return {"sent": sent, "failed": failed}

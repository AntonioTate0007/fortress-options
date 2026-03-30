Act as an expert quantitative developer and Python engineer. I need you to build an automated options scanning bot that finds high-probability "Put Credit Spreads" (Bull Put Spreads) and sends the trade alerts directly to me via a Telegram bot. 

Please write the complete Python script using the following strict criteria:

1. TECH STACK:
- Python 3
- Data Provider: Use the `robin_stocks` library (or `yfinance` / `yahoo_fin` if options chains are easier to parse for free). 
- Telegram: Use the `python-telegram-bot` or `requests` library to push messages to a Telegram Chat ID.
- Schedule: Include a simple scheduler (like the `schedule` library) to run the scan daily at 10:00 AM EST.

2. THE WATCHLIST (The "Fortress" Stocks):
Limit the scan to highly liquid, mega-cap stocks and ETFs: ['SPY', 'QQQ', 'AAPL', 'AMZN', 'MSFT', 'GOOGL'].

3. THE OPTIONS STRATEGY LOGIC:
For each ticker in the watchlist, the bot must find trades that meet these exact rules:
- Expiration Date: 7 to 14 days out from the current date.
- Trade Type: Put Credit Spread (Sell a Put, Buy a Put at a lower strike).
- Width: The distance between the Short Put and Long Put must be exactly $5 (this limits collateral to $500).
- Safety Buffer: The Short Put strike must be at least 5% to 8% below the current stock price (or have a Delta between -0.10 and -0.15).
- Premium: The total estimated credit collected must be between $0.35 and $0.80.

4. EARNINGS FILTER:
The bot must check if the underlying stock has an earnings report before the selected expiration date. If it does, discard the trade. We do not hold these spreads through earnings. (ETFs like SPY and QQQ can bypass this check).

5. TELEGRAM ALERT FORMAT:
When a valid trade is found, format the Telegram message cleanly like this so I know exactly which legs to enter:

"🏰 **FORTRESS PLAY FOUND** 🏰
Ticker: $AMZN
Current Price: $210.50
Expiration: March 20 (9 DTE)
🟢 **SELL:** $195 Put
🔴 **BUY:** $190 Put
Buffer: $15.50 (7.3% out of the money)
Estimated Credit: $0.45 ($45 cash)
Max Risk: $455"

6. INSTRUCTIONS:
Please provide the fully functional Python code, handled exceptions, and a step-by-step guide on how to securely store my API keys and Telegram Bot Token in a `.env` file.
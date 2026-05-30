# AI Crypto Signal Bot

Local Windows crypto signal scanner with a Vercel-compatible Next.js dashboard.

## Architecture

Local Windows runs the exchange connections, scanner, signal engine, Telegram alerts, WebSocket server, and REST API at `http://localhost:4000`.

Vercel runs only the dashboard UI. The deployed dashboard reads the local API from the user's browser via `NEXT_PUBLIC_LOCAL_API_URL`.

## Run Locally

Double-click `START_BOT.bat`, or run:

```bash
npm install
npm run local:all
```

Dashboard: `http://localhost:3000`

Local API: `http://localhost:4000`

## Vercel

Deploy the repository as a Next.js app. Do not configure scanner secrets on Vercel. Only set `NEXT_PUBLIC_LOCAL_API_URL` if needed.

## Trading Safety

The bot does not place orders. It produces high-selectivity signals, watchlist entries, and no-trade decisions from live public market data and configured exchange context.

## Signal Engine

The signal engine acts as a trade assistant, not an auto-trader. It requires a score of `85+` for any trade signal and rejects weaker setups as `NO TRADE`.

Futures leverage is capped at `5x`; recommendations are limited to `2x`, `3x`, or `5x` and are reduced automatically when volatility is high or momentum is weak.

Every accepted setup includes entry timing, entry zone, current price, stop loss, TP1/TP2/TP3, risk/reward, invalidation level, win probability, confidence, and trade-management actions.

Continuous monitoring sends management alerts for entry triggers, hold, partial profit, breakeven stop movement, trailing stop, exit now, and trend reversal detection.

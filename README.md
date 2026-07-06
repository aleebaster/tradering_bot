# AI Trading Bot v2

Professional multi-factor AI crypto trading bot with adaptive learning, momentum hunting, smart money detection, and continuous self-improvement.

## Architecture

```
src/local/
  launcher.ts          # Unified entry point (all modes)
  index.ts             # Express API + WebSocket server
  scanner.ts           # Main trading loop orchestrator
  scoring.ts           # Signal builder (weighted multi-factor)
  exchanges.ts         # Exchange clients (Bybit, OKX, KuCoin, Binance)
  indicators.ts        # Technical indicators (EMA, RSI, MACD, ATR, etc.)
  validation.ts        # Config validation, startup banner, diagnostics
  config.ts            # Zod-validated environment config
  
  bots/                # Intelligence consensus bots
    PumpDetectorBot.ts     # Pump/momentum breakout detection
    WhaleTrackerBot.ts     # Whale/smart-money tracking
    LiqBot.ts              # Liquidation sweep detection
    MarketReportBot.ts     # Market regime assessment
    shared.ts              # Shared bot utilities
  
  engines/             # Specialized analysis engines
    MomentumHunterEngine.ts  # Pump Probability + Momentum Score + Entry AI
    MomentumDetector.ts      # 13-factor momentum analysis
    SmartMoneyAnalyzer.ts    # Whale/OI/funding/orderbook analysis
    MomentumExitEngine.ts    # Pump Exhaustion Score + trailing stop
  
  learning/            # Self-learning system
    ModelRegistry.ts        # Model versioning (active/candidate/history)
    ParameterGovernor.ts    # One-change-at-a-time control + auto-rollback

  memory/              # [extendable] Learning engine, trade memory
```

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Run (choose one):
npm run bot        # Continuous trading
npm run demo       # Demo account mode
npm run scan       # Scan only (no orders)
npm run one        # One-shot: scan + execute single trade
npm run dry        # Full simulation (no real orders)
npm run doctor     # Full system diagnostics
npm run health     # Quick health check
```

## Modes

| Command | Mode | Description |
|---------|------|-------------|
| `npm run bot` | Continuous | Full trading loop: scan → consensus → risk → execute → manage → learn |
| `npm run live` | Live | Real account trading with safety confirmation prompt |
| `npm run demo` | Demo | Demo account mode with account verification |
| `npm run one` | One-Shot | Single scan + execute cycle, shows stage-by-stage pipeline |
| `npm run scan` | Scan Only | Full analysis, prints best opportunities, NO orders |
| `npm run dry` | Dry Run | Everything runs (including execution), but orders are simulated |
| `npm run doctor` | Diagnostics | Full system health check |
| `npm run health` | Health | Quick config + connection check |

## Pipeline (Continuous Mode)

```
========================================
  SCAN MARKET           → scanner.ts
  MARKET HEALTH         → scoring.ts (regimeFrom)
  LIQUIDITY             → exchanges.ts (depth + volume)
  CORRELATION           → exchanges.ts (multi-exchange)
  SMART MONEY           → bots/WhaleTrackerBot.ts
  ORDER BOOK AI         → exchanges.ts (bybitOrderBookStats)
  MOMENTUM HUNTER       → engines/MomentumHunterEngine.ts
  AI CONSENSUS          → bots/* (4 bots → IntelligenceBundle)
  RISK ENGINE           → positionSizing.ts
  PORTFOLIO HEAT        → learning.ts (symbol stats)
  TRADE VALIDATION      → tradeValidator.ts
  EXECUTION             → [simulated in dry mode]
  POSITION MANAGEMENT   → scanner.ts (monitorActiveTrades)
  LEARNING              → learning.ts (recordLearningOutcome)
  STATISTICS            → state.ts + tradeMemory.ts
  NEXT SCAN             → ▼
========================================
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `BYBIT_API_KEY` | — | Bybit API key |
| `BYBIT_API_SECRET` | — | Bybit API secret |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (optional) |
| `TELEGRAM_CHAT_ID` | — | Telegram chat ID (optional) |
| `USER_BALANCE_USDT` | 5 | Account balance for position sizing |
| `BOT_MODE` | LOCAL_ONLY | Trading mode |
| `BOT_ACCOUNT` | demo | `demo` or `live` |
| `LIVE_TRADING` | 0 | Set to `1` for real orders |
| `DRY_RUN` | 0 | Set to `1` for simulation only |
| `SAFE_SCALPING_MODE` | 1 | Enable safety limits |
| `SCAN_INTERVAL_SECONDS` | 12 | Seconds between scans (10-15) |
| `LOCAL_API_PORT` | 4000 | API server port |

## Self-Learning System

The bot uses a controlled model evolution system:

1. **Active Model** — currently used for trading decisions
2. **Candidate Model** — proposed change (ONE parameter only)
3. **Validation**: Backtest → Monte Carlo → Shadow Mode → Compare
4. **Decision**: Accept (activate candidate) or Reject (keep active)
5. **Auto-Rollback**: If performance degrades, returns to parent model

### Model Registry

All model versions are stored in `data/model-registry.json`. Each entry records:
- Parameters (weights, thresholds, multipliers)
- Performance (win rate, profit factor, drawdown, expectancy)
- Change history (what changed, old value, new value, reason)

### Parameter Governor

- Only ONE parameter can change per candidate
- Each change must have a documented reason
- System auto-rejects changes that fail validation
- Rollback is automatic if performance drops below threshold

## Development

```bash
npm run typecheck    # TypeScript check
npm run tests        # Full test suite
npm run clean        # Clear runtime data
npm run reset-learning  # Reset learning engine state
npm run local:api    # Start API server only
npm run dev          # Start dashboard only
npm run local:all    # API + Dashboard together
```

## Dashboard

The React dashboard runs on `http://localhost:3001`:
- Real-time state updates via WebSocket
- Signal history and active positions
- Market analysis
- Momentum Hunter output
- System diagnostics

```bash
npm run dashboard    # Start dashboard only
```

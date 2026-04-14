# Polymarket BTC 5M — Paper Trading Bot

Automated **paper trading** bot for [Polymarket](https://polymarket.com) "Bitcoin Up or Down - 5 Minutes" markets.  
Makes directional predictions on BTC price using real-time order book microstructure data from Binance.  
All trades are **virtual** — no real money is at risk.

---

## How It Works

```
Every 5 minutes:
  Binance WS ──► Feature Engine ──► Predictor ──► Paper Trade saved to SQLite
                                                           │
  Polymarket Gamma API ◄──────────────────────────────────┘
       (find active BTC 5M market, read YES/NO prices)

After window closes:
  Gamma API ──► Settler ──► Update outcome + P&L in DB

Dashboard:
  Express server ──► http://localhost:3000
  Auto-refreshes every 30s, shows live stats + cumulative P&L chart
```

---

## Features

- **Real-time data** — Binance WebSocket streams (order book, trades, 1m klines)
- **Rule-based predictor** with hard-veto safety rules (backtest-optimised)
- **Auto-retraining** — Logistic Regression model activates after 50 settled trades, retrains every 25
- **Web dashboard** — Win rate, cumulative P&L chart, feature importances, trade history
- **Next trade countdown** — live timer showing seconds until next 5-minute window
- **Paper trading only** — no wallet, no API keys, no real money required

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript (`tsx` for dev) |
| Data | Binance WebSocket (`binance` npm) |
| Markets | Polymarket Gamma API (public, no auth) |
| Storage | SQLite (`better-sqlite3`) |
| ML | Custom Logistic Regression (pure TS, no deps) |
| Dashboard | Express + Chart.js |

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm 9+

### Install & Run

```bash
git clone https://github.com/YOUR_USERNAME/polymarket-bot.git
cd polymarket-bot

npm install
npm run dev
```

Dashboard: **http://localhost:3000**

### Other Commands

```bash
npm run build    # compile to dist/
npm run start    # run compiled version (for production)
```

---

## Project Structure

```
src/
├── main.ts                    # Entry point — main bot loop (60s ticks)
│
├── data/
│   ├── collector.ts           # Binance WebSocket streams (orderbook, trades, klines)
│   └── features.ts            # Feature engineering (OBI, TFI, RSI, MACD, ATR, funding)
│
├── bot/
│   ├── polymarket.ts          # Polymarket Gamma API client (read-only)
│   ├── paper-trader.ts        # Virtual trade execution — saves to DB
│   └── settler.ts             # Resolves outcomes after market expiry
│
├── model/
│   ├── logistic-regression.ts # Pure TS logistic regression (gradient descent + L2)
│   ├── trainer.ts             # Auto-retraining logic (load data, split, train, save)
│   └── predictor.ts           # Signal generation — rule-based OR ML, with veto rules
│
├── db/
│   └── database.ts            # SQLite schema + all queries
│
└── dashboard/
    ├── server.ts              # Express API (/api/stats, /api/trades, /api/model)
    └── public/index.html      # Single-page dashboard (Chart.js)

data/
├── trades.db                  # SQLite database (auto-created)
└── model.json                 # Trained LR model (auto-created after 50 trades)
```

---

## Features Used for Prediction

| Feature | Source | Description |
|---------|--------|-------------|
| `obi` | Binance order book | Order Book Imbalance — bid vs ask volume ratio |
| `tfi` | Binance trades | Trade Flow Imbalance — aggressive buy vs sell ratio |
| `rsi` | 1m candles | RSI(14) — momentum oscillator |
| `macdHist` | 1m candles | MACD histogram (12/26/9) |
| `atr` | 1m candles | Average True Range — volatility |
| `fundingRate` | Binance Futures | Perpetual funding rate — leverage sentiment |
| `oiDelta` | Binance Futures | Open Interest change % — new position flow |
| `volumeDelta` | 1m candles | (buyVol − sellVol) / totalVol |
| `spread` | Order book | Best ask − best bid in USD |

---

## Predictor Logic

### Phase 1: Rule-based (0–49 settled trades)

Weighted vote system across all features. Hard-veto rules (derived from backtest):

```
❌ RSI > 62 AND MACD histogram > 10   → skip (overbought exhaustion zone)
❌ RSI < 25 AND signal = DOWN         → skip (oversold bounce risk)
❌ |TFI| < 0.25 AND RSI > 58 AND UP  → skip (weak buyer flow in elevated zone)
```

### Phase 2: ML — Logistic Regression (50+ settled trades)

Trained on actual trade outcomes. 9 features including OBI×TFI synergy term.  
Veto rules remain active as a safety layer over the ML output.  
Retrains automatically every 25 new settled trades.

```
data/model.json — persisted weights, normalisation stats, val_accuracy
```

---

## Market Structure

BTC 5M markets on Polymarket follow this pattern:

```
Slug:      btc-updown-5m-{UNIX_START_TIMESTAMP}
Windows:   Aligned to 5-minute boundaries (every :00, :05, :10, ...)
Settlement: Chainlink BTC/USD oracle, instant
Prices:    0–1 USDC (= implied probability)
```

Example: `btc-updown-5m-1776155700` = window starting at Unix ts 1776155700

---

## Database Schema

```sql
trades (
  id, created_at, market_id, market_end, signal, confidence,
  price_yes, price_no, size_usdc, outcome, pnl, settled_at
)

snapshots (
  trade_id, obi, tfi, spread, funding_rate, oi_delta,
  rsi, macd, atr, btc_price
)
```

---

## Dashboard API

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Win rate, total P&L, ROI, avg confidence |
| `GET /api/trades?limit=100` | Trade history with feature snapshots |
| `GET /api/pnl-timeline` | Cumulative P&L over time |
| `GET /api/model` | ML model status, val_accuracy, feature importances |

---

## Deployment (Vultr)

**Recommended**: Cloud Compute, London (LHR), 1 vCPU / 2 GB RAM — $12/month.  
London is closest to Polymarket's CLOB infrastructure (AWS eu-west-2).

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

# Install PM2
npm install -g pm2

# Clone and start
git clone https://github.com/YOUR_USERNAME/polymarket-bot.git
cd polymarket-bot && npm install

pm2 start "npm run dev" --name polymarket-bot
pm2 save && pm2 startup
```

Access dashboard via SSH tunnel (recommended — no public port exposure):

```bash
ssh -L 3000:localhost:3000 root@YOUR_SERVER_IP
# Then open http://localhost:3000
```

---

## When to Consider Live Trading

The bot needs sufficient data before real money makes sense:

- [ ] 200+ unique settled trades (~2–3 weeks of demo)
- [ ] Win rate > 58% across different market conditions (trend + sideways)
- [ ] ML model active with val_acc > 60%
- [ ] Tested across both BTC bull and bear sessions
- [ ] P&L positive in sideways market (not just in trending conditions)

Current demo results (as of initial testing):  
**44 settled trades · 75% Win Rate · +$111 virtual P&L** on $10/trade virtual stakes.

> ⚠️ Small sample size — insufficient for statistical confidence. Keep collecting data.

---

## Roadmap

- [ ] Collect 200+ trades for reliable ML training
- [ ] Add multi-asset support (ETH, SOL 5M markets)
- [ ] Add liquidation cascade data from CoinGlass
- [ ] Implement live trading mode (`@polymarket/clob-client` + Polygon wallet)
- [ ] Add Telegram/Discord alerts for trades and daily P&L summary
- [ ] Backtest on historical Chainlink oracle data

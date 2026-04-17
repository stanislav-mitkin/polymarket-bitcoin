# CLAUDE.md — Polymarket BTC 5M Paper Trading Bot

This file provides Claude with essential context for working on this project. Read it before making any changes.

---

## Project Overview

Automated **paper trading** bot for Polymarket "Bitcoin Up or Down - 5 Minutes" binary markets.  
Predictions are based on real-time Binance microstructure data. All trades are virtual (no real money).

**Entry point:** `src/main.ts`  
**Dashboard:** `http://localhost:3000`  
**Run:** `npm run dev`

---

## Development Commands

```bash
npm run dev      # Run with tsx (hot-reload-friendly)
npm run build    # Compile TypeScript → dist/
npm run start    # Run compiled build

# Kill stuck port
lsof -ti :3000 | xargs kill -9

# Check DB directly
sqlite3 data/trades.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 5;"
sqlite3 data/trades.db "SELECT outcome, count(*) FROM trades GROUP BY outcome;"

# Regime / performance report (ad-hoc or via cron)
npm run report          # compiled build
npm run report:dev      # tsx, no build step
```

---

## Regime-aware adaptation

`scripts/regime-report.ts` aggregates trade outcomes over 7d / 30d windows and
writes `data/regime.json`. The bot reads that file every tick:

- `recommendedHalflife` → trainer uses it as the recency decay halflife (default
  7d, drops to 3d when a regime shift is detected: `|wr7d - wr30d| > 8pp`).
- `forceRetrain` → trainer bypasses the usual "+25 new trades" gate and
  retrains immediately; cleared by the trainer after it honors the flag.
- `pauseTrading` → `main.ts` stops opening new trades while
  `realizedEdge7d < -2% AND n7d >= 20`. Settlements and retraining keep running
  so the bot recovers once the report no longer flags a loss.

Cron setup on the server (daily at 00:05 UTC):
```bash
crontab -e
# Add:
5 0 * * * cd /root/polymarket && /usr/bin/node dist/scripts/regime-report.js >> logs/regime.log 2>&1
```

The script is idempotent and read-only against `trades`. Safe to invoke
manually at any time for a fresh snapshot.

---

## Architecture

```
src/
├── main.ts                    # Main loop: 60s ticks, settlement, retraining
├── data/
│   ├── collector.ts           # Binance WebSocket streams (3 separate WS clients)
│   └── features.ts            # OBI, TFI, RSI, MACD, ATR, Funding, OI, VolDelta, Spread
├── bot/
│   ├── polymarket.ts          # Gamma API client — finds active BTC 5M markets
│   ├── paper-trader.ts        # Saves virtual trades to SQLite
│   └── settler.ts             # Resolves outcomes after market expiry
├── model/
│   ├── logistic-regression.ts # Pure TS LR: gradient descent + L2 regularization
│   ├── trainer.ts             # Auto-retraining (50 trades to activate, every 25 after)
│   ├── predictor.ts           # Rule-based OR ML signal, hard-veto rules always active
│   └── regime.ts              # Regime state I/O (data/regime.json)
├── scripts/
│   └── regime-report.ts       # Daily cron: detect regime shifts → writes data/regime.json
├── db/
│   └── database.ts            # SQLite schema + all queries
└── dashboard/
    ├── server.ts              # Express API server
    └── public/index.html      # Single-page dashboard (Chart.js)

data/
├── trades.db                  # SQLite (auto-created on first run)
└── model.json                 # Trained LR weights (created after 50 settled trades)
```

---

## Critical Bugs Fixed — Do Not Regress

### 1. Binance WebSocket method names
The `binance` npm package's `WebsocketClient` uses these exact method names:
```typescript
ws.subscribeSpotPartialBookDepth(symbol, levels, speed)  // NOT subscribeSpotSymbol
ws.subscribeSpotAggregateTrades(symbol)
ws.subscribeSpotKline(symbol, '1m')
```
Three **separate** `WebsocketClient` instances are used (one per subscription type).

### 2. Funding rate — correct API call
`USDMClient.getFundingRates({symbol})` returns **static config** (caps/floors), NOT the live rate.  
Use `USDMClient.getMarkPrice({symbol})` and read `.lastFundingRate`:
```typescript
const markRes = await usdmClient.getMarkPrice({ symbol: FUTURES_SYMBOL });
const fundingRate = parseFloat(String((markRes as any).lastFundingRate ?? 0));
```

### 3. SQLite date comparison — ISO-8601 vs SQLite format
`market_end` is stored as ISO-8601: `'2026-04-14T09:20:00Z'` (with `T` separator).  
SQLite's `datetime('now')` returns `'2026-04-14 10:xx:xx'` (with space).  
Since ASCII `'T'` > `' '`, naive comparison `market_end < datetime('now')` **never triggers**.  
**Fix:** Always wrap with `datetime()`:
```sql
SELECT * FROM trades WHERE outcome IS NULL AND datetime(market_end) < datetime('now')
```

### 4. Paper trader field names
`Market` interface uses `priceUp` / `priceDown` (NOT `priceYes` / `priceNo`).  
Always check `src/bot/polymarket.ts` for the exact `Market` interface before referencing fields.

### 5. Duplicate trades across restarts
An in-memory Set doesn't survive restarts. Use DB lookup:
```typescript
if (hasTradeForMarket(market.id)) return;  // in main.ts tick()
```
`hasTradeForMarket()` is in `src/db/database.ts`.

### 6. Polymarket Gamma API — 403 without User-Agent
All requests to `gamma-api.polymarket.com` require a `User-Agent` header:
```typescript
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; polymarket-bot/1.0)',
  'Accept': 'application/json',
};
```

---

## Market Structure

BTC 5M market slugs follow a strict pattern:
```
btc-updown-5m-{UNIX_TIMESTAMP}
```
Where timestamp is aligned to **300-second boundaries** (multiples of 300).

```typescript
const WINDOW_SEC = 300;
const current = Math.floor(Math.floor(Date.now() / 1000) / WINDOW_SEC) * WINDOW_SEC;
// Try current, current+300, current+600
```

Gamma API endpoint: `https://gamma-api.polymarket.com/markets?slug={slug}`

Settlement: Chainlink BTC/USD oracle, `outcomePrices` field — value >= 0.99 = winner.

---

## Feature Engineering (`src/data/features.ts`)

| Feature | Calculation |
|---------|-------------|
| `obi` | `(bidVol - askVol) / (bidVol + askVol)` — Order Book Imbalance |
| `tfi` | `(buyVol - sellVol) / (buyVol + sellVol)` — Trade Flow Imbalance |
| `rsi` | RSI(14) on 1m closes |
| `macdHist` | MACD(12,26,9) histogram |
| `atr` | ATR(14) on 1m candles |
| `fundingRate` | From `USDMClient.getMarkPrice()` (see bug #2 above) |
| `oiDelta` | OI change % over last window |
| `volumeDelta` | `(buyVol - sellVol) / totalVol` from last kline |
| `spread` | `bestAsk - bestBid` in USD |

---

## Prediction Logic (`src/model/predictor.ts`)

### Phase 1: Rule-based (< 50 settled trades)
Weighted vote across features → `weightedScore` → threshold 0.55.

### Phase 2: ML (≥ 50 settled trades)
Logistic Regression trained on actual trade outcomes. Same threshold 0.55.  
**Retrains automatically every 25 new settled trades** via `maybeRetrain()` in `src/model/trainer.ts`.

### Hard Veto Rules (always active, both phases)
```
RSI > 62 AND MACD_hist > 10           → skip (overbought exhaustion)
RSI < 25 AND signal = DOWN            → skip (oversold bounce risk)
|TFI| < 0.25 AND RSI > 58 AND UP      → skip (weak buyer flow)
```

---

## ML Model (`src/model/logistic-regression.ts`)

- 9 features: `obi, tfi, rsi_norm, macd_atr, oi_delta_norm, funding, vol_delta, spread, obi_tfi`
- `obi_tfi` = synergy term `sign(obi) * sqrt(|obi * tfi|)` when both agree
- Z-score normalization (mean/std computed on training set, stored in `model.json`)
- L2 regularization: `w[j] -= lr * (dw[j]/N + lambda * w[j])`
- Saved to `data/model.json` — auto-created after first training

---

## TypeScript Conventions

- **Import extensions:** All internal imports use `.js` extension (not `.ts`):
  ```typescript
  import { computeFeatures } from './data/features.js';
  ```
  This is required for ESM compatibility with `tsx` and compiled output.
- **`tsconfig.json`:** `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
- **No `any` casts** unless interfacing with poorly-typed external libs (binance npm)

---

## Database Schema

```sql
trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT,
  market_id TEXT UNIQUE,
  market_end TEXT,          -- ISO-8601 format, e.g. '2026-04-14T09:20:00Z'
  signal TEXT,              -- 'UP' or 'DOWN'
  confidence REAL,
  price_yes REAL,           -- YES token price at trade time
  price_no REAL,            -- NO token price at trade time
  size_usdc REAL,           -- virtual stake (default $10)
  outcome TEXT,             -- NULL=pending, 'WIN', 'LOSS', 'PUSH'
  pnl REAL,                 -- virtual P&L in USDC
  settled_at TEXT
)

snapshots (
  trade_id INTEGER REFERENCES trades(id),
  obi REAL, tfi REAL, spread REAL, funding_rate REAL,
  oi_delta REAL, rsi REAL, macd REAL, atr REAL, btc_price REAL
)
```

---

## Dashboard API

| Endpoint | Returns |
|----------|---------|
| `GET /api/stats` | `{ totalTrades, settledTrades, winRate, totalPnl, roi, avgConfidence }` |
| `GET /api/trades?limit=N` | Array of trades joined with snapshots |
| `GET /api/pnl-timeline` | `[{ settled_at, cumulative_pnl }]` |
| `GET /api/model` | `{ active, trainedAt, trainingSamples, trainAcc, valAcc, featureImportances }` |

---

## Known Limitations / Future Work

- **No live trading yet** — needs `@polymarket/clob-client` + Polygon wallet with USDC
- **Single asset** — only BTC 5M; ETH/SOL 5M markets exist but not implemented
- **Rule-based veto rules** — derived from only 17 trades; may need revision with more data
- **No liquidation data** — CoinGlass API not integrated (listed in roadmap)
- **No Telegram/Discord alerts** — manual dashboard monitoring only
- **ML needs 200+ trades** for statistical reliability (currently ~44 at initial test)

---

## Deployment (Vultr)

**Recommended server:** Cloud Compute, London (LHR), 1 vCPU / 2 GB RAM — ~$12/month.  
London is closest to Polymarket's CLOB infrastructure (AWS eu-west-2).

```bash
# On server:
npm install -g pm2
git clone <repo> && cd polymarket-bot && npm install
pm2 start "npm run dev" --name polymarket-bot
pm2 save && pm2 startup

# Access dashboard via SSH tunnel (don't expose port publicly):
ssh -L 3000:localhost:3000 root@YOUR_SERVER_IP
```

---

## Current Bot Performance (as of initial testing)

- **44 settled trades** (small sample — insufficient for statistical conclusions)
- **75% Win Rate**
- **+$111 virtual P&L** on $10/trade virtual stakes
- ML model: not yet active (activates at 50 settled trades)
- Mode: Rule-based with hard veto rules

> Target before considering live trading: 200+ trades, >58% sustained win rate, ML val_acc > 60%

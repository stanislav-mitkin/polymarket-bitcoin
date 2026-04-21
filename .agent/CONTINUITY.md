[PLANS]
- 2026-04-21T11:59Z [USER] Add staged migration foundation from paper to live trading: runtime mode switch, live executor skeleton, and env validation.
- 2026-04-21T11:59Z [CODE] Keep settlement/training pipeline operational by recording executed live attempts into existing trades/snapshots tables until full fill-reconciliation schema is added.
- 2026-04-21T12:03Z [USER] Implement next stage: hard risk controls and live order status reconciliation in DB.
- 2026-04-21T12:07Z [USER] Continue to next stage: trade-level fee reconciliation and live settlement P&L based on actual fills.
- 2026-04-21T12:10Z [USER] Add reconciliation audit/autocorrect workflow to calibrate stored fill/fee/PnL data.

[DECISIONS]
- 2026-04-21T11:59Z [CODE] Introduced `TradingConfig` with `TRADING_MODE` (`paper|live`), `TRADE_SIZE_USDC`, and required live env checks (`POLY_PRIVATE_KEY`, `POLY_SIGNATURE_TYPE`, `POLY_FUNDER_ADDRESS`).
- 2026-04-21T11:59Z [CODE] Added `TradeExecutor` abstraction and switched `main.ts` to call executor instead of hardcoded paper trader.
- 2026-04-21T11:59Z [CODE] Live signer implemented via `ethers` adapter (`_signTypedData` + `getAddress`) to avoid `viem` DOM-type conflicts in current TS config.
- 2026-04-21T12:03Z [CODE] Added risk limits at tick level (`MAX_OPEN_POSITIONS`, `MAX_DAILY_LOSS_USDC`, `MAX_CONSECUTIVE_LOSSES`, `MAX_CONSECUTIVE_TICK_ERRORS`) and kill-switch behavior on repeated tick errors.
- 2026-04-21T12:03Z [CODE] Extended `trades` schema for live lifecycle fields (`mode`, `live_order_id`, `live_status`, request/fill/error fields) via additive migrations.
- 2026-04-21T12:07Z [CODE] Settlement now branches by mode: paper keeps legacy formula; live uses reconciled `filled_price`, `filled_size`, and `fees_usdc`.
- 2026-04-21T12:10Z [CODE] Added dedicated audit script with `--apply` mode instead of silently mutating rows inside bot runtime; operator controls when bulk corrections are applied.

[PROGRESS]
- 2026-04-21T11:59Z [CODE] Added `src/bot/live-trader.ts` with pre-trade checks: geoblock cache, acceptingOrders, min order-size buffer, collateral balance/allowance, dry-run toggle, and market order placement path.
- 2026-04-21T11:59Z [CODE] Updated `.env.example` and `README.md` for new live/paper mode controls and rollout defaults.
- 2026-04-21T12:03Z [CODE] Added live order reconciliation loop (`reconcileOpenTrades`) that updates trade status and fill fields via CLOB `getOrder`.
- 2026-04-21T12:03Z [CODE] Added DB helpers for risk gates and live reconciliation queue (`countOpenTrades`, `getDailyRealizedPnl`, `getConsecutiveLosses`, `getLiveTradesToReconcile`, `updateLiveTradeMetaById`).
- 2026-04-21T12:07Z [CODE] Live reconciliation now pulls trade fills from CLOB (`getTrades`) and stores weighted fill price/size plus fee estimate.
- 2026-04-21T12:07Z [CODE] `settleTradeById` now computes P&L from stored trade row and returns structured settlement details for logging.
- 2026-04-21T12:10Z [CODE] Added `src/scripts/live-reconciliation-audit.ts` to compare stored live fill/fee data with CLOB trades, print deltas, and optionally apply updates.
- 2026-04-21T12:10Z [CODE] Added `recomputeSettledTradePnlById()` DB helper so audit `--apply` can recompute settled live P&L after fill/fee corrections.
- 2026-04-21T12:10Z [CODE] Added npm scripts `audit:live` / `audit:live:dev` and documented usage in README.

[DISCOVERIES]
- 2026-04-21T11:59Z [TOOL] Local tool environment has `node` but no `npm`; direct `npm run build` cannot be executed here.
- 2026-04-21T11:59Z [TOOL] Typecheck passes with `./node_modules/.bin/tsc -p tsconfig.json --noEmit` after removing direct `viem` imports from project code.
- 2026-04-21T12:03Z [CODE] CLOB order status reconciliation is possible from `getOrder` (status, price, size_matched), but exact fee accounting still needs trade-level fill parsing.
- 2026-04-21T12:07Z [CODE] CLOB `getTrades({market})` includes `taker_order_id`, `size`, `price`, `fee_rate_bps`, enabling fill aggregation per order; fee is still an estimate from `fee_rate_bps * notional`.
- 2026-04-21T12:10Z [ASSUMPTION] Audit currently fetches only first page of market trades (`only_first_page=true`) for speed; highly active markets may require pagination support if order fills are missing from first page.

[OUTCOMES]
- 2026-04-21T11:59Z [CODE] Foundation for live mode is implemented and wired into runtime selection; project compiles via TypeScript no-emit check. Remaining work: true live order lifecycle reconciliation (order status/fills/fees) and DB schema expansion for precise live accounting.
- 2026-04-21T12:03Z [CODE] Stage 3 and most of Stage 4 completed: risk-limits active, DB schema expanded, and live status/fill reconciliation implemented. Remaining gap: fee-accurate P&L from raw fill/trade data.
- 2026-04-21T12:07Z [CODE] Next-stage implementation done: settlement for live mode now uses reconciled fills and estimated fees. Remaining gap narrowed to validation/calibration of fee formula against exchange-reported settlements.
- 2026-04-21T12:10Z [CODE] Reconciliation calibration loop is now operational via explicit audit command (`--apply` for auto-correction + settled P&L recompute). Remaining improvement: optional pagination in audit for complete fill coverage on high-volume markets.

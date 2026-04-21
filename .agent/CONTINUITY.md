[PLANS]
- 2026-04-21T11:59Z [USER] Add staged migration foundation from paper to live trading: runtime mode switch, live executor skeleton, and env validation.
- 2026-04-21T11:59Z [CODE] Keep settlement/training pipeline operational by recording executed live attempts into existing trades/snapshots tables until full fill-reconciliation schema is added.

[DECISIONS]
- 2026-04-21T11:59Z [CODE] Introduced `TradingConfig` with `TRADING_MODE` (`paper|live`), `TRADE_SIZE_USDC`, and required live env checks (`POLY_PRIVATE_KEY`, `POLY_SIGNATURE_TYPE`, `POLY_FUNDER_ADDRESS`).
- 2026-04-21T11:59Z [CODE] Added `TradeExecutor` abstraction and switched `main.ts` to call executor instead of hardcoded paper trader.
- 2026-04-21T11:59Z [CODE] Live signer implemented via `ethers` adapter (`_signTypedData` + `getAddress`) to avoid `viem` DOM-type conflicts in current TS config.

[PROGRESS]
- 2026-04-21T11:59Z [CODE] Added `src/bot/live-trader.ts` with pre-trade checks: geoblock cache, acceptingOrders, min order-size buffer, collateral balance/allowance, dry-run toggle, and market order placement path.
- 2026-04-21T11:59Z [CODE] Updated `.env.example` and `README.md` for new live/paper mode controls and rollout defaults.

[DISCOVERIES]
- 2026-04-21T11:59Z [TOOL] Local tool environment has `node` but no `npm`; direct `npm run build` cannot be executed here.
- 2026-04-21T11:59Z [TOOL] Typecheck passes with `./node_modules/.bin/tsc -p tsconfig.json --noEmit` after removing direct `viem` imports from project code.

[OUTCOMES]
- 2026-04-21T11:59Z [CODE] Foundation for live mode is implemented and wired into runtime selection; project compiles via TypeScript no-emit check. Remaining work: true live order lifecycle reconciliation (order status/fills/fees) and DB schema expansion for precise live accounting.

import { startStreaming } from './data/collector';
import { computeFeatures } from './data/features';
import { getNextMarket } from './bot/polymarket';
import { predict, reloadModel, getModelInfo } from './model/predictor';
import { settleExpiredTrades } from './bot/settler';
import { startDashboard } from './dashboard/server';
import {
  countOpenTrades, getConsecutiveLosses, getDailyRealizedPnl, hasTradeForMarket,
  getLiveCumulativePnl, getLiveBankroll,
} from './db/database';
import { maybeRetrain, MIN_TRADES_FOR_TRAINING, RETRAIN_EVERY } from './model/trainer';
import { loadRegime } from './model/regime';
import { loadTradingConfig } from './config/trading';
import { createTradeExecutor } from './bot/trade-executor';
import { computePositionSize } from './bot/sizing';

const TICK_INTERVAL_MS = 60_000;       // Run prediction loop every 1 minute
const SETTLE_INTERVAL_MS = 2 * 60_000; // Check settlements every 2 minutes
const WARMUP_MS = 10_000;              // Wait for WS data before first tick
const MIN_EDGE = 0.04;                 // Minimum edge = 4% (confidence - breakeven price)
const tradingConfig = loadTradingConfig();
const tradeExecutor = createTradeExecutor(tradingConfig);
let consecutiveTickErrors = 0;
let tickInProgress = false;
let tickIntervalHandle: NodeJS.Timeout | null = null;
let settleIntervalHandle: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  if (tickInProgress) {
    console.log('[Bot] Previous tick still running — skipping this interval');
    return;
  }
  tickInProgress = true;

  let tickFailed = false;
  try {
    // 1. Settle any expired trades first
    await settleExpiredTrades();
    await tradeExecutor.reconcileOpenTrades?.();

    // 1b. Auto-retrain if enough new data has accumulated
    const retrained = maybeRetrain();
    if (retrained) reloadModel();

    // 1c. Circuit breaker — pause new trades when recent performance is bad.
    // Settlements and retraining still run above so we keep collecting data.
    const regime = loadRegime();
    if (regime?.pauseTrading) {
      console.log(
        `[Bot] PAUSE: regime=${regime.reason} ` +
        `(wr7d=${regime.wr7d !== null ? (regime.wr7d * 100).toFixed(1) + '%' : 'n/a'}, ` +
        `edge7d=${regime.realizedEdge7d !== null ? (regime.realizedEdge7d * 100).toFixed(1) + '%' : 'n/a'}, ` +
        `n7d=${regime.n7d})`
      );
      return;
    }

    // 1d. Cumulative drawdown kill-switch (live only — paper PnL is imaginary).
    // Evaluated BEFORE other risk returns so a breach is never hidden by an
    // earlier `return` (e.g. daily-loss or consecutive-loss gates).
    // Protects against slow bleed: many small losses that never breach the
    // daily cap or streak cap but still drain capital. Hard-exits so PM2 will
    // NOT auto-recover — operator must review and reset bankroll intentionally.
    if (tradingConfig.mode === 'live') {
      const cumulativePnl = getLiveCumulativePnl();
      const { initialBankrollUsdc, maxDrawdownPct } = tradingConfig.risk;
      const drawdownPct = -cumulativePnl / initialBankrollUsdc;
      if (drawdownPct >= maxDrawdownPct) {
        console.error(
          `[Bot] KILL-SWITCH: cumulative drawdown=${(drawdownPct * 100).toFixed(2)}% ` +
          `>= ${(maxDrawdownPct * 100).toFixed(2)}% of initial bankroll $${initialBankrollUsdc.toFixed(2)}. ` +
          `Cumulative PnL=$${cumulativePnl.toFixed(2)}. Exiting — operator intervention required.`
        );
        if (tickIntervalHandle) clearInterval(tickIntervalHandle);
        if (settleIntervalHandle) clearInterval(settleIntervalHandle);
        process.exit(1);
      }
    }

    // 1e. Other risk limits (soft — just skip this tick)
    const openTrades = countOpenTrades();
    if (openTrades >= tradingConfig.risk.maxOpenPositions) {
      console.log(`[Bot] RISK: open positions=${openTrades} >= ${tradingConfig.risk.maxOpenPositions}, skipping new trade`);
      return;
    }
    const dailyPnl = getDailyRealizedPnl();
    if (dailyPnl <= -Math.abs(tradingConfig.risk.maxDailyLossUsdc)) {
      console.log(
        `[Bot] RISK: daily pnl=${dailyPnl.toFixed(2)} <= -${Math.abs(tradingConfig.risk.maxDailyLossUsdc).toFixed(2)}, pause new trades`
      );
      return;
    }
    const consecutiveLosses = getConsecutiveLosses();
    if (consecutiveLosses >= tradingConfig.risk.maxConsecutiveLosses) {
      console.log(
        `[Bot] RISK: consecutive losses=${consecutiveLosses} >= ${tradingConfig.risk.maxConsecutiveLosses}, pause new trades`
      );
      return;
    }

    // 2. Find the next active market
    const market = await getNextMarket();
    if (!market) {
      console.log('[Bot] No active BTC 5M market found, skipping...');
      return;
    }

    // 3. Skip if we already have a trade for this market in DB (survives restarts)
    if (hasTradeForMarket(market.id)) return;

    // 4. Check there's enough time left to be meaningful (at least 60s)
    const msUntilEnd = new Date(market.endDateIso).getTime() - Date.now();
    if (msUntilEnd < 60_000) {
      console.log(`[Bot] Market ${market.id} ends in ${Math.round(msUntilEnd / 1000)}s — too late, skipping`);
      return;
    }

    // 5. Compute features from live Binance data
    const features = await computeFeatures();
    console.log(
      `[Bot] Features | OBI=${features.obi} TFI=${features.tfi} ` +
      `RSI=${features.rsi.toFixed(1)} Funding=${features.fundingRate.toFixed(4)}% ` +
      `BTC=$${features.btcPrice.toLocaleString()}`
    );

    // 6. Run prediction model
    const prediction = predict(features);
    if (!prediction) {
      console.log(`[Bot] Confidence below threshold — no trade`);
      return;
    }

    // 6b. Edge check: confidence must exceed contract breakeven price by MIN_EDGE
    // breakeven = price of the token we're buying (YES for UP, NO for DOWN)
    const betPrice = prediction.signal === 'UP' ? market.priceUp : market.priceDown;
    const edge = prediction.confidence - betPrice;
    if (edge < MIN_EDGE) {
      console.log(
        `[Bot] SKIP: edge=${(edge * 100).toFixed(1)}% < ${MIN_EDGE * 100}% ` +
        `(conf=${prediction.confidence} breakeven=${betPrice} signal=${prediction.signal})`
      );
      return;
    }

    // 7. Size the position. Paper mode keeps the legacy fixed TRADE_SIZE_USDC
    // so historical virtual comparisons stay apples-to-apples; live mode uses
    // half-Kelly with loss-damping on the current bankroll.
    let sizeUsdc = tradingConfig.tradeSizeUsdc;
    if (tradingConfig.mode === 'live') {
      const bankroll = getLiveBankroll(tradingConfig.risk.initialBankrollUsdc);
      const sizing = computePositionSize(
        {
          bankrollUsdc: bankroll,
          consecutiveLosses,
          confidence: prediction.confidence,
          edge,
        },
        tradingConfig.risk,
      );
      sizeUsdc = sizing.sizeUsdc;
      console.log(
        `[Bot] SIZE | bankroll=$${bankroll.toFixed(2)} kelly=${sizing.kellyFraction.toFixed(3)} ` +
        `base=$${sizing.baseSize.toFixed(2)} damp=${sizing.dampening.toFixed(2)} ` +
        `losses=${consecutiveLosses} → size=$${sizeUsdc.toFixed(2)}`
      );
    }

    // 8. Execute trade (paper or live)
    await tradeExecutor.execute({
      market,
      prediction,
      features,
      edge,
      sizeUsdc,
    });
  } catch (err) {
    tickFailed = true;
    consecutiveTickErrors += 1;
    console.error('[Bot] Tick error:', err);
    console.error(
      `[Bot] Tick error streak=${consecutiveTickErrors}/${tradingConfig.risk.maxConsecutiveTickErrors}`
    );
  } finally {
    if (!tickFailed) consecutiveTickErrors = 0;
    tickInProgress = false;
  }

  // Kill-switch: exit so PM2/operator restarts cleanly. A bare `return` left the
  // interval firing forever with the counter latched, masking the failure.
  if (consecutiveTickErrors >= tradingConfig.risk.maxConsecutiveTickErrors) {
    console.error(
      `[Bot] KILL-SWITCH: consecutive tick errors=${consecutiveTickErrors} ` +
      `>= ${tradingConfig.risk.maxConsecutiveTickErrors}. Exiting (PM2 should restart).`
    );
    if (tickIntervalHandle) clearInterval(tickIntervalHandle);
    if (settleIntervalHandle) clearInterval(settleIntervalHandle);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log(`  Polymarket BTC 5M — ${tradingConfig.mode.toUpperCase()} Trading Bot`);
  console.log('═══════════════════════════════════════════');

  // Start WebSocket streams from Binance
  startStreaming();

  // Start dashboard web server
  startDashboard();

  // Wait for WebSocket to warm up
  console.log(`[Bot] Warming up for ${WARMUP_MS / 1000}s...`);
  await new Promise(resolve => setTimeout(resolve, WARMUP_MS));

  // Run first tick immediately
  await tick();

  // Schedule recurring ticks
  tickIntervalHandle = setInterval(tick, TICK_INTERVAL_MS);

  // Separate settler interval
  settleIntervalHandle = setInterval(async () => {
    try {
      await settleExpiredTrades();
    } catch (err) {
      console.error('[Settler] Error:', err);
    }
  }, SETTLE_INTERVAL_MS);

  const modelInfo = getModelInfo();
  if (modelInfo.active) {
    console.log(`[Bot] ML model active | trained on ${modelInfo.samples} samples | val_acc=${((modelInfo.valAcc ?? 0) * 100).toFixed(1)}%`);
  } else {
    console.log(`[Bot] Rule-based mode (ML activates after ${MIN_TRADES_FOR_TRAINING} settled trades, retrains every ${RETRAIN_EVERY})`);
  }
  console.log(`[Bot] Trading mode=${tradingConfig.mode} | tradeSize=$${tradingConfig.tradeSizeUsdc.toFixed(2)}`);
  console.log(
    `[Bot] Risk limits | maxOpen=${tradingConfig.risk.maxOpenPositions} ` +
    `maxDailyLoss=$${tradingConfig.risk.maxDailyLossUsdc.toFixed(2)} ` +
    `maxConsecLoss=${tradingConfig.risk.maxConsecutiveLosses} ` +
    `maxTickErr=${tradingConfig.risk.maxConsecutiveTickErrors} ` +
    `maxDrawdown=${(tradingConfig.risk.maxDrawdownPct * 100).toFixed(0)}%`
  );
  if (tradingConfig.mode === 'live') {
    const cumulativePnl = getLiveCumulativePnl();
    const bankroll = tradingConfig.risk.initialBankrollUsdc + cumulativePnl;
    console.log(
      `[Bot] Live bankroll=$${bankroll.toFixed(2)} (initial=$${tradingConfig.risk.initialBankrollUsdc.toFixed(2)}, ` +
      `cumPnl=$${cumulativePnl.toFixed(2)}) | sizing: base=${(tradingConfig.risk.basePositionPct * 100).toFixed(1)}% ` +
      `min=$${tradingConfig.risk.minPositionUsdc} max=$${tradingConfig.risk.maxPositionUsdc} ` +
      `lossDamp=${tradingConfig.risk.lossDampFactor}/loss`
    );
    console.log(
      `[Bot] Live dry-run=${tradingConfig.live.dryRun} | confirmed=${tradingConfig.live.tradingConfirmed} | host=${tradingConfig.live.host}`
    );
  }
  console.log('[Bot] Running. Dashboard: http://localhost:3000');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

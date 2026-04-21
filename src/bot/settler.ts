import { getUnsettledTrades, settleTradeById, type Trade } from '../db/database';
import { resolveMarketOutcome } from './polymarket';

/**
 * Checks all trades whose market has expired but haven't been settled yet.
 * Tries to fetch the outcome from Polymarket and updates the DB.
 */
export async function settleExpiredTrades(): Promise<void> {
  const unsettled: Trade[] = getUnsettledTrades();
  if (unsettled.length === 0) return;

  console.log(`[Settler] Checking ${unsettled.length} unsettled trade(s)...`);

  for (const trade of unsettled) {
    try {
      const outcome = await resolveMarketOutcome(trade.market_id);
      if (!outcome) {
        console.log(`[Settler] Trade #${trade.id} — outcome not available yet`);
        continue;
      }

      const settled = settleTradeById(trade.id!, outcome);

      console.log(
        `[Settler] Trade #${trade.id} settled | signal=${trade.signal} outcome=${outcome} ` +
        `${settled.won ? '✓ WIN' : '✗ LOSS'} | mode=${settled.mode} | ` +
        `P&L=${settled.pnl > 0 ? '+' : ''}${settled.pnl.toFixed(2)} USDC ` +
        `(entry=${settled.entryPrice.toFixed(4)} shares=${settled.shares.toFixed(4)} fees=${settled.feesUsdc.toFixed(4)})`
      );
    } catch (err) {
      console.error(`[Settler] Error settling trade #${trade.id}:`, err);
    }
  }
}

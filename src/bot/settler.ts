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

      settleTradeById(
        trade.id!,
        outcome,
        trade.price_yes,
        trade.price_no,
        trade.size_usdc,
        trade.signal
      );

      const won = outcome === trade.signal;
      const pnl = won
        ? trade.size_usdc * (1 - (trade.signal === 'UP' ? trade.price_yes : trade.price_no))
        : -trade.size_usdc * (trade.signal === 'UP' ? trade.price_yes : trade.price_no);

      console.log(
        `[Settler] Trade #${trade.id} settled | signal=${trade.signal} outcome=${outcome} ` +
        `${won ? '✓ WIN' : '✗ LOSS'} | P&L=${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDC`
      );
    } catch (err) {
      console.error(`[Settler] Error settling trade #${trade.id}:`, err);
    }
  }
}

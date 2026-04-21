import { Chain, ClobClient, type ClobSigner, type Trade as ClobTrade } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import db, { recomputeSettledTradePnlById, updateLiveTradeMetaById } from '../db/database';
import { loadTradingConfig } from '../config/trading';

interface AuditTradeRow {
  id: number;
  market_id: string;
  live_order_id: string;
  signal: 'UP' | 'DOWN';
  outcome: 'UP' | 'DOWN' | null;
  pnl: number | null;
  filled_price: number | null;
  filled_size: number | null;
  fees_usdc: number | null;
}

interface FillAgg {
  totalSize: number;
  weightedPrice: number | null;
  feesUsdcEstimate: number;
}

function parseArgs(): { apply: boolean; limit: number; maxPages: number } {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const pagesArg = args.find((a) => a.startsWith('--max-pages='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 50;
  const maxPages = pagesArg ? Number(pagesArg.split('=')[1]) : 5;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Invalid --limit value: ${limitArg}`);
  if (!Number.isFinite(maxPages) || maxPages <= 0) throw new Error(`Invalid --max-pages value: ${pagesArg}`);
  return { apply, limit: Math.floor(limit), maxPages: Math.floor(maxPages) };
}

function createSigner(privateKey: string): ClobSigner {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(normalized);
  return {
    _signTypedData: async (domain, types, value) => wallet.signTypedData(domain as any, types as any, value as any),
    getAddress: async () => wallet.address,
  };
}

function parseNum(v: unknown): number | null {
  const parsed = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function aggregateFills(trades: ClobTrade[], orderId: string): FillAgg {
  let totalSize = 0;
  let totalNotional = 0;
  let feesUsdcEstimate = 0;

  for (const t of trades) {
    if (t.taker_order_id !== orderId) continue;
    const size = parseNum(t.size);
    const price = parseNum(t.price);
    if (size === null || price === null || size <= 0 || price <= 0) continue;

    const notional = size * price;
    totalSize += size;
    totalNotional += notional;

    const feeRateBps = parseNum(t.fee_rate_bps) ?? 0;
    feesUsdcEstimate += notional * (feeRateBps / 10_000);
  }

  return {
    totalSize: round6(totalSize),
    weightedPrice: totalSize > 0 ? round6(totalNotional / totalSize) : null,
    feesUsdcEstimate: round6(feesUsdcEstimate),
  };
}

async function main(): Promise<void> {
  const { apply, limit, maxPages } = parseArgs();
  const cfg = loadTradingConfig();
  if (cfg.mode !== 'live') {
    throw new Error('Set TRADING_MODE=live for reconciliation audit.');
  }

  const signer = createSigner(cfg.live.privateKey!);
  const chainId = cfg.live.chainId === 137 ? Chain.POLYGON : Chain.AMOY;

  const l1 = new ClobClient(cfg.live.host, chainId, signer, undefined, cfg.live.signatureType, cfg.live.funderAddress);
  const creds = await l1.createOrDeriveApiKey();
  const clob = new ClobClient(
    cfg.live.host,
    chainId,
    signer,
    creds,
    cfg.live.signatureType,
    cfg.live.funderAddress,
    undefined,
    true
  );

  const rows = db.prepare(
    `
      SELECT id, market_id, live_order_id, signal, outcome, pnl, filled_price, filled_size, fees_usdc
      FROM trades
      WHERE mode = 'live' AND live_order_id IS NOT NULL
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `
  ).all(limit) as AuditTradeRow[];

  if (rows.length === 0) {
    console.log('[Audit] No live trades with live_order_id found.');
    return;
  }

  const marketTradesCache = new Map<string, ClobTrade[]>();
  let changed = 0;

  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Live Reconciliation Audit | trades=${rows.length} | apply=${apply}`);
  console.log(`═══════════════════════════════════════════════════════════`);

  for (const row of rows) {
    try {
      let marketTrades = marketTradesCache.get(row.market_id);
      if (!marketTrades) {
        marketTrades = await fetchMarketTrades(clob, row.market_id, maxPages);
        marketTradesCache.set(row.market_id, marketTrades);
      }

      const order = await clob.getOrder(row.live_order_id);
      const status = typeof order?.status === 'string' ? order.status.toUpperCase() : null;
      const agg = aggregateFills(marketTrades, row.live_order_id);

      const newFilledPrice = agg.weightedPrice ?? parseNum(order?.price);
      const newFilledSize = agg.totalSize > 0 ? agg.totalSize : parseNum(order?.size_matched);
      const newFees = agg.feesUsdcEstimate;

      const priceDelta = Math.abs((newFilledPrice ?? 0) - (row.filled_price ?? 0));
      const sizeDelta = Math.abs((newFilledSize ?? 0) - (row.filled_size ?? 0));
      const feesDelta = Math.abs((newFees ?? 0) - (row.fees_usdc ?? 0));
      const hasDelta = priceDelta > 0.000001 || sizeDelta > 0.000001 || feesDelta > 0.000001;

      if (hasDelta) {
        changed += 1;
        console.log(
          `[Audit] Trade #${row.id} status=${status ?? 'n/a'} ` +
          `price ${fmt(row.filled_price)} -> ${fmt(newFilledPrice)} | ` +
          `size ${fmt(row.filled_size)} -> ${fmt(newFilledSize)} | ` +
          `fees ${fmt(row.fees_usdc)} -> ${fmt(newFees)}`
        );

        if (apply) {
          updateLiveTradeMetaById(row.id, {
            live_status: status,
            live_error: null,
            filled_price: newFilledPrice,
            filled_size: newFilledSize,
            fees_usdc: newFees,
          });

          if (row.outcome) {
            const recomputed = recomputeSettledTradePnlById(row.id);
            if (recomputed) {
              console.log(
                `[Audit] Trade #${row.id} pnl recomputed -> ${recomputed.pnl.toFixed(2)} ` +
                `(mode=${recomputed.mode} fees=${recomputed.feesUsdc.toFixed(6)})`
              );
            }
          }
        }
      }
    } catch (err) {
      console.log(`[Audit] Trade #${row.id} ERROR: ${String(err)}`);
    }
  }

  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`[Audit] Completed. changed=${changed} apply=${apply}`);
}

function fmt(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'null';
  return v.toFixed(6);
}

async function fetchMarketTrades(client: ClobClient, marketId: string, maxPages: number): Promise<ClobTrade[]> {
  const out: ClobTrade[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const resp = await client.getTradesPaginated({ market: marketId }, cursor);
    if (!resp?.trades || resp.trades.length === 0) break;

    out.push(...resp.trades);
    page += 1;

    const next = resp.next_cursor;
    if (!next || next === 'LTE=') break;
    cursor = next;
  }

  return out;
}

main().catch((err) => {
  console.error('[Audit] Fatal:', err);
  process.exit(1);
});

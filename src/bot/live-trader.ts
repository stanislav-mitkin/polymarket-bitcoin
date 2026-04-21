import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type ClobSigner,
  type TickSize,
  type Trade as ClobTrade,
} from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { getLiveTradesToReconcile, saveTrade, updateLiveTradeMetaById } from '../db/database';
import { type LiveTradingConfig } from '../config/trading';
import { type TradeExecutionInput, type TradeExecutionResult, type TradeExecutor } from './trade-executor';

type GeoblockStatus = {
  blocked?: boolean;
  country?: string;
  region?: string;
  ip?: string;
};

const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
const GEOBLOCK_TTL_MS = 5 * 60_000;
const RECONCILE_MAX_TRADE_PAGES = 5;

export class LiveTraderExecutor implements TradeExecutor {
  private client: ClobClient | null = null;
  private creds: ApiKeyCreds | null = null;
  private geoblockCache: { at: number; status: GeoblockStatus } | null = null;

  constructor(private readonly config: LiveTradingConfig) {}

  async execute(input: TradeExecutionInput): Promise<TradeExecutionResult> {
    await this.assertGeoblockAllowed();

    if (!input.market.acceptingOrders) {
      throw new Error(`Market ${input.market.id} is not accepting orders.`);
    }

    const client = await this.getClient();
    const tokenId = input.prediction.signal === 'UP' ? input.market.tokenIdUp : input.market.tokenIdDown;
    if (!tokenId) {
      throw new Error(`Missing token ID for ${input.prediction.signal} side.`);
    }

    const orderBook = await client.getOrderBook(tokenId);
    const minOrderSize = parseFloat(orderBook.min_order_size);
    const buyPrice = clamp(
      (input.prediction.signal === 'UP' ? input.market.priceUp : input.market.priceDown) + this.config.maxBuyPriceImpact,
      0.001,
      0.99
    );
    const sizeShares = input.sizeUsdc / buyPrice;
    const minRequired = minOrderSize * (1 + this.config.minOrderSizeBufferPct);

    if (!Number.isFinite(sizeShares) || sizeShares <= 0) {
      throw new Error(`Invalid size computed from sizeUsdc=${input.sizeUsdc} and price=${buyPrice}.`);
    }
    if (sizeShares < minRequired) {
      throw new Error(
        `Order too small: size=${sizeShares.toFixed(4)} < min_with_buffer=${minRequired.toFixed(4)}`
      );
    }

    const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    ensureEnoughCollateral(collateral, input.sizeUsdc);

    let externalOrderId: string | undefined;
    let liveStatus = this.config.dryRun ? 'DRY_RUN' : 'PENDING_SUBMIT';
    let liveError: string | null = null;
    let filledPrice: number | null = null;
    let filledSize: number | null = null;
    if (this.config.dryRun) {
      console.log(
        `[LiveTrader] DRY-RUN | market=${input.market.id} signal=${input.prediction.signal} ` +
        `amount=${input.sizeUsdc.toFixed(2)} token=${tokenId}`
      );
    } else {
      try {
        const response = await client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            amount: input.sizeUsdc,
            side: Side.BUY,
            price: buyPrice,
          },
          {
            tickSize: orderBook.tick_size as TickSize,
            negRisk: orderBook.neg_risk,
          },
          OrderType.FOK
        );
        externalOrderId = extractOrderId(response);
        liveStatus = extractOrderStatus(response) ?? 'POSTED';
        filledPrice = extractFilledPrice(response);
        filledSize = extractFilledSize(response);
        console.log(
          `[LiveTrader] LIVE ORDER posted | market=${input.market.id} signal=${input.prediction.signal} ` +
          `amount=${input.sizeUsdc.toFixed(2)} orderId=${externalOrderId ?? 'unknown'} status=${liveStatus}`
        );
      } catch (err) {
        liveStatus = 'FAILED';
        liveError = String(err);
        throw err;
      }
    }

    const tradeId = saveTrade(
      {
        market_id: input.market.id,
        market_end: input.market.endDateIso,
        signal: input.prediction.signal,
        confidence: input.prediction.confidence,
        edge: Math.round(input.edge * 10000) / 10000,
        mode: 'live',
        live_order_id: externalOrderId ?? null,
        live_status: liveStatus,
        live_error: liveError,
        requested_price: buyPrice,
        requested_size: sizeShares,
        filled_price: filledPrice,
        filled_size: filledSize,
        fees_usdc: null,
        live_updated_at: new Date().toISOString(),
        price_yes: input.market.priceUp,
        price_no: input.market.priceDown,
        size_usdc: input.sizeUsdc,
      },
      {
        obi: input.features.obi,
        tfi: input.features.tfi,
        spread: input.features.spread,
        funding_rate: input.features.fundingRate,
        oi_delta: input.features.oiDelta,
        rsi: input.features.rsi,
        macd: input.features.macdHist,
        atr: input.features.atr,
        volume_delta: input.features.volumeDelta,
        btc_trend_1h: input.features.btcTrend1h,
        btc_price: input.features.btcPrice,
      }
    );

    console.log(
      `[LiveTrader] Trade #${tradeId} recorded | signal=${input.prediction.signal} conf=${input.prediction.confidence} ` +
      `size=$${input.sizeUsdc.toFixed(2)}`
    );

    return {
      mode: 'live',
      paperTrade: {
        tradeId,
        signal: input.prediction.signal,
        confidence: input.prediction.confidence,
        marketId: input.market.id,
        marketEnd: input.market.endDateIso,
        priceUp: input.market.priceUp,
        priceDown: input.market.priceDown,
        sizeUsdc: input.sizeUsdc,
      },
      externalOrderId,
    };
  }

  async reconcileOpenTrades(): Promise<void> {
    if (this.config.dryRun) return;

    const rows = getLiveTradesToReconcile(30);
    if (rows.length === 0) return;

    const client = await this.getClient();
    for (const row of rows) {
      if (!row.id || !row.live_order_id) continue;
      try {
        const order = await client.getOrder(row.live_order_id);
        const liveStatus = typeof order?.status === 'string' ? order.status.toUpperCase() : null;
        let filledSize = parseNum(order?.size_matched);
        let filledPrice = parseNum(order?.price);
        let feesUsdc: number | null = null;

        const trades = await fetchMarketTrades(client, row.market_id, RECONCILE_MAX_TRADE_PAGES);
        const ownFills = trades.filter((t) => t.taker_order_id === row.live_order_id);
        if (ownFills.length > 0) {
          const aggregates = aggregateFills(ownFills);
          filledSize = aggregates.totalSize > 0 ? aggregates.totalSize : filledSize;
          filledPrice = aggregates.weightedPrice ?? filledPrice;
          feesUsdc = aggregates.feesUsdcEstimate;
        }

        updateLiveTradeMetaById(row.id, {
          live_status: liveStatus,
          live_error: null,
          filled_price: filledPrice,
          filled_size: filledSize,
          fees_usdc: feesUsdc,
        });
      } catch (err) {
        updateLiveTradeMetaById(row.id, {
          live_error: String(err),
        });
      }
    }
  }

  private async getClient(): Promise<ClobClient> {
    if (this.client) return this.client;

    const chainId = this.config.chainId === 137 ? Chain.POLYGON : Chain.AMOY;
    const signer = createSigner(this.config.privateKey!);

    const l1Client = new ClobClient(
      this.config.host,
      chainId,
      signer,
      undefined,
      this.config.signatureType,
      this.config.funderAddress
    );

    this.creds = await l1Client.createOrDeriveApiKey();
    this.client = new ClobClient(
      this.config.host,
      chainId,
      signer,
      this.creds,
      this.config.signatureType,
      this.config.funderAddress,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    console.log(
      `[LiveTrader] Connected | host=${this.config.host} chain=${chainId} dryRun=${this.config.dryRun}`
    );
    return this.client;
  }

  private async assertGeoblockAllowed(): Promise<void> {
    if (this.geoblockCache && Date.now() - this.geoblockCache.at < GEOBLOCK_TTL_MS) {
      if (this.geoblockCache.status.blocked) {
        throw new Error(formatGeoblockError(this.geoblockCache.status));
      }
      return;
    }

    const res = await fetch(GEOBLOCK_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Geoblock check failed with status=${res.status}.`);

    const status = await res.json() as GeoblockStatus;
    this.geoblockCache = { at: Date.now(), status };
    if (status.blocked) {
      throw new Error(formatGeoblockError(status));
    }
  }
}

function createSigner(privateKey: string): ClobSigner {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(normalized);

  return {
    _signTypedData: async (domain, types, value) => {
      return wallet.signTypedData(domain as any, types as any, value as any);
    },
    getAddress: async () => wallet.address,
  };
}

function ensureEnoughCollateral(collateral: BalanceAllowanceResponse, amountUsdc: number): void {
  const balance = parseFloat(collateral.balance);
  const allowance = parseFloat(collateral.allowance);

  if (balance < amountUsdc) {
    throw new Error(`Insufficient collateral balance: ${balance.toFixed(4)} < ${amountUsdc.toFixed(4)} USDC.`);
  }
  if (allowance < amountUsdc) {
    throw new Error(`Insufficient collateral allowance: ${allowance.toFixed(4)} < ${amountUsdc.toFixed(4)} USDC.`);
  }
}

function formatGeoblockError(status: GeoblockStatus): string {
  return (
    `Polymarket geoblock blocked this host` +
    ` (country=${status.country ?? 'unknown'}, region=${status.region ?? 'unknown'}, ip=${status.ip ?? 'unknown'}).`
  );
}

function extractOrderId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = response as Record<string, unknown>;

  const direct = value['orderID'] ?? value['orderId'] ?? value['id'];
  if (typeof direct === 'string' && direct !== '') return direct;

  const nested = value['order'] as Record<string, unknown> | undefined;
  if (nested && typeof nested['id'] === 'string' && nested['id'] !== '') {
    return nested['id'] as string;
  }
  return undefined;
}

function extractOrderStatus(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = response as Record<string, unknown>;
  if (typeof value['status'] === 'string' && value['status'] !== '') return String(value['status']).toUpperCase();
  return undefined;
}

function extractFilledPrice(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const value = response as Record<string, unknown>;
  const price = value['price'] ?? value['filledPrice'];
  const parsed = parseFloat(String(price ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractFilledSize(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const value = response as Record<string, unknown>;
  const size = value['sizeMatched'] ?? value['size_matched'] ?? value['makingAmount'];
  const parsed = parseFloat(String(size ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function aggregateFills(trades: ClobTrade[]): {
  totalSize: number;
  weightedPrice: number | null;
  feesUsdcEstimate: number;
} {
  let totalSize = 0;
  let totalNotional = 0;
  let feesUsdcEstimate = 0;

  for (const t of trades) {
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

function parseNum(v: unknown): number | null {
  const parsed = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

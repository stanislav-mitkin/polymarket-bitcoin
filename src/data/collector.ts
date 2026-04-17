import { MainClient, USDMClient, WebsocketClient } from 'binance';

export interface OrderBookLevel {
  price: number;
  qty: number;
}

export interface OrderBookState {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  updatedAt: number;
}

export interface Trade {
  price: number;
  qty: number;
  isBuyerMaker: boolean; // true = seller aggressor (sell), false = buyer aggressor (buy)
  time: number;
}

export interface FuturesInfo {
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  spotPrice: number;
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  close: number;
  low: number;
  volume: number;
  buyVolume: number;
}

const SYMBOL = 'BTCUSDT';
const DEPTH_LEVELS = 20;

// Shared in-memory state updated by WebSocket streams
let orderBook: OrderBookState = { bids: [], asks: [], updatedAt: 0 };
let recentTrades: Trade[] = [];
let candles1m: Candle[] = [];

const spotClient = new MainClient();
const futuresClient = new USDMClient();

export function getOrderBook(): OrderBookState {
  return orderBook;
}

export function getRecentTrades(windowMs = 60_000): Trade[] {
  const cutoff = Date.now() - windowMs;
  return recentTrades.filter(t => t.time >= cutoff);
}

export function getCandles(): Candle[] {
  return [...candles1m];
}

/**
 * BTC return over last 60 minutes (1-hour trend).
 * Positive = uptrend, negative = downtrend, ~0 = sideways.
 * Returns fraction, not percent (e.g., 0.015 = +1.5%).
 */
export function getBtcTrend1h(): number {
  if (candles1m.length < 60) return 0; // not enough data yet
  const recent = candles1m.slice(-60);
  const priceNow = recent[recent.length - 1].close;
  const price1hAgo = recent[0].open;
  if (price1hAgo <= 0) return 0;
  return (priceNow - price1hAgo) / price1hAgo;
}

export async function getFuturesInfo(): Promise<FuturesInfo> {
  const [oiRes, markRes, spotRes] = await Promise.all([
    futuresClient.getOpenInterest({ symbol: SYMBOL }),
    futuresClient.getMarkPrice({ symbol: SYMBOL }),
    spotClient.getSymbolPriceTicker({ symbol: SYMBOL }),
  ]);

  // lastFundingRate is the current period's funding rate, available in getMarkPrice()
  const fundingRate = parseFloat(String((markRes as any).lastFundingRate ?? 0));
  const openInterest = parseFloat(String((oiRes as any).openInterest ?? 0));
  const markPrice = parseFloat(String((markRes as any).markPrice ?? 0));
  const spotPrice = parseFloat(String((spotRes as any).price ?? 0));

  return { fundingRate, openInterest, markPrice, spotPrice };
}

// Seed initial 1m candles (last 50) via REST
async function seedCandles(): Promise<void> {
  const raw = await spotClient.getKlines({ symbol: SYMBOL, interval: '1m', limit: 50 });
  candles1m = (raw as any[]).map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    buyVolume: parseFloat(k[9]),
  }));
  console.log(`[Collector] Seeded ${candles1m.length} candles`);
}

export function startStreaming(): void {
  // ── 1. Spot Partial Book Depth (order book) ───────────────────────
  const wsDepth = new WebsocketClient({});
  wsDepth.subscribeSpotPartialBookDepth(SYMBOL, DEPTH_LEVELS, 100);
  wsDepth.on('message', (data: any) => {
    const msg = data.data ?? data;
    if (msg.bids && msg.asks) {
      orderBook = {
        bids: (msg.bids as [string, string][]).map(([p, q]) => ({
          price: parseFloat(p),
          qty: parseFloat(q),
        })),
        asks: (msg.asks as [string, string][]).map(([p, q]) => ({
          price: parseFloat(p),
          qty: parseFloat(q),
        })),
        updatedAt: Date.now(),
      };
    }
  });
  wsDepth.on('error', (err: unknown) => console.error('[Collector] Depth WS error:', err));

  // ── 2. Spot Aggregate Trades (trade flow) ─────────────────────────
  const wsTrades = new WebsocketClient({});
  wsTrades.subscribeSpotAggregateTrades(SYMBOL);
  wsTrades.on('message', (data: any) => {
    const msg = data.data ?? data;
    if (msg.e === 'aggTrade') handleAggTrade(msg);
  });
  wsTrades.on('error', (err: unknown) => console.error('[Collector] Trades WS error:', err));

  // ── 3. Spot 1m Klines (candlesticks) ─────────────────────────────
  const wsKlines = new WebsocketClient({});
  wsKlines.subscribeSpotKline(SYMBOL, '1m');
  wsKlines.on('message', (data: any) => {
    const msg = data.data ?? data;
    if (msg.e === 'kline') handleKline(msg);
  });
  wsKlines.on('error', (err: unknown) => console.error('[Collector] Klines WS error:', err));

  // Seed candles from REST
  seedCandles().catch(console.error);

  console.log('[Collector] Streaming started for', SYMBOL);
}

function handleAggTrade(msg: any): void {
  recentTrades.push({
    price: parseFloat(msg.p),
    qty: parseFloat(msg.q),
    isBuyerMaker: msg.m,
    time: msg.T ?? Date.now(),
  });
  // Keep only last 5 minutes
  const cutoff = Date.now() - 5 * 60_000;
  recentTrades = recentTrades.filter(t => t.time >= cutoff);
}

function handleKline(msg: any): void {
  const k = msg.k;
  const candle: Candle = {
    openTime: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
    buyVolume: parseFloat(k.V),
  };

  const last = candles1m[candles1m.length - 1];
  if (last && last.openTime === candle.openTime) {
    candles1m[candles1m.length - 1] = candle; // update current candle
  } else {
    candles1m.push(candle);
    if (candles1m.length > 200) candles1m.shift();
  }
}

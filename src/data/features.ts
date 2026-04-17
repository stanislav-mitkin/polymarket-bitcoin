import { getOrderBook, getRecentTrades, getCandles, getFuturesInfo, getBtcTrend1h, type Candle } from './collector';

export interface Features {
  // Order book microstructure
  obi: number;        // Order Book Imbalance [-1, 1]
  tfi: number;        // Trade Flow Imbalance [-1, 1]
  spread: number;     // Bid-Ask spread in USDT
  spreadPct: number;  // Spread as % of mid price
  bidDepth: number;   // Total bid volume (top 10 levels)
  askDepth: number;   // Total ask volume (top 10 levels)

  // Futures
  fundingRate: number;
  oiDelta: number;    // OI change vs previous snapshot (%)
  markSpotDelta: number; // (markPrice - spotPrice) / spotPrice

  // Technical indicators
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  atr: number;
  volumeDelta: number; // (buyVol - sellVol) / totalVol for last candle

  // Regime / trend
  btcTrend1h: number;  // BTC return over last 60 candles (e.g., 0.015 = +1.5%)

  // Price
  btcPrice: number;
}

let prevOpenInterest = 0;

export async function computeFeatures(): Promise<Features> {
  const book = getOrderBook();
  const trades = getRecentTrades(60_000); // last 1 minute
  const candles = getCandles();
  const futures = await getFuturesInfo();

  // ── Order Book Imbalance ──────────────────────────────────────────
  const topLevels = 10;
  const bids = book.bids.slice(0, topLevels);
  const asks = book.asks.slice(0, topLevels);

  const bidVol = bids.reduce((s, l) => s + l.qty, 0);
  const askVol = asks.reduce((s, l) => s + l.qty, 0);
  const obi = bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0;

  // ── Spread ────────────────────────────────────────────────────────
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPct = midPrice > 0 ? spread / midPrice : 0;

  // ── Trade Flow Imbalance ──────────────────────────────────────────
  let buyVol = 0;
  let sellVol = 0;
  for (const t of trades) {
    if (t.isBuyerMaker) {
      sellVol += t.qty; // buyer is maker → seller is aggressor
    } else {
      buyVol += t.qty;
    }
  }
  const tfi = buyVol + sellVol > 0 ? (buyVol - sellVol) / (buyVol + sellVol) : 0;

  // ── Technical indicators (requires ≥26 candles) ───────────────────
  const closes = candles.map(c => c.close);
  const rsi = closes.length >= 14 ? calcRSI(closes, 14) : 50;
  const { macd, signal: macdSignal, hist: macdHist } = closes.length >= 26
    ? calcMACD(closes)
    : { macd: 0, signal: 0, hist: 0 };
  const atr = candles.length >= 14 ? calcATR(candles, 14) : 0;

  // Volume delta on last completed candle
  const lastCandle = candles[candles.length - 2]; // -2 = last completed
  const volumeDelta = lastCandle && lastCandle.volume > 0
    ? (lastCandle.buyVolume - (lastCandle.volume - lastCandle.buyVolume)) / lastCandle.volume
    : 0;

  // ── Futures ───────────────────────────────────────────────────────
  const oiDelta = prevOpenInterest > 0
    ? (futures.openInterest - prevOpenInterest) / prevOpenInterest
    : 0;
  prevOpenInterest = futures.openInterest;

  const markSpotDelta = futures.spotPrice > 0
    ? (futures.markPrice - futures.spotPrice) / futures.spotPrice
    : 0;

  return {
    obi: round(obi),
    tfi: round(tfi),
    spread: round(spread),
    spreadPct: round(spreadPct * 100),
    bidDepth: round(bidVol),
    askDepth: round(askVol),
    fundingRate: round(futures.fundingRate * 100),   // in %
    oiDelta: round(oiDelta * 100),                   // in %
    markSpotDelta: round(markSpotDelta * 10000),      // in bps
    rsi: round(rsi),
    macd: round(macd),
    macdSignal: round(macdSignal),
    macdHist: round(macdHist),
    atr: round(atr),
    volumeDelta: round(volumeDelta),
    btcTrend1h: round(getBtcTrend1h()),
    btcPrice: round(futures.spotPrice || midPrice),
  };
}

// ── Indicator math ────────────────────────────────────────────────────

function calcRSI(closes: number[], period: number): number {
  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...new Array(period - 1).fill(NaN), prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function calcMACD(closes: number[]): { macd: number; signal: number; hist: number } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i]));
  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalLine = ema(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1] ?? 0;
  const lastSignal = signalLine[signalLine.length - 1] ?? 0;
  return { macd: lastMacd, signal: lastSignal, hist: lastMacd - lastSignal };
}

function calcATR(candles: Candle[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function round(n: number, decimals = 6): number {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

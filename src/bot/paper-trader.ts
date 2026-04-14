import { saveTrade } from '../db/database';
import { type Features } from '../data/features';
import { type Prediction, TRADE_SIZE_USDC } from '../model/predictor';
import { type PolyMarket5M } from './polymarket';

export interface PaperTrade {
  tradeId: number;
  signal: 'UP' | 'DOWN';
  confidence: number;
  marketId: string;
  marketEnd: string;
  priceUp: number;
  priceDown: number;
  sizeUsdc: number;
}

export function executePaperTrade(
  market: PolyMarket5M,
  prediction: Prediction,
  features: Features
): PaperTrade {
  const tradeId = saveTrade(
    {
      market_id: market.id,
      market_end: market.endDateIso,
      signal: prediction.signal,
      confidence: prediction.confidence,
      price_yes: market.priceUp,   // "Up" outcome = YES
      price_no: market.priceDown,  // "Down" outcome = NO
      size_usdc: TRADE_SIZE_USDC,
    },
    {
      obi: features.obi,
      tfi: features.tfi,
      spread: features.spread,
      funding_rate: features.fundingRate,
      oi_delta: features.oiDelta,
      rsi: features.rsi,
      macd: features.macdHist,
      atr: features.atr,
      btc_price: features.btcPrice,
    }
  );

  console.log(
    `[PaperTrader] Trade #${tradeId} | ${prediction.signal} @ conf=${prediction.confidence} | ` +
    `UP=${market.priceUp} DOWN=${market.priceDown} | ends ${market.endDateIso} | ${prediction.reason}`
  );

  return {
    tradeId,
    signal: prediction.signal,
    confidence: prediction.confidence,
    marketId: market.id,
    marketEnd: market.endDateIso,
    priceUp: market.priceUp,
    priceDown: market.priceDown,
    sizeUsdc: TRADE_SIZE_USDC,
  };
}

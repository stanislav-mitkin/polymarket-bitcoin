import { type Features } from '../data/features';
import { type Prediction } from '../model/predictor';
import { type PolyMarket5M } from './polymarket';
import { executePaperTrade, type PaperTrade } from './paper-trader';
import { type TradingConfig } from '../config/trading';
import { LiveTraderExecutor } from './live-trader';

export interface TradeExecutionInput {
  market: PolyMarket5M;
  prediction: Prediction;
  features: Features;
  edge: number;
  sizeUsdc: number;
}

export interface TradeExecutionResult {
  mode: 'paper' | 'live';
  paperTrade: PaperTrade;
  externalOrderId?: string;
}

export interface TradeExecutor {
  execute(input: TradeExecutionInput): Promise<TradeExecutionResult> | TradeExecutionResult;
  reconcileOpenTrades?(): Promise<void> | void;
}

class PaperTraderExecutor implements TradeExecutor {
  execute(input: TradeExecutionInput): TradeExecutionResult {
    return {
      mode: 'paper',
      paperTrade: executePaperTrade(
        input.market,
        input.prediction,
        input.features,
        input.edge,
        input.sizeUsdc
      ),
    };
  }
}

export function createTradeExecutor(config: TradingConfig): TradeExecutor {
  if (config.mode === 'live') return new LiveTraderExecutor(config.live);
  return new PaperTraderExecutor();
}

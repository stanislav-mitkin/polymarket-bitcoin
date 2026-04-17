import { type Features } from '../data/features';
import { loadModel, type LRModel } from './trainer';
import {
  extractFeatures,
  normSingle,
  predictProba,
} from './logistic-regression';

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.65;    // baseline — below this is near-random (50.7% WR on 203 trades)
const CONFIDENCE_THRESHOLD_UP = 0.65; // same as DOWN — UP now profitable (52% WR) after BTC uptrend
const CONFIDENCE_MAX = 0.85;          // cap — overconfident trades: 38.5% WR, -$13.65
export const TRADE_SIZE_USDC = 10;

// ─── ML model (lazy-loaded, hot-swappable) ────────────────────────────────────

let mlModel: LRModel | null = loadModel();

/** Called by main.ts after a successful retrain to hot-swap the model. */
export function reloadModel(): void {
  mlModel = loadModel();
  if (mlModel) {
    console.log(
      `[Predictor] ML model loaded | samples=${mlModel.trainingSamples} ` +
      `val_acc=${(mlModel.metrics.valAcc * 100).toFixed(1)}%`
    );
  }
}

export function getModelInfo(): { active: boolean; samples?: number; valAcc?: number } {
  if (!mlModel) return { active: false };
  return {
    active: true,
    samples: mlModel.trainingSamples,
    valAcc: mlModel.metrics.valAcc,
  };
}

// ─── Hard-veto rules (always active, even in ML mode) ────────────────────────
//
// Backtest on 17 unique trades showed:
//   Rule 1: RSI > 62 AND MACD > 10 → prevented losses #15, #17 (WR 71% → 80%)
//   Rule 2: RSI < 25 AND DOWN      → prevented loss #29 (oversold bounce)
//   Rule 3: |TFI| < 0.25 AND RSI > 58 AND UP → prevented loss #25 (weak flow)

type VetoRule = {
  name: string;
  check: (f: Features, signal: 'UP' | 'DOWN') => boolean;
};

const VETO_RULES: VetoRule[] = [
  {
    name: 'Overbought exhaustion (RSI>62 & MACD>10)',
    check: (f) => f.rsi > 62 && f.macdHist > 10,
  },
  {
    name: 'Oversold bounce guard (RSI<25 & DOWN)',
    check: (f, s) => f.rsi < 25 && s === 'DOWN',
  },
  {
    name: 'Weak buyer flow in elevated RSI (|TFI|<0.25 & RSI>58 & UP)',
    check: (f, s) => Math.abs(f.tfi) < 0.25 && f.rsi > 58 && s === 'UP',
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Prediction {
  signal: 'UP' | 'DOWN';
  confidence: number;
  reason: string;
  mode: 'ML' | 'RULES';
}

// ─── Main predict function ────────────────────────────────────────────────────

export function predict(f: Features): Prediction | null {

  // ── Step 1: Rule-based scoring (always runs — cheap, no I/O) ────────
  const votes: { label: string; weight: number; score: number }[] = [];

  votes.push({ label: 'OBI',      weight: 3.0, score: f.obi });
  votes.push({ label: 'TFI',      weight: 3.0, score: f.tfi });

  // OBI × TFI synergy — amplify when both agree
  if (Math.sign(f.obi) === Math.sign(f.tfi) && f.obi !== 0 && f.tfi !== 0) {
    const synergy = Math.sign(f.obi) * Math.sqrt(Math.abs(f.obi) * Math.abs(f.tfi));
    votes.push({ label: 'OBI×TFI', weight: 1.5, score: synergy });
  }

  // RSI — regime-weighted (extreme zones get higher weight)
  let rsiScore = 0;
  let rsiWeight = 1.5;
  if (f.rsi < 30) {
    rsiScore  = (30 - f.rsi) / 30;
    rsiWeight = f.rsi < 20 ? 3.0 : 2.0;
  } else if (f.rsi > 70) {
    rsiScore  = -(f.rsi - 70) / 30;
    rsiWeight = f.rsi > 80 ? 3.0 : 2.0;
  }
  votes.push({ label: 'RSI',      weight: rsiWeight, score: rsiScore });

  const macdScore = clamp(f.macdHist / Math.max(f.atr, 1) * 2, -1, 1);
  votes.push({ label: 'MACD',     weight: 0.8,  score: macdScore });

  // Funding: ML top feature (weight +0.247). Positive funding = longs overpaying = bearish pressure.
  // Negative funding = shorts overpaying = bullish pressure. Weight raised to match ML importance.
  votes.push({ label: 'Funding',  weight: 2.5,  score: -clamp(f.fundingRate / 0.05, -1, 1) });

  const oiSign  = Math.sign(f.tfi);
  const oiScore = oiSign * clamp(Math.abs(f.oiDelta) / 1, 0, 1);
  votes.push({ label: 'OI_delta', weight: 1.0,  score: oiScore });
  votes.push({ label: 'VolDelta', weight: 1.0,  score: f.volumeDelta });

  // BTC 1h trend — regime signal. Positive trend supports UP, negative supports DOWN.
  // Scale: ±5% trend → ±1.0 score. Weight 2.0 — meaningful but not dominant (avoids pure momentum chase).
  votes.push({ label: 'Trend',    weight: 2.0,  score: clamp(f.btcTrend1h * 20, -1, 1) });

  const totalWeight   = votes.reduce((s, v) => s + v.weight, 0);
  const weightedScore = votes.reduce((s, v) => s + v.weight * v.score, 0) / totalWeight;
  const ruleSignal: 'UP' | 'DOWN' = weightedScore >= 0 ? 'UP' : 'DOWN';
  const ruleConf = 0.5 + Math.abs(weightedScore) * 0.5;

  // ── Step 2: ML path ──────────────────────────────────────────────────
  if (mlModel !== null) {
    const rawX = extractFeatures({
      obi: f.obi, tfi: f.tfi, rsi: f.rsi,
      macd: f.macdHist,
      atr: f.atr,
      oi_delta: f.oiDelta,
      funding_rate: f.fundingRate,
      spread: f.spread,
      volume_delta: f.volumeDelta,
      btc_trend_1h: f.btcTrend1h,
    });
    const xNorm = normSingle(rawX, mlModel.normStats);
    const prob  = predictProba(mlModel.weights, mlModel.bias, xNorm);

    const mlSignal: 'UP' | 'DOWN' = prob >= 0.5 ? 'UP' : 'DOWN';
    const mlConf = 0.5 + Math.abs(prob - 0.5); // distance from 0.5

    const minConf = mlSignal === 'UP' ? CONFIDENCE_THRESHOLD_UP : CONFIDENCE_THRESHOLD;
    if (mlConf < minConf) {
      console.log(`[Predictor] SKIP (ML): ${mlSignal} conf=${mlConf.toFixed(3)} < ${minConf}`);
      return null;
    }
    if (mlConf > CONFIDENCE_MAX) {
      console.log(`[Predictor] SKIP (ML): overconfident ${mlConf.toFixed(3)} > ${CONFIDENCE_MAX} — historically 38.5% WR`);
      return null;
    }

    // Hard vetoes apply to the ML signal
    for (const rule of VETO_RULES) {
      if (rule.check(f, mlSignal)) {
        console.log(`[Predictor] VETO (ML): ${rule.name}`);
        return null;
      }
    }

    const topFactors = votes
      .sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score))
      .slice(0, 3)
      .map(v => `${v.label}=${v.score > 0 ? '+' : ''}${v.score.toFixed(2)}`)
      .join(', ');

    return {
      signal: mlSignal,
      confidence: Math.round(mlConf * 10000) / 10000,
      reason: `ML(LR) p=${prob.toFixed(3)} | rule_score=${weightedScore.toFixed(3)} | ${topFactors}`,
      mode: 'ML',
    };
  }

  // ── Step 3: Rule-based fallback ──────────────────────────────────────
  const minRuleConf = ruleSignal === 'UP' ? CONFIDENCE_THRESHOLD_UP : CONFIDENCE_THRESHOLD;
  if (ruleConf < minRuleConf) {
    console.log(`[Predictor] SKIP (rules): ${ruleSignal} conf=${ruleConf.toFixed(3)} < ${minRuleConf}`);
    return null;
  }
  if (ruleConf > CONFIDENCE_MAX) {
    console.log(`[Predictor] SKIP (rules): overconfident ${ruleConf.toFixed(3)} > ${CONFIDENCE_MAX}`);
    return null;
  }

  // Hard vetoes for rule-based signal
  for (const rule of VETO_RULES) {
    if (rule.check(f, ruleSignal)) {
      console.log(`[Predictor] VETO (rules): ${rule.name}`);
      return null;
    }
  }

  const topFactors = votes
    .filter(v => Math.abs(v.score) > 0.1)
    .sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score))
    .slice(0, 4)
    .map(v => `${v.label}=${v.score > 0 ? '+' : ''}${v.score.toFixed(2)}`)
    .join(', ');

  return {
    signal: ruleSignal,
    confidence: Math.round(ruleConf * 10000) / 10000,
    reason: `score=${weightedScore.toFixed(3)} | ${topFactors}`,
    mode: 'RULES',
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

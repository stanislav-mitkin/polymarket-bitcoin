import fs from 'fs';
import path from 'path';
import db from '../db/database';
import {
  extractFeatures, fitNorm, applyNorm, trainLogisticRegression, evaluate,
  FEATURE_NAMES, NUM_FEATURES,
  type LRModel, type RawRow,
} from './logistic-regression';
import { loadRegime, clearForceRetrain } from './regime';

export type { LRModel };

// ─── Config ───────────────────────────────────────────────────────────────────

export const MIN_TRADES_FOR_TRAINING = 50;   // first retrain threshold
export const RETRAIN_EVERY = 25;             // retrain every N new settled trades
const DEFAULT_HALFLIFE_DAYS = 7;             // sample weight = 0.5 at this age (overridable by regime)

const MODEL_PATH = path.join(process.cwd(), 'data', 'model.json');

// ─── Persistence ─────────────────────────────────────────────────────────────

export function saveModel(model: LRModel): void {
  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));
}

export function loadModel(): LRModel | null {
  if (!fs.existsSync(MODEL_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8')) as LRModel;
  } catch {
    return null;
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

interface DBRow extends RawRow {
  outcome: 'UP' | 'DOWN';
  settled_at: string;
}

function loadTrainingData(halflifeDays: number): { X: number[][]; y: number[]; weights: number[] } | null {
  const rows = db.prepare(`
    SELECT t.outcome, t.settled_at,
           s.obi, s.tfi, s.rsi, s.macd, s.atr,
           s.oi_delta, s.funding_rate, s.spread,
           s.volume_delta, s.btc_trend_1h
    FROM trades t
    JOIN snapshots s ON s.trade_id = t.id
    WHERE t.outcome IS NOT NULL
      AND s.atr IS NOT NULL AND s.atr > 0
      AND s.obi IS NOT NULL
    ORDER BY t.settled_at ASC
  `).all() as DBRow[];

  if (rows.length < MIN_TRADES_FOR_TRAINING) return null;

  // Time-weighted samples: exp(-age_days / halflife * ln2)
  // Most recent trade = 1.0, trade at halflife age = 0.5, etc.
  const now = Date.now();
  const ln2 = Math.log(2);
  const weights = rows.map(r => {
    const ageMs = now - new Date(r.settled_at).getTime();
    const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
    return Math.exp(-ageDays / halflifeDays * ln2);
  });

  const X = rows.map(r => extractFeatures(r));
  const y = rows.map(r => r.outcome === 'UP' ? 1 : 0);

  return { X, y, weights };
}

// ─── Train/val split (time-ordered, no shuffle) ───────────────────────────────

function splitData(X: number[][], y: number[], weights: number[], valFrac = 0.2) {
  const splitIdx = Math.floor(X.length * (1 - valFrac));
  return {
    XTrain: X.slice(0, splitIdx), yTrain: y.slice(0, splitIdx), wTrain: weights.slice(0, splitIdx),
    XVal:   X.slice(splitIdx),    yVal:   y.slice(splitIdx),
  };
}

// ─── Count settled trades ─────────────────────────────────────────────────────

function countSettledTrades(): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM trades WHERE outcome IS NOT NULL').get() as { n: number };
  return row.n;
}

// ─── Main retrain function ────────────────────────────────────────────────────

/**
 * Checks whether retraining is needed and performs it if so.
 * Returns true if the model was retrained, false otherwise.
 * Runs synchronously — typically takes 5-30ms on 100-300 samples.
 */
export function maybeRetrain(): boolean {
  const settledCount = countSettledTrades();

  if (settledCount < MIN_TRADES_FOR_TRAINING) {
    console.log(`[Trainer] Not enough data (${settledCount}/${MIN_TRADES_FOR_TRAINING} trades). Skipping.`);
    return false;
  }

  const regime = loadRegime();
  const halflife = regime?.recommendedHalflife ?? DEFAULT_HALFLIFE_DAYS;
  const forceRetrain = regime?.forceRetrain === true;

  // Check if a retrain is due (bypassed when regime shift demands it)
  const existing = loadModel();
  if (existing && !forceRetrain) {
    const newSince = settledCount - existing.trainingSamples;
    if (newSince < RETRAIN_EVERY) return false; // not enough new data
  }

  const data = loadTrainingData(halflife);
  if (!data) return false;

  const { X, y, weights: sampleWeights } = data;
  const { XTrain, yTrain, wTrain, XVal, yVal } = splitData(X, y, sampleWeights);

  // Normalise (fit only on train set to avoid data leakage)
  const normStats = fitNorm(XTrain);
  const XTrainNorm = applyNorm(XTrain, normStats);
  const XValNorm   = applyNorm(XVal,   normStats);

  // Train with time-weighted samples (recent trades get higher influence)
  const t0 = Date.now();
  const { weights, bias } = trainLogisticRegression(XTrainNorm, yTrain, {
    lr: 0.1,
    epochs: 1000,
    lambda: 0.01,
    sampleWeights: wTrain,
  });

  // Evaluate
  const train = evaluate(weights, bias, XTrainNorm, yTrain);
  const val   = XVal.length > 0
    ? evaluate(weights, bias, XValNorm, yVal)
    : { accuracy: train.accuracy, loss: train.loss };

  // Feature importances (by absolute weight magnitude)
  const featureImportances = FEATURE_NAMES.map((name, i) => ({
    name,
    weight: Math.round(weights[i] * 1000) / 1000,
    absWeight: Math.round(Math.abs(weights[i]) * 1000) / 1000,
  })).sort((a, b) => b.absWeight - a.absWeight);

  const model: LRModel = {
    weights,
    bias,
    normStats,
    trainedAt: new Date().toISOString(),
    trainingSamples: settledCount,
    metrics: {
      trainAcc: Math.round(train.accuracy * 10000) / 10000,
      valAcc:   Math.round(val.accuracy * 10000) / 10000,
      valLoss:  Math.round(val.loss * 10000) / 10000,
      featureImportances,
    },
  };

  saveModel(model);

  // Consume the forceRetrain flag — we just honored it.
  if (forceRetrain) clearForceRetrain();

  console.log(
    `[Trainer] ✓ Retrained in ${Date.now() - t0}ms | ` +
    `samples=${X.length} (train=${XTrain.length}, val=${XVal.length}) | ` +
    `halflife=${halflife}d${forceRetrain ? ' (forced by regime shift)' : ''} | ` +
    `train_acc=${(train.accuracy * 100).toFixed(1)}% val_acc=${(val.accuracy * 100).toFixed(1)}%`
  );
  console.log(
    `[Trainer] Top features: ` +
    featureImportances.slice(0, 5).map(f => `${f.name}(${f.weight > 0 ? '+' : ''}${f.weight})`).join(' | ')
  );

  return true;
}

import fs from 'fs';
import path from 'path';
import db from '../db/database.js';
import {
  extractFeatures, fitNorm, applyNorm, trainLogisticRegression, evaluate,
  FEATURE_NAMES, NUM_FEATURES,
  type LRModel, type RawRow,
} from './logistic-regression.js';

export type { LRModel };

// ─── Config ───────────────────────────────────────────────────────────────────

export const MIN_TRADES_FOR_TRAINING = 50;   // first retrain threshold
export const RETRAIN_EVERY = 25;             // retrain every N new settled trades

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
}

function loadTrainingData(): { X: number[][]; y: number[] } | null {
  const rows = db.prepare(`
    SELECT t.outcome,
           s.obi, s.tfi, s.rsi, s.macd, s.atr,
           s.oi_delta, s.funding_rate, s.spread
    FROM trades t
    JOIN snapshots s ON s.trade_id = t.id
    WHERE t.outcome IS NOT NULL
      AND s.atr IS NOT NULL AND s.atr > 0
      AND s.obi IS NOT NULL
    ORDER BY t.settled_at ASC
  `).all() as DBRow[];

  if (rows.length < MIN_TRADES_FOR_TRAINING) return null;

  const X = rows.map(r => extractFeatures(r));
  const y = rows.map(r => r.outcome === 'UP' ? 1 : 0);

  return { X, y };
}

// ─── Train/val split (time-ordered, no shuffle) ───────────────────────────────

function splitData(X: number[][], y: number[], valFrac = 0.2) {
  const splitIdx = Math.floor(X.length * (1 - valFrac));
  return {
    XTrain: X.slice(0, splitIdx), yTrain: y.slice(0, splitIdx),
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

  // Check if a retrain is due
  const existing = loadModel();
  if (existing) {
    const newSince = settledCount - existing.trainingSamples;
    if (newSince < RETRAIN_EVERY) return false; // not enough new data
  }

  const data = loadTrainingData();
  if (!data) return false;

  const { X, y } = data;
  const { XTrain, yTrain, XVal, yVal } = splitData(X, y);

  // Normalise (fit only on train set to avoid data leakage)
  const normStats = fitNorm(XTrain);
  const XTrainNorm = applyNorm(XTrain, normStats);
  const XValNorm   = applyNorm(XVal,   normStats);

  // Train
  const t0 = Date.now();
  const { weights, bias } = trainLogisticRegression(XTrainNorm, yTrain, {
    lr: 0.1,
    epochs: 1000,
    lambda: 0.01,
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

  console.log(
    `[Trainer] ✓ Retrained in ${Date.now() - t0}ms | ` +
    `samples=${X.length} (train=${XTrain.length}, val=${XVal.length}) | ` +
    `train_acc=${(train.accuracy * 100).toFixed(1)}% val_acc=${(val.accuracy * 100).toFixed(1)}%`
  );
  console.log(
    `[Trainer] Top features: ` +
    featureImportances.slice(0, 5).map(f => `${f.name}(${f.weight > 0 ? '+' : ''}${f.weight})`).join(' | ')
  );

  return true;
}

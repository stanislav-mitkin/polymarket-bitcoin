// Pure TypeScript Logistic Regression — no external dependencies
// Gradient descent with L2 regularisation + feature normalisation

export const FEATURE_NAMES = [
  'obi',
  'tfi',
  'rsi_norm',       // rsi / 100
  'macd_atr',       // macdHist / atr
  'oi_delta_norm',  // oiDelta / 100
  'funding',        // fundingRate (already in %)
  'vol_delta',      // volumeDelta
  'spread',         // bid-ask spread in USD
  'obi_tfi',        // obi × tfi synergy
  'btc_trend_1h',   // BTC return over last 60 min (regime signal)
] as const;

export const NUM_FEATURES = FEATURE_NAMES.length; // 10

export interface NormStats {
  mean: number[];
  std: number[];
}

export interface TrainingMetrics {
  trainAcc: number;
  valAcc: number;
  valLoss: number;
  featureImportances: { name: string; weight: number; absWeight: number }[];
}

export interface LRModel {
  weights: number[];
  bias: number;
  normStats: NormStats;
  trainedAt: string;
  trainingSamples: number;
  metrics: TrainingMetrics;
}

// ── Feature extraction ────────────────────────────────────────────────────────

export interface RawRow {
  obi: number;
  tfi: number;
  rsi: number;
  macd: number;  // this is macdHist in the DB (stored as 'macd' column)
  atr: number;
  oi_delta: number;
  funding_rate: number;
  spread: number;
  volume_delta?: number;
  btc_trend_1h?: number;  // optional — NULL for historical rows before this column existed
}

export function extractFeatures(row: RawRow): number[] {
  const safeAtr = Math.max(row.atr, 1);
  return [
    clamp(row.obi, -1, 1),
    clamp(row.tfi, -1, 1),
    row.rsi / 100,
    clamp(row.macd / safeAtr, -3, 3),
    clamp(row.oi_delta / 100, -1, 1),
    row.funding_rate,
    clamp(row.volume_delta ?? 0, -1, 1),
    Math.min(row.spread, 100),
    clamp(row.obi * row.tfi, -1, 1),
    clamp((row.btc_trend_1h ?? 0) * 20, -1, 1), // scale: ±5% trend → ±1.0
  ];
}

// ── Normalisation ─────────────────────────────────────────────────────────────

export function fitNorm(X: number[][]): NormStats {
  const N = X.length;
  const D = X[0].length;
  const mean = new Array(D).fill(0);
  const std  = new Array(D).fill(0);

  for (const row of X) for (let j = 0; j < D; j++) mean[j] += row[j];
  for (let j = 0; j < D; j++) mean[j] /= N;

  for (const row of X) for (let j = 0; j < D; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / N) || 1e-8;

  return { mean, std };
}

export function applyNorm(X: number[][], stats: NormStats): number[][] {
  return X.map(row => row.map((v, j) => (v - stats.mean[j]) / stats.std[j]));
}

export function normSingle(x: number[], stats: NormStats): number[] {
  return x.map((v, j) => (v - stats.mean[j]) / stats.std[j]);
}

// ── Core math ─────────────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
}

function dot(w: number[], x: number[]): number {
  return w.reduce((s, wi, i) => s + wi * x[i], 0);
}

function binaryCrossEntropy(y: number[], probs: number[]): number {
  const eps = 1e-10;
  return -y.reduce((s, yi, i) => {
    const p = Math.max(eps, Math.min(1 - eps, probs[i]));
    return s + yi * Math.log(p) + (1 - yi) * Math.log(1 - p);
  }, 0) / y.length;
}

// ── Training ──────────────────────────────────────────────────────────────────

export interface TrainOpts {
  lr?: number;               // learning rate  (default 0.1)
  epochs?: number;           // gradient steps (default 1000)
  lambda?: number;           // L2 coefficient (default 0.01)
  sampleWeights?: number[];  // per-sample weights, length = N (default: all 1.0)
  // Early stopping: if XVal/yVal provided, val loss is checked every `evalEvery`
  // epochs. Best weights are kept; training halts after `earlyStoppingPatience`
  // evaluations without improvement. Without val data these are ignored.
  XVal?: number[][];
  yVal?: number[];
  earlyStoppingPatience?: number; // default 20 evaluations
  evalEvery?: number;             // default 10 epochs
}

export interface TrainResult {
  weights: number[];
  bias: number;
  epochsRan: number;
  earlyStopped: boolean;
  bestValLoss: number | null;
}

/**
 * Trains binary logistic regression via gradient descent with L2 regularisation.
 * Optionally accepts `sampleWeights` to weight each training sample — useful for
 * giving recent trades more influence than old ones (market regime adaptation).
 *
 * If val data is supplied, uses early stopping on val loss with best-weight
 * checkpointing. Otherwise runs full `epochs` and returns the final weights.
 */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  opts: TrainOpts = {}
): TrainResult {
  const {
    lr = 0.1,
    epochs = 1000,
    lambda = 0.01,
    sampleWeights,
    XVal,
    yVal,
    earlyStoppingPatience = 20,
    evalEvery = 10,
  } = opts;
  const N = X.length;
  const D = X[0].length;

  const wSample = sampleWeights ?? new Array(N).fill(1);
  const totalWeight = wSample.reduce((s, v) => s + v, 0);

  const w = new Array(D).fill(0);
  let b = 0;

  const canEarlyStop = Array.isArray(XVal) && Array.isArray(yVal) && XVal.length > 0 && yVal.length === XVal.length;
  let bestValLoss: number | null = null;
  let bestW: number[] = w.slice();
  let bestB = b;
  let evaluationsWithoutImprovement = 0;
  let earlyStopped = false;
  let epochsRan = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    epochsRan = epoch + 1;
    const dw = new Array(D).fill(0);
    let db = 0;

    for (let i = 0; i < N; i++) {
      const p = sigmoid(dot(w, X[i]) + b);
      const err = (p - y[i]) * wSample[i]; // weighted error
      for (let j = 0; j < D; j++) dw[j] += err * X[i][j];
      db += err;
    }

    for (let j = 0; j < D; j++) {
      w[j] -= lr * (dw[j] / totalWeight + lambda * w[j]); // gradient + L2
    }
    b -= lr * (db / totalWeight); // bias: no L2 penalty

    if (canEarlyStop && (epoch + 1) % evalEvery === 0) {
      const probs = XVal!.map(x => sigmoid(dot(w, x) + b));
      const valLoss = binaryCrossEntropy(yVal!, probs);

      if (bestValLoss === null || valLoss < bestValLoss - 1e-6) {
        bestValLoss = valLoss;
        bestW = w.slice();
        bestB = b;
        evaluationsWithoutImprovement = 0;
      } else {
        evaluationsWithoutImprovement += 1;
        if (evaluationsWithoutImprovement >= earlyStoppingPatience) {
          earlyStopped = true;
          break;
        }
      }
    }
  }

  if (canEarlyStop && bestValLoss !== null) {
    return { weights: bestW, bias: bestB, epochsRan, earlyStopped, bestValLoss };
  }
  return { weights: w, bias: b, epochsRan, earlyStopped: false, bestValLoss };
}

// ── Inference ─────────────────────────────────────────────────────────────────

/** Returns probability of UP (class 1) — already normalised input */
export function predictProba(weights: number[], bias: number, xNorm: number[]): number {
  return sigmoid(dot(weights, xNorm) + bias);
}

// ── Evaluation ────────────────────────────────────────────────────────────────

export function evaluate(
  weights: number[],
  bias: number,
  X: number[][],
  y: number[]
): { accuracy: number; loss: number } {
  const probs = X.map(x => predictProba(weights, bias, x));
  const preds = probs.map(p => p >= 0.5 ? 1 : 0);
  const accuracy = preds.filter((p, i) => p === y[i]).length / y.length;
  const loss = binaryCrossEntropy(y, probs);
  return { accuracy, loss };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

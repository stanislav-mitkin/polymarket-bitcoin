/**
 * Daily regime-check script.
 *
 * Aggregates trade performance over 7- and 30-day windows, detects regime
 * shifts, and writes data/regime.json — which the bot reads each tick to
 * adjust training halflife, force retrains, or pause trading.
 *
 * Intended cron cadence: once per day (e.g. 05 00 * * *).
 * Safe to run more often — it's a pure read on trades + single-file write.
 *
 * Invocation: `npm run report` or `node dist/scripts/regime-report.js`
 */

import db from '../db/database';
import { saveRegime, type CalibrationBin, type CalibrationReport, type RegimeState } from '../model/regime';

// ── Tunables ──────────────────────────────────────────────────────────────
const DEFAULT_HALFLIFE = 7;             // days — matches trainer.ts baseline
const SHIFTED_HALFLIFE = 3;             // days — aggressive recency when regime shifts
const SHIFT_THRESHOLD_WR = 0.08;        // 8 pp gap between 7d and 30d winrate
const PAUSE_EDGE_THRESHOLD = -0.02;     // realized edge < -2%
const PAUSE_MIN_N = 20;                 // need ≥20 recent trades before pausing
const DAILY_LIMIT = 30;                 // days in the per-day breakdown

// Calibration diagnostics
const CAL_LOOKBACK_TRADES = 100;        // last N live trades used for reliability diagram
const CAL_BIN_EDGES = [0.55, 0.60, 0.65, 0.70, 0.75, 0.85, 1.0]; // inclusive-exclusive pairs
const CAL_MIN_N_PER_BIN = 8;            // ignore bins with <N samples (noise)
const CAL_MIN_TOTAL_N = 30;             // skip calibration entirely below this
const CAL_DRIFT_THRESHOLD = 0.10;       // pause if any bin predicts 10pp too high

// ── DB rows ───────────────────────────────────────────────────────────────
interface AggRow {
  n: number;
  wins: number | null;
  total_pnl: number | null;
  avg_breakeven: number | null;
}

interface DayRow {
  day: string;
  n: number;
  wr: number | null;
  pnl: number | null;
  avg_edge: number | null;
}

// ── Aggregation ───────────────────────────────────────────────────────────

function aggregateLastDays(days: number): AggRow {
  return db.prepare(`
    SELECT
      COUNT(*)                                                                AS n,
      SUM(CASE WHEN outcome = signal THEN 1 ELSE 0 END)                       AS wins,
      COALESCE(SUM(pnl), 0)                                                   AS total_pnl,
      AVG(CASE WHEN signal = 'UP' THEN price_yes ELSE price_no END)           AS avg_breakeven
    FROM trades
    WHERE outcome IS NOT NULL
      AND edge IS NOT NULL
      AND datetime(settled_at) >= datetime('now', ?)
  `).get(`-${days} days`) as AggRow;
}

function perDayBreakdown(limit: number): DayRow[] {
  return db.prepare(`
    SELECT strftime('%Y-%m-%d', settled_at) AS day,
           COUNT(*)                                                            AS n,
           ROUND(AVG(CASE WHEN outcome = signal THEN 1.0 ELSE 0.0 END) * 100, 1) AS wr,
           ROUND(SUM(pnl), 2)                                                  AS pnl,
           ROUND(AVG(edge) * 100, 1)                                           AS avg_edge
    FROM trades
    WHERE outcome IS NOT NULL AND edge IS NOT NULL
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `).all(limit) as DayRow[];
}

// ── Calibration ───────────────────────────────────────────────────────────

interface CalRow {
  confidence: number;
  won: number;  // 0/1
}

function loadRecentLiveCalibrationRows(limit: number): CalRow[] {
  // Only live, filled trades — paper is frictionless, FAILED/REJECTED have no
  // position. Using `outcome = signal` as the win indicator handles both UP
  // and DOWN bets; PUSH is excluded because it doesn't test directional skill.
  return db.prepare(`
    SELECT confidence,
           CASE WHEN outcome = signal THEN 1 ELSE 0 END AS won
    FROM trades
    WHERE mode = 'live'
      AND outcome IS NOT NULL
      AND outcome IN ('UP', 'DOWN')
      AND UPPER(COALESCE(live_status, '')) IN ('MATCHED', 'FILLED')
      AND confidence IS NOT NULL
    ORDER BY datetime(settled_at) DESC, id DESC
    LIMIT ?
  `).all(limit) as CalRow[];
}

function computeCalibration(): CalibrationReport | null {
  const rows = loadRecentLiveCalibrationRows(CAL_LOOKBACK_TRADES);
  if (rows.length < CAL_MIN_TOTAL_N) return null;

  const bins: CalibrationBin[] = [];
  let worstBinShift = 0;

  for (let i = 0; i < CAL_BIN_EDGES.length - 1; i++) {
    const lo = CAL_BIN_EDGES[i];
    const hi = CAL_BIN_EDGES[i + 1];
    const inBin = rows.filter(r => r.confidence >= lo && r.confidence < hi);
    const n = inBin.length;
    const predicted = n > 0 ? inBin.reduce((s, r) => s + r.confidence, 0) / n : null;
    const actual = n > 0 ? inBin.reduce((s, r) => s + r.won, 0) / n : null;

    bins.push({ lo, hi, n, predicted, actual });

    // Only count shifts where prediction > actual (overconfidence) and bin has
    // enough samples. Under-confidence is a smaller concern — we lose upside
    // but don't over-bet on bad signals.
    if (n >= CAL_MIN_N_PER_BIN && predicted !== null && actual !== null) {
      const shift = predicted - actual;
      if (shift > worstBinShift) worstBinShift = shift;
    }
  }

  return {
    n: rows.length,
    bins,
    worstBinShift: Math.round(worstBinShift * 10000) / 10000,
    driftDetected: worstBinShift > CAL_DRIFT_THRESHOLD,
  };
}

// ── Regime logic ──────────────────────────────────────────────────────────

function computeRegime(): RegimeState {
  const a7  = aggregateLastDays(7);
  const a30 = aggregateLastDays(30);
  const calibration = computeCalibration();

  const wr7d  = a7.n  > 0 ? (a7.wins  ?? 0) / a7.n  : null;
  const wr30d = a30.n > 0 ? (a30.wins ?? 0) / a30.n : null;

  const realizedEdge7d = wr7d !== null && a7.avg_breakeven !== null
    ? wr7d - a7.avg_breakeven
    : null;

  // Shift detection: meaningful gap between short- and long-window winrate.
  // Requires enough data in both windows to avoid noise from 2-3 trades.
  const shiftDetected = (
    wr7d  !== null && wr30d !== null &&
    a7.n >= 10 && a30.n >= 25 &&
    Math.abs(wr7d - wr30d) > SHIFT_THRESHOLD_WR
  );

  // Pause trading when losing money over enough samples OR when calibration
  // drift indicates the model's confidence no longer matches reality (i.e.
  // posted edge is mirage). Either condition → pause + force retrain.
  const calibrationDrift = calibration?.driftDetected === true;
  const pauseTrading = (
    (realizedEdge7d !== null && a7.n >= PAUSE_MIN_N && realizedEdge7d < PAUSE_EDGE_THRESHOLD) ||
    calibrationDrift
  );

  const recommendedHalflife = (shiftDetected || calibrationDrift) ? SHIFTED_HALFLIFE : DEFAULT_HALFLIFE;

  const reasons: string[] = [];
  if (shiftDetected)  reasons.push(`shift Δwr=${((wr7d! - wr30d!) * 100).toFixed(1)}pp`);
  if (realizedEdge7d !== null && a7.n >= PAUSE_MIN_N && realizedEdge7d < PAUSE_EDGE_THRESHOLD) {
    reasons.push(`pause edge7d=${(realizedEdge7d * 100).toFixed(1)}%`);
  }
  if (calibrationDrift) {
    reasons.push(`calibration-drift=${(calibration!.worstBinShift * 100).toFixed(1)}pp`);
  }
  if (reasons.length === 0) reasons.push('stable');

  return {
    updatedAt: new Date().toISOString(),
    n7d: a7.n, n30d: a30.n,
    wr7d, wr30d,
    realizedEdge7d,
    totalPnl7d: Math.round((a7.total_pnl ?? 0) * 100) / 100,
    shiftDetected,
    recommendedHalflife,
    forceRetrain: shiftDetected || calibrationDrift, // both conditions warrant immediate retrain
    pauseTrading,
    reason: reasons.join(' | '),
    calibration: calibration ?? null,
  };
}

// ── Pretty-print ──────────────────────────────────────────────────────────

function printReport(state: RegimeState, days: DayRow[]): void {
  const pct = (v: number | null, digits = 1) =>
    v === null ? '   —  ' : `${(v * 100).toFixed(digits).padStart(5)}%`;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Regime report — ${state.updatedAt}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Last 7d:   n=${state.n7d.toString().padStart(3)}  wr=${pct(state.wr7d)}  realized_edge=${pct(state.realizedEdge7d)}  pnl=$${state.totalPnl7d.toFixed(2)}`);
  console.log(`  Last 30d:  n=${state.n30d.toString().padStart(3)}  wr=${pct(state.wr30d)}`);
  console.log(`  Shift detected:      ${state.shiftDetected ? 'YES' : 'no'}`);
  console.log(`  Pause trading:       ${state.pauseTrading ? 'YES' : 'no'}`);
  console.log(`  Halflife (days):     ${state.recommendedHalflife}`);
  console.log(`  Force retrain:       ${state.forceRetrain ? 'YES' : 'no'}`);
  console.log(`  Reason:              ${state.reason}`);

  if (state.calibration) {
    const c = state.calibration;
    console.log('');
    console.log(`  Calibration (last ${c.n} live):  worst overconfidence=${(c.worstBinShift * 100).toFixed(1)}pp  drift=${c.driftDetected ? 'YES' : 'no'}`);
    console.log('  bin          n    predicted  actual  Δ');
    console.log('  ──────────  ───  ─────────  ──────  ─────');
    for (const b of c.bins) {
      if (b.n === 0) continue;
      const deltaStr = (b.predicted !== null && b.actual !== null)
        ? `${((b.predicted - b.actual) * 100).toFixed(1).padStart(5)}pp`
        : '   —  ';
      console.log(
        `  [${b.lo.toFixed(2)}, ${b.hi.toFixed(2)})  ${b.n.toString().padStart(3)}  ` +
        `${b.predicted !== null ? (b.predicted * 100).toFixed(1).padStart(8) + '%' : '     —  '}  ` +
        `${b.actual !== null ? (b.actual * 100).toFixed(1).padStart(5) + '%' : '   —  '}  ${deltaStr}`
      );
    }
  }

  if (days.length > 0) {
    console.log('');
    console.log('  Per-day (last ' + days.length + ' days):');
    console.log('  day          n    wr    pnl    avg_edge');
    console.log('  ──────────  ───  ─────  ─────  ────────');
    for (const d of days) {
      console.log(
        `  ${d.day}  ${d.n.toString().padStart(3)}  ` +
        `${(d.wr ?? 0).toFixed(1).padStart(5)}  ` +
        `${(d.pnl ?? 0).toFixed(2).padStart(5)}  ` +
        `${(d.avg_edge ?? 0).toFixed(1).padStart(6)}%`
      );
    }
  }
  console.log('═══════════════════════════════════════════════════════════');
}

// ── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const state = computeRegime();
  const days  = perDayBreakdown(DAILY_LIMIT);

  // Preserve an existing forceRetrain flag if trainer hasn't consumed it yet.
  // (Without this, two consecutive reports before a retrain would flip it back.)
  // Done by OR-ing: if old was true AND we haven't had a retrain since, keep it.
  // Trainer clears the flag explicitly via clearForceRetrain() after using it.
  // Here we simply trust the new value — if report says "shift", set it; otherwise
  // a prior pending retrain stays as-is only if the shift condition still holds.

  saveRegime(state);
  printReport(state, days);
}

main();

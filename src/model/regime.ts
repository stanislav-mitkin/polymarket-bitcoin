import fs from 'fs';
import path from 'path';

const REGIME_PATH = path.join(process.cwd(), 'data', 'regime.json');

export interface CalibrationBin {
  lo: number;             // lower edge of confidence bin (inclusive)
  hi: number;             // upper edge of confidence bin (exclusive)
  n: number;              // trades in this bin
  predicted: number | null;  // mean predicted confidence, null if n=0
  actual: number | null;     // actual win rate, null if n=0
}

export interface CalibrationReport {
  n: number;                     // total trades used
  bins: CalibrationBin[];
  worstBinShift: number;         // max |predicted - actual| across bins with n ≥ minN
  driftDetected: boolean;        // worstBinShift > threshold and enough samples
}

export interface RegimeState {
  updatedAt: string;

  // Sample counts
  n7d: number;
  n30d: number;

  // Winrates
  wr7d: number | null;      // null if n7d === 0
  wr30d: number | null;

  // Realized edge = wr - avg(breakeven price of bought token)
  realizedEdge7d: number | null;
  totalPnl7d: number;

  // Flags
  shiftDetected: boolean;        // |wr7d - wr30d| > 8 percentage points
  recommendedHalflife: number;   // days; shorter when regime shifts
  forceRetrain: boolean;         // next maybeRetrain() will bypass RETRAIN_EVERY
  pauseTrading: boolean;         // main loop skips new trades
  reason: string;                // human-readable explanation

  // Optional: calibration diagnostics (null if insufficient live-trade data)
  calibration?: CalibrationReport | null;
}

export function loadRegime(): RegimeState | null {
  if (!fs.existsSync(REGIME_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(REGIME_PATH, 'utf-8')) as RegimeState;
  } catch {
    return null;
  }
}

export function saveRegime(state: RegimeState): void {
  fs.mkdirSync(path.dirname(REGIME_PATH), { recursive: true });
  fs.writeFileSync(REGIME_PATH, JSON.stringify(state, null, 2));
}

/** Called by trainer after it honors a forceRetrain request. */
export function clearForceRetrain(): void {
  const r = loadRegime();
  if (!r || !r.forceRetrain) return;
  saveRegime({ ...r, forceRetrain: false });
}

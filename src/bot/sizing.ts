import type { RiskConfig } from '../config/trading';

export interface SizingInput {
  bankrollUsdc: number;
  consecutiveLosses: number;
  confidence: number;   // predictor confidence in [0, 1] — probability of our chosen side
  edge: number;         // confidence - breakeven, fraction in [0, 1]
}

export interface SizingResult {
  sizeUsdc: number;
  kellyFraction: number;
  baseSize: number;
  dampening: number;
}

/**
 * Dynamic position sizing for binary-outcome markets.
 *
 * Uses half-Kelly on the model's predicted probability to scale the base
 * position fraction, then dampens by consecutive losses to protect against
 * gambler's ruin during bad streaks. Result is clamped to [min, max] so a
 * tiny bankroll or extreme confidence can't break Polymarket's min-order
 * size or exceed a single-trade cap.
 *
 * For a binary outcome priced near 0.50, optimal Kelly ≈ (2p - 1). We use
 * half-Kelly (0.5x) as the canonical safety margin against overbetting from
 * model estimation error — the model's p is itself noisy.
 */
export function computePositionSize(input: SizingInput, risk: RiskConfig): SizingResult {
  const { bankrollUsdc, consecutiveLosses, confidence } = input;

  const kellyFraction = Math.max(0, 2 * confidence - 1); // 0 when p ≤ 0.5
  const kellyScale = Math.min(kellyFraction * 0.5, 1);   // half-Kelly, capped at 1

  const baseSize = Math.max(0, bankrollUsdc) * risk.basePositionPct * kellyScale;

  // Dampen by consecutive losses, floor at 20% so we never fully zero out
  // (that would block recovery even when the signal is strong).
  const dampening = Math.max(0.2, 1 - consecutiveLosses * risk.lossDampFactor);
  const dampened = baseSize * dampening;

  const clamped = clamp(dampened, risk.minPositionUsdc, risk.maxPositionUsdc);

  return {
    sizeUsdc: round2(clamped),
    kellyFraction,
    baseSize: round2(baseSize),
    dampening,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

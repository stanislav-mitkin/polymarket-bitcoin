export type TradingMode = 'paper' | 'live';

export interface TradingConfig {
  mode: TradingMode;
  tradeSizeUsdc: number;
  live: LiveTradingConfig;
  risk: RiskConfig;
}

export interface LiveTradingConfig {
  enabled: boolean;
  dryRun: boolean;
  host: string;
  chainId: 137 | 80002;
  privateKey?: string;
  signatureType?: 0 | 1 | 2;
  funderAddress?: string;
  expectedSignerAddress?: string;
  maxBuyPriceImpact: number;
  minOrderSizeBufferPct: number;
}

export interface RiskConfig {
  maxOpenPositions: number;
  maxDailyLossUsdc: number;
  maxConsecutiveLosses: number;
  maxConsecutiveTickErrors: number;
}

const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com';

export function loadTradingConfig(): TradingConfig {
  const mode = parseMode(process.env.TRADING_MODE);
  const tradeSizeUsdc = parsePositiveNumber(process.env.TRADE_SIZE_USDC, 10, 'TRADE_SIZE_USDC');
  const chainId = parseChainId(process.env.POLY_CHAIN_ID);

  const live: LiveTradingConfig = {
    enabled: mode === 'live',
    dryRun: parseBoolean(process.env.LIVE_DRY_RUN, true),
    host: process.env.POLY_CLOB_HOST?.trim() || DEFAULT_CLOB_HOST,
    chainId,
    privateKey: sanitizeOptional(process.env.POLY_PRIVATE_KEY),
    signatureType: parseOptionalSignatureType(process.env.POLY_SIGNATURE_TYPE),
    funderAddress: sanitizeOptional(process.env.POLY_FUNDER_ADDRESS),
    expectedSignerAddress: sanitizeOptional(process.env.POLY_EXPECTED_SIGNER_ADDRESS),
    maxBuyPriceImpact: parsePositiveNumber(process.env.LIVE_MAX_BUY_PRICE_IMPACT, 0.03, 'LIVE_MAX_BUY_PRICE_IMPACT'),
    minOrderSizeBufferPct: parsePositiveNumber(process.env.LIVE_MIN_ORDER_BUFFER_PCT, 0.05, 'LIVE_MIN_ORDER_BUFFER_PCT'),
  };
  const risk: RiskConfig = {
    maxOpenPositions: parsePositiveInteger(process.env.MAX_OPEN_POSITIONS, 1, 'MAX_OPEN_POSITIONS'),
    maxDailyLossUsdc: parsePositiveNumber(process.env.MAX_DAILY_LOSS_USDC, 5, 'MAX_DAILY_LOSS_USDC'),
    maxConsecutiveLosses: parsePositiveInteger(process.env.MAX_CONSECUTIVE_LOSSES, 4, 'MAX_CONSECUTIVE_LOSSES'),
    maxConsecutiveTickErrors: parsePositiveInteger(process.env.MAX_CONSECUTIVE_TICK_ERRORS, 5, 'MAX_CONSECUTIVE_TICK_ERRORS'),
  };

  if (mode === 'live') validateLiveConfig(live);

  return { mode, tradeSizeUsdc, live, risk };
}

function parseMode(raw: string | undefined): TradingMode {
  const value = (raw ?? 'paper').trim().toLowerCase();
  if (value === 'paper' || value === 'live') return value;
  throw new Error(`Invalid TRADING_MODE="${raw}". Use "paper" or "live".`);
}

function parseChainId(raw: string | undefined): 137 | 80002 {
  if (!raw || raw.trim() === '') return 137;
  const value = Number(raw);
  if (value === 137 || value === 80002) return value;
  throw new Error(`Invalid POLY_CHAIN_ID="${raw}". Supported: 137 (Polygon) or 80002 (Amoy).`);
}

function parseOptionalSignatureType(raw: string | undefined): 0 | 1 | 2 | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (value === 0 || value === 1 || value === 2) return value;
  throw new Error(`Invalid POLY_SIGNATURE_TYPE="${raw}". Supported: 0, 1, or 2.`);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`Invalid boolean value "${raw}".`);
}

function parsePositiveNumber(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${envName}="${raw}". Expected a positive number.`);
  }
  return value;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${envName}="${raw}". Expected a positive integer.`);
  }
  return value;
}

function sanitizeOptional(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function validateLiveConfig(config: LiveTradingConfig): void {
  const missing: string[] = [];

  if (!config.privateKey) missing.push('POLY_PRIVATE_KEY');
  if (config.signatureType === undefined) missing.push('POLY_SIGNATURE_TYPE');
  if (!config.funderAddress) missing.push('POLY_FUNDER_ADDRESS');
  if (!config.expectedSignerAddress) missing.push('POLY_EXPECTED_SIGNER_ADDRESS');

  if (missing.length > 0) {
    throw new Error(
      `TRADING_MODE=live requires: ${missing.join(', ')}`
    );
  }
}

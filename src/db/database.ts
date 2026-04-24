import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'trades.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    market_id     TEXT NOT NULL,
    market_end    TEXT NOT NULL,
    signal        TEXT NOT NULL CHECK (signal IN ('UP', 'DOWN')),
    confidence    REAL NOT NULL,
    edge          REAL,
    mode          TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
    live_order_id TEXT,
    live_status   TEXT,
    live_error    TEXT,
    requested_price REAL,
    requested_size  REAL,
    filled_price    REAL,
    filled_size     REAL,
    fees_usdc       REAL,
    live_updated_at TEXT,
    price_yes     REAL NOT NULL,
    price_no      REAL NOT NULL,
    size_usdc     REAL NOT NULL DEFAULT 10,
    outcome       TEXT CHECK (outcome IN ('UP', 'DOWN')),
    pnl           REAL,
    settled_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id        INTEGER NOT NULL REFERENCES trades(id),
    obi             REAL,
    tfi             REAL,
    spread          REAL,
    funding_rate    REAL,
    oi_delta        REAL,
    rsi             REAL,
    macd            REAL,
    atr             REAL,
    volume_delta    REAL,
    btc_trend_1h    REAL,
    btc_price       REAL
  );
`);

// Schema migrations — ALTER TABLE ADD COLUMN is idempotent-safe via try/catch
try { db.exec('ALTER TABLE trades ADD COLUMN edge REAL'); } catch (_) {}
try { db.exec(`ALTER TABLE trades ADD COLUMN mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live'))`); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN live_order_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN live_status TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN live_error TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN requested_price REAL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN requested_size REAL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN filled_price REAL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN filled_size REAL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN fees_usdc REAL'); } catch (_) {}
try { db.exec('ALTER TABLE trades ADD COLUMN live_updated_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE snapshots ADD COLUMN volume_delta REAL'); } catch (_) {}
try { db.exec('ALTER TABLE snapshots ADD COLUMN btc_trend_1h REAL'); } catch (_) {}

// Migration: rebuild trades to widen outcome CHECK to include 'PUSH'.
// SQLite cannot ALTER CHECK in place; use PRAGMA user_version as a guard and
// extra schema checks so partial/older states don't crash at startup.
const SCHEMA_VERSION = 1;
{
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const currentVersion = row?.user_version ?? 0;
  const tradesSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='trades'`
  ).get() as { sql?: string } | undefined;
  const hasPushOutcome = (tradesSql?.sql ?? '').includes(`'PUSH'`);

  if (currentVersion < SCHEMA_VERSION && hasPushOutcome) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (currentVersion < SCHEMA_VERSION) {
    const hasTrades = tableExists('trades');
    const hasTradesOld = tableExists('trades_old');
    if (!hasTrades && !hasTradesOld) {
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else {
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        // Keep a stable source table for copy, regardless of partial past runs.
        if (!hasTradesOld && hasTrades) {
          db.exec('ALTER TABLE trades RENAME TO trades_old');
        }

        db.exec(`
          DROP TABLE IF EXISTS trades_new;
          CREATE TABLE trades_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            market_id     TEXT NOT NULL,
            market_end    TEXT NOT NULL,
            signal        TEXT NOT NULL CHECK (signal IN ('UP', 'DOWN')),
            confidence    REAL NOT NULL,
            edge          REAL,
            mode          TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
            live_order_id TEXT,
            live_status   TEXT,
            live_error    TEXT,
            requested_price REAL,
            requested_size  REAL,
            filled_price    REAL,
            filled_size     REAL,
            fees_usdc       REAL,
            live_updated_at TEXT,
            price_yes     REAL NOT NULL,
            price_no      REAL NOT NULL,
            size_usdc     REAL NOT NULL DEFAULT 10,
            outcome       TEXT CHECK (outcome IN ('UP', 'DOWN', 'PUSH')),
            pnl           REAL,
            settled_at    TEXT
          );
        `);

        const source = tableExists('trades_old') ? 'trades_old' : 'trades';
        db.exec(`
          INSERT INTO trades_new (
            id, created_at, market_id, market_end, signal, confidence, edge,
            mode, live_order_id, live_status, live_error,
            requested_price, requested_size, filled_price, filled_size, fees_usdc, live_updated_at,
            price_yes, price_no, size_usdc, outcome, pnl, settled_at
          )
          SELECT
            id, created_at, market_id, market_end, signal, confidence, edge,
            mode, live_order_id, live_status, live_error,
            requested_price, requested_size, filled_price, filled_size, fees_usdc, live_updated_at,
            price_yes, price_no, size_usdc, outcome, pnl, settled_at
          FROM ${source};
        `);

        db.exec(`
          DROP TABLE IF EXISTS trades;
          ALTER TABLE trades_new RENAME TO trades;
          DROP TABLE IF EXISTS trades_old;
        `);

        db.pragma(`user_version = ${SCHEMA_VERSION}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_trades_outcome_market_end ON trades(outcome, market_end);
  CREATE INDEX IF NOT EXISTS idx_trades_mode_status ON trades(mode, live_status);
  CREATE INDEX IF NOT EXISTS idx_trades_settled_at ON trades(settled_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_trades_market_mode ON trades(market_id, mode);
`);

export interface Trade {
  id?: number;
  created_at?: string;
  market_id: string;
  market_end: string;
  signal: 'UP' | 'DOWN';
  confidence: number;
  edge?: number | null;
  mode: 'paper' | 'live';
  live_order_id?: string | null;
  live_status?: string | null;
  live_error?: string | null;
  requested_price?: number | null;
  requested_size?: number | null;
  filled_price?: number | null;
  filled_size?: number | null;
  fees_usdc?: number | null;
  live_updated_at?: string | null;
  price_yes: number;
  price_no: number;
  size_usdc: number;
  outcome?: 'UP' | 'DOWN' | 'PUSH' | null;
  pnl?: number | null;
  settled_at?: string | null;
}

export interface Snapshot {
  trade_id: number;
  obi?: number;
  tfi?: number;
  spread?: number;
  funding_rate?: number;
  oi_delta?: number;
  rsi?: number;
  macd?: number;
  atr?: number;
  volume_delta?: number;
  btc_trend_1h?: number;
  btc_price?: number;
}

export interface TradeStats {
  total: number;
  settled: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  roi_pct: number;
  avg_confidence: number;
}

const insertTrade = db.prepare<Trade>(`
  INSERT INTO trades (
    market_id, market_end, signal, confidence, edge,
    mode, live_order_id, live_status, live_error, requested_price, requested_size, filled_price, filled_size, fees_usdc, live_updated_at,
    price_yes, price_no, size_usdc
  )
  VALUES (
    @market_id, @market_end, @signal, @confidence, @edge,
    @mode, @live_order_id, @live_status, @live_error, @requested_price, @requested_size, @filled_price, @filled_size, @fees_usdc, @live_updated_at,
    @price_yes, @price_no, @size_usdc
  )
`);

const insertSnapshot = db.prepare<Snapshot>(`
  INSERT INTO snapshots (trade_id, obi, tfi, spread, funding_rate, oi_delta, rsi, macd, atr, volume_delta, btc_trend_1h, btc_price)
  VALUES (@trade_id, @obi, @tfi, @spread, @funding_rate, @oi_delta, @rsi, @macd, @atr, @volume_delta, @btc_trend_1h, @btc_price)
`);

const settleTrade = db.prepare<{ outcome: 'UP' | 'DOWN' | 'PUSH'; pnl: number; id: number }>(`
  UPDATE trades SET outcome = @outcome, pnl = @pnl, settled_at = datetime('now')
  WHERE id = @id
`);

const getTradeByIdStmt = db.prepare('SELECT * FROM trades WHERE id = ? LIMIT 1');
const updateTradePnlStmt = db.prepare<{ id: number; pnl: number }>(`
  UPDATE trades SET pnl = @pnl WHERE id = @id
`);

export function saveTrade(trade: Trade, snapshot: Omit<Snapshot, 'trade_id'>): number {
  if (trade.mode !== 'paper' && trade.mode !== 'live') {
    throw new Error(`saveTrade: 'mode' is required (paper|live), got ${String(trade.mode)}`);
  }
  const result = insertTrade.run({
    edge: null,
    live_order_id: null,
    live_status: null,
    live_error: null,
    requested_price: null,
    requested_size: null,
    filled_price: null,
    filled_size: null,
    fees_usdc: null,
    live_updated_at: null,
    ...trade,
  });
  const tradeId = result.lastInsertRowid as number;
  insertSnapshot.run({ trade_id: tradeId, ...snapshot });
  return tradeId;
}

export interface SettlementResult {
  pnl: number;
  won: boolean;
  mode: 'paper' | 'live';
  entryPrice: number;
  shares: number;
  costUsdc: number;
  feesUsdc: number;
}

export function settleTradeById(id: number, outcome: 'UP' | 'DOWN' | 'PUSH'): SettlementResult {
  const trade = getTradeByIdStmt.get(id) as Trade | undefined;
  if (!trade) throw new Error(`Trade not found: id=${id}`);

  const result = computeSettlement(trade, outcome);
  settleTrade.run({ outcome, pnl: result.pnl, id });
  return result;
}

export function recomputeSettledTradePnlById(id: number): SettlementResult | null {
  const trade = getTradeByIdStmt.get(id) as Trade | undefined;
  if (!trade || !trade.outcome) return null;
  const result = computeSettlement(trade, trade.outcome);
  updateTradePnlStmt.run({ id, pnl: result.pnl });
  return result;
}

export function hasTradeForMarket(marketId: string): boolean {
  const row = db.prepare('SELECT 1 FROM trades WHERE market_id = ? LIMIT 1').get(marketId);
  return row != null;
}

export function countOpenTrades(): number {
  // Exclude live rows that never resulted in an active position so a streak of
  // rejects can't permanently block new trades via the maxOpenPositions gate.
  const row = db.prepare(
    `
      SELECT COUNT(*) AS n FROM trades
      WHERE outcome IS NULL
        AND (
          mode = 'paper'
          OR live_status IS NULL
          OR upper(live_status) NOT IN ('FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'DRY_RUN')
        )
    `
  ).get() as { n: number };
  return row.n ?? 0;
}

export function getDailyRealizedPnl(): number {
  const row = db.prepare(
    `SELECT ROUND(COALESCE(SUM(pnl), 0), 6) AS pnl FROM trades WHERE settled_at IS NOT NULL AND date(settled_at) = date('now')`
  ).get() as { pnl: number | null };
  return row.pnl ?? 0;
}

export function getConsecutiveLosses(): number {
  // Count backwards from the most recent settled trade until a non-loss breaks
  // the streak. Using pnl (rather than signal == outcome) handles: PUSH (fees
  // only, pnl ≤ 0 but not a directional loss), partial fills on live trades
  // (pnl scales with filled_size), and any future outcome variants.
  const rows = db.prepare(
    `SELECT pnl FROM trades WHERE outcome IS NOT NULL AND pnl IS NOT NULL
     ORDER BY datetime(settled_at) DESC, id DESC LIMIT 200`
  ).all() as Array<{ pnl: number }>;

  let losses = 0;
  for (const row of rows) {
    if (row.pnl >= 0) break; // wins and PUSH-with-zero-fees stop the streak
    losses += 1;
  }
  return losses;
}

export function getLiveCumulativePnl(sinceIso?: string | null): number {
  if (sinceIso) {
    const row = db.prepare(
      `SELECT ROUND(COALESCE(SUM(pnl), 0), 6) AS pnl FROM trades
       WHERE mode = 'live' AND outcome IS NOT NULL AND pnl IS NOT NULL
         AND settled_at IS NOT NULL
         AND datetime(settled_at) > datetime(?)`
    ).get(sinceIso) as { pnl: number | null };
    return row.pnl ?? 0;
  }
  const row = db.prepare(
    `SELECT ROUND(COALESCE(SUM(pnl), 0), 6) AS pnl FROM trades
     WHERE mode = 'live' AND outcome IS NOT NULL AND pnl IS NOT NULL`
  ).get() as { pnl: number | null };
  return row.pnl ?? 0;
}

export function getLiveBankroll(initialUsdc: number, sinceIso?: string | null): number {
  return initialUsdc + getLiveCumulativePnl(sinceIso);
}

export type LiveTradeReconcileRow = Pick<
  Trade,
  'id' | 'market_id' | 'live_order_id' | 'live_status' | 'mode' | 'outcome'
>;

export function getLiveTradesToReconcile(limit = 30): LiveTradeReconcileRow[] {
  return db.prepare(
    `
      SELECT id, market_id, live_order_id, live_status, mode, outcome
      FROM trades
      WHERE
        mode = 'live'
        AND outcome IS NULL
        AND live_order_id IS NOT NULL
        AND (
          live_status IS NULL OR upper(live_status) NOT IN ('FILLED', 'CANCELED', 'CANCELLED', 'REJECTED', 'FAILED')
        )
      ORDER BY created_at DESC
      LIMIT ?
    `
  ).all(limit) as LiveTradeReconcileRow[];
}

export function updateLiveTradeMetaById(
  id: number,
  patch: {
    live_order_id?: string | null;
    live_status?: string | null;
    live_error?: string | null;
    filled_price?: number | null;
    filled_size?: number | null;
    fees_usdc?: number | null;
  }
): void {
  db.prepare(
    `
      UPDATE trades
      SET
        live_order_id = COALESCE(@live_order_id, live_order_id),
        live_status = COALESCE(@live_status, live_status),
        live_error = COALESCE(@live_error, live_error),
        filled_price = COALESCE(@filled_price, filled_price),
        filled_size = COALESCE(@filled_size, filled_size),
        fees_usdc = COALESCE(@fees_usdc, fees_usdc),
        live_updated_at = datetime('now')
      WHERE id = @id
    `
  ).run({
    id,
    live_order_id: patch.live_order_id ?? null,
    live_status: patch.live_status ?? null,
    live_error: patch.live_error ?? null,
    filled_price: patch.filled_price ?? null,
    filled_size: patch.filled_size ?? null,
    fees_usdc: patch.fees_usdc ?? null,
  });
}

function computeSettlement(trade: Trade, outcome: 'UP' | 'DOWN' | 'PUSH'): SettlementResult {
  const mode: 'paper' | 'live' = trade.mode === 'live' ? 'live' : 'paper';

  if (outcome === 'PUSH') {
    const fallbackEntryPrice = trade.signal === 'UP' ? trade.price_yes : trade.price_no;
    const entryPrice = positiveOrNull(trade.filled_price)
      ?? positiveOrNull(trade.requested_price)
      ?? fallbackEntryPrice;
    const shares = positiveOrNull(trade.filled_size)
      ?? positiveOrNull(trade.requested_size)
      ?? (trade.size_usdc / Math.max(entryPrice, 0.0001));
    const feesUsdc = Math.max(0, trade.fees_usdc ?? 0);
    return {
      pnl: -round2(feesUsdc),
      won: false,
      mode,
      entryPrice,
      shares: round6(shares),
      costUsdc: round6(shares * entryPrice),
      feesUsdc: round6(feesUsdc),
    };
  }

  const won = outcome === trade.signal;

  if (mode === 'paper') {
    const entryPrice = trade.signal === 'UP' ? trade.price_yes : trade.price_no;
    const pnlRaw = won
      ? trade.size_usdc * (1 - entryPrice)
      : -trade.size_usdc * entryPrice;

    return {
      pnl: round2(pnlRaw),
      won,
      mode,
      entryPrice,
      shares: trade.size_usdc,
      costUsdc: trade.size_usdc * entryPrice,
      feesUsdc: 0,
    };
  }

  const fallbackEntryPrice = trade.signal === 'UP' ? trade.price_yes : trade.price_no;
  const entryPrice = positiveOrNull(trade.filled_price)
    ?? positiveOrNull(trade.requested_price)
    ?? fallbackEntryPrice;

  const shares = positiveOrNull(trade.filled_size)
    ?? positiveOrNull(trade.requested_size)
    ?? (trade.size_usdc / Math.max(entryPrice, 0.0001));

  const costUsdc = shares * entryPrice;
  const feesUsdc = Math.max(0, trade.fees_usdc ?? 0);
  const pnlRaw = won
    ? shares - costUsdc - feesUsdc
    : -costUsdc - feesUsdc;

  return {
    pnl: round2(pnlRaw),
    won,
    mode,
    entryPrice,
    shares: round6(shares),
    costUsdc: round6(costUsdc),
    feesUsdc: round6(feesUsdc),
  };
}

function positiveOrNull(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

export function getUnsettledTrades(): Trade[] {
  return db.prepare(`
    SELECT * FROM trades WHERE outcome IS NULL AND datetime(market_end) < datetime('now')
  `).all() as Trade[];
}

export function getStats(): TradeStats {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(outcome)                                    AS settled,
      SUM(CASE WHEN outcome = signal THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome IS NOT NULL AND outcome != signal THEN 1 ELSE 0 END) AS losses,
      ROUND(AVG(confidence), 4)                         AS avg_confidence,
      ROUND(SUM(COALESCE(pnl, 0)), 2)                   AS total_pnl,
      SUM(size_usdc)                                    AS total_wagered
    FROM trades
    WHERE mode = 'paper'
  `).get() as any;

  const winRate = row.settled > 0 ? Math.round((row.wins / row.settled) * 10000) / 100 : 0;
  const roi = row.total_wagered > 0 ? Math.round((row.total_pnl / row.total_wagered) * 10000) / 100 : 0;

  return {
    total: row.total,
    settled: row.settled,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    win_rate: winRate,
    total_pnl: row.total_pnl ?? 0,
    roi_pct: roi,
    avg_confidence: row.avg_confidence ?? 0,
  };
}

export function getLiveStats(): TradeStats {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(outcome)                                    AS settled,
      SUM(CASE WHEN outcome = signal THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome IS NOT NULL AND outcome != signal THEN 1 ELSE 0 END) AS losses,
      ROUND(AVG(confidence), 4)                         AS avg_confidence,
      ROUND(SUM(COALESCE(pnl, 0)), 2)                   AS total_pnl,
      SUM(COALESCE(filled_price, size_usdc) * COALESCE(filled_size, 1)) AS total_wagered
    FROM trades
    WHERE mode = 'live'
      AND UPPER(COALESCE(live_status, '')) IN ('MATCHED', 'FILLED')
  `).get() as any;

  const winRate = row.settled > 0 ? Math.round((row.wins / row.settled) * 10000) / 100 : 0;
  const roi = row.total_wagered > 0 ? Math.round((row.total_pnl / row.total_wagered) * 10000) / 100 : 0;

  return {
    total: row.total ?? 0,
    settled: row.settled ?? 0,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    win_rate: winRate,
    total_pnl: row.total_pnl ?? 0,
    roi_pct: roi,
    avg_confidence: row.avg_confidence ?? 0,
  };
}

export function getRecentTrades(limit = 100): (Trade & Snapshot)[] {
  return db.prepare(`
    SELECT t.*, s.obi, s.tfi, s.spread, s.funding_rate, s.oi_delta, s.rsi, s.macd, s.atr, s.btc_price
    FROM trades t
    LEFT JOIN snapshots s ON s.trade_id = t.id
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(limit) as (Trade & Snapshot)[];
}

export function getPnlTimeline(): { created_at: string; cumulative_pnl: number }[] {
  return db.prepare(`
    SELECT created_at,
           ROUND(SUM(COALESCE(pnl, 0)) OVER (ORDER BY created_at), 2) AS cumulative_pnl
    FROM trades
    ORDER BY created_at
  `).all() as { created_at: string; cumulative_pnl: number }[];
}

export default db;

function tableExists(name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name) as { name?: string } | undefined;
  return row?.name === name;
}

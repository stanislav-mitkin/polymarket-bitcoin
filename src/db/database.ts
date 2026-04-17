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
try { db.exec('ALTER TABLE snapshots ADD COLUMN volume_delta REAL'); } catch (_) {}
try { db.exec('ALTER TABLE snapshots ADD COLUMN btc_trend_1h REAL'); } catch (_) {}

export interface Trade {
  id?: number;
  created_at?: string;
  market_id: string;
  market_end: string;
  signal: 'UP' | 'DOWN';
  confidence: number;
  edge?: number | null;
  price_yes: number;
  price_no: number;
  size_usdc: number;
  outcome?: 'UP' | 'DOWN' | null;
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
  INSERT INTO trades (market_id, market_end, signal, confidence, edge, price_yes, price_no, size_usdc)
  VALUES (@market_id, @market_end, @signal, @confidence, @edge, @price_yes, @price_no, @size_usdc)
`);

const insertSnapshot = db.prepare<Snapshot>(`
  INSERT INTO snapshots (trade_id, obi, tfi, spread, funding_rate, oi_delta, rsi, macd, atr, volume_delta, btc_trend_1h, btc_price)
  VALUES (@trade_id, @obi, @tfi, @spread, @funding_rate, @oi_delta, @rsi, @macd, @atr, @volume_delta, @btc_trend_1h, @btc_price)
`);

const settleTrade = db.prepare<{ outcome: string; pnl: number; id: number }>(`
  UPDATE trades SET outcome = @outcome, pnl = @pnl, settled_at = datetime('now')
  WHERE id = @id
`);

export function saveTrade(trade: Trade, snapshot: Omit<Snapshot, 'trade_id'>): number {
  const result = insertTrade.run(trade);
  const tradeId = result.lastInsertRowid as number;
  insertSnapshot.run({ trade_id: tradeId, ...snapshot });
  return tradeId;
}

export function settleTradeById(id: number, outcome: 'UP' | 'DOWN', entryPriceYes: number, entryPriceNo: number, sizeUsdc: number, signal: 'UP' | 'DOWN'): void {
  // P&L calculation:
  // If we bet UP and outcome is UP: we bought YES at price_yes, it settles at 1.0
  // If we bet UP and outcome is DOWN: we lose what we paid
  const won = outcome === signal;
  const entryPrice = signal === 'UP' ? entryPriceYes : entryPriceNo;
  const pnl = won ? sizeUsdc * (1 - entryPrice) : -sizeUsdc * entryPrice;

  settleTrade.run({ outcome, pnl: Math.round(pnl * 100) / 100, id });
}

export function hasTradeForMarket(marketId: string): boolean {
  const row = db.prepare('SELECT 1 FROM trades WHERE market_id = ? LIMIT 1').get(marketId);
  return row != null;
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

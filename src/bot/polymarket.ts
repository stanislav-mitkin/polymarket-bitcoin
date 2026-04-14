// Read-only Polymarket client — no wallet or API key needed for demo mode
// BTC 5M event slugs follow the pattern: btc-updown-5m-{UNIX_START_TIMESTAMP}
// where windows are aligned to 5-minute boundaries (300s intervals)

const GAMMA_API = 'https://gamma-api.polymarket.com';
const WINDOW_SEC = 300; // 5 minutes

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; polymarket-bot/1.0)',
  'Accept': 'application/json',
};

export interface PolyMarket5M {
  id: string;
  conditionId: string;
  question: string;
  startDateIso: string;
  endDateIso: string;
  tokenIdUp: string;
  tokenIdDown: string;
  priceUp: number;
  priceDown: number;
  active: boolean;
  acceptingOrders: boolean;
}

// Cache: slug → market, TTL 30s
const cache = new Map<string, { market: PolyMarket5M; at: number }>();
const CACHE_TTL = 30_000;

/** Return aligned start-timestamps for the current and next 5M windows */
function currentWindowTimestamps(): number[] {
  const now = Math.floor(Date.now() / 1000);
  const current = Math.floor(now / WINDOW_SEC) * WINDOW_SEC;
  return [current, current + WINDOW_SEC, current + WINDOW_SEC * 2];
}

/** Build the event slug from a start timestamp */
function slugFromTs(ts: number): string {
  return `btc-updown-5m-${ts}`;
}

/** Fetch a single BTC 5M market by its start-window timestamp */
async function fetchMarketByTs(ts: number): Promise<PolyMarket5M | null> {
  const slug = slugFromTs(ts);
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.market;

  try {
    const url = `${GAMMA_API}/events?slug=${slug}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;

    const events = await res.json() as any[];
    const event = events[0];
    if (!event) return null;

    const market = event.markets?.[0];
    if (!market) return null;

    // Parse token IDs (clobTokenIds is a JSON-encoded array)
    const tokenIds: string[] = market.clobTokenIds
      ? JSON.parse(market.clobTokenIds)
      : [];

    // Parse outcome prices
    const rawPrices: string[] = market.outcomePrices
      ? JSON.parse(market.outcomePrices)
      : ['0.5', '0.5'];

    // outcomes[0] = "Up", outcomes[1] = "Down"
    const priceUp = parseFloat(rawPrices[0] ?? '0.5');
    const priceDown = parseFloat(rawPrices[1] ?? '0.5');

    const result: PolyMarket5M = {
      id: market.id,
      conditionId: market.conditionId,
      question: market.question,
      startDateIso: event.endDate
        ? new Date((ts) * 1000).toISOString()
        : market.startDate,
      endDateIso: event.endDate,
      tokenIdUp: tokenIds[0] ?? '',
      tokenIdDown: tokenIds[1] ?? '',
      priceUp,
      priceDown,
      active: event.active && !event.closed,
      acceptingOrders: market.acceptingOrders ?? false,
    };

    cache.set(slug, { market: result, at: Date.now() });
    return result;
  } catch (err) {
    console.error(`[Polymarket] Error fetching ${slug}:`, err);
    return null;
  }
}

/** Get the next market that is active and still accepting orders */
export async function getNextMarket(): Promise<PolyMarket5M | null> {
  const timestamps = currentWindowTimestamps();

  for (const ts of timestamps) {
    const market = await fetchMarketByTs(ts);
    if (!market) continue;

    // Skip already-closed markets
    if (!market.active) continue;

    // Check there's at least 30s left
    const msLeft = new Date(market.endDateIso).getTime() - Date.now();
    if (msLeft < 30_000) continue;

    return market;
  }

  return null;
}

/** Resolve outcome of a closed market by its Gamma market ID */
export async function resolveMarketOutcome(marketId: string): Promise<'UP' | 'DOWN' | null> {
  try {
    const url = `${GAMMA_API}/markets/${marketId}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;

    const market: any = await res.json();

    const rawPrices: string[] = market.outcomePrices
      ? JSON.parse(market.outcomePrices)
      : [];

    // Resolved: winner token settles at 1.0
    if (parseFloat(rawPrices[0] ?? '0') >= 0.99) return 'UP';
    if (parseFloat(rawPrices[1] ?? '0') >= 0.99) return 'DOWN';

    return null;
  } catch {
    return null;
  }
}

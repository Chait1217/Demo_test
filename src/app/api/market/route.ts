// Server-side Polymarket market data proxy.
// Fetches live data from Polymarket Gamma + CLOB APIs and caches it.
// Using a server route eliminates any potential CORS issues in the browser.
export const dynamic = "force-dynamic";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

// Primary event/market slug — "Will the Iranian regime fall by June 30?"
// polymarket.com/event/will-the-iranian-regime-fall-by-june-30
const PRIMARY_SLUG = "will-the-iranian-regime-fall-by-june-30";

const IRAN_KEYWORDS = ["iranian", "iran regime", "iran fall", "regime fall"];

export interface MarketData {
  question:     string;
  marketUrl:    string;
  yesPrice:     number;
  noPrice:      number;
  yesTokenId:   string;
  noTokenId:    string;
  volume:       number;
  liquidity:    number;
  spread:       number;
  endDate:      string;
  priceHistory: { t: number; p: number }[];
}

const FALLBACK: MarketData = {
  question:     "Will the Iranian regime fall by June 30?",
  marketUrl:    `https://polymarket.com/event/${PRIMARY_SLUG}`,
  yesPrice:     0.5,
  noPrice:      0.5,
  yesTokenId:   "",
  noTokenId:    "",
  volume:       0,
  liquidity:    0,
  spread:       0,
  endDate:      "2026-06-30",
  priceHistory: [],
};

// Module-level in-process cache
let cachedMeta: Omit<MarketData, "yesPrice" | "noPrice" | "spread"> | null = null;
let metaExpiry = 0;
let cachedPrices = { yesPrice: 0.5, noPrice: 0.5, spread: 0 };

type GammaMarket = Record<string, unknown>;

function isIranMarket(m: GammaMarket): boolean {
  const q = ((m.question as string) ?? "").toLowerCase();
  const s = ((m.slug    as string) ?? "").toLowerCase();
  return IRAN_KEYWORDS.some((kw) => q.includes(kw) || s.includes(kw));
}

/** Parse outcomePrices from Gamma API — either JSON string '["0.65","0.35"]' or array */
function parseOutcomePrices(m: GammaMarket): { yes: number; no: number } | null {
  try {
    const raw = m.outcomePrices;
    const arr: string[] = typeof raw === "string" ? JSON.parse(raw) : (raw as string[]);
    if (Array.isArray(arr) && arr.length >= 2) {
      const yes = parseFloat(arr[0]);
      const no  = parseFloat(arr[1]);
      if (isFinite(yes) && isFinite(no) && yes > 0 && no > 0) return { yes, no };
    }
  } catch { /* ignore */ }
  return null;
}

/** Extract YES/NO token IDs from a Gamma market object.
 *  Handles both array and JSON-string forms of clobTokenIds / outcomes. */
function parseTokenIds(m: GammaMarket): { yesTokenId: string; noTokenId: string } {
  // Form 1: tokens array with {token_id, outcome}
  if (Array.isArray(m.tokens)) {
    const tokens = m.tokens as { token_id: string; outcome: string }[];
    const yes = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
    const no  = tokens.find((t) => t.outcome?.toLowerCase() === "no");
    if (yes?.token_id && no?.token_id)
      return { yesTokenId: yes.token_id, noTokenId: no.token_id };
  }

  // Form 2: clobTokenIds (array or JSON string) + outcomes (array or JSON string)
  let clobIds: string[] = [];
  try {
    const raw = m.clobTokenIds;
    clobIds = Array.isArray(raw) ? (raw as string[]) : JSON.parse(raw as string);
  } catch { /* ignore */ }

  let outcomes: string[] = [];
  try {
    const raw = m.outcomes;
    outcomes = Array.isArray(raw) ? (raw as string[]) : JSON.parse(raw as string);
  } catch { /* ignore */ }

  if (clobIds.length >= 2) {
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const noIdx  = outcomes.findIndex((o) => o.toLowerCase() === "no");
    const yesId  = clobIds[yesIdx !== -1 ? yesIdx : 0];
    const noId   = clobIds[noIdx  !== -1 ? noIdx  : 1];
    if (yesId && noId) return { yesTokenId: yesId, noTokenId: noId };
  }

  return {
    yesTokenId: process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES ?? "",
    noTokenId:  process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO  ?? "",
  };
}

/** Pick the active (non-closed/non-resolved) market from a list */
function pickActive(markets: GammaMarket[]): GammaMarket | null {
  // Prefer active + not closed; fall back to any with token IDs
  return (
    markets.find((m) => m.active && !m.closed && parseTokenIds(m).yesTokenId) ??
    markets.find((m) => !m.closed && parseTokenIds(m).yesTokenId) ??
    markets.find((m) => parseTokenIds(m).yesTokenId) ??
    markets[0] ??
    null
  );
}

async function findMarket(): Promise<GammaMarket | null> {
  // 0. Env-var override
  const configuredSlug = process.env.POLYMARKET_MARKET_SLUG?.trim();
  if (configuredSlug) {
    try {
      const r = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(configuredSlug)}`, {
        signal: AbortSignal.timeout(6_000),
      });
      if (r.ok) {
        const d = await r.json();
        const m: GammaMarket = Array.isArray(d) ? (d[0] ?? null) : d;
        if (m?.id) { console.log(`[market] Using configured slug: ${configuredSlug}`); return m; }
      }
    } catch { /* fall through */ }
  }

  // 1. Events endpoint — most reliable for polymarket.com/event/SLUG URLs
  try {
    const r = await fetch(`${GAMMA}/events?slug=${PRIMARY_SLUG}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (r.ok) {
      const d = await r.json();
      const event: GammaMarket = Array.isArray(d) ? (d[0] ?? null) : d;
      const markets: GammaMarket[] = (event?.markets as GammaMarket[]) ?? [];
      const m = pickActive(markets);
      if (m?.id) { console.log(`[market] Found via events endpoint`); return m; }
    }
  } catch { /* continue */ }

  // 2. Direct markets slug lookup
  try {
    const r = await fetch(`${GAMMA}/markets?slug=${PRIMARY_SLUG}`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (r.ok) {
      const d = await r.json();
      const m: GammaMarket = Array.isArray(d) ? (d[0] ?? null) : d;
      if (m?.id) { console.log(`[market] Found via markets slug`); return m; }
    }
  } catch { /* continue */ }

  // 3. Keyword search across active markets
  for (const url of [
    `${GAMMA}/markets?active=true&closed=false&limit=200`,
    `${GAMMA}/markets?limit=500`,
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (r.ok) {
        const arr: GammaMarket[] = await r.json();
        const m = arr.find(isIranMarket);
        if (m?.id) { console.log(`[market] Found via keyword search`); return m; }
      }
    } catch { /* continue */ }
  }

  // 4. Events search with Iran keywords
  try {
    const r = await fetch(`${GAMMA}/events?active=true&limit=100`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const arr: GammaMarket[] = await r.json();
      const event = arr.find(isIranMarket);
      if (event) {
        const markets: GammaMarket[] = (event.markets as GammaMarket[]) ?? [];
        const m = pickActive(markets);
        if (m?.id) { console.log(`[market] Found via events search`); return m; }
      }
    }
  } catch { /* continue */ }

  console.warn("[market] Iran market not found on Polymarket — using fallback");
  return null;
}

// Fetch market metadata — cached 2 minutes
async function fetchMeta(): Promise<Omit<MarketData, "yesPrice" | "noPrice" | "spread">> {
  const now = Date.now();
  if (cachedMeta && now < metaExpiry) return cachedMeta;

  const market = await findMarket();
  const { yesTokenId, noTokenId } = market
    ? parseTokenIds(market)
    : { yesTokenId: "", noTokenId: "" };

  // Price history (1 week, hourly candles)
  let priceHistory: { t: number; p: number }[] = [];
  if (yesTokenId) {
    try {
      const hr = await fetch(
        `${CLOB}/prices-history?market=${yesTokenId}&interval=1w&fidelity=60`,
        { cache: "no-store", signal: AbortSignal.timeout(8_000) }
      );
      if (hr.ok) {
        const json = await hr.json();
        const raw: { t: unknown; p: unknown }[] = json.history ?? json.History ?? [];
        priceHistory = raw
          .map((h) => ({ t: Number(h.t), p: parseFloat(String(h.p)) }))
          .filter((h) => isFinite(h.p) && h.p > 0 && h.p < 1);
      }
    } catch { /* ignore */ }
  }

  const slug = (market?.slug as string) ?? PRIMARY_SLUG;

  cachedMeta = {
    question:  (market?.question as string) ?? FALLBACK.question,
    marketUrl: `https://polymarket.com/event/${slug}`,
    yesTokenId,
    noTokenId,
    volume:    parseFloat(String(market?.volume24hr ?? market?.volume ?? "0")) || 0,
    liquidity: parseFloat(String(market?.liquidityNum ?? market?.liquidity ?? "0")) || 0,
    endDate:   (market?.endDate as string) ?? (market?.end_date_iso as string) ?? FALLBACK.endDate,
    priceHistory,
  };
  metaExpiry = now + 120_000;

  // Seed cachedPrices from Gamma only as a last-resort fallback (no expiry override)
  if (market && cachedPrices.yesPrice === 0.5) {
    const gp = parseOutcomePrices(market);
    if (gp) {
      cachedPrices = { yesPrice: parseFloat(gp.yes.toFixed(4)), noPrice: parseFloat(gp.no.toFixed(4)), spread: 0 };
      console.log(`[market] Gamma seed prices — YES: ${cachedPrices.yesPrice} NO: ${cachedPrices.noPrice}`);
    }
  }

  return cachedMeta;
}

// Fetch live bid/ask from CLOB — no server-side caching so every client poll gets fresh data
async function fetchLivePrices(yesTokenId: string) {
  if (!yesTokenId) return cachedPrices;

  try {
    const [sellRes, buyRes] = await Promise.all([
      fetch(`${CLOB}/price?token_id=${yesTokenId}&side=SELL`, { cache: "no-store", signal: AbortSignal.timeout(5_000) }),
      fetch(`${CLOB}/price?token_id=${yesTokenId}&side=BUY`,  { cache: "no-store", signal: AbortSignal.timeout(5_000) }),
    ]);

    if (!sellRes.ok || !buyRes.ok) {
      console.warn(`[market] CLOB price HTTP error — sell:${sellRes.status} buy:${buyRes.status}`);
      return cachedPrices;
    }

    const sellData = await sellRes.json();
    const buyData  = await buyRes.json();
    console.log(`[market] CLOB raw — sell:${JSON.stringify(sellData)} buy:${JSON.stringify(buyData)}`);

    const bid = parseFloat(String(sellData.price ?? sellData.price ?? "0"));
    const ask = parseFloat(String(buyData.price  ?? buyData.price  ?? "0"));

    if (bid > 0 && ask > 0 && bid <= ask + 0.01 && ask <= 1.01) {
      const mid = (bid + ask) / 2;
      cachedPrices = {
        yesPrice: parseFloat(Math.min(mid, 1).toFixed(4)),
        noPrice:  parseFloat(Math.max(1 - mid, 0).toFixed(4)),
        spread:   parseFloat(Math.abs(ask - bid).toFixed(4)),
      };
      console.log(`[market] Live CLOB prices — YES: ${cachedPrices.yesPrice} NO: ${cachedPrices.noPrice}`);
    } else {
      console.warn(`[market] CLOB prices rejected — bid:${bid} ask:${ask}`);
    }
  } catch (e) {
    console.warn(`[market] CLOB fetch error — ${e}`);
  }

  return cachedPrices;
}

export async function GET() {
  try {
    const meta   = await fetchMeta();
    const prices = await fetchLivePrices(meta.yesTokenId);

    // Always append the current live price as the final history point so the
    // chart end-point reflects real-time CLOB data, not stale cached history.
    const nowSec     = Math.floor(Date.now() / 1000);
    const livePoint  = { t: nowSec, p: prices.yesPrice };
    const history    = meta.priceHistory ?? [];
    const lastT      = history.length > 0 ? history[history.length - 1].t : 0;
    const priceHistory = lastT === nowSec
      ? [...history.slice(0, -1), livePoint]   // replace same-second bucket
      : [...history, livePoint];               // append new point

    const data: MarketData = { ...meta, priceHistory, ...prices };
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err: unknown) {
    console.error("[/api/market]", err);
    return Response.json(FALLBACK);
  }
}

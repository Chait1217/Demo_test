// Server-side Polymarket market data proxy.
// Fetches live data from Polymarket Gamma + CLOB APIs and caches it.
// Using a server route eliminates any potential CORS issues in the browser.
export const dynamic = "force-dynamic";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

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
  question:     "Loading market data…",
  marketUrl:    "https://polymarket.com",
  yesPrice:     0.5,
  noPrice:      0.5,
  yesTokenId:   "",
  noTokenId:    "",
  volume:       0,
  liquidity:    0,
  spread:       0,
  endDate:      "",
  priceHistory: [],
};

// Module-level in-process cache
let cachedMeta: Omit<MarketData, "yesPrice" | "noPrice" | "spread"> | null = null;
let metaExpiry = 0;
let cachedPrices = { yesPrice: 0.5, noPrice: 0.5, spread: 0 };
let priceExpiry  = 0;

type GammaMarket = Record<string, unknown>;

/** Parse outcomePrices from Gamma API response.
 *  The field is either a JSON string like '["0.65","0.35"]' or an array. */
function parseOutcomePrices(m: GammaMarket): { yes: number; no: number } | null {
  try {
    const raw = m.outcomePrices;
    const arr: string[] = typeof raw === "string" ? JSON.parse(raw) : (raw as string[]);
    if (Array.isArray(arr) && arr.length >= 2) {
      const yes = parseFloat(arr[0]);
      const no  = parseFloat(arr[1]);
      if (isFinite(yes) && isFinite(no) && yes > 0 && no > 0) {
        return { yes, no };
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Resolve token IDs from a Gamma market object. */
function parseTokenIds(m: GammaMarket): { yesTokenId: string; noTokenId: string } {
  const tokens: { token_id: string; outcome: string }[] = Array.isArray(m.tokens)
    ? (m.tokens as { token_id: string; outcome: string }[])
    : [];
  // Also check clobTokenIds (newer API format)
  const clobIds: string[] = Array.isArray(m.clobTokenIds)
    ? (m.clobTokenIds as string[])
    : [];

  const yesToken = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken  = tokens.find((t) => t.outcome?.toLowerCase() === "no");

  const yesTokenId =
    yesToken?.token_id ||
    clobIds[0] ||
    process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES ||
    "";
  const noTokenId =
    noToken?.token_id ||
    clobIds[1] ||
    process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO ||
    "";

  return { yesTokenId, noTokenId };
}

/** Find an active binary market.
 *  Strategy:
 *  1. If POLYMARKET_MARKET_SLUG is set, look up that specific slug.
 *  2. Otherwise fetch top active markets sorted by volume and pick the first
 *     binary (yes/no) market with real liquidity.
 */
async function findMarket(): Promise<GammaMarket | null> {
  const configuredSlug = process.env.POLYMARKET_MARKET_SLUG?.trim();

  // 1. Configured slug takes priority
  if (configuredSlug) {
    try {
      const r = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(configuredSlug)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) {
        const d = await r.json();
        const m: GammaMarket = Array.isArray(d) ? (d[0] ?? null) : d;
        if (m?.id) {
          console.log(`[market] Found configured market: ${m.slug ?? configuredSlug}`);
          return m;
        }
      }
    } catch { /* fall through */ }
    console.warn(`[market] Configured slug "${configuredSlug}" not found, searching active markets`);
  }

  // 2. Top active markets by volume (sorted desc, active + not closed)
  for (const url of [
    `${GAMMA}/markets?active=true&closed=false&order=volume&ascending=false&limit=20`,
    `${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=20`,
    `${GAMMA}/markets?active=true&limit=50`,
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) continue;
      const arr: GammaMarket[] = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Pick first market that has binary outcomes (yes/no tokens) and real prices
      const candidate = arr.find((m) => {
        const { yesTokenId } = parseTokenIds(m);
        const prices = parseOutcomePrices(m);
        return yesTokenId && prices;
      }) ?? arr[0];

      if (candidate?.id) {
        console.log(`[market] Using top active market: ${candidate.slug ?? candidate.id}`);
        return candidate;
      }
    } catch { /* try next */ }
  }

  return null;
}

// Fetch market metadata - cached 2 minutes
async function fetchMeta(): Promise<Omit<MarketData, "yesPrice" | "noPrice" | "spread">> {
  const now = Date.now();
  if (cachedMeta && now < metaExpiry) return cachedMeta;

  const market = await findMarket();

  const { yesTokenId, noTokenId } = market
    ? parseTokenIds(market)
    : { yesTokenId: "", noTokenId: "" };

  // Price history for chart (1 week, hourly)
  let priceHistory: { t: number; p: number }[] = [];
  if (yesTokenId) {
    try {
      const hr = await fetch(
        `${CLOB}/prices-history?market=${yesTokenId}&interval=1w&fidelity=60`,
        { signal: AbortSignal.timeout(8_000) }
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

  const slug    = (market?.slug as string) ?? "";
  const eventSlug = (market?.groupItemTitle as string) ?? slug;

  cachedMeta = {
    question:
      (market?.question as string) ?? FALLBACK.question,
    marketUrl:
      slug
        ? `https://polymarket.com/event/${slug}`
        : "https://polymarket.com",
    yesTokenId,
    noTokenId,
    volume:    parseFloat(String(market?.volume24hr ?? market?.volume ?? "0")) || 0,
    liquidity: parseFloat(String(market?.liquidityNum ?? market?.liquidity ?? "0")) || 0,
    endDate:
      (market?.endDate as string) ??
      (market?.end_date_iso as string) ??
      "",
    priceHistory,
  };
  metaExpiry = now + 120_000; // 2-minute cache

  // Seed prices from Gamma outcomePrices so first response isn't 0.5/0.5
  if (market) {
    const gp = parseOutcomePrices(market);
    if (gp) {
      cachedPrices = {
        yesPrice: parseFloat(gp.yes.toFixed(4)),
        noPrice:  parseFloat(gp.no.toFixed(4)),
        spread:   0,
      };
      priceExpiry = now + 30_000; // Gamma prices good for 30s until CLOB refreshes
    }
  }

  if (yesTokenId) {
    console.log(`[market] Market loaded: "${cachedMeta.question.slice(0, 60)}" — YES token: ${yesTokenId.slice(0, 16)}…`);
  } else {
    console.warn("[market] No active binary market found on Polymarket — using fallback prices");
  }

  return cachedMeta;
}

// Fetch live bid/ask from CLOB - cached 8 seconds
async function fetchLivePrices(yesTokenId: string) {
  if (!yesTokenId) return cachedPrices;
  const now = Date.now();
  if (now < priceExpiry) return cachedPrices;

  try {
    const [sellRes, buyRes] = await Promise.all([
      fetch(`${CLOB}/price?token_id=${yesTokenId}&side=sell`, { signal: AbortSignal.timeout(5_000) }),
      fetch(`${CLOB}/price?token_id=${yesTokenId}&side=buy`,  { signal: AbortSignal.timeout(5_000) }),
    ]);

    if (sellRes.ok && buyRes.ok) {
      const bid = parseFloat((await sellRes.json()).price ?? "0");
      const ask = parseFloat((await buyRes.json()).price  ?? "0");
      if (bid > 0 && ask > 0 && bid <= ask && ask <= 1) {
        const mid = (bid + ask) / 2;
        cachedPrices = {
          yesPrice: parseFloat(mid.toFixed(4)),
          noPrice:  parseFloat((1 - mid).toFixed(4)),
          spread:   parseFloat((ask - bid).toFixed(4)),
        };
        priceExpiry = now + 8_000;
        console.log(`[market] Live CLOB prices — YES: ${cachedPrices.yesPrice} NO: ${cachedPrices.noPrice}`);
      }
    }
  } catch { /* keep cached */ }

  return cachedPrices;
}

export async function GET() {
  try {
    const meta   = await fetchMeta();
    const prices = await fetchLivePrices(meta.yesTokenId);
    const data: MarketData = { ...meta, ...prices };
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err: unknown) {
    console.error("[/api/market]", err);
    return Response.json(FALLBACK);
  }
}

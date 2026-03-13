// Server-side Polymarket market data proxy.
// Fetches live data from Polymarket Gamma + CLOB APIs and caches it.
// Using a server route eliminates any potential CORS issues in the browser.
export const dynamic = "force-dynamic";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const SLUG  = "will-the-iranian-regime-fall-by-june-30";

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
  marketUrl:    `https://polymarket.com/event/${SLUG}`,
  yesPrice:     0.5,
  noPrice:      0.5,
  yesTokenId:   "",
  noTokenId:    "",
  volume:       0,
  liquidity:    0,
  spread:       0,
  endDate:      "2025-06-30",
  priceHistory: [],
};

// Module-level in-process cache
let cachedMeta: Omit<MarketData, "yesPrice" | "noPrice" | "spread"> | null = null;
let metaExpiry = 0;
let cachedPrices = { yesPrice: 0.5, noPrice: 0.5, spread: 0 };
let priceExpiry  = 0;

// Keywords to match against question and slug
const IRAN_KEYWORDS = ["iranian", "iran regime", "iran fall", "regime fall"];

function isIranMarket(m: Record<string, unknown>): boolean {
  const q = ((m.question as string) ?? "").toLowerCase();
  const s = ((m.slug    as string) ?? "").toLowerCase();
  return IRAN_KEYWORDS.some((kw) => q.includes(kw) || s.includes(kw));
}

// Fetch market metadata - cached 2 minutes
async function fetchMeta(): Promise<Omit<MarketData, "yesPrice" | "noPrice" | "spread">> {
  const now = Date.now();
  if (cachedMeta && now < metaExpiry) return cachedMeta;

  let market: Record<string, unknown> | null = null;

  // 1. Try exact slug lookup
  try {
    const r = await fetch(`${GAMMA}/markets?slug=${SLUG}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (r.ok) {
      const d = await r.json();
      const m = Array.isArray(d) ? (d[0] ?? null) : d;
      if (m?.id) market = m;
    }
  } catch { /* ignore */ }

  // 2. Try slug variants (with year suffix)
  if (!market?.id) {
    for (const variant of [
      `${SLUG}-2025`,
      "will-iran-regime-fall-by-june-30",
      "will-the-iran-regime-fall-by-june-30",
    ]) {
      try {
        const r = await fetch(`${GAMMA}/markets?slug=${variant}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const d = await r.json();
          const m = Array.isArray(d) ? (d[0] ?? null) : d;
          if (m?.id) { market = m; break; }
        }
      } catch { /* ignore */ }
    }
  }

  // 3. Keyword search — no active=true filter so we catch all markets
  if (!market?.id) {
    try {
      const r = await fetch(`${GAMMA}/markets?limit=500`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const arr: Record<string, unknown>[] = await r.json();
        market = arr.find(isIranMarket) ?? null;
      }
    } catch { /* ignore */ }
  }

  // 4. Try events endpoint as alternative
  if (!market?.id) {
    try {
      const r = await fetch(`${GAMMA}/events?slug=${SLUG}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const d = await r.json();
        const event = Array.isArray(d) ? (d[0] ?? null) : d;
        // events contain markets array
        const markets: Record<string, unknown>[] = event?.markets ?? [];
        market = markets.find(isIranMarket) ?? markets[0] ?? null;
      }
    } catch { /* ignore */ }
  }

  // Parse token IDs
  const tokens: { token_id: string; outcome: string }[] = Array.isArray(market?.tokens)
    ? (market!.tokens as { token_id: string; outcome: string }[])
    : [];
  const yesToken   = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken    = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  const yesTokenId =
    yesToken?.token_id || process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES || "";
  const noTokenId =
    noToken?.token_id  || process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO  || "";

  // Price history for chart
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

  cachedMeta = {
    question:
      (market?.question as string) ?? "Will the Iranian regime fall by June 30?",
    marketUrl: `https://polymarket.com/event/${(market?.slug as string) ?? SLUG}`,
    yesTokenId,
    noTokenId,
    volume:   parseFloat(String(market?.volume24hr ?? market?.volume ?? "0")) || 0,
    liquidity: parseFloat(String(market?.liquidityNum ?? market?.liquidity ?? "0")) || 0,
    endDate:
      (market?.endDate as string) ?? (market?.end_date_iso as string) ?? "2025-06-30",
    priceHistory,
  };
  metaExpiry = now + 120_000;

  // Log result for debugging
  if (yesTokenId) {
    console.log(`[market] Found Iran market — YES token: ${yesTokenId.slice(0, 16)}…`);
  } else {
    console.warn("[market] Iran market not found on Polymarket — using fallback prices");
  }

  return cachedMeta;
}

// Fetch live prices - cached 8 seconds
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
        console.log(`[market] Live prices — YES: ${cachedPrices.yesPrice} NO: ${cachedPrices.noPrice}`);
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

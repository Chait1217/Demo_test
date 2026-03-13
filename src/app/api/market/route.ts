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

// Fetch market metadata - cached 2 minutes
async function fetchMeta(): Promise<Omit<MarketData, "yesPrice" | "noPrice" | "spread">> {
  const now = Date.now();
  if (cachedMeta && now < metaExpiry) return cachedMeta;

  let market: Record<string, unknown> | null = null;

  // Try slug lookup
  try {
    const r = await fetch(`${GAMMA}/markets?slug=${SLUG}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (r.ok) {
      const d = await r.json();
      market = Array.isArray(d) ? (d[0] ?? null) : d;
    }
  } catch { /* ignore */ }

  // Keyword fallback
  if (!market?.id) {
    try {
      const r = await fetch(`${GAMMA}/markets?limit=200&active=true`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) {
        const arr: Record<string, unknown>[] = await r.json();
        market =
          arr.find(
            (m) =>
              (m.question as string)?.toLowerCase().includes("iranian") ||
              (m.slug as string)?.includes("iran")
          ) ?? null;
      }
    } catch { /* ignore */ }
  }

  const tokens: { token_id: string; outcome: string }[] = Array.isArray(market?.tokens)
    ? (market!.tokens as { token_id: string; outcome: string }[])
    : [];
  const yesToken   = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken    = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  const yesTokenId =
    yesToken?.token_id || process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES || "";
  const noTokenId =
    noToken?.token_id  || process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO  || "";

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

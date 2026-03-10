export const dynamic = "force-dynamic";

let cache: { data: MarketData; fetchedAt: number } | null = null;
const CACHE_TTL = 10_000;

export interface MarketData {
  question: string;
  yesPrice: number;
  noPrice: number;
  yesTokenId: string;
  noTokenId: string;
  volume: number;
  liquidity: number;
  spread: number;
  endDate: string;
  priceHistory: { t: number; p: number }[];
}

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

// Gamma API returns outcomePrices as a JSON-encoded string: '["0.82","0.18"]'
function parseOutcomePrices(raw: unknown): [number, number] {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length >= 2) {
      return [parseFloat(arr[0]), parseFloat(arr[1])];
    }
  } catch { /* fall through */ }
  return [0.5, 0.5];
}

async function fetchMarketData(): Promise<MarketData> {
  // 1. Fetch from Gamma — try slug first, then keyword search
  let market: any = null;

  try {
    const r = await fetch(
      `${GAMMA}/markets?slug=will-the-iranian-regime-fall-by-june-30`,
      { cache: "no-store" }
    );
    if (r.ok) {
      const d = await r.json();
      market = Array.isArray(d) ? d[0] : d;
    }
  } catch { /* try fallback */ }

  if (!market?.id) {
    try {
      const r = await fetch(`${GAMMA}/markets?limit=50`, { cache: "no-store" });
      if (r.ok) {
        const arr: any[] = await r.json();
        market = arr.find((m) =>
          m.question?.toLowerCase().includes("iranian") ||
          m.question?.toLowerCase().includes("iran regime")
        ) ?? null;
      }
    } catch { /* give up */ }
  }

  if (!market) throw new Error("Market not found");

  // 2. Parse YES/NO token IDs
  // Gamma returns tokens as: [{token_id: "...", outcome: "Yes"}, ...]
  const tokens: { token_id: string; outcome: string }[] =
    Array.isArray(market.tokens) ? market.tokens : [];

  const yesToken = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken  = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  const yesTokenId = yesToken?.token_id ?? "";
  const noTokenId  = noToken?.token_id  ?? "";

  // 3. Baseline prices from Gamma outcomePrices (always a JSON string)
  let [yesPrice, noPrice] = parseOutcomePrices(market.outcomePrices);

  // 4. Fresher mid-price from CLOB bid+ask
  if (yesTokenId) {
    try {
      const [bidRes, askRes] = await Promise.all([
        fetch(`${CLOB}/price?token_id=${yesTokenId}&side=sell`, { cache: "no-store" }),
        fetch(`${CLOB}/price?token_id=${yesTokenId}&side=buy`,  { cache: "no-store" }),
      ]);
      if (bidRes.ok && askRes.ok) {
        const bid = parseFloat((await bidRes.json()).price ?? "0");
        const ask = parseFloat((await askRes.json()).price ?? "0");
        if (bid > 0 && ask > 0 && bid <= ask) {
          yesPrice = (bid + ask) / 2;
          noPrice  = parseFloat((1 - yesPrice).toFixed(4));
        }
      }
    } catch { /* keep Gamma prices */ }
  }

  // 5. Price history for chart
  let priceHistory: { t: number; p: number }[] = [];
  if (yesTokenId) {
    try {
      const r = await fetch(
        `${CLOB}/prices-history?market=${yesTokenId}&interval=1w&fidelity=60`,
        { cache: "no-store" }
      );
      if (r.ok) {
        const json = await r.json();
        const raw: { t: number; p: number | string }[] = json.history ?? json.History ?? [];
        priceHistory = raw
          .map((h) => ({ t: Number(h.t), p: parseFloat(String(h.p)) }))
          .filter((h) => isFinite(h.p));
      }
    } catch { /* leave empty */ }
  }

  return {
    question:    market.question ?? "Will the Iranian regime fall by June 30?",
    yesPrice,
    noPrice,
    yesTokenId,
    noTokenId,
    volume:    parseFloat(String(market.volume24hr    ?? market.volume    ?? "0")) || 0,
    liquidity: parseFloat(String(market.liquidityNum  ?? market.liquidity ?? "0")) || 0,
    spread:    Math.abs(yesPrice + noPrice - 1),
    endDate:   market.endDate ?? market.endDateIso ?? market.end_date_iso ?? "",
    priceHistory,
  };
}

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL) return Response.json(cache.data);
    const data = await fetchMarketData();
    cache = { data, fetchedAt: now };
    return Response.json(data);
  } catch (err: any) {
    console.error("[/api/market]", err.message);
    if (cache) return Response.json(cache.data); // serve stale on error
    return Response.json({
      question: "Will the Iranian regime fall by June 30?",
      yesPrice: 0.5, noPrice: 0.5,
      yesTokenId: "", noTokenId: "",
      volume: 0, liquidity: 0, spread: 0,
      endDate: "2025-06-30", priceHistory: [],
    } satisfies MarketData);
  }
}

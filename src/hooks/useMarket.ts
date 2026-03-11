"use client";

import { useQuery } from "@tanstack/react-query";

export interface MarketData {
  question: string;
  marketUrl: string;
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
const SLUG  = "will-the-iranian-regime-fall-by-june-30";

function parseOutcomePrices(raw: unknown): [number, number] {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length >= 2) {
      return [parseFloat(arr[0]), parseFloat(arr[1])];
    }
  } catch { /* fall through */ }
  return [0.5, 0.5];
}

async function fetchMarket(): Promise<MarketData> {
  // 1. Fetch market metadata from Gamma API (public, no auth, CORS-open)
  let market: any = null;

  const r = await fetch(`${GAMMA}/markets?slug=${SLUG}`);
  if (r.ok) {
    const d = await r.json();
    market = Array.isArray(d) ? d[0] : d;
  }

  // Fallback: search by keyword
  if (!market?.id) {
    const r2 = await fetch(`${GAMMA}/markets?tag_slug=iran&limit=20`);
    if (r2.ok) {
      const arr: any[] = await r2.json();
      market = arr.find((m: any) =>
        m.question?.toLowerCase().includes("iranian") ||
        m.question?.toLowerCase().includes("iran regime")
      ) ?? null;
    }
  }

  if (!market) throw new Error("Market not found");

  // 2. Parse token IDs
  const tokens: { token_id: string; outcome: string }[] =
    Array.isArray(market.tokens) ? market.tokens : [];
  const yesToken = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken  = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  const yesTokenId = yesToken?.token_id ?? "";
  const noTokenId  = noToken?.token_id  ?? "";

  // 3. Baseline prices from Gamma (outcomePrices is a JSON-encoded string)
  let [yesPrice, noPrice] = parseOutcomePrices(market.outcomePrices);

  // 4. Live mid-price from CLOB (bid + ask averaged)
  if (yesTokenId) {
    try {
      const [bidRes, askRes] = await Promise.all([
        fetch(`${CLOB}/price?token_id=${yesTokenId}&side=sell`),
        fetch(`${CLOB}/price?token_id=${yesTokenId}&side=buy`),
      ]);
      if (bidRes.ok && askRes.ok) {
        const bid = parseFloat((await bidRes.json()).price ?? "0");
        const ask = parseFloat((await askRes.json()).price ?? "0");
        if (bid > 0 && ask > 0 && bid <= ask) {
          yesPrice = parseFloat(((bid + ask) / 2).toFixed(4));
          noPrice  = parseFloat((1 - yesPrice).toFixed(4));
        }
      }
    } catch { /* keep Gamma prices */ }
  }

  // 5. Price history for chart
  let priceHistory: { t: number; p: number }[] = [];
  if (yesTokenId) {
    try {
      const hr = await fetch(
        `${CLOB}/prices-history?market=${yesTokenId}&interval=1w&fidelity=60`
      );
      if (hr.ok) {
        const json = await hr.json();
        const raw: { t: number; p: number | string }[] = json.history ?? json.History ?? [];
        priceHistory = raw
          .map((h) => ({ t: Number(h.t), p: parseFloat(String(h.p)) }))
          .filter((h) => isFinite(h.p) && h.p > 0);
      }
    } catch { /* leave empty */ }
  }

  const marketUrl = `https://polymarket.com/event/${market.slug ?? SLUG}`;

  return {
    question:  market.question ?? "Will the Iranian regime fall by June 30?",
    marketUrl,
    yesPrice,
    noPrice,
    yesTokenId,
    noTokenId,
    volume:    parseFloat(String(market.volume24hr ?? market.volume ?? "0")) || 0,
    liquidity: parseFloat(String(market.liquidityNum ?? market.liquidity ?? "0")) || 0,
    spread:    Math.abs(yesPrice + noPrice - 1),
    endDate:   market.endDate ?? market.end_date_iso ?? "",
    priceHistory,
  };
}

export function useMarket() {
  return useQuery<MarketData>({
    queryKey: ["market"],
    queryFn: fetchMarket,
    refetchInterval: 10_000,   // re-fetch every 10s for live prices
    staleTime: 8_000,
    retry: 2,
  });
}

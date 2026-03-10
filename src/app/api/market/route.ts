import { NextRequest } from "next/server";
import { POLYMARKET_GAMMA_HOST, POLYMARKET_API_HOST, IRAN_MARKET_SLUG } from "@/lib/constants";

// Cache market data for 10 seconds to avoid hammering the API
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

async function fetchMarketData(): Promise<MarketData> {
  // Fetch market info from Gamma API
  const gammaRes = await fetch(
    `${POLYMARKET_GAMMA_HOST}/markets?slug=${IRAN_MARKET_SLUG}`,
    { next: { revalidate: 10 } }
  );

  if (!gammaRes.ok) {
    throw new Error(`Gamma API error: ${gammaRes.status}`);
  }

  const gammaData = await gammaRes.json();
  const market = Array.isArray(gammaData) ? gammaData[0] : gammaData;

  if (!market) {
    throw new Error("Market not found");
  }

  // Parse outcome tokens
  const tokens: { token_id: string; outcome: string }[] =
    market.tokens ?? market.clobTokenIds ?? [];

  const yesToken = tokens.find((t) =>
    t.outcome?.toLowerCase() === "yes"
  );
  const noToken = tokens.find((t) =>
    t.outcome?.toLowerCase() === "no"
  );

  // Fetch live orderbook prices from CLOB
  let yesPrice = 0.5;
  let noPrice = 0.5;
  let spread = 0;

  if (yesToken?.token_id) {
    try {
      const priceRes = await fetch(
        `${POLYMARKET_API_HOST}/price?token_id=${yesToken.token_id}&side=buy`,
        { next: { revalidate: 5 } }
      );
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        yesPrice = parseFloat(priceData.price ?? "0.5");
        noPrice = parseFloat((1 - yesPrice).toFixed(4));
      }
    } catch {
      // fall back to market prices
      yesPrice = parseFloat(market.outcomePrices?.[0] ?? "0.5");
      noPrice = parseFloat(market.outcomePrices?.[1] ?? "0.5");
    }
  } else {
    // Fall back to gamma prices
    yesPrice = parseFloat(market.outcomePrices?.[0] ?? "0.5");
    noPrice = parseFloat(market.outcomePrices?.[1] ?? "0.5");
  }

  // Fetch price history for chart (last 7 days)
  let priceHistory: { t: number; p: number }[] = [];
  if (yesToken?.token_id) {
    try {
      const histRes = await fetch(
        `${POLYMARKET_API_HOST}/prices-history?market=${yesToken.token_id}&interval=1d&fidelity=60`,
        { next: { revalidate: 60 } }
      );
      if (histRes.ok) {
        const histData = await histRes.json();
        priceHistory = (histData.history ?? []).map((h: { t: number; p: string | number }) => ({
          t: h.t,
          p: parseFloat(String(h.p)),
        }));
      }
    } catch {
      // ignore
    }
  }

  // Compute spread from bid/ask if available
  spread = Math.abs(yesPrice - (1 - noPrice));

  return {
    question: market.question ?? "Will the Iranian regime fall by June 30?",
    yesPrice,
    noPrice,
    yesTokenId: yesToken?.token_id ?? "",
    noTokenId: noToken?.token_id ?? "",
    volume: parseFloat(market.volume24hr ?? market.volume ?? "0"),
    liquidity: parseFloat(market.liquidityNum ?? market.liquidity ?? "0"),
    spread,
    endDate: market.endDate ?? market.end_date_iso ?? "",
    priceHistory,
  };
}

export async function GET(_req: NextRequest) {
  try {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL) {
      return Response.json(cache.data);
    }

    const data = await fetchMarketData();
    cache = { data, fetchedAt: now };
    return Response.json(data);
  } catch (err: any) {
    // Return fallback data so the UI never fully breaks
    const fallback: MarketData = {
      question: "Will the Iranian regime fall by June 30?",
      yesPrice: 0.5,
      noPrice: 0.5,
      yesTokenId: "",
      noTokenId: "",
      volume: 0,
      liquidity: 0,
      spread: 0,
      endDate: "2025-06-30",
      priceHistory: [],
    };
    return Response.json(fallback, { status: 200 });
  }
}

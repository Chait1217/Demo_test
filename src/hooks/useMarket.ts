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

// Hardcoded fallback token IDs so prices work even if Gamma is slow/down
// These are the real Polymarket token IDs for this market
const FALLBACK_YES_TOKEN = process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES ?? "";
const FALLBACK_NO_TOKEN  = process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO  ?? "";

function parseOutcomePrices(raw: unknown): [number, number] {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length >= 2) {
      return [parseFloat(arr[0]), parseFloat(arr[1])];
    }
  } catch { /* fall through */ }
  return [0.5, 0.5];
}

interface MetaResult {
  question: string;
  marketUrl: string;
  yesTokenId: string;
  noTokenId: string;
  volume: number;
  liquidity: number;
  endDate: string;
  priceHistory: { t: number; p: number }[];
  baseYes: number;
  baseNo: number;
}

async function fetchMarketMeta(): Promise<MetaResult> {
  let market: any = null;

  // Try slug lookup
  try {
    const r = await fetch(`${GAMMA}/markets?slug=${SLUG}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      market = Array.isArray(d) ? d[0] : d;
    }
  } catch { /* ignore */ }

  // Keyword fallback
  if (!market?.id) {
    try {
      const r2 = await fetch(`${GAMMA}/markets?limit=100`, { signal: AbortSignal.timeout(8000) });
      if (r2.ok) {
        const arr: any[] = await r2.json();
        market = arr.find((m: any) =>
          m.question?.toLowerCase().includes("iranian") ||
          m.slug?.includes("iran")
        ) ?? null;
      }
    } catch { /* ignore */ }
  }

  // Parse token IDs — use env vars as fallback
  const tokens: { token_id: string; outcome: string }[] =
    Array.isArray(market?.tokens) ? market.tokens : [];
  const yesToken = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken  = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  const yesTokenId = yesToken?.token_id || FALLBACK_YES_TOKEN;
  const noTokenId  = noToken?.token_id  || FALLBACK_NO_TOKEN;

  const [baseYes, baseNo] = parseOutcomePrices(market?.outcomePrices);

  // Price history
  let priceHistory: { t: number; p: number }[] = [];
  if (yesTokenId) {
    try {
      const hr = await fetch(
        `${CLOB}/prices-history?market=${yesTokenId}&interval=1w&fidelity=60`,
        { signal: AbortSignal.timeout(8000) }
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

  return {
    question:     market?.question ?? "Will the Iranian regime fall by June 30?",
    marketUrl:    `https://polymarket.com/event/${market?.slug ?? SLUG}`,
    yesTokenId,
    noTokenId,
    volume:       parseFloat(String(market?.volume24hr ?? market?.volume ?? "0")) || 0,
    liquidity:    parseFloat(String(market?.liquidityNum ?? market?.liquidity ?? "0")) || 0,
    endDate:      market?.endDate ?? market?.end_date_iso ?? "",
    priceHistory,
    baseYes,
    baseNo,
  };
}

async function fetchLivePrices(yesTokenId: string): Promise<{ yesPrice: number; noPrice: number; spread: number }> {
  const [bidRes, askRes] = await Promise.all([
    fetch(`${CLOB}/price?token_id=${yesTokenId}&side=sell`, { signal: AbortSignal.timeout(5000) }),
    fetch(`${CLOB}/price?token_id=${yesTokenId}&side=buy`,  { signal: AbortSignal.timeout(5000) }),
  ]);

  if (!bidRes.ok || !askRes.ok) throw new Error("CLOB price fetch failed");

  const bid = parseFloat((await bidRes.json()).price ?? "0");
  const ask = parseFloat((await askRes.json()).price ?? "0");

  if (bid <= 0 || ask <= 0 || bid > ask) throw new Error("Invalid bid/ask");

  const yesPrice = parseFloat(((bid + ask) / 2).toFixed(4));
  const noPrice  = parseFloat((1 - yesPrice).toFixed(4));
  const spread   = parseFloat((ask - bid).toFixed(4));
  return { yesPrice, noPrice, spread };
}

export function useMarket() {
  // Slow: metadata + chart, refresh every 60s
  const metaQuery = useQuery({
    queryKey: ["market-meta"],
    queryFn: fetchMarketMeta,
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 3,
    retryDelay: 2000,
  });

  const meta = metaQuery.data;
  const yesTokenId = meta?.yesTokenId ?? FALLBACK_YES_TOKEN;

  // Fast: live prices every 8s — enabled as soon as we have a tokenId
  const priceQuery = useQuery({
    queryKey: ["market-prices", yesTokenId],
    queryFn: () => fetchLivePrices(yesTokenId),
    enabled: Boolean(yesTokenId),
    refetchInterval: 8_000,
    staleTime: 6_000,
    retry: 1,
  });

  const yesPrice = priceQuery.data?.yesPrice ?? meta?.baseYes ?? 0.5;
  const noPrice  = priceQuery.data?.noPrice  ?? meta?.baseNo  ?? 0.5;
  const spread   = priceQuery.data?.spread   ?? 0;

  const data: MarketData = {
    question:     meta?.question     ?? "Will the Iranian regime fall by June 30?",
    marketUrl:    meta?.marketUrl    ?? `https://polymarket.com/event/${SLUG}`,
    yesPrice,
    noPrice,
    yesTokenId,
    noTokenId:    meta?.noTokenId    ?? FALLBACK_NO_TOKEN,
    volume:       meta?.volume       ?? 0,
    liquidity:    meta?.liquidity    ?? 0,
    spread,
    endDate:      meta?.endDate      ?? "",
    priceHistory: meta?.priceHistory ?? [],
  };

  return {
    data,
    isLoading: metaQuery.isLoading && !metaQuery.data,
  };
}

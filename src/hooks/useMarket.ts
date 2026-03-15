"use client";

import { useQuery } from "@tanstack/react-query";
import { useLivePrices } from "./useLivePrices";

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

const SLUG = "will-the-iranian-regime-fall-by-june-30";

const DEFAULT: MarketData = {
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

async function fetchMarket(): Promise<MarketData> {
  const r = await fetch("/api/market", { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`Market API error: ${r.status}`);
  return r.json();
}

export function useMarket() {
  const { data, isLoading } = useQuery<MarketData>({
    queryKey:        ["market"],
    queryFn:         fetchMarket,
    refetchInterval: 60_000,  // refresh metadata every 60s — live prices come from WS
    staleTime:       55_000,
    retry:           3,
    retryDelay:      2_000,
    initialData:     DEFAULT,
  });

  // WebSocket live price feed — updates on every order book change (ms-level)
  const live = useLivePrices(data?.yesTokenId || undefined);

  // Merge: WebSocket prices override the HTTP-fetched snapshot when available
  const merged: MarketData = live
    ? { ...data!, yesPrice: live.yesPrice, noPrice: live.noPrice, spread: live.spread }
    : data!;

  return { data: merged, isLoading };
}

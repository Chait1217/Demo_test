"use client";

import { useQuery } from "@tanstack/react-query";

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
    refetchInterval: 10_000,   // poll every 10s — server caches prices for 8s
    staleTime:       8_000,
    retry:           3,
    retryDelay:      2_000,
    initialData:     DEFAULT,
  });

  return { data: data!, isLoading };
}

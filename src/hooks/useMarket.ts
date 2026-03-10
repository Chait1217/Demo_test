"use client";

import { useQuery } from "@tanstack/react-query";
import type { MarketData } from "@/app/api/market/route";

export function useMarket() {
  return useQuery<MarketData>({
    queryKey: ["market"],
    queryFn: async () => {
      const res = await fetch("/api/market");
      if (!res.ok) throw new Error("Failed to fetch market");
      return res.json();
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

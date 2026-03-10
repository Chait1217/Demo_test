"use client";

import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Position } from "@/server/positionsStore";

export function usePositions() {
  const { address } = useAccount();

  const query = useQuery<Position[]>({
    queryKey: ["positions", address],
    queryFn: async () => {
      if (!address) return [];
      const res = await fetch(`/api/positions?walletAddress=${address}`);
      if (!res.ok) throw new Error("Failed to load positions");
      return res.json();
    },
    enabled: Boolean(address),
    refetchInterval: 10_000,
  });

  return query;
}


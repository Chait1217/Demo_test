"use client";

import { useAccount } from "wagmi";
import { useState, useEffect, useCallback } from "react";
import { simVaultUserBalance, simVaultTVL, subscribeSimState } from "@/lib/simState";

export interface VaultSnapshot {
  tvl: number;
  totalBorrowed: number;
  available: number;
  utilization: number;
  userShare: number;
  maxWithdraw: number;
}

export function useVault(): {
  snapshot?: VaultSnapshot;
  isLoading: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const [, rerender] = useState(0);

  // Re-render whenever simState changes (deposit / withdraw)
  useEffect(() => subscribeSimState(() => rerender((n) => n + 1)), []);

  const refetch = useCallback(() => rerender((n) => n + 1), []);

  if (!address) return { snapshot: undefined, isLoading: false, refetch };

  const tvl       = simVaultTVL();
  const userShare = simVaultUserBalance(address);

  return {
    snapshot: {
      tvl,
      totalBorrowed: 0,
      available:     tvl,
      utilization:   0,
      userShare,
      maxWithdraw:   userShare,
    },
    isLoading: false,
    refetch,
  };
}

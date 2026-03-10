"use client";

import { useAccount, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { leveragedVaultAbi, leveragedVaultAddress } from "@/lib/vaultAbi";

export interface VaultSnapshot {
  tvl: number;
  totalBorrowed: number;
  available: number;
  utilization: number;
  userShare: number;
  maxWithdraw: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const hasVault =
  leveragedVaultAddress &&
  leveragedVaultAddress.toLowerCase() !== ZERO_ADDRESS;

export function useVault(): {
  snapshot?: VaultSnapshot;
  isLoading: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const enabled = Boolean(hasVault && address);

  const { data, isLoading, refetch } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS, abi: leveragedVaultAbi, functionName: "totalAssets" },
      { address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS, abi: leveragedVaultAbi, functionName: "totalBorrowed" },
      { address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS, abi: leveragedVaultAbi, functionName: "availableLiquidity" },
      { address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS, abi: leveragedVaultAbi, functionName: "utilization" },
      { address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS, abi: leveragedVaultAbi, functionName: "balanceOf", args: [address ?? ZERO_ADDRESS] },
      { address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS, abi: leveragedVaultAbi, functionName: "maxWithdraw", args: [address ?? ZERO_ADDRESS] },
    ],
    query: { enabled, refetchInterval: 10_000 },
  });

  if (!enabled || !data) return { snapshot: undefined, isLoading, refetch };

  const [tvl, borrowed, available, util, userShare, maxWithdrawRaw] = data;
  const toNum = (v: any) => (typeof v === "bigint" ? Number(formatUnits(v, 6)) : 0);
  const utilizationFloat = typeof util?.result === "bigint" ? Number(util.result) / 1e18 : 0;

  return {
    snapshot: {
      tvl:           toNum(tvl?.result),
      totalBorrowed: toNum(borrowed?.result),
      available:     toNum(available?.result),
      utilization:   utilizationFloat,
      userShare:     toNum(userShare?.result),
      maxWithdraw:   toNum(maxWithdrawRaw?.result),
    },
    isLoading,
    refetch,
  };
}

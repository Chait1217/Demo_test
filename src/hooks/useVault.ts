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
  isDeployed: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const enabled = Boolean(hasVault && address);

  const { data, isLoading, refetch, isError } = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS,
        abi: leveragedVaultAbi,
        functionName: "totalAssets",
      },
      {
        address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS,
        abi: leveragedVaultAbi,
        functionName: "totalBorrowed",
      },
      {
        address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS,
        abi: leveragedVaultAbi,
        functionName: "availableLiquidity",
      },
      {
        address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS,
        abi: leveragedVaultAbi,
        functionName: "utilization",
      },
      {
        address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS,
        abi: leveragedVaultAbi,
        functionName: "balanceOf",
        args: [address ?? ZERO_ADDRESS],
      },
      {
        address: hasVault ? leveragedVaultAddress : ZERO_ADDRESS,
        abi: leveragedVaultAbi,
        functionName: "maxWithdraw",
        args: [address ?? ZERO_ADDRESS],
      },
    ],
    query: { enabled, refetchInterval: 10_000 },
  });

  if (!enabled || !data) return { snapshot: undefined, isLoading, isDeployed: false, refetch };

  const [tvl, borrowed, available, util, userShare, maxWithdrawRaw] = data;

  // If every call errored, the contract is not deployed at this address.
  const allFailed = data.every((d) => d.error && !d.result);
  const isDeployed = !allFailed;

  const toNum = (v: any) =>
    typeof v?.result === "bigint" ? Number(formatUnits(v.result, 6)) : 0;
  const utilizationFloat =
    typeof util?.result === "bigint" ? Number(util.result) / 1e18 : 0;

  const tvlNum      = toNum(tvl);
  const borrowedNum = toNum(borrowed);
  // availableLiquidity() = balanceOf(vault) = totalAssets - totalBorrowed.
  // If the call fails (older deployment or RPC issue), derive it from the
  // other two values which are more likely to succeed (public state variable
  // + explicit function). This prevents showing $0.00 when money is present.
  const availableNum = available?.error
    ? Math.max(tvlNum - borrowedNum, 0)
    : toNum(available);

  if (available?.error) {
    console.warn("[useVault] availableLiquidity() call failed — deriving from totalAssets - totalBorrowed:", available.error);
  }

  return {
    snapshot: {
      tvl:           tvlNum,
      totalBorrowed: borrowedNum,
      available:     availableNum,
      utilization:   utilizationFloat,
      userShare:     toNum(userShare),
      maxWithdraw:   toNum(maxWithdrawRaw),
    },
    isLoading,
    isDeployed,
    refetch,
  };
}

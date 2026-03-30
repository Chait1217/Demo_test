"use client";

import { useReadContract, useAccount } from "wagmi";
import { formatUnits } from "viem";
import { USDCe_ADDRESS } from "@/lib/constants";

const ERC20_ABI = [
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function useUsdcBalance() {
  const { address } = useAccount();

  const { data: decimalsData } = useReadContract({
    address: USDCe_ADDRESS,
    abi: ERC20_ABI,
    functionName: "decimals",
  });

  const { data: balanceData } = useReadContract({
    address: USDCe_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address!],
    query: {
      enabled: Boolean(address),
      // Poll every 4s — avoids the wagmi blockNumber prop which is broken in
      // some configurations (causes 0-flicker on every block, infinite refetch).
      refetchInterval: 4_000,
      placeholderData: (prev: bigint | undefined) => prev,
    },
  });

  if (!balanceData || decimalsData === undefined) {
    return { display: "$0.00", rawBalance: 0 };
  }

  const value = Number(formatUnits(balanceData as bigint, Number(decimalsData)));
  const display = `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return { display, rawBalance: value };
}

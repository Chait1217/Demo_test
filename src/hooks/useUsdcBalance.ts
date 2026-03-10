"use client";

import { useEffect, useState } from "react";
import { Address, formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { USDCe_ADDRESS } from "@/lib/constants";

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
] as const;

export function useUsdcBalance() {
  const { address } = useAccount();
  const client = usePublicClient();
  const [formatted, setFormatted] = useState("0.00");

  useEffect(() => {
    if (!client || !address) return;

    let cancelled = false;
    async function load() {
      try {
        const [decimals, raw] = await Promise.all([
          client.readContract({
            address: USDCe_ADDRESS,
            abi: ERC20_ABI,
            functionName: "decimals",
          }),
          client.readContract({
            address: USDCe_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address as Address],
          }),
        ]);
        if (cancelled) return;
        const value = Number(formatUnits(raw as bigint, decimals as number));
        setFormatted(value.toLocaleString(undefined, { maximumFractionDigits: 2 }));
      } catch {
        if (!cancelled) setFormatted("0.00");
      }
    }
    load();

    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, address]);

  return {
    display: `$${formatted}`,
  };
}


"use client";

import { useAccount } from "wagmi";
import { useState, useEffect } from "react";
import { simWalletBalance, subscribeSimState } from "@/lib/simState";

export function useUsdcBalance() {
  const { address } = useAccount();
  const [, rerender] = useState(0);

  // Re-render whenever simState changes (deposit / withdraw)
  useEffect(() => subscribeSimState(() => rerender((n) => n + 1)), []);

  const value   = address ? simWalletBalance(address) : 0;
  const display = `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  return { display, rawBalance: value };
}

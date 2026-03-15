"use client";

import { useAccount, useConnect, useDisconnect, useConfig } from "wagmi";

export function useWallet() {
  const { address, isConnecting, isConnected } = useAccount();
  const config = useConfig();
  const { connect, isPending, error, reset } = useConnect();
  const { disconnect } = useDisconnect();

  const isAlreadyPending = error?.message?.includes("already pending");

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isPending,
    connectError: error,
    isAlreadyPending,
    connect: () => {
      // If MetaMask has a stale pending request, clear wagmi state and retry
      if (isAlreadyPending) {
        reset();
        return;
      }
      const connectors = config.connectors;
      const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];
      if (!injected) {
        console.warn("[wallet] no connectors configured");
        return;
      }
      connect({ connector: injected });
    },
    disconnect,
  };
}

"use client";

import { useAccount, useConnect, useDisconnect, useConfig } from "wagmi";

export function useWallet() {
  const { address, isConnecting, isConnected } = useAccount();
  const config = useConfig();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isPending,
    connectError: error,
    connect: () => {
      // Prefer the injected (browser) wallet; fall back through all configured connectors
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

"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export function useWallet() {
  const { address, isConnecting, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isPending,
    // Use the first available connector from wagmi config (injected/MetaMask)
    connect: () => {
      const connector = connectors[0];
      if (connector) connect({ connector });
    },
    disconnect,
  };
}

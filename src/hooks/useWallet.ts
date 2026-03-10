"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";

export function useWallet() {
  const { address, isConnecting, isConnected } = useAccount();
  const { connect, isPending: isConnectPending } = useConnect();
  const { disconnect } = useDisconnect();

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isConnectPending,
    // Create connector inline — never at module scope outside React
    connect: () => connect({ connector: injected() }),
    disconnect,
  };
}

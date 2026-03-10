"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";

const injectedConnector = injected();

export function useWallet() {
  const { address, isConnecting, isConnected } = useAccount();
  const { connect, isPending: isConnectPending } = useConnect();
  const { disconnect } = useDisconnect();

  return {
    address,
    isConnected,
    isConnecting: isConnecting || isConnectPending,
    connect: () => connect({ connector: injectedConnector }),
    disconnect,
  };
}


"use client";

import { ReactNode, useState } from "react";
import { WagmiProvider, createConfig, http, fallback } from "wagmi";
import { polygon } from "wagmi/chains";
import { injected, coinbaseWallet } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Multiple public Polygon RPC endpoints for reliability
const polygonTransport = fallback([
  http("https://polygon-rpc.com"),
  http("https://rpc-mainnet.matic.quiknode.pro"),
  http("https://matic-mainnet.chainstacklabs.com"),
]);

function makeConfig() {
  return createConfig({
    chains: [polygon],
    connectors: [
      injected(),
      coinbaseWallet({ appName: "LevMarket" }),
    ],
    transports: {
      [polygon.id]: polygonTransport,
    },
    ssr: true,
  });
}

export function WalletProviders({ children }: { children: ReactNode }) {
  const [config]      = useState(() => makeConfig());
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry:            2,
        retryDelay:       1_000,
        staleTime:        10_000,
        refetchOnWindowFocus: false,
      },
    },
  }));

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

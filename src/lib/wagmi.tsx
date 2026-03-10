"use client";

import { ReactNode, useState } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { polygon } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function makeConfig() {
  return createConfig({
    chains: [polygon],
    connectors: [injected()],
    transports: {
      [polygon.id]: http(),
    },
    ssr: true,
  });
}

export function WalletProviders({ children }: { children: ReactNode }) {
  const [config] = useState(() => makeConfig());
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}


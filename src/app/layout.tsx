import "./globals.css";
import type { ReactNode } from "react";
import { WalletProviders } from "@/lib/wagmi";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const metadata = {
  title: "IranMarket — Leveraged Prediction Terminal",
  description: "Trade leveraged positions on Will the Iranian regime fall by June 30?",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <ErrorBoundary>
          <WalletProviders>
            {children}
          </WalletProviders>
        </ErrorBoundary>
      </body>
    </html>
  );
}

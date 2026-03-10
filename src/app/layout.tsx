import "./globals.css";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { WalletProviders } from "@/lib/wagmi";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "Leverage Terminal – Iran Regime Market",
  description:
    "Leveraged prediction market terminal for the Polymarket question: Will the Iranian regime fall by June 30?",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.className} min-h-screen`}
        style={{ backgroundColor: "#050711", color: "#f9fafb" }}
      >
        <ErrorBoundary>
          <WalletProviders>
            <div className="min-h-screen" style={{ background: "linear-gradient(to bottom, #050711, #050711, #020311)" }}>
              {children}
            </div>
          </WalletProviders>
        </ErrorBoundary>
      </body>
    </html>
  );
}


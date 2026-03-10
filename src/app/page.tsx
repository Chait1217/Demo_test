"use client";

import { VaultView } from "../components/vault/VaultView";
import { TradingView } from "../components/trading/TradingView";
import { TransactionsView } from "../components/transactions/TransactionsView";
import { useWallet } from "@/hooks/useWallet";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";

export default function HomePage() {
  const { address, isConnected, isConnecting, connect, disconnect } = useWallet();
  const { display: usdcDisplay } = useUsdcBalance();

  const shortAddress =
    address && `${address.slice(0, 6)}…${address.slice(address.length - 4)}`;

  return (
    <main className="px-8 py-6 max-w-7xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Leverage Terminal
          </h1>
          <p className="text-sm text-textSecondary">
            Leveraged prediction market on Polymarket –&nbsp;
            <span className="font-medium text-textPrimary">
              Will the Iranian regime fall by June 30?
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isConnected && (
            <div className="px-3 py-1 rounded-full border border-border text-xs text-textSecondary bg-surface/60 flex items-center gap-2">
              <span>Polygon • USDC.e</span>
              <span className="w-px h-3 bg-border/60" />
              <span className="text-textPrimary font-medium">{usdcDisplay}</span>
            </div>
          )}
          <button
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-black shadow-xl-soft min-w-[150px]"
            onClick={() => (isConnected ? disconnect() : connect())}
            disabled={isConnecting}
          >
            {isConnecting
              ? "Connecting..."
              : isConnected
              ? shortAddress
              : "Connect Wallet"}
          </button>
        </div>
      </header>

      <section className="grid grid-cols-12 gap-6">
        <div className="col-span-12 xl:col-span-4 space-y-6">
          <VaultView />
        </div>
        <div className="col-span-12 xl:col-span-5 space-y-6">
          <TradingView />
        </div>
        <div className="col-span-12 xl:col-span-3 space-y-6">
          <TransactionsView />
        </div>
      </section>
    </main>
  );
}


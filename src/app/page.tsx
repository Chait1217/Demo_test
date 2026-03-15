"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { VaultView } from "@/components/vault/VaultView";
import { TradingView } from "@/components/trading/TradingView";
import { TransactionsView } from "@/components/transactions/TransactionsView";

type Tab = "trade" | "vault" | "history";

export default function HomePage() {
  const { address, isConnected, isConnecting, connect, disconnect, connectError, isAlreadyPending } = useWallet();
  const { display: usdcDisplay } = useUsdcBalance();
  const [tab, setTab] = useState<Tab>("trade");

  const short = address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : null;

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Top bar */}
      <header style={{
        borderBottom: "1px solid var(--border)",
        background: "rgba(7,10,20,0.8)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}>
        <div style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "0 24px",
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
        }}>
          {/* Logo + market badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: "linear-gradient(135deg, var(--accent), #00b8ff)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, fontWeight: 700, color: "#000",
                fontFamily: "var(--mono)",
              }}>L</div>
              <span style={{
                fontFamily: "var(--sans)",
                fontWeight: 700,
                fontSize: 16,
                color: "var(--text-1)",
                letterSpacing: "-0.02em",
              }}>LevMarket</span>
            </div>
            <div style={{
              height: 20,
              width: 1,
              background: "var(--border)",
            }} />
            <div className="pill pill-live" style={{ fontSize: 10 }}>
              Iran Regime Market
            </div>
          </div>

          {/* Nav tabs */}
          <nav style={{ display: "flex", gap: 4 }}>
            {(["trade", "vault", "history"] as Tab[]).map((t) => (
              <button
                key={t}
                className={`nav-tab ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "trade" ? "Trade" : t === "vault" ? "Vault" : "History"}
              </button>
            ))}
          </nav>

          {/* Wallet */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {isConnected && (
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "5px 12px",
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--text-2)",
              }}>
                <span style={{ color: "var(--text-3)" }}>USDC.e</span>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{usdcDisplay}</span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <button
                style={{
                  background: isConnected ? "var(--surface-2)" : "var(--accent)",
                  border: isConnected ? "1px solid var(--border)" : "none",
                  borderRadius: 8,
                  padding: "7px 16px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  fontWeight: 600,
                  color: isConnected ? "var(--text-2)" : "#000",
                  cursor: (isConnecting && !isAlreadyPending) ? "not-allowed" : "pointer",
                  transition: "all 150ms",
                  minWidth: 140,
                  opacity: (isConnecting && !isAlreadyPending) ? 0.6 : 1,
                }}
                onClick={() => isConnected ? disconnect() : connect()}
                disabled={isConnecting && !isAlreadyPending}
              >
                {isAlreadyPending
                  ? "Retry Connect"
                  : isConnecting ? "Connecting…"
                  : isConnected ? short
                  : "Connect Wallet"}
              </button>
              {connectError && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#ff6b6b" }}>
                  {isAlreadyPending
                    ? "Open MetaMask and approve, or click Retry"
                    : connectError.message.includes("provider")
                    ? "No wallet detected — install MetaMask"
                    : connectError.message.slice(0, 60)}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Market banner */}
      <div style={{
        background: "linear-gradient(90deg, rgba(0,229,160,0.04), rgba(77,159,255,0.04))",
        borderBottom: "1px solid var(--border)",
        padding: "10px 24px",
      }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Active Market</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600, color: "var(--text-1)" }}>
              Will the Iranian regime fall by June 30?
            </span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>
            Powered by Polymarket • Polygon Network
          </div>
        </div>
      </div>

      {/* Main content */}
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "24px" }}>
        {tab === "trade" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>
            <TradingView />
            <VaultView />
          </div>
        )}
        {tab === "vault" && <VaultView fullWidth />}
        {tab === "history" && <TransactionsView />}
      </main>
    </div>
  );
}

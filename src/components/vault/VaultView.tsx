"use client";

import { useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { polygon } from "wagmi/chains";
import { useVault } from "@/hooks/useVault";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { simDeposit, simWithdraw } from "@/lib/simState";

type Phase = "idle" | "done" | "error";

export function VaultView({ fullWidth = false }: { fullWidth?: boolean }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const isWrongChain = isConnected && chainId !== polygon.id;

  const { snapshot, isLoading, refetch: refetchVault } = useVault();
  const { display: usdcDisplay, rawBalance } = useUsdcBalance();

  const [amount, setAmount] = useState("");
  const [mode, setMode]     = useState<"deposit" | "withdraw">("deposit");
  const [phase, setPhase]   = useState<Phase>("idle");
  const [errMsg, setErrMsg] = useState("");

  const val = parseFloat(amount) || 0;

  function reset() {
    setPhase("idle");
    setErrMsg("");
    setAmount("");
  }

  function handleDeposit() {
    if (!address || val <= 0) return;
    if (val > (rawBalance ?? 0)) {
      setErrMsg("Amount exceeds your wallet balance.");
      setPhase("error");
      return;
    }
    simDeposit(address, val);
    refetchVault();
    setAmount("");
    setPhase("done");
  }

  function handleWithdraw() {
    if (!address || val <= 0) return;
    if (val > (snapshot?.maxWithdraw ?? 0)) {
      setErrMsg("Amount exceeds your vault balance.");
      setPhase("error");
      return;
    }
    simWithdraw(address, val);
    refetchVault();
    setAmount("");
    setPhase("done");
  }

  const fmt = (v?: number) =>
    v !== undefined
      ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "—";

  const utilizationPct = (snapshot?.utilization ?? 0) * 100;

  const stats = [
    { label: "Vault TVL",           value: fmt(snapshot?.tvl),          highlight: false },
    { label: "Total Borrowed",      value: fmt(snapshot?.totalBorrowed), highlight: false },
    { label: "Available Liquidity", value: fmt(snapshot?.available),     highlight: true  },
    { label: "Your Balance",        value: fmt(snapshot?.userShare),     highlight: false },
    { label: "Max Withdraw",        value: fmt(snapshot?.maxWithdraw),   highlight: false },
  ];

  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="card-header">
        <div>
          <div className="metric-label" style={{ marginBottom: 3 }}>LP Vault</div>
          <div style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>
            USDC.e Liquidity Pool
          </div>
        </div>
        <div className={`pill ${isLoading ? "" : "pill-live"}`}>{isLoading ? "Syncing" : "Live"}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fullWidth ? "repeat(5, 1fr)" : "repeat(2, 1fr)", gap: 10, marginBottom: 18 }}>
        {stats.map(({ label, value, highlight }) => (
          <div key={label} className="stat-box">
            <div className="metric-label" style={{ marginBottom: 5 }}>{label}</div>
            <div className="metric-value" style={{ fontSize: 15, color: highlight ? "var(--accent)" : "var(--text-1)" }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span className="metric-label">Utilization</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: utilizationPct > 80 ? "var(--danger)" : "var(--text-2)" }}>
            {utilizationPct.toFixed(1)}%
          </span>
        </div>
        <div className="util-bar-track">
          <div className="util-bar-fill" style={{ width: `${Math.min(utilizationPct, 100)}%` }} />
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", marginTop: 5 }}>
          Borrow APR: {(5 + utilizationPct * 0.73).toFixed(1)}% est.
        </div>
      </div>

      {isConnected ? (
        <div>
          {isWrongChain && (
            <div className="alert-error" style={{ marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span>⚠ Wallet is on the wrong network. Switch to Polygon to deposit.</span>
              <button
                className="btn-primary"
                style={{ padding: "6px 14px", fontSize: 11, whiteSpace: "nowrap" }}
                disabled={isSwitching}
                onClick={() => switchChain({ chainId: polygon.id })}
              >
                {isSwitching ? "Switching…" : "Switch to Polygon"}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {(["deposit", "withdraw"] as const).map((m) => (
              <button
                key={m}
                className={`nav-tab ${mode === m ? "active" : ""}`}
                style={{ flex: 1, textAlign: "center" }}
                onClick={() => { setMode(m); reset(); }}
              >
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <label className="metric-label">Amount</label>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>
                Wallet: <span style={{ color: "var(--text-2)" }}>{usdcDisplay}</span>
              </span>
            </div>
            <div style={{ position: "relative" }}>
              <input
                className="input"
                type="number"
                min={0}
                value={amount}
                onChange={(e) => { setAmount(e.target.value); if (phase !== "idle") reset(); }}
                placeholder="0.00"
              />
              <button
                onClick={() =>
                  mode === "deposit"
                    ? setAmount((rawBalance ?? 0).toFixed(2))
                    : setAmount((snapshot?.maxWithdraw ?? 0).toFixed(2))
                }
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
              >
                MAX
              </button>
            </div>
          </div>

          {mode === "deposit" ? (
            <button
              className="btn-primary"
              style={{ width: "100%" }}
              disabled={val <= 0 || isWrongChain}
              onClick={handleDeposit}
            >
              Deposit USDC.e
            </button>
          ) : (
            <button
              className="btn-primary"
              style={{ width: "100%" }}
              disabled={val <= 0 || val > (snapshot?.maxWithdraw ?? 0) || isWrongChain}
              onClick={handleWithdraw}
            >
              Withdraw USDC.e
            </button>
          )}

          {phase === "done"  && <div className="alert-success" style={{ marginTop: 10 }}>✓ {mode === "deposit" ? "Deposit confirmed!" : "Withdrawal confirmed!"}</div>}
          {phase === "error" && errMsg && <div className="alert-error" style={{ marginTop: 10 }}>✕ {errMsg}</div>}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "16px", background: "var(--surface-2)", borderRadius: 10, border: "1px solid var(--border)" }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)", margin: 0 }}>
            Connect wallet to deposit or withdraw
          </p>
        </div>
      )}

      <div className="gradient-line" />
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", lineHeight: 1.8 }}>
        <div>Open/Close Fee: 0.4% of notional → 50% vault · 30% insurance · 20% treasury</div>
        <div>Borrow APR: 5%–78% (kink model) → same 50/30/20 split</div>
        <div>Liquidation Fee: 5% of collateral → 50% vault · 30% insurance · 20% treasury</div>
      </div>
    </div>
  );
}

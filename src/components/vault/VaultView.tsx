"use client";

import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { useVault } from "@/hooks/useVault";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { USDCe_ADDRESS, VAULT_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi, leveragedVaultAddress } from "@/lib/vaultAbi";

const ZERO = "0x0000000000000000000000000000000000000000";
const hasVault = leveragedVaultAddress && leveragedVaultAddress !== ZERO;

const ERC20_APPROVE_ABI = [
  {
    constant: false,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const;

export function VaultView({ fullWidth = false }: { fullWidth?: boolean }) {
  const { address, isConnected } = useAccount();
  const { snapshot, isLoading } = useVault();
  const { display: usdcDisplay, rawBalance } = useUsdcBalance();
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [txMsg, setTxMsg] = useState("");

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isTxLoading, isSuccess: isTxSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const busy = isPending || isTxLoading || !hasVault;
  const val = parseFloat(amount) || 0;

  const fmt = (v?: number) =>
    v !== undefined ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";

  const utilizationPct = ((snapshot?.utilization ?? 0) * 100);

  function approve() {
    if (!address || val <= 0 || !hasVault) return;
    writeContract({
      address: USDCe_ADDRESS,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [leveragedVaultAddress, parseUnits(val.toString(), 6)],
    });
    setTxMsg("Approval sent…");
  }

  function deposit() {
    if (!address || val <= 0 || !hasVault) return;
    writeContract({
      address: leveragedVaultAddress,
      abi: leveragedVaultAbi,
      functionName: "deposit",
      args: [parseUnits(val.toString(), 6), address],
    });
    setTxMsg("Deposit sent…");
  }

  function withdraw() {
    if (!address || val <= 0 || !hasVault) return;
    writeContract({
      address: leveragedVaultAddress,
      abi: leveragedVaultAbi,
      functionName: "withdraw",
      args: [parseUnits(val.toString(), 6), address, address],
    });
    setTxMsg("Withdrawal sent…");
  }

  const stats = [
    { label: "Vault TVL", value: fmt(snapshot?.tvl), highlight: false },
    { label: "Total Borrowed", value: fmt(snapshot?.totalBorrowed), highlight: false },
    { label: "Available Liquidity", value: fmt(snapshot?.available), highlight: true },
    { label: "Your Balance", value: fmt(snapshot?.userShare), highlight: false },
    { label: "Max Withdraw", value: fmt(snapshot?.maxWithdraw), highlight: false },
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
        <div className={`pill ${isLoading ? "" : "pill-live"}`}>
          {isLoading ? "Syncing" : "Live"}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: fullWidth ? "repeat(5, 1fr)" : "repeat(2, 1fr)",
        gap: 10,
        marginBottom: 18,
      }}>
        {stats.map(({ label, value, highlight }) => (
          <div key={label} className="stat-box">
            <div className="metric-label" style={{ marginBottom: 5 }}>{label}</div>
            <div className="metric-value" style={{
              fontSize: 15,
              color: highlight ? "var(--accent)" : "var(--text-1)",
            }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Utilization bar */}
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

      {/* Deposit / Withdraw */}
      {isConnected ? (
        <div>
          {/* Tab toggle */}
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {(["deposit", "withdraw"] as const).map((m) => (
              <button
                key={m}
                className={`nav-tab ${mode === m ? "active" : ""}`}
                style={{ flex: 1, textAlign: "center" }}
                onClick={() => setMode(m)}
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
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
              <button
                onClick={() => {
                  if (mode === "deposit") setAmount((rawBalance ?? 0).toFixed(2));
                  else setAmount((snapshot?.maxWithdraw ?? 0).toFixed(2));
                }}
                style={{
                  position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
                  background: "none", border: "none", cursor: "pointer",
                }}
              >
                MAX
              </button>
            </div>
          </div>

          {mode === "deposit" ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-outline" style={{ flex: 1 }} disabled={busy || val <= 0} onClick={approve}>
                Approve
              </button>
              <button className="btn-primary" style={{ flex: 2 }} disabled={busy || val <= 0} onClick={deposit}>
                {isTxLoading ? "Confirming…" : "Deposit USDC.e"}
              </button>
            </div>
          ) : (
            <button
              className="btn-primary"
              style={{ width: "100%" }}
              disabled={busy || val <= 0 || val > (snapshot?.maxWithdraw ?? 0)}
              onClick={withdraw}
            >
              {isTxLoading ? "Confirming…" : "Withdraw USDC.e"}
            </button>
          )}

          {txMsg && (
            <div className="alert-success" style={{ marginTop: 10 }}>
              {isTxSuccess ? "✓ Transaction confirmed!" : txMsg}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          textAlign: "center",
          padding: "16px",
          background: "var(--surface-2)",
          borderRadius: 10,
          border: "1px solid var(--border)",
        }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)", margin: 0 }}>
            Connect wallet to deposit or withdraw
          </p>
        </div>
      )}

      {/* Fee info */}
      <div className="gradient-line" />
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", lineHeight: 1.8 }}>
        <div>Open/Close Fee: 0.4% of notional → 50% vault · 30% insurance · 20% treasury</div>
        <div>Borrow APR: 5%–78% (kink model) → same 50/30/20 split</div>
        <div>Liquidation Fee: 5% of collateral → 50% vault · 30% insurance · 20% treasury</div>
      </div>
    </div>
  );
}

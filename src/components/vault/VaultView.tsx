"use client";

import { useState, useEffect, useRef } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useChainId,
  useSwitchChain,
  usePublicClient,
} from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { polygon } from "wagmi/chains";
import { useVault } from "@/hooks/useVault";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { USDCe_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi, leveragedVaultAddress } from "@/lib/vaultAbi";

/** Parse amount string directly to avoid float precision loss */
function safeParseAmount(s: string): bigint {
  if (!s || !s.trim()) return 0n;
  try {
    const [int, dec = ""] = s.trim().split(".");
    const truncated = dec.length > 6 ? `${int}.${dec.slice(0, 6)}` : s.trim();
    return parseUnits(truncated, 6);
  } catch {
    return 0n;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const hasVault = leveragedVaultAddress && leveragedVaultAddress.toLowerCase() !== ZERO;

const ERC20_ABI = [
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance", outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view", type: "function",
  },
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve", outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable", type: "function",
  },
] as const;

type Phase = "idle" | "simulating" | "approving" | "depositPending" | "done" | "error";

/** Extract a human-readable message from a wagmi/viem error */
function extractError(e: unknown): string {
  if (!e) return "Transaction failed";
  const err = e as any;
  // Contract revert with reason string
  if (err.cause?.reason) return err.cause.reason;
  if (err.cause?.shortMessage) return err.cause.shortMessage;
  if (err.shortMessage) return err.shortMessage;
  if (err.message?.includes("reverted")) {
    const m = err.message.match(/reason: "(.+?)"/);
    if (m) return m[1];
    return "Transaction reverted — check vault contract is deployed and you have sufficient USDC.e balance.";
  }
  if (err.message?.includes("ContractFunctionZeroDataError") || err.message?.includes("returned no data")) {
    return "Vault contract not found at this address. Please check NEXT_PUBLIC_VAULT_ADDRESS is set to the deployed contract.";
  }
  return err.message ?? "Transaction failed";
}

export function VaultView({ fullWidth = false }: { fullWidth?: boolean }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const isWrongChain = isConnected && chainId !== polygon.id;
  const publicClient = usePublicClient();
  const { snapshot, isLoading, isDeployed, refetch: refetchVault } = useVault();
  const { display: usdcDisplay, rawBalance } = useUsdcBalance();
  const [amount, setAmount] = useState("");
  const [mode, setMode]     = useState<"deposit" | "withdraw">("deposit");
  const [phase, setPhase]   = useState<Phase>("idle");
  const [errMsg, setErrMsg] = useState("");

  const val      = parseFloat(amount) || 0;
  const amountRaw = safeParseAmount(amount);
  const amountRawRef = useRef(0n);
  amountRawRef.current = amountRaw;

  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: [address ?? ZERO, leveragedVaultAddress],
    query: { enabled: Boolean(address && hasVault), refetchInterval: 5_000 },
  });
  const currentAllowance = allowanceData ? Number(formatUnits(allowanceData as bigint, 6)) : 0;
  const needsApproval = mode === "deposit" && val > 0 && currentAllowance < val;

  const { writeContract: sendApprove,  data: approveTxHash,  isPending: approveWalletPending,  error: approveError,  reset: resetApprove  } = useWriteContract();
  const { writeContract: sendDeposit,  data: depositTxHash,  isPending: depositWalletPending,  error: depositError,  reset: resetDeposit  } = useWriteContract();
  const { writeContract: sendWithdraw, data: withdrawTxHash, isPending: withdrawWalletPending, error: withdrawError, reset: resetWithdraw } = useWriteContract();

  const { isLoading: approveConfirming, isSuccess: approveConfirmed } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { isLoading: depositConfirming, isSuccess: depositConfirmed } = useWaitForTransactionReceipt({ hash: depositTxHash });
  const { isLoading: withdrawConfirming, isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({ hash: withdrawTxHash });

  // Approval confirmed → fire deposit automatically
  useEffect(() => {
    if (approveConfirmed && phase === "approving" && address) {
      const raw = amountRawRef.current;
      if (raw > 0n) {
        refetchAllowance();
        setPhase("depositPending");
        sendDeposit({
          address: leveragedVaultAddress,
          abi: leveragedVaultAbi,
          functionName: "deposit",
          args: [raw, address],
        });
      }
    }
  }, [approveConfirmed]); // eslint-disable-line

  useEffect(() => {
    if (depositConfirmed) { setPhase("done"); setAmount(""); refetchAllowance(); refetchVault(); }
  }, [depositConfirmed]); // eslint-disable-line

  useEffect(() => {
    if (withdrawConfirmed) { setPhase("done"); setAmount(""); refetchVault(); }
  }, [withdrawConfirmed]); // eslint-disable-line

  useEffect(() => {
    const e = approveError || depositError || withdrawError;
    if (e) { setErrMsg(extractError(e)); setPhase("error"); }
  }, [approveError, depositError, withdrawError]);

  async function handleDeposit() {
    if (!address || amountRaw <= 0n || !hasVault || !publicClient) return;
    setErrMsg(""); resetApprove(); resetDeposit(); resetWithdraw();

    // Simulate first to surface the real revert reason before asking wallet
    setPhase("simulating");
    try {
      await publicClient.simulateContract({
        address: leveragedVaultAddress,
        abi: leveragedVaultAbi,
        functionName: "deposit",
        args: [amountRaw, address],
        account: address,
      });
    } catch (simErr: any) {
      // Only bail on simulation errors that are NOT "insufficient allowance"
      // (allowance will be fixed by the approve step).
      const msg = simErr?.message ?? "";
      const isAllowanceErr =
        msg.includes("allowance") ||
        msg.includes("ERC20: transfer amount exceeds allowance") ||
        msg.includes("transfer failed");
      if (!isAllowanceErr) {
        setErrMsg(extractError(simErr));
        setPhase("error");
        return;
      }
    }

    if (needsApproval) {
      setPhase("approving");
      sendApprove({
        address: USDCe_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [leveragedVaultAddress, amountRaw],
      });
    } else {
      setPhase("depositPending");
      sendDeposit({
        address: leveragedVaultAddress,
        abi: leveragedVaultAbi,
        functionName: "deposit",
        args: [amountRaw, address],
      });
    }
  }

  async function handleWithdraw() {
    if (!address || amountRaw <= 0n || !hasVault || !publicClient) return;
    setErrMsg(""); resetApprove(); resetDeposit(); resetWithdraw();

    setPhase("simulating");
    try {
      await publicClient.simulateContract({
        address: leveragedVaultAddress,
        abi: leveragedVaultAbi,
        functionName: "withdraw",
        args: [amountRaw, address, address],
        account: address,
      });
    } catch (simErr: any) {
      setErrMsg(extractError(simErr));
      setPhase("error");
      return;
    }

    setPhase("idle");
    sendWithdraw({
      address: leveragedVaultAddress,
      abi: leveragedVaultAbi,
      functionName: "withdraw",
      args: [amountRaw, address, address],
    });
  }

  function reset() { setPhase("idle"); setErrMsg(""); setAmount(""); resetApprove(); resetDeposit(); resetWithdraw(); }

  const busy = phase === "simulating" || approveWalletPending || approveConfirming || depositWalletPending || depositConfirming || withdrawWalletPending || withdrawConfirming;

  function depositLabel() {
    if (phase === "simulating")   return "Validating…";
    if (approveWalletPending)     return "Confirm approval in wallet…";
    if (approveConfirming)        return "Waiting for approval (1/2)…";
    if (depositWalletPending)     return "Confirm deposit in wallet…";
    if (depositConfirming)        return "Confirming deposit (2/2)…";
    return needsApproval ? "Approve & Deposit USDC.e" : "Deposit USDC.e";
  }

  const fmt = (v?: number) => v !== undefined ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
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
          <div style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>USDC.e Liquidity Pool</div>
        </div>
        <div className={`pill ${isLoading ? "" : "pill-live"}`}>{isLoading ? "Syncing" : "Live"}</div>
      </div>

      {/* Warn if vault contract is not deployed */}
      {!isLoading && isConnected && !isDeployed && (
        <div className="alert-error" style={{ marginBottom: 14, fontSize: 11 }}>
          ⚠ Vault contract not found at <code style={{ fontSize: 10 }}>{leveragedVaultAddress}</code>. Deploy <code style={{ fontSize: 10 }}>LeveragedVault.sol</code> to Polygon and set <code style={{ fontSize: 10 }}>NEXT_PUBLIC_VAULT_ADDRESS</code>.
        </div>
      )}

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
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: utilizationPct > 80 ? "var(--danger)" : "var(--text-2)" }}>{utilizationPct.toFixed(1)}%</span>
        </div>
        <div className="util-bar-track"><div className="util-bar-fill" style={{ width: `${Math.min(utilizationPct, 100)}%` }} /></div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", marginTop: 5 }}>Borrow APR: {(5 + utilizationPct * 0.73).toFixed(1)}% est.</div>
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
              <button key={m} className={`nav-tab ${mode === m ? "active" : ""}`} style={{ flex: 1, textAlign: "center" }} onClick={() => { setMode(m); reset(); }}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <label className="metric-label">Amount</label>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>Wallet: <span style={{ color: "var(--text-2)" }}>{usdcDisplay}</span></span>
            </div>
            <div style={{ position: "relative" }}>
              <input className="input" type="number" min={0} value={amount} onChange={(e) => { setAmount(e.target.value); if (phase === "done" || phase === "error") reset(); }} placeholder="0.00" disabled={busy} />
              <button onClick={() => mode === "deposit" ? setAmount((rawBalance ?? 0).toFixed(6)) : setAmount((snapshot?.maxWithdraw ?? 0).toFixed(6))}
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>
                MAX
              </button>
            </div>
          </div>

          {mode === "deposit" && val > 0 && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, marginBottom: 8, color: needsApproval ? "var(--warn)" : "var(--accent)" }}>
              {needsApproval ? "⚠ Will prompt wallet twice: approve then deposit" : "✓ Already approved — single transaction"}
            </div>
          )}

          {mode === "deposit" ? (
            <button className="btn-primary" style={{ width: "100%" }} disabled={busy || amountRaw <= 0n || isWrongChain || !isDeployed} onClick={handleDeposit}>{depositLabel()}</button>
          ) : (
            <button className="btn-primary" style={{ width: "100%" }} disabled={busy || amountRaw <= 0n || val > (snapshot?.maxWithdraw ?? 0) || isWrongChain || !isDeployed} onClick={handleWithdraw}>
              {phase === "simulating" ? "Validating…" : withdrawWalletPending || withdrawConfirming ? "Confirming…" : "Withdraw USDC.e"}
            </button>
          )}

          {phase === "done"           && <div className="alert-success" style={{ marginTop: 10 }}>✓ {mode === "deposit" ? "Deposit confirmed!" : "Withdrawal confirmed!"}</div>}
          {phase === "error"          && errMsg && <div className="alert-error" style={{ marginTop: 10 }}>✕ {errMsg}</div>}
          {phase === "simulating"     && <div className="alert-success" style={{ marginTop: 10 }}>Validating transaction…</div>}
          {phase === "approving"      && !approveError && <div className="alert-success" style={{ marginTop: 10 }}>Step 1 of 2: Approve USDC.e — confirm in your wallet</div>}
          {phase === "depositPending" && !depositError && <div className="alert-success" style={{ marginTop: 10 }}>Step 2 of 2: Depositing — confirm in your wallet</div>}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "16px", background: "var(--surface-2)", borderRadius: 10, border: "1px solid var(--border)" }}>
          <p style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)", margin: 0 }}>Connect wallet to deposit or withdraw</p>
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

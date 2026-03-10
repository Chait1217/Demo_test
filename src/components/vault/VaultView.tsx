"use client";

import { useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits } from "viem";
import { useVault } from "@/hooks/useVault";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { USDCe_ADDRESS } from "@/lib/constants";
import {
  leveragedVaultAbi,
  leveragedVaultAddress,
} from "@/lib/vaultAbi";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const hasVault = leveragedVaultAddress && leveragedVaultAddress !== ZERO_ADDRESS;

const ERC20_ABI = [
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

export function VaultView() {
  const { address, isConnected } = useAccount();
  const { snapshot, isLoading } = useVault();
  const { display: usdcDisplay } = useUsdcBalance();
  const [amount, setAmount] = useState("");

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isTxLoading } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const disabled = !isConnected || isPending || isTxLoading || !hasVault;

  const fmt = (v?: number) =>
    `$${(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <section className="card-surface p-5 space-y-4">
      <div className="card-header">
        <div>
          <h2 className="text-sm font-medium text-textSecondary">
            LP Vault – USDC.e
          </h2>
          <p className="text-xs text-textSecondary/80">
            Provide liquidity to back leveraged positions on the Iran regime
            market.
          </p>
        </div>
        <span className="pill">{isLoading ? "Syncing…" : "Live"}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="metric-label">Vault TVL</div>
          <div className="metric-value">{fmt(snapshot?.tvl)}</div>
        </div>
        <div>
          <div className="metric-label">Total Borrowed</div>
          <div className="metric-value">{fmt(snapshot?.totalBorrowed)}</div>
        </div>
        <div>
          <div className="metric-label">Your Vault Balance</div>
          <div className="metric-value">{fmt(snapshot?.userShare)}</div>
        </div>
        <div>
          <div className="metric-label">Available Liquidity</div>
          <div className="metric-value">{fmt(snapshot?.available)}</div>
        </div>
      </div>

      <div className="rounded-2xl bg-surfaceMuted border border-border/60 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-textSecondary">
            Wallet balance (USDC.e)
          </span>
          <span className="text-xs font-medium text-textPrimary">
            {usdcDisplay}
          </span>
        </div>

        <div className="flex gap-3">
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 rounded-xl bg-background border border-border px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            className="btn-outline w-24"
            disabled={disabled}
            onClick={() => {
              if (!address) return;
              const v = parseFloat(amount);
              if (!Number.isFinite(v) || v <= 0) return;
              const raw = parseUnits(v.toString(), 6);
              if (!hasVault) return;
              writeContract({
                address: USDCe_ADDRESS,
                abi: ERC20_ABI,
                functionName: "approve",
                args: [leveragedVaultAddress, raw],
              });
            }}
          >
            Approve
          </button>
          <button
            className="btn-primary w-28"
            onClick={() => {
              if (!address || !hasVault) return;
              const v = parseFloat(amount);
              if (!Number.isFinite(v) || v <= 0) return;
              const raw = parseUnits(v.toString(), 6);
              writeContract({
                address: leveragedVaultAddress,
                abi: leveragedVaultAbi,
                functionName: "deposit",
                args: [raw, address],
              });
            }}
            disabled={disabled}
          >
            Deposit
          </button>
          <button
            className="btn-outline w-28"
            onClick={() => {
              if (!address || !hasVault) return;
              const v = parseFloat(amount);
              if (!Number.isFinite(v) || v <= 0) return;
              const raw = parseUnits(v.toString(), 6);
              writeContract({
                address: leveragedVaultAddress,
                abi: leveragedVaultAbi,
                functionName: "withdraw",
                args: [raw, address, address],
              });
            }}
            disabled={disabled || !hasVault || (snapshot?.maxWithdraw ?? 0) <= 0}
          >
            Withdraw
          </button>
        </div>

        <p className="text-[11px] leading-snug text-textSecondary/80">
          Funds in this vault are lent to traders as leverage on the Polymarket
          question{" "}
          <span className="text-textPrimary">
            “Will the Iranian regime fall by June 30?”
          </span>
          . Borrow interest and trading fees stream back to LPs, insurance, and
          treasury.
        </p>
      </div>
    </section>
  );
}


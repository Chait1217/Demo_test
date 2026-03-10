"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useVault } from "@/hooks/useVault";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { computePositionPreview } from "@/lib/leverage";

export function TradingView() {
  const { isConnected, address } = useAccount();
  const { snapshot } = useVault();
  const { display: usdcDisplay } = useUsdcBalance();

  const [side, setSide] = useState<"YES" | "NO" | null>(null);
  const [collateral, setCollateral] = useState("");
  const [leverage, setLeverage] = useState(1);

  const numericCollateral = parseFloat(collateral) || 0;
  const utilization = snapshot?.utilization ?? 0;
  const preview = computePositionPreview(
    { collateral: numericCollateral, leverage },
    utilization
  );

  const yesPrice = 0.5; // TODO: live via Polymarket markets API
  const noPrice = 1 - yesPrice;

  async function submit() {
    if (!isConnected || !address || !side) return;
    if (numericCollateral <= 0) return;

    const res = await fetch("/api/trade/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: address,
        side,
        collateral: numericCollateral,
        leverage,
        price: side === "YES" ? yesPrice : noPrice,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      alert(text);
      return;
    }

    const json = await res.json();
    alert(`Trade opened. Order ID: ${json.orderId}`);
  }

  return (
    <section className="space-y-4">
      <div className="card-surface p-5 space-y-4">
        <div className="card-header">
          <div>
            <h2 className="text-sm font-medium text-textSecondary">
              Trading – Leveraged Market
            </h2>
            <p className="text-xs text-textSecondary/80 max-w-md">
              “Will the Iranian regime fall by June 30?”
            </p>
          </div>
          <span className="pill">Polymarket • Live</span>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 rounded-2xl bg-surfaceMuted border border-border/60 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="metric-label">Orderbook Snapshot</span>
              <span className="text-xs text-textSecondary">
                YES / NO mid prices
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <div className="text-xs text-emerald-300 font-medium">
                  YES PRICE
                </div>
                <div className="text-2xl font-semibold">
                  {yesPrice.toFixed(2)}
                </div>
                <div className="text-[11px] text-textSecondary">
                  Outcome token representing regime falls by June 30.
                </div>
              </div>
              <div className="space-y-1 text-right">
                <div className="text-xs text-sky-300 font-medium">
                  NO PRICE
                </div>
                <div className="text-2xl font-semibold">
                  {noPrice.toFixed(2)}
                </div>
                <div className="text-[11px] text-textSecondary">
                  Outcome token representing regime does not fall by June 30.
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-surfaceMuted border border-border/60 p-4 space-y-3">
            <div className="metric-label">Vault Utilization</div>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-semibold">
                {(utilization * 100).toFixed(1)}%
              </span>
              <span className="text-[11px] text-textSecondary">
                Drives borrow APR and leverage limits.
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-background overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(utilization * 100, 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card-surface p-5 space-y-4">
        <div className="card-header">
          <h3 className="text-sm font-medium text-textSecondary">
            Open Leveraged Position
          </h3>
          <span className="pill">1x – 5x Leverage</span>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="flex gap-2">
              <button
                className={`flex-1 ${
                  side === "YES" ? "btn-primary" : "btn-outline"
                }`}
                onClick={() => setSide("YES")}
              >
                YES
              </button>
              <button
                className={`flex-1 ${
                  side === "NO" ? "btn-primary" : "btn-outline"
                }`}
                onClick={() => setSide("NO")}
              >
                NO
              </button>
            </div>

            <div className="space-y-2">
              <label className="flex items-center justify-between text-xs text-textSecondary">
                <span>Collateral (USDC.e)</span>
                <span>Wallet: {usdcDisplay}</span>
              </label>
              <input
                type="number"
                min={0}
                value={collateral}
                onChange={(e) => setCollateral(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-xl bg-background border border-border px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-textSecondary">
                <span>Leverage</span>
                <span>Max 5x, based on vault liquidity and risk</span>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[1, 2, 3, 4, 5].map((x) => {
                  const active = leverage === x;
                  return (
                    <button
                      key={x}
                      type="button"
                      onClick={() => setLeverage(x)}
                      className={`text-xs rounded-lg border px-2 py-1.5 ${
                        active
                          ? "border-accent bg-accent/10 text-textPrimary"
                          : "border-border text-textSecondary hover:border-accent"
                      }`}
                    >
                      {x}x
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-surfaceMuted border border-border/60 p-4 space-y-3">
            <div className="metric-label">Position Preview</div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-textSecondary">Side</div>
                <div className="font-medium text-textPrimary">
                  {side ?? "–"}
                </div>
              </div>
              <div>
                <div className="text-textSecondary">Entry Price</div>
                <div className="font-medium text-textPrimary">
                  {(side === "YES" ? yesPrice : noPrice).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-textSecondary">Collateral</div>
                <div className="font-medium text-textPrimary">
                  ${preview.collateral.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-textSecondary">Borrowed from Vault</div>
                <div className="font-medium text-textPrimary">
                  ${preview.borrowed.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-textSecondary">Total Position Size</div>
                <div className="font-medium text-textPrimary">
                  ${preview.notional.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-textSecondary">Effective Leverage</div>
                <div className="font-medium text-textPrimary">
                  {preview.effectiveLeverage.toFixed(2)}x
                </div>
              </div>
            </div>

            <div className="border-t border-border/60 pt-3 space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-textSecondary">Open Fee (0.4%)</span>
                <span className="text-textPrimary">
                  ${preview.fees.openFee.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-textSecondary">Estimated Close Fee</span>
                <span className="text-textPrimary">
                  ${preview.fees.closeFee.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-textSecondary">
                  Borrow APR (utilization-based)
                </span>
                <span className="text-textPrimary">
                  {(preview.fees.borrowApr * 100).toFixed(1)}% est.
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-textSecondary">Liquidation Fee</span>
                <span className="text-textPrimary">5% of collateral</span>
              </div>
            </div>

            <p className="text-[11px] leading-snug text-textSecondary/80">
              On submit, we verify USDC.e balance, check vault liquidity,
              borrow from the vault, and open a real position on Polymarket for
              this market. Fees are split 50% vault, 30% insurance, 20%
              treasury and will be reflected on the vault + transactions views.
            </p>

            <button
              className="btn-primary w-full mt-1"
              onClick={submit}
              disabled={!isConnected || !side || numericCollateral <= 0}
            >
              {isConnected ? "Open Leveraged Position" : "Connect wallet to trade"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}


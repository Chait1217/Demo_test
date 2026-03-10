"use client";

import { useAccount } from "wagmi";
import { usePositions } from "@/hooks/usePositions";

export function TransactionsView() {
  const { isConnected } = useAccount();
  const { data, isLoading } = usePositions();

  const positions = data ?? [];
  const hasPositions = positions.length > 0;

  return (
    <section className="card-surface p-5 space-y-4">
      <div className="card-header">
        <h2 className="text-sm font-medium text-textSecondary">
          Positions & History
        </h2>
        <span className="pill">Wallet-linked</span>
      </div>

      {!isConnected && (
        <div className="text-xs text-textSecondary/80">
          Connect your wallet to see open and closed positions on the Iran
          regime market.
        </div>
      )}

      {isConnected && (
        <>
          <div className="rounded-2xl bg-surfaceMuted border border-border/60 p-3 text-[11px] text-textSecondary">
            <p>
              Each row is a leveraged position on the Polymarket question{" "}
              <span className="text-textPrimary">
                “Will the Iranian regime fall by June 30?”
              </span>
              . Open positions have a primary{" "}
              <span className="text-textPrimary font-semibold">Close</span>{" "}
              button that unwinds the real Polymarket trade and repays the
              vault.
            </p>
          </div>

          {isLoading && (
            <div className="text-xs text-textSecondary/80">Loading…</div>
          )}

          {!isLoading && !hasPositions && (
            <div className="text-xs text-textSecondary/80">
              No positions found for the connected wallet.
            </div>
          )}

          {hasPositions && (
            <div className="space-y-2 text-[11px]">
              {positions.map((p) => (
                <div
                  key={p.id}
                  className="rounded-xl bg-background/40 border border-border/60 px-3 py-2 flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          p.side === "YES"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-sky-500/20 text-sky-300"
                        }`}
                      >
                        {p.side}
                      </span>
                      <span className="text-textSecondary">
                        {p.state === "OPEN" ? "Open" : "Closed"}
                      </span>
                    </div>
                    <span className="text-textSecondary">
                      x{p.leverage.toFixed(2)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <div>
                      <div className="text-textSecondary">Entry</div>
                      <div className="text-textPrimary">
                        {p.entryPrice.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-textSecondary">Exit</div>
                      <div className="text-textPrimary">
                        {p.exitPrice != null ? p.exitPrice.toFixed(2) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-textSecondary">Collateral</div>
                      <div className="text-textPrimary">
                        ${p.collateral.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-textSecondary">Borrowed</div>
                      <div className="text-textPrimary">
                        ${p.borrowed.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-textSecondary">Position Size</div>
                      <div className="text-textPrimary">
                        ${p.notional.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-textSecondary">Fees (open+close)</div>
                      <div className="text-textPrimary">
                        ${(p.fees.openFee + p.fees.closeFee).toFixed(2)}
                      </div>
                    </div>
                  </div>
                  {p.state === "OPEN" && (
                    <div className="pt-1">
                      <button
                        className="btn-primary w-full"
                        onClick={async () => {
                          const res = await fetch("/api/trade/close", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              orderId: p.id,
                              repayAmount: p.borrowed,
                            }),
                          });
                          if (!res.ok) {
                            const text = await res.text();
                            alert(text);
                          }
                        }}
                      >
                        Close Position
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}


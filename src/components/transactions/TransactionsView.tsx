"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { usePositions } from "@/hooks/usePositions";

type Filter = "all" | "open" | "closed";

export function TransactionsView() {
  const { isConnected } = useAccount();
  const { data, isLoading } = usePositions();
  const [filter, setFilter] = useState<Filter>("all");

  const all = data ?? [];
  const filtered = filter === "all" ? all : all.filter((p) => p.state === (filter === "open" ? "OPEN" : "CLOSED"));

  const openCount = all.filter((p) => p.state === "OPEN").length;
  const closedCount = all.filter((p) => p.state === "CLOSED").length;

  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="card-header">
        <div>
          <div className="metric-label" style={{ marginBottom: 3 }}>Transaction History</div>
          <div style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>
            Your Trading Activity
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="pill pill-live">{openCount} Open</span>
          <span className="pill">{closedCount} Closed</span>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
        {(["all", "open", "closed"] as Filter[]).map((f) => (
          <button
            key={f}
            className={`nav-tab ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {!isConnected ? (
        <div style={{
          textAlign: "center",
          padding: "40px 20px",
          background: "var(--surface-2)",
          borderRadius: 12,
          border: "1px solid var(--border)",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
            Connect your wallet to see trading history
          </div>
        </div>
      ) : isLoading ? (
        <div style={{ textAlign: "center", padding: "40px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
          Loading positions…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          textAlign: "center",
          padding: "40px 20px",
          background: "var(--surface-2)",
          borderRadius: 12,
          border: "1px solid var(--border)",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>
            No {filter !== "all" ? filter + " " : ""}positions found
          </div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Collateral</th>
                <th>Borrowed</th>
                <th>Size</th>
                <th>Leverage</th>
                <th>Fees</th>
                <th>Order ID</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className={p.state === "OPEN" ? "tag tag-open" : "tag tag-closed"}>
                      {p.state}
                    </span>
                  </td>
                  <td>
                    <span className={`tag tag-${p.side.toLowerCase()}`}>{p.side}</span>
                  </td>
                  <td style={{ color: "var(--text-1)" }}>${p.entryPrice.toFixed(4)}</td>
                  <td style={{ color: p.exitPrice ? "var(--text-1)" : "var(--text-3)" }}>
                    {p.exitPrice ? `$${p.exitPrice.toFixed(4)}` : "—"}
                  </td>
                  <td>${p.collateral.toFixed(2)}</td>
                  <td style={{ color: "var(--warn)" }}>${p.borrowed.toFixed(2)}</td>
                  <td style={{ color: "var(--text-1)", fontWeight: 600 }}>${p.notional.toFixed(2)}</td>
                  <td style={{ color: "var(--accent)" }}>{p.leverage.toFixed(1)}x</td>
                  <td>${(p.fees.openFee + p.fees.closeFee).toFixed(4)}</td>
                  <td>
                    <span style={{ color: "var(--text-3)", fontSize: 10 }}>
                      {p.id.length > 12 ? `${p.id.slice(0, 8)}…${p.id.slice(-4)}` : p.id}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Fee distribution note */}
      {all.length > 0 && (
        <>
          <div className="gradient-line" />
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", lineHeight: 1.8 }}>
            Fees distribute to: 50% LP Vault · 30% Insurance Fund · 20% Treasury
          </div>
        </>
      )}
    </div>
  );
}

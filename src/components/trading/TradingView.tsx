"use client";

import { useState } from "react";
import { useAccount, useChainId, useSwitchChain, useSignTypedData, usePublicClient, useWriteContract } from "wagmi";
import { polygon } from "wagmi/chains";
import { useMarket } from "@/hooks/useMarket";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useVault } from "@/hooks/useVault";
import { usePositions, addPosition, closePositionLocal } from "@/hooks/usePositions";
import { computePositionPreview } from "@/lib/leverage";
import { USDCe_ADDRESS } from "@/lib/constants";

const ERC20_APPROVE_ABI = [
  { name: "allowance", type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve",   type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount",  type: "uint256" }], outputs: [{ name: "", type: "bool"    }] },
] as const;

type Side = "YES" | "NO";

function MiniChart({ history, color }: { history: { t: number; p: number }[]; color: string }) {
  const id = color.replace(/[^a-z0-9]/gi, "");
  if (!history || history.length < 2) {
    return <div style={{ height: 80 }} />;
  }
  const W = 320, H = 80;
  const prices = history.map((h) => h.p);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const range = maxP - minP || 0.01;
  const pts = history.map((h, i) => {
    const x = (i / (history.length - 1)) * W;
    const y = H - ((h.p - minP) / range) * (H - 10) - 5;
    return `${x},${y}`;
  });
  const pathD = `M ${pts.join(" L ")}`;
  const areaD = `M ${pts[0]} L ${pts.join(" L ")} L ${W},${H} L 0,${H} Z`;
  const last = prices[prices.length - 1], first = prices[0];
  const pct = ((last - first) / first * 100).toFixed(1);
  const up = last >= first;
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 80, display: "block" }}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#g${id})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ position: "absolute", top: 4, right: 0, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 600, color: up ? "var(--yes-color)" : "var(--danger)" }}>
        {up ? "+" : ""}{pct}%
      </div>
    </div>
  );
}

export function TradingView() {
  const { isConnected, address } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const isWrongChain = isConnected && chainId !== polygon.id;
  const { data: market, isLoading: marketLoading } = useMarket();
  const { rawBalance } = useUsdcBalance();
  const { snapshot, isDeployed: vaultDeployed } = useVault();
  const { data: positions, refetch: refetchPositions } = usePositions();

  const { signTypedDataAsync }          = useSignTypedData();
  const publicClient                    = usePublicClient();
  const { writeContractAsync }          = useWriteContract();

  const [side, setSide]             = useState<Side | null>(null);
  const [collateral, setCollateral] = useState("");
  const [leverage, setLeverage]     = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState<string>("");
  const [closing, setClosing]       = useState<string | null>(null);
  const [error, setError]           = useState("");
  const [success, setSuccess]       = useState("");

  const numCollateral = parseFloat(collateral) || 0;
  const utilization   = snapshot?.utilization ?? 0;
  const preview       = computePositionPreview({ collateral: numCollateral, leverage }, utilization);

  const yesPrice   = market?.yesPrice ?? 0.5;
  const noPrice    = market?.noPrice  ?? 0.5;
  const entryPrice = side === "YES" ? yesPrice : noPrice;

  const openPositions = (positions ?? []).filter((p) => p.state === "OPEN");

  const walletBalanceNum      = rawBalance ?? 0;
  const insufficientBalance   = numCollateral > 0 && numCollateral > walletBalanceNum;
  const insufficientLiquidity = preview.borrowed > 0 && snapshot && preview.borrowed > snapshot.available;
  const canTrade = isConnected && !isWrongChain && !!side && numCollateral > 0 && !insufficientBalance && !insufficientLiquidity && !submitting;

  async function submit() {
    if (!canTrade || !address || !side) return;
    setError(""); setSuccess(""); setSubmitting(true);
    try {
      // ── Step 1: Prepare the order struct server-side ──────────────────────
      setSubmitStep("Preparing order…");
      const prepRes = await fetch("/api/trade/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: address,
          side,
          collateral: numCollateral,
          leverage,
          price: entryPrice,
          yesTokenId: market?.yesTokenId ?? "",
          noTokenId:  market?.noTokenId  ?? "",
        }),
      });
      if (!prepRes.ok) throw new Error(await prepRes.text() || `Prepare error ${prepRes.status}`);
      const { orderStruct, exchangeAddress, l1Timestamp, l1Nonce } = await prepRes.json();

      // ── Step 2: Ensure USDC.e allowance for the CTF Exchange ─────────────
      setSubmitStep("Checking USDC.e allowance…");
      const needed = BigInt(orderStruct.makerAmount as string);
      const currentAllowance = await publicClient!.readContract({
        address:      USDCe_ADDRESS,
        abi:          ERC20_APPROVE_ABI,
        functionName: "allowance",
        args:         [address, exchangeAddress as `0x${string}`],
      }) as bigint;

      if (currentAllowance < needed) {
        setSubmitStep("Approve USDC.e spend… (wallet prompt)");
        const approveTx = await writeContractAsync({
          address:      USDCe_ADDRESS,
          abi:          ERC20_APPROVE_ABI,
          functionName: "approve",
          args:         [exchangeAddress as `0x${string}`, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
        });
        setSubmitStep("Waiting for approval confirmation…");
        await publicClient!.waitForTransactionReceipt({ hash: approveTx });
      }

      // ── Step 3: Sign the Polymarket L1 auth message (wallet popup #1) ─────
      setSubmitStep("Sign to authenticate with Polymarket… (1/2)");
      const l1Signature = await signTypedDataAsync({
        domain: { name: "ClobAuthDomain", version: "1", chainId: polygon.id },
        types: {
          ClobAuth: [
            { name: "address",   type: "address" },
            { name: "timestamp", type: "string"  },
            { name: "nonce",     type: "uint256"  },
            { name: "message",   type: "string"  },
          ],
        },
        primaryType: "ClobAuth",
        message: {
          address:   address,
          timestamp: String(l1Timestamp),
          nonce:     BigInt(l1Nonce),
          message:   "This message attests that I control the given wallet",
        },
      });

      // ── Step 4: Sign the order itself (wallet popup #2) ───────────────────
      setSubmitStep("Sign to authorise this trade… (2/2)");
      const orderSignature = await signTypedDataAsync({
        domain: {
          name:              "Polymarket CTF Exchange",
          version:           "1",
          chainId:           polygon.id,
          verifyingContract: exchangeAddress as `0x${string}`,
        },
        types: {
          Order: [
            { name: "salt",          type: "uint256" },
            { name: "maker",         type: "address" },
            { name: "signer",        type: "address" },
            { name: "taker",         type: "address" },
            { name: "tokenId",       type: "uint256" },
            { name: "makerAmount",   type: "uint256" },
            { name: "takerAmount",   type: "uint256" },
            { name: "expiration",    type: "uint256" },
            { name: "nonce",         type: "uint256" },
            { name: "feeRateBps",    type: "uint256" },
            { name: "side",          type: "uint8"   },
            { name: "signatureType", type: "uint8"   },
          ],
        },
        primaryType: "Order",
        message: {
          salt:          BigInt(orderStruct.salt),
          maker:         orderStruct.maker         as `0x${string}`,
          signer:        orderStruct.signer        as `0x${string}`,
          taker:         orderStruct.taker         as `0x${string}`,
          tokenId:       BigInt(orderStruct.tokenId),
          makerAmount:   BigInt(orderStruct.makerAmount),
          takerAmount:   BigInt(orderStruct.takerAmount),
          expiration:    BigInt(orderStruct.expiration),
          nonce:         BigInt(orderStruct.nonce),
          feeRateBps:    BigInt(orderStruct.feeRateBps),
          side:          orderStruct.side          as number,
          signatureType: orderStruct.signatureType as number,
        },
      });

      // ── Step 5: Submit to CLOB via server (derives API creds + posts order) ─
      setSubmitStep("Submitting to Polymarket…");
      const subRes = await fetch("/api/trade/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: address,
          l1Signature,
          l1Timestamp,
          l1Nonce,
          orderStruct,
          orderSignature,
          side,
          collateral: numCollateral,
          leverage,
          price: entryPrice,
        }),
      });
      if (!subRes.ok) throw new Error(await subRes.text() || `Submit error ${subRes.status}`);
      const json = await subRes.json();
      const orderId = json.orderId;

      // ── Step 6: Persist locally ────────────────────────────────────────────
      addPosition({
        id: orderId,
        walletAddress: address,
        side,
        entryPrice,
        collateral: numCollateral,
        borrowed:  json.preview?.borrowed  ?? preview.borrowed,
        notional:  json.preview?.notional  ?? preview.notional,
        leverage,
        fees: {
          openFee:        json.preview?.fees?.openFee        ?? preview.fees.openFee,
          closeFee:       json.preview?.fees?.closeFee       ?? preview.fees.closeFee,
          liquidationFee: json.preview?.fees?.liquidationFee ?? preview.fees.liquidationFee,
        },
        state:    "OPEN",
        openedAt: new Date().toISOString(),
      });
      refetchPositions();

      setSuccess(`Position opened · ID: ${orderId}`);
      setCollateral(""); setLeverage(1); setSide(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
      setSubmitStep("");
    }
  }

  async function closePosition(positionId: string, borrowed: number) {
    setClosing(positionId); setError(""); setSuccess("");
    try {
      // For real orders: sign L1 auth so the server can cancel on Polymarket
      const isSimulated = positionId.startsWith("sim_") || positionId.startsWith("placed_");
      let l1Signature: string | undefined;
      let l1Timestamp: number | undefined;

      if (!isSimulated && address) {
        l1Timestamp = Math.floor(Date.now() / 1000);
        l1Signature = await signTypedDataAsync({
          domain: { name: "ClobAuthDomain", version: "1", chainId: polygon.id },
          types: {
            ClobAuth: [
              { name: "address",   type: "address" },
              { name: "timestamp", type: "string"  },
              { name: "nonce",     type: "uint256"  },
              { name: "message",   type: "string"  },
            ],
          },
          primaryType: "ClobAuth",
          message: {
            address:   address,
            timestamp: String(l1Timestamp),
            nonce:     BigInt(0),
            message:   "This message attests that I control the given wallet",
          },
        });
      }

      // Immediately update localStorage — UI reflects change instantly
      closePositionLocal(positionId);

      // Fire-and-forget: cancel on Polymarket + repay vault
      fetch("/api/trade/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId:      positionId,
          repayAmount:  borrowed,
          walletAddress: address,
          l1Signature,
          l1Timestamp,
          l1Nonce: 0,
        }),
      }).catch(() => { /* ignore network errors — position already closed locally */ });

      setSuccess("Position closed successfully.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setClosing(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Market Header ─────────────────────────────────── */}
      <div className="card" style={{ padding: 20 }}>
        <div className="card-header">
          <div>
            <div className="metric-label" style={{ marginBottom: 4 }}>Prediction Market</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h2 style={{ fontFamily: "var(--sans)", fontSize: 18, fontWeight: 700, color: "var(--text-1)", margin: 0, lineHeight: 1.3 }}>
                Will the Iranian regime fall by June 30?
              </h2>
              <a
                href={market?.marketUrl ?? "https://polymarket.com/event/will-the-iranian-regime-fall-by-june-30"}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontFamily: "var(--mono)", fontSize: 10, fontWeight: 600,
                  color: "var(--accent)", textDecoration: "none",
                  border: "1px solid rgba(0,229,160,0.3)", borderRadius: 6,
                  padding: "3px 8px", whiteSpace: "nowrap",
                  transition: "border-color 150ms",
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(0,229,160,0.3)")}
              >
                ↗ Polymarket
              </a>
            </div>
          </div>
          <div className="pill pill-live">LIVE</div>
        </div>

        {/* YES / NO price panels */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div style={{ background: "var(--surface-2)", border: `1px solid ${side === "YES" ? "var(--yes-color)" : "var(--border)"}`, borderRadius: 12, padding: "14px 16px", transition: "border-color 150ms" }}>
            <div className="metric-label" style={{ color: "var(--yes-color)", marginBottom: 6 }}>YES</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 28, fontWeight: 700, color: "var(--yes-color)" }}>
              {marketLoading ? "—" : `$${yesPrice.toFixed(3)}`}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>Regime falls by June 30</div>
            <MiniChart history={market?.priceHistory ?? []} color="var(--yes-color)" />
          </div>
          <div style={{ background: "var(--surface-2)", border: `1px solid ${side === "NO" ? "var(--no-color)" : "var(--border)"}`, borderRadius: 12, padding: "14px 16px", transition: "border-color 150ms" }}>
            <div className="metric-label" style={{ color: "var(--no-color)", marginBottom: 6 }}>NO</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 28, fontWeight: 700, color: "var(--no-color)" }}>
              {marketLoading ? "—" : `$${noPrice.toFixed(3)}`}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>Regime survives until July</div>
            <MiniChart history={(market?.priceHistory ?? []).map((h) => ({ t: h.t, p: 1 - h.p }))} color="var(--no-color)" />
          </div>
        </div>

        {/* Market stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {[
            { label: "24h Volume", value: market?.volume   ? `$${(market.volume   / 1000).toFixed(1)}K` : "—" },
            { label: "Liquidity",  value: market?.liquidity ? `$${(market.liquidity / 1000).toFixed(1)}K` : "—" },
            { label: "Spread",     value: market?.spread    ? `${(market.spread * 100).toFixed(2)}%`       : "—" },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: "var(--surface-3)", borderRadius: 8, padding: "8px 12px" }}>
              <div className="metric-label" style={{ marginBottom: 3 }}>{label}</div>
              <div className="metric-value-sm">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Trade Box ──────────────────────────────────────── */}
      <div className="card" style={{ padding: 20 }}>
        <div className="card-header">
          <div className="metric-label">Open Leveraged Position</div>
          <div className="pill">Max 5x</div>
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
          <button className={`side-btn side-btn-yes ${side === "YES" ? "active" : ""}`} onClick={() => setSide("YES")}>
            LONG YES · {yesPrice.toFixed(3)}
          </button>
          <button className={`side-btn side-btn-no ${side === "NO" ? "active" : ""}`} onClick={() => setSide("NO")}>
            LONG NO · {noPrice.toFixed(3)}
          </button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <label className="metric-label">Collateral</label>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>
              Wallet: <span style={{ color: insufficientBalance ? "var(--danger)" : "var(--text-2)" }}>${walletBalanceNum.toFixed(2)} USDC.e</span>
            </span>
          </div>
          <div style={{ position: "relative" }}>
            <input className="input" type="number" min={0} placeholder="0.00" value={collateral} onChange={(e) => setCollateral(e.target.value)} />
            <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>USDC.e</span>
          </div>
          {insufficientBalance && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)", marginTop: 6 }}>✕ Insufficient USDC.e balance</div>}
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <label className="metric-label">Leverage</label>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>{leverage}x</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
            {[1, 2, 3, 4, 5].map((x) => (
              <button key={x} className={`lev-btn ${leverage === x ? "active" : ""}`} onClick={() => setLeverage(x)}>{x}x</button>
            ))}
          </div>
        </div>

        <div className="row-divider" />

        <div style={{ marginBottom: 16 }}>
          <div className="metric-label" style={{ marginBottom: 10 }}>Position Summary</div>
          <div style={{ background: "var(--surface-2)", borderRadius: 10, padding: "12px 14px" }}>
            {[
              { label: "Side",                value: side ? <span className={`tag tag-${side.toLowerCase()}`}>{side}</span> : <span style={{ color: "var(--text-3)" }}>—</span> },
              { label: "Entry Price",         value: side ? `$${entryPrice.toFixed(4)}` : "—" },
              { label: "Collateral",          value: numCollateral > 0 ? `$${numCollateral.toFixed(2)}` : "—" },
              { label: "Borrowed from Vault", value: preview.borrowed > 0 ? <span style={{ color: "var(--warn)" }}>${preview.borrowed.toFixed(2)}</span> : "—" },
              { label: "Total Position Size", value: preview.notional  > 0 ? <span style={{ color: "var(--text-1)", fontWeight: 600 }}>${preview.notional.toFixed(2)}</span> : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="summary-row">
                <span className="summary-label">{label}</span>
                <span className="summary-value">{value}</span>
              </div>
            ))}
            <div className="row-divider" style={{ margin: "10px 0" }} />
            {[
              { label: "Open Fee (0.4%)",       value: preview.notional > 0 ? `$${preview.fees.openFee.toFixed(4)}` : "—" },
              { label: "Est. Close Fee (0.4%)", value: preview.notional > 0 ? `$${preview.fees.closeFee.toFixed(4)}` : "—" },
              { label: "Borrow APR",            value: `${(preview.fees.borrowApr * 100).toFixed(1)}%` },
            ].map(({ label, value }) => (
              <div key={label} className="summary-row">
                <span className="summary-label">{label}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {isWrongChain && (
          <div className="alert-error" style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span>⚠ Switch to Polygon to trade.</span>
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
        {insufficientLiquidity && (
          <div className="alert-error" style={{ marginBottom: 12 }}>
            ✕ Vault has insufficient liquidity. Available: ${snapshot?.available.toFixed(2) ?? "0"}. Deposit into the vault first.
          </div>
        )}
        {error   && <div className="alert-error"   style={{ marginBottom: 12 }}>✕ {error}</div>}
        {success && <div className="alert-success" style={{ marginBottom: 12 }}>✓ {success}</div>}

        <button className="btn-primary" style={{ width: "100%" }} onClick={submit} disabled={!canTrade}>
          {!isConnected
            ? "Connect Wallet to Trade"
            : isWrongChain
            ? "Wrong Network — Switch to Polygon"
            : !side
            ? "Select YES or NO"
            : submitting
            ? (submitStep || "Opening Position…")
            : `Open ${side} Position · $${preview.notional.toFixed(2)}`}
        </button>
        {!isConnected && (
          <p style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)", textAlign: "center", marginTop: 8, marginBottom: 0 }}>
            Any wallet on Polygon network supported
          </p>
        )}
      </div>

      {/* ── Open Positions ─────────────────────────────────── */}
      <div className="card" style={{ padding: 20 }}>
        <div className="card-header">
          <div className="metric-label">Open Positions</div>
          <div className={`pill ${openPositions.length > 0 ? "pill-live" : ""}`}>
            {openPositions.length > 0 ? `${openPositions.length} Active` : "None"}
          </div>
        </div>

        {!isConnected ? (
          <div style={{ textAlign: "center", padding: "32px 20px", background: "var(--surface-2)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>Connect wallet to see your open positions</div>
          </div>
        ) : openPositions.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 20px", background: "var(--surface-2)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>No open positions — open one above</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {openPositions.map((p) => (
              <div key={p.id} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className={`tag tag-${p.side.toLowerCase()}`}>{p.side}</span>
                    <span className="tag tag-open">OPEN</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-2)" }}>{p.leverage.toFixed(1)}x leverage</span>
                  </div>
                  <button
                    className="btn-danger"
                    style={{ padding: "7px 16px", fontSize: 12 }}
                    disabled={closing === p.id}
                    onClick={() => closePosition(p.id, p.borrowed)}
                  >
                    {closing === p.id ? "Closing…" : "✕ Close Position"}
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                  {[
                    { label: "Entry",      value: `$${p.entryPrice.toFixed(4)}` },
                    { label: "Collateral", value: `$${p.collateral.toFixed(2)}`  },
                    { label: "Borrowed",   value: `$${p.borrowed.toFixed(2)}`    },
                    { label: "Size",       value: `$${p.notional.toFixed(2)}`    },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="metric-label" style={{ marginBottom: 3 }}>{label}</div>
                      <div className="metric-value-sm">{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)" }}>
                    Opened {new Date(p.openedAt).toLocaleString()}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)" }}>·</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                    ID: {p.id}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

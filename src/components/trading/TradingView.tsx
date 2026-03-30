"use client";

import { useState, useEffect } from "react";
import { useAccount, useChainId, useSwitchChain, useSignTypedData, usePublicClient, useWriteContract } from "wagmi";
import { polygon } from "wagmi/chains";
import { useMarket } from "@/hooks/useMarket";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useVault } from "@/hooks/useVault";
import { usePositions, addPosition, updatePosition, closePositionLocal } from "@/hooks/usePositions";
import { computePositionPreview } from "@/lib/leverage";
import { USDCe_ADDRESS, CTF_EXCHANGE_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS, CTF_TOKEN_ADDRESS } from "@/lib/constants";

const ERC20_APPROVE_ABI = [
  { name: "allowance", type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve",   type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount",  type: "uint256" }], outputs: [{ name: "", type: "bool"    }] },
] as const;

const ERC1155_APPROVAL_ABI = [
  { name: "isApprovedForAll", type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { name: "setApprovalForAll", type: "function", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
  { name: "balanceOf",         type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }],         outputs: [{ name: "", type: "uint256" }] },
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
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [confirmClosePreview, setConfirmClosePreview] = useState<{
    id: string; bestBid: number | null; loading: boolean;
  } | null>(null);
  const [syncing, setSyncing]       = useState(false);
  const [error, setError]           = useState("");
  const [success, setSuccess]       = useState("");
  const [orphanedTokens, setOrphanedTokens] = useState<
    { positionId: string; tokenId: string; balance: bigint; exchangeAddress: string; side: string }[]
  >([]);
  const [sellingOrphan, setSellingOrphan] = useState<string | null>(null);

  const numCollateral = parseFloat(collateral) || 0;
  const utilization   = snapshot?.utilization ?? 0;
  const preview       = computePositionPreview({ collateral: numCollateral, leverage }, utilization);

  const yesPrice   = market?.yesPrice ?? 0.5;
  const noPrice    = market?.noPrice  ?? 0.5;
  const spread     = market?.spread   ?? 0;
  // Entry = ask (what you pay when buying); Exit = bid (what you receive when selling)
  const entryPrice = (side === "YES" ? yesPrice : noPrice) + spread / 2;
  const exitMid    = (side === "YES" ? yesPrice : noPrice);
  const exitBid    = Math.max(exitMid - spread / 2, 0.001);

  const openPositions   = (positions ?? []).filter((p) => p.state === "OPEN");
  const closedWithToken = (positions ?? []).filter(
    (p) => p.state === "CLOSED" && p.tokenId && p.exchangeAddress,
  );

  // Scan closed positions for leftover CTF tokens (e.g. from a partial SELL that didn't fully fill)
  useEffect(() => {
    if (!publicClient || !address || closedWithToken.length === 0) {
      setOrphanedTokens([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const found: typeof orphanedTokens = [];
      const seenTokenIds = new Set<string>();
      for (const p of closedWithToken) {
        if (seenTokenIds.has(p.tokenId!)) continue; // same token across multiple closed positions
        seenTokenIds.add(p.tokenId!);
        try {
          const bal = await publicClient.readContract({
            address:      CTF_TOKEN_ADDRESS,
            abi:          ERC1155_APPROVAL_ABI,
            functionName: "balanceOf",
            args:         [address as `0x${string}`, BigInt(p.tokenId!)],
          }) as bigint;
          if (bal > 0n) {
            found.push({ positionId: p.id, tokenId: p.tokenId!, balance: bal, exchangeAddress: p.exchangeAddress!, side: p.side });
          }
        } catch { /* ignore RPC errors for individual positions */ }
      }
      if (!cancelled) setOrphanedTokens(found);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, closedWithToken.length, publicClient]);

  const walletBalanceNum      = rawBalance ?? 0;
  const insufficientBalance   = numCollateral > 0 && numCollateral > walletBalanceNum;
  const insufficientLiquidity = preview.borrowed > 0 && vaultDeployed && snapshot && preview.borrowed > snapshot.available;
  // When vault can't cover the requested leverage, fall back to 1× (user's collateral only).
  const effectiveLeverage = (insufficientLiquidity && numCollateral > 0) ? 1 : leverage;
  const effectivePreview  = effectiveLeverage !== leverage
    ? computePositionPreview({ collateral: numCollateral, leverage: effectiveLeverage }, utilization)
    : preview;
  const canTrade = isConnected && !isWrongChain && !!side && numCollateral > 0 && !insufficientBalance && !submitting;

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
          leverage: effectiveLeverage,
          price: entryPrice,
          yesTokenId: market?.yesTokenId ?? "",
          noTokenId:  market?.noTokenId  ?? "",
        }),
      });
      if (!prepRes.ok) throw new Error(await prepRes.text() || `Prepare error ${prepRes.status}`);
      const { orderStruct, exchangeAddress, l1Timestamp, l1Nonce } = await prepRes.json();

      // ── Step 1b: Hard balance check — user only needs to cover their collateral;
      // the vault will provide the borrowed portion in Step 2b below.
      if (rawBalance < numCollateral) {
        throw new Error(
          `Insufficient USDC.e balance — need $${numCollateral.toFixed(2)}, wallet has $${rawBalance.toFixed(2)}`
        );
      }

      // ── Step 2: Ensure USDC.e allowance for both Polymarket exchange contracts ──
      // We approve both the standard CTF exchange and the neg-risk exchange because
      // the CLOB checks whichever one governs the token, and the neg-risk API lookup
      // can fail causing us to use the wrong address otherwise.
      setSubmitStep("Checking USDC.e allowance…");
      const needed = BigInt(orderStruct.makerAmount as string);
      const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      let openTxHash: string | undefined;

      for (const spender of [CTF_EXCHANGE_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS]) {
        const currentAllowance = await publicClient!.readContract({
          address:      USDCe_ADDRESS,
          abi:          ERC20_APPROVE_ABI,
          functionName: "allowance",
          args:         [address, spender],
        }) as bigint;

        if (currentAllowance < needed) {
          setSubmitStep(`Approve USDC.e spend… (wallet prompt)`);
          const approveTx = await writeContractAsync({
            address:      USDCe_ADDRESS,
            abi:          ERC20_APPROVE_ABI,
            functionName: "approve",
            args:         [spender, MAX_UINT256],
          });
          openTxHash = approveTx; // Real on-chain tx hash
          setSubmitStep("Waiting for approval confirmation…");
          await publicClient!.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
        }
      }

      // ── Step 2b: vault.borrow() is onlyEngine — the SERVER handles borrowing ─
      // The submit route calls vault.borrow() with the server's marginEngine wallet
      // and then transfers the borrowed USDC to the user's wallet. No client action
      // needed here; the server does it before posting the Polymarket order.

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
          leverage: effectiveLeverage,
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
        borrowed:  json.preview?.borrowed  ?? effectivePreview.borrowed,
        notional:  json.preview?.notional  ?? effectivePreview.notional,
        leverage: effectiveLeverage,
        fees: {
          openFee:        json.preview?.fees?.openFee        ?? effectivePreview.fees.openFee,
          closeFee:       0,
          liquidationFee: json.preview?.fees?.liquidationFee ?? effectivePreview.fees.liquidationFee,
        },
        state:    "OPEN",
        openedAt: new Date().toISOString(),
        // Use vault borrow transfer hash as the primary tx hash — it's the
        // on-chain proof the borrowed funds reached the user's wallet.
        txHash: json.transferHash ?? openTxHash,
        // Store fields needed to SELL tokens back when closing a filled position
        tokenId:         orderStruct.tokenId as string,
        tokenCount:      Number(BigInt(orderStruct.takerAmount as string)) / 1e6,
        exchangeAddress,
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

  async function enterConfirmClose(positionId: string, tokenId?: string, tokenCount?: number) {
    setConfirmClose(positionId);
    setConfirmClosePreview({ id: positionId, bestBid: null, loading: true });
    if (tokenId) {
      try {
        const bookRes = await fetch(
          `https://clob.polymarket.com/book?token_id=${tokenId}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        const book = bookRes.ok
          ? await bookRes.json() as { bids?: { price: string; size: string }[] }
          : { bids: [] };
        const bids = (book.bids ?? []) as { price: string; size: string }[];
        if (bids.length === 0) {
          setConfirmClosePreview({ id: positionId, bestBid: null, loading: false });
          return;
        }
        // Compute sweep price: walk bids until cumulative volume covers the position
        const tokensNeeded = tokenCount ?? 0;
        let cumulative = 0;
        let sweepPrice = parseFloat(bids[bids.length - 1].price);
        for (const bid of bids) {
          cumulative += parseFloat(bid.size ?? "0");
          if (tokensNeeded > 0 && cumulative >= tokensNeeded) {
            sweepPrice = parseFloat(bid.price);
            break;
          }
        }
        const bestBid = tokensNeeded > 0 ? sweepPrice : parseFloat(bids[0].price);
        setConfirmClosePreview({ id: positionId, bestBid, loading: false });
      } catch {
        setConfirmClosePreview({ id: positionId, bestBid: null, loading: false });
      }
    } else {
      setConfirmClosePreview({ id: positionId, bestBid: null, loading: false });
    }
  }

  async function sellOrphanedTokens(positionId: string) {
    const orphan = orphanedTokens.find((o) => o.positionId === positionId);
    if (!orphan) return;
    setSellingOrphan(positionId); setError(""); setSuccess("");
    try {
      // ── L1 auth signature ────────────────────────────────────────────────
      setSubmitStep("Sign auth (wallet popup)…");
      const l1Ts = Math.floor(Date.now() / 1000);
      const l1Signature = await signTypedDataAsync({
        domain: { name: "ClobAuthDomain", version: "1", chainId: polygon.id },
        types: {
          ClobAuth: [
            { name: "address",   type: "address" },
            { name: "timestamp", type: "string"  },
            { name: "nonce",     type: "uint256" },
            { name: "message",   type: "string"  },
          ],
        },
        primaryType: "ClobAuth",
        message: {
          address:   address as `0x${string}`,
          timestamp: String(l1Ts),
          nonce:     BigInt(0),
          message:   "This message attests that I control the given wallet",
        },
      });

      // ── ERC-1155 approval ────────────────────────────────────────────────
      setSubmitStep("Checking token approval…");
      const isApproved = await publicClient!.readContract({
        address:      CTF_TOKEN_ADDRESS,
        abi:          ERC1155_APPROVAL_ABI,
        functionName: "isApprovedForAll",
        args:         [address as `0x${string}`, orphan.exchangeAddress as `0x${string}`],
      });
      if (!isApproved) {
        setSubmitStep("Approve exchange to transfer tokens (wallet popup)…");
        const tx = await writeContractAsync({
          address: CTF_TOKEN_ADDRESS,
          abi: ERC1155_APPROVAL_ABI,
          functionName: "setApprovalForAll",
          args: [orphan.exchangeAddress as `0x${string}`, true],
        });
        await publicClient!.waitForTransactionReceipt({ hash: tx });
      }

      // ── Sweep the book & build SELL order ────────────────────────────────
      setSubmitStep("Fetching live prices…");
      const makerAmountRaw = (BigInt(Math.floor(Number(orphan.balance) / 10_000)) * 10_000n).toString();
      const tokensToSell   = Number(makerAmountRaw) / 1_000_000;

      let tickPrice: number;
      try {
        const bookRes = await fetch(
          `https://clob.polymarket.com/book?token_id=${orphan.tokenId}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        const book = bookRes.ok
          ? await bookRes.json() as { bids?: { price: string; size: string }[] }
          : { bids: [] };
        const bids = (book.bids ?? []) as { price: string; size: string }[];
        if (bids.length === 0) throw new Error("No bids — market has no buyers right now. Try again shortly.");
        let cumulative = 0;
        let sweepPrice = parseFloat(bids[bids.length - 1].price);
        for (const bid of bids) {
          cumulative += parseFloat(bid.size ?? "0");
          if (cumulative >= tokensToSell) { sweepPrice = parseFloat(bid.price); break; }
        }
        tickPrice = Math.max(Math.round(sweepPrice * 100) / 100, 0.01);
      } catch (e: any) { throw e; }

      const takerAmountRaw = (Math.floor(tokensToSell * tickPrice * 1_000_000 / 100) * 100).toString();
      const ZERO_ADDRESS   = "0x0000000000000000000000000000000000000000";
      const sellStruct = {
        salt: Math.round(Math.random() * Date.now()).toString(),
        maker: address, signer: address, taker: ZERO_ADDRESS,
        tokenId: orphan.tokenId,
        makerAmount: makerAmountRaw, takerAmount: takerAmountRaw,
        expiration: "0", nonce: "0", feeRateBps: "0",
        side: 1, signatureType: 0,
      };

      setSubmitStep("Sign SELL order (wallet popup)…");
      const sellSig = await signTypedDataAsync({
        domain: {
          name: "Polymarket CTF Exchange", version: "1",
          chainId: polygon.id,
          verifyingContract: orphan.exchangeAddress as `0x${string}`,
        },
        types: { Order: [
          { name: "salt", type: "uint256" }, { name: "maker", type: "address" },
          { name: "signer", type: "address" }, { name: "taker", type: "address" },
          { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" },
          { name: "takerAmount", type: "uint256" }, { name: "expiration", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "feeRateBps", type: "uint256" },
          { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" },
        ]},
        primaryType: "Order",
        message: {
          salt: BigInt(sellStruct.salt), maker: sellStruct.maker as `0x${string}`,
          signer: sellStruct.signer as `0x${string}`, taker: sellStruct.taker as `0x${string}`,
          tokenId: BigInt(sellStruct.tokenId), makerAmount: BigInt(sellStruct.makerAmount),
          takerAmount: BigInt(sellStruct.takerAmount), expiration: BigInt(sellStruct.expiration),
          nonce: BigInt(sellStruct.nonce), feeRateBps: BigInt(sellStruct.feeRateBps),
          side: sellStruct.side as number, signatureType: sellStruct.signatureType as number,
        },
      });

      // ── Post SELL via close route (repayAmount=0 — vault already repaid) ─
      setSubmitStep("Posting SELL order…");
      const closeRes = await fetch("/api/trade/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId:           positionId,
          repayAmount:       0,
          walletAddress:     address,
          l1Signature,
          l1Timestamp:       l1Ts,
          l1Nonce:           0,
          sellOrderStruct:   sellStruct,
          sellOrderSignature: sellSig,
        }),
      });
      if (!closeRes.ok) throw new Error(`SELL failed (${closeRes.status}): ${await closeRes.text()}`);

      setOrphanedTokens((prev) => prev.filter((o) => o.positionId !== positionId));
      setSuccess(`SELL order submitted — ~${(tokensToSell * tickPrice).toFixed(2)} USDC will arrive in your wallet shortly.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSellingOrphan(null);
      setSubmitStep("");
    }
  }

  async function closePosition(positionId: string, borrowed: number) {
    setClosing(positionId); setError(""); setSuccess("");
    try {
      const isSimulated = positionId.startsWith("sim_") || positionId.startsWith("placed_");
      let l1Signature: string | undefined;
      let l1Timestamp: number | undefined;
      let sellOrderStruct: Record<string, unknown> | undefined;
      let sellOrderSignature: string | undefined;

      if (!isSimulated && address) {
        l1Timestamp = Math.floor(Date.now() / 1000);

        // ── Sign L1 auth (wallet popup #1) ──────────────────────────────────
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

        // ── Build + sign SELL order for filled-position recovery ─────────────
        // Look up stored position data (tokenId, tokenCount, exchangeAddress)
        const pos = (positions ?? []).find((p) => p.id === positionId);
        if (pos?.tokenId && pos.tokenCount && pos.exchangeAddress) {
          // ERC-1155 SELL orders require the exchange to be approved as an operator.
          setSubmitStep("Checking ERC-1155 token approval…");
          const isApproved = await publicClient!.readContract({
            address:      CTF_TOKEN_ADDRESS,
            abi:          ERC1155_APPROVAL_ABI,
            functionName: "isApprovedForAll",
            args:         [address as `0x${string}`, pos.exchangeAddress as `0x${string}`],
          });
          if (!isApproved) {
            setSubmitStep("Approving exchange to transfer tokens (wallet popup)…");
            const approveTx = await writeContractAsync({
              address:      CTF_TOKEN_ADDRESS,
              abi:          ERC1155_APPROVAL_ABI,
              functionName: "setApprovalForAll",
              args:         [pos.exchangeAddress as `0x${string}`, true],
            });
            await publicClient!.waitForTransactionReceipt({ hash: approveTx });
          }
          const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

          // Read the exact on-chain balance first so we know exactly how many tokens to sell
          // before fetching the book (need the size to sweep correctly).
          // makerAmount must be a multiple of 10_000 (max 2 dp in token units) → floor, not round.
          // takerAmount must be a multiple of 100   (max 4 dp in USDC  units) → derived from floored maker.
          const onChainBalance = await publicClient!.readContract({
            address:      CTF_TOKEN_ADDRESS,
            abi:          ERC1155_APPROVAL_ABI,
            functionName: "balanceOf",
            args:         [address as `0x${string}`, BigInt(pos.tokenId)],
          }) as bigint;
          const makerAmountRaw = (BigInt(Math.floor(Number(onChainBalance) / 10_000)) * 10_000n).toString();
          const tokensToSell   = Number(makerAmountRaw) / 1_000_000; // exact token count we're selling

          // Sweep the order book: walk bids from best to worst, accumulating available
          // liquidity until we cover the full token amount.  The price of the last bid
          // level we need becomes our limit price, so ALL bids at or above it match
          // immediately — giving a guaranteed full fill in one order with no GTC residue.
          // Falls back to mid − spread/2 if the book is unreachable.
          let tickPrice: number;
          try {
            const bookRes = await fetch(
              `https://clob.polymarket.com/book?token_id=${pos.tokenId}`,
              { signal: AbortSignal.timeout(5_000) },
            );
            const book = bookRes.ok
              ? await bookRes.json() as { bids?: { price: string; size: string }[] }
              : { bids: [] };
            const bids = (book.bids ?? []) as { price: string; size: string }[];
            if (bids.length === 0) throw new Error("No bids in order book — market has no liquidity to sell into right now. Try again shortly.");

            // Walk the book until cumulative bid volume covers our full position.
            let cumulative = 0;
            let sweepPrice = parseFloat(bids[bids.length - 1].price); // worst-case floor
            for (const bid of bids) {
              cumulative += parseFloat(bid.size ?? "0");
              if (cumulative >= tokensToSell) {
                sweepPrice = parseFloat(bid.price);
                break;
              }
            }
            tickPrice = Math.max(Math.round(sweepPrice * 100) / 100, 0.01);
            console.log(`[close] book sweep: need ${tokensToSell} tokens, cumulative liquidity ${cumulative.toFixed(2)} at ${tickPrice}`);
          } catch (e: any) {
            if (e.message?.includes("No bids")) throw e; // propagate no-liquidity error
            const posMidSell = pos.side === "YES" ? yesPrice : noPrice;
            tickPrice = Math.max(Math.round(Math.max(posMidSell - spread / 2, 0.01) * 100) / 100, 0.01);
          }

          const takerAmountRaw = (Math.floor(tokensToSell * tickPrice * 1_000_000 / 100) * 100).toString();
          const sellSalt       = Math.round(Math.random() * Date.now()).toString();

          sellOrderStruct = {
            salt:          sellSalt,
            maker:         address,
            signer:        address,
            taker:         ZERO_ADDRESS,
            tokenId:       pos.tokenId,
            makerAmount:   makerAmountRaw,
            takerAmount:   takerAmountRaw,
            expiration:    "0",
            nonce:         "0",
            feeRateBps:    "0",
            side:          1,   // SELL
            signatureType: 0,   // EOA
          };

          // ── Sign the SELL order (wallet popup #2) ────────────────────────
          sellOrderSignature = await signTypedDataAsync({
            domain: {
              name:              "Polymarket CTF Exchange",
              version:           "1",
              chainId:           polygon.id,
              verifyingContract: pos.exchangeAddress as `0x${string}`,
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
              salt:          BigInt(sellOrderStruct.salt as string),
              maker:         sellOrderStruct.maker  as `0x${string}`,
              signer:        sellOrderStruct.signer as `0x${string}`,
              taker:         sellOrderStruct.taker  as `0x${string}`,
              tokenId:       BigInt(sellOrderStruct.tokenId  as string),
              makerAmount:   BigInt(sellOrderStruct.makerAmount as string),
              takerAmount:   BigInt(sellOrderStruct.takerAmount as string),
              expiration:    BigInt(sellOrderStruct.expiration  as string),
              nonce:         BigInt(sellOrderStruct.nonce       as string),
              feeRateBps:    BigInt(sellOrderStruct.feeRateBps  as string),
              side:          sellOrderStruct.side          as number,
              signatureType: sellOrderStruct.signatureType as number,
            },
          });
        }
      }

      // ── Step: Approve engine to pull borrowed USDC.e (approve-and-pull) ─────────
      // The close route does transferFrom(user→engine) + vault.repay() atomically.
      // If vault.repay() fails the server returns 500, the position stays open, and
      // this approval is never exercised — the user's USDC.e stays safe.
      if (!isSimulated && borrowed > 0) {
        const engRes = await fetch("/api/engine-address");
        const { address: engineAddress } = await engRes.json() as { address: string | null };
        if (engineAddress) {
          const repayRaw = BigInt(Math.round(borrowed * 1_000_000));
          const currentAllowance = await publicClient!.readContract({
            address:      USDCe_ADDRESS,
            abi:          ERC20_APPROVE_ABI,
            functionName: "allowance",
            args:         [address as `0x${string}`, engineAddress as `0x${string}`],
          }) as bigint;
          if (currentAllowance < repayRaw) {
            setSubmitStep("Approve repayment… (wallet prompt)");
            const approveTx = await writeContractAsync({
              address:      USDCe_ADDRESS,
              abi:          ERC20_APPROVE_ABI,
              functionName: "approve",
              args:         [engineAddress as `0x${string}`, repayRaw],
            });
            await publicClient!.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
          }
        }
      }

      // Cancel (or SELL if filled) on Polymarket + repay vault — AWAIT so we only
      // mark the position closed after the server confirms success
      const closeRes = await fetch("/api/trade/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId:           positionId,
          repayAmount:       borrowed,
          walletAddress:     address,
          l1Signature,
          l1Timestamp,
          l1Nonce:           0,
          sellOrderStruct,
          sellOrderSignature,
        }),
      });

      if (!closeRes.ok) {
        const errText = await closeRes.text();
        throw new Error(`Close failed (${closeRes.status}): ${errText}`);
      }

      const closeJson = await closeRes.json();

      // Mark CLOSED locally immediately so the UI clears the position
      closePositionLocal(positionId);

      // Save closeTxHash if the repayment already happened (cancel path)
      if (closeJson.closeTxHash) {
        updatePosition(positionId, { closeTxHash: closeJson.closeTxHash });
      }

      if (closeJson.repayPending && closeJson.repayAmount > 0) {
        // SELL path — SELL proceeds are in-flight.
        // Poll until the SELL order fills (up to 90s), then call settle.
        // The server background task auto-reposts at floor after 30s, so we
        // just need to keep trying settle until USDC arrives.
        setSuccess("SELL order submitted — waiting for fill…");

        // First: poll CLOB directly if we got a sellOrderId (gives accurate fill time)
        const sellOrderId: string | undefined = closeJson.sellOrderId;
        if (sellOrderId) {
          setSubmitStep("Waiting for SELL to fill…");
          const fillDeadline = Date.now() + 90_000;
          let fillConfirmed = false;
          while (Date.now() < fillDeadline && !fillConfirmed) {
            await new Promise(r => setTimeout(r, 5_000));
            try {
              const statusRes = await fetch(`/api/trade/orders?orderId=${encodeURIComponent(sellOrderId)}&walletAddress=${encodeURIComponent(address!)}&l1Signature=${encodeURIComponent(closeJson.preSellBalance ?? "")}`);
              // orders route needs auth; fallback: just keep going to settle
              if (statusRes.ok) {
                const data = await statusRes.json() as { status?: string; sizeRemaining?: string };
                const s = (data.status ?? "").toUpperCase();
                if (s === "MATCHED" || s === "FILLED" || parseFloat(data.sizeRemaining ?? "1") === 0) {
                  fillConfirmed = true;
                }
              }
            } catch { /* ignore — fall through to settle retries */ }
          }
        } else {
          // No sell order ID: wait a flat 15s then proceed to settle retries
          await new Promise(r => setTimeout(r, 15_000));
        }

        setSubmitStep("Settling repayment…");

        // Retry settle up to 12 times (8s apart = up to 96s total)
        let settled = false;
        let settleError = "";
        for (let attempt = 0; attempt < 12 && !settled; attempt++) {
          const settleRes = await fetch("/api/trade/settle", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              orderId:          positionId,
              repayAmount:      closeJson.repayAmount,
              walletAddress:    address,
              preSellBalance:   closeJson.preSellBalance,
            }),
          });
          if (settleRes.ok) {
            const settleJson = await settleRes.json();
            if (settleJson.closeTxHash) {
              updatePosition(positionId, { closeTxHash: settleJson.closeTxHash });
            }
            settled = true;
          } else if (settleRes.status === 409) {
            // Proceeds not yet available — wait 8s and retry
            if (attempt === 0) setSuccess("Waiting for SELL proceeds to arrive…");
            await new Promise(r => setTimeout(r, 8_000));
          } else {
            settleError = await settleRes.text();
            console.error("[close] settle failed:", settleError);
            break;
          }
        }
        if (settled) {
          setSuccess("Position closed — repayment settled.");
        } else if (settleError) {
          setError(`Position closed but vault repayment failed: ${settleError}. Contact support with order ID: ${positionId}`);
        } else {
          setError(`SELL proceeds not yet available after retries. Contact support with order ID: ${positionId}`);
        }
      } else {
        setSuccess("Position closed.");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setClosing(null);
    }
  }

  async function syncPositions() {
    if (!address || syncing) return;
    setSyncing(true); setError(""); setSuccess("");
    try {
      // Sign L1 auth so the server can derive API creds
      const ts  = Math.floor(Date.now() / 1000);
      const sig = await signTypedDataAsync({
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
          timestamp: String(ts),
          nonce:     BigInt(0),
          message:   "This message attests that I control the given wallet",
        },
      });

      const params = new URLSearchParams({
        walletAddress: address,
        l1Signature:   sig,
        l1Timestamp:   String(ts),
        // Pass market token IDs so the server can check on-chain balances directly
        // (needed when old orders have been pruned from the CLOB order history)
        yesTokenId:    market?.yesTokenId ?? "",
        noTokenId:     market?.noTokenId  ?? "",
      });
      const res = await fetch(`/api/trade/orders?${params}`);
      if (!res.ok) throw new Error(await res.text());

      const recovered: {
        orderId: string; tokenId: string; tokenCount: number;
        side: "YES" | "NO"; entryPrice: number; exchangeAddress: string;
      }[] = await res.json();

      const existingIds = new Set((positions ?? []).map((p) => p.id));
      let added = 0;
      for (const r of recovered) {
        if (r.tokenCount <= 0) continue;
        if (existingIds.has(r.orderId)) {
          // Always overwrite balance-derived positions so a stale tokenCount gets corrected
          if (r.orderId.startsWith("balance-")) {
            updatePosition(r.orderId, {
              tokenCount:      r.tokenCount,
              tokenId:         r.tokenId,
              exchangeAddress: r.exchangeAddress,
            });
          }
          continue;
        }
        addPosition({
          id:              r.orderId,
          walletAddress:   address,
          side:            r.side,
          entryPrice:      r.entryPrice,
          collateral:      parseFloat((r.tokenCount * r.entryPrice).toFixed(6)),
          borrowed:        0,
          notional:        parseFloat((r.tokenCount * r.entryPrice).toFixed(6)),
          leverage:        1,
          fees:            { openFee: 0, closeFee: 0, liquidationFee: 0 },
          state:           "OPEN",
          openedAt:        new Date().toISOString(),
          tokenId:         r.tokenId,
          tokenCount:      r.tokenCount,
          exchangeAddress: r.exchangeAddress,
        });
        added++;
      }
      refetchPositions();
      if (added > 0) {
        setSuccess(`Synced ${added} position${added > 1 ? "s" : ""} from Polymarket.`);
      } else if (recovered.length === 0) {
        setSuccess("No active positions found on Polymarket.");
      } else {
        setSuccess("All positions already up to date.");
      }
    } catch (e: any) {
      setError(`Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Open Positions ─────────────────────────────────── */}
      <div className="card" style={{ padding: 20 }}>
        <div className="card-header">
          <div className="metric-label">Open Positions</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {isConnected && (
              <button
                onClick={syncPositions}
                disabled={syncing}
                style={{
                  fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600,
                  color: syncing ? "var(--text-3)" : "var(--accent)",
                  background: "transparent", border: "1px solid",
                  borderColor: syncing ? "var(--border)" : "rgba(0,229,160,0.3)",
                  borderRadius: 6, padding: "4px 10px", cursor: syncing ? "default" : "pointer",
                  transition: "border-color 150ms",
                }}
              >
                {syncing ? "Syncing…" : "↻ Sync"}
              </button>
            )}
            <div className={`pill ${openPositions.length > 0 ? "pill-live" : ""}`}>
              {openPositions.length > 0 ? `${openPositions.length} Active` : "None"}
            </div>
          </div>
        </div>

        {!isConnected ? (
          <div style={{ textAlign: "center", padding: "32px 20px", background: "var(--surface-2)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>Connect wallet to see your open positions</div>
          </div>
        ) : openPositions.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 20px", background: "var(--surface-2)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-3)" }}>No open positions — open one below</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {openPositions.map((p) => {
              // Sell at bid (mid − spread/2); buy was at ask (mid + spread/2)
              const posMid    = p.side === "YES" ? yesPrice : noPrice;
              const exitPx    = Math.max(posMid - spread / 2, 0.001);
              const grossPnl  = p.entryPrice > 0 ? p.notional * (exitPx / p.entryPrice - 1) : 0;
              const netPnl    = grossPnl; // No close fee
              const pnlPct    = p.collateral > 0 ? (netPnl / p.collateral) * 100 : 0;
              const pnlColor  = netPnl >= 0 ? "var(--yes-color)" : "var(--danger)";
              const isConfirming = confirmClose === p.id;
              const preview = isConfirming && confirmClosePreview?.id === p.id ? confirmClosePreview : null;
              // If we have a real bestBid, compute exact payout; otherwise fall back to estimated exitPx
              const closePx      = preview?.bestBid ?? exitPx;
              const sellProceeds = p.tokenCount ? (p.tokenCount / 1_000_000) * closePx : p.notional * (closePx / (p.entryPrice || closePx));
              const netPayout    = sellProceeds - p.borrowed;
              const confirmPnl   = netPayout - p.collateral;
              const confirmPnlColor = confirmPnl >= 0 ? "var(--yes-color)" : "var(--danger)";
              return (
              <div key={p.id} style={{ background: "var(--surface-2)", border: `1px solid ${isConfirming ? "var(--warn)" : "var(--border)"}`, borderRadius: 12, padding: "14px 16px", transition: "border-color 150ms" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className={`tag tag-${p.side.toLowerCase()}`}>{p.side}</span>
                    <span className="tag tag-open">OPEN</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-2)" }}>{p.leverage.toFixed(1)}x leverage</span>
                  </div>
                  {isConfirming ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                      {preview?.loading ? (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>Fetching live price…</div>
                      ) : (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6, textAlign: "right" }}>
                          <div style={{ color: "var(--text-2)" }}>
                            Sell proceeds: <strong style={{ color: "var(--text-1)" }}>${sellProceeds.toFixed(2)}</strong>
                            {preview?.bestBid != null && <span style={{ color: "var(--text-3)", marginLeft: 4 }}>(bid {preview.bestBid.toFixed(2)})</span>}
                          </div>
                          <div style={{ color: "var(--text-2)" }}>Repay vault: <strong style={{ color: "var(--text-1)" }}>−${p.borrowed.toFixed(2)}</strong></div>
                          <div style={{ color: confirmPnlColor }}>
                            Net P&amp;L: <strong>{confirmPnl >= 0 ? "+" : ""}${confirmPnl.toFixed(2)}</strong>
                            {" "}({confirmPnl >= 0 ? "+" : ""}{p.collateral > 0 ? ((confirmPnl / p.collateral) * 100).toFixed(1) : "—"}%)
                          </div>
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className="btn-danger"
                          style={{ padding: "7px 14px", fontSize: 12 }}
                          disabled={closing === p.id || preview?.loading}
                          onClick={() => { setConfirmClose(null); setConfirmClosePreview(null); closePosition(p.id, p.borrowed); }}
                        >
                          {closing === p.id ? "Closing…" : "Confirm Close"}
                        </button>
                        <button
                          style={{ padding: "7px 12px", fontSize: 12, fontFamily: "var(--mono)", fontWeight: 600, background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-2)", cursor: "pointer" }}
                          onClick={() => { setConfirmClose(null); setConfirmClosePreview(null); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn-danger"
                      style={{ padding: "7px 16px", fontSize: 12 }}
                      disabled={closing === p.id}
                      onClick={() => enterConfirmClose(p.id, p.tokenId, p.tokenCount)}
                    >
                      {closing === p.id ? "Closing…" : "✕ Close Position"}
                    </button>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                  {[
                    { label: "Entry Price", value: p.entryPrice > 0 ? `${(p.entryPrice * 100).toFixed(1)}¢` : "N/A" },
                    { label: "Exit Price",  value: <span style={{ color: "var(--text-1)", fontWeight: 600 }}>{(exitPx * 100).toFixed(1)}¢</span> },
                    { label: "Collateral",  value: `$${p.collateral.toFixed(2)}` },
                    { label: "Size",        value: `$${p.notional.toFixed(2)}` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="metric-label" style={{ marginBottom: 3 }}>{label}</div>
                      <div className="metric-value-sm">{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, background: "var(--surface-3)", borderRadius: 8, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div className="metric-label" style={{ marginBottom: 3 }}>Unrealized PnL</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 700, color: pnlColor }}>
                      {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
                      <span style={{ fontSize: 12, marginLeft: 8, opacity: 0.8 }}>({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)</span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="metric-label" style={{ marginBottom: 3 }}>Borrowed</div>
                    <div className="metric-value-sm">${p.borrowed.toFixed(2)}</div>
                  </div>
                </div>
                {isConfirming && (
                  <div style={{ marginTop: 10, background: "rgba(255,180,0,0.07)", border: "1px solid rgba(255,180,0,0.25)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--warn)", fontWeight: 600, marginBottom: 6 }}>Close summary</div>
                    {[
                      { label: "Sell price (bid)", value: `${(exitPx * 100).toFixed(1)}¢` },
                      { label: "Est. proceeds",    value: `$${(p.notional * exitPx / (p.entryPrice || 1)).toFixed(2)}` },
                      { label: "Net PnL",          value: `${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` },
                    ].map(({ label, value }) => (
                      <div key={label} className="summary-row">
                        <span className="summary-label">{label}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-1)" }}>{value}</span>
                      </div>
                    ))}
                  </div>
                )}
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
              );
            })}
          </div>
        )}

        {/* ── Orphaned tokens: sold position but tokens remain in wallet ─── */}
        {isConnected && orphanedTokens.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--warn)", fontWeight: 700, letterSpacing: "0.05em", paddingTop: 4 }}>
              UNSOLD TOKENS DETECTED
            </div>
            {orphanedTokens.map((o) => {
              const tokensHeld = Number(o.balance) / 1_000_000;
              const isSelling  = sellingOrphan === o.positionId;
              return (
                <div key={o.positionId} style={{ background: "rgba(255,180,0,0.06)", border: "1px solid rgba(255,180,0,0.3)", borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
                    <span className={`tag tag-${o.side.toLowerCase()}`} style={{ marginRight: 8 }}>{o.side}</span>
                    <strong style={{ color: "var(--text-1)" }}>{tokensHeld.toFixed(4)} tokens</strong>
                    {" "}still in wallet from a previous close — sell now to recover USDC.
                  </div>
                  <button
                    className="btn-warn"
                    style={{ padding: "7px 16px", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}
                    disabled={isSelling}
                    onClick={() => sellOrphanedTokens(o.positionId)}
                  >
                    {isSelling ? (submitStep || "Selling…") : "Sell Now"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
              {marketLoading ? "—" : `${(yesPrice * 100).toFixed(1)}¢`}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>Regime falls by June 30</div>
            <MiniChart history={market?.priceHistory ?? []} color="var(--yes-color)" />
          </div>
          <div style={{ background: "var(--surface-2)", border: `1px solid ${side === "NO" ? "var(--no-color)" : "var(--border)"}`, borderRadius: 12, padding: "14px 16px", transition: "border-color 150ms" }}>
            <div className="metric-label" style={{ color: "var(--no-color)", marginBottom: 6 }}>NO</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 28, fontWeight: 700, color: "var(--no-color)" }}>
              {marketLoading ? "—" : `${(noPrice * 100).toFixed(1)}¢`}
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
            LONG YES · {(yesPrice * 100).toFixed(1)}¢
          </button>
          <button className={`side-btn side-btn-no ${side === "NO" ? "active" : ""}`} onClick={() => setSide("NO")}>
            LONG NO · {(noPrice * 100).toFixed(1)}¢
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
              { label: "Entry Price",         value: side ? `${(entryPrice * 100).toFixed(1)}¢` : "—" },
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
              { label: "Open Fee (0.4%)", value: preview.notional > 0 ? `$${preview.fees.openFee.toFixed(4)}` : "—" },
              { label: "Borrow APR",      value: `${(preview.fees.borrowApr * 100).toFixed(1)}%` },
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
          <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, background: "rgba(255,180,0,0.1)", border: "1px solid rgba(255,180,0,0.4)", color: "var(--text-2)", fontSize: 13 }}>
            ⚠ Vault liquidity unavailable (${snapshot?.available.toFixed(2) ?? "0.00"}). Trading at 1× with your collateral only.
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
            : `Open ${side} Position · $${effectivePreview.notional.toFixed(2)}`}
        </button>
        {!isConnected && (
          <p style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)", textAlign: "center", marginTop: 8, marginBottom: 0 }}>
            Any wallet on Polygon network supported
          </p>
        )}
      </div>


    </div>
  );
}

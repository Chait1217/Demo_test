// POST /api/trade/settle
//
// Second-phase repayment for SELL-path position closes.
//
// When a filled position is closed, the user posts a SELL order on Polymarket
// and the 3 USDC proceeds flow back to their wallet once the order fills (~8s).
// Only AFTER those proceeds arrive can we safely pull the borrowed portion back
// to the vault — doing it earlier drains the wallet by the full notional (the -3 bug).
//
// The close route returns repayPending:true for SELL-path closes.  The client
// waits ~10 seconds and then calls this endpoint to complete the repayment.

import { NextRequest } from "next/server";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POLYGON_CHAIN, USDCe_ADDRESS, VAULT_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

// Idempotency guard — prevents double-repayment if the client retries settle
// after a successful on-chain pull (e.g. network drop after 200 was sent).
const settledOrders = new Set<string>();

const publicClient = createPublicClient({
  chain:     POLYGON_CHAIN,
  transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com", {
    timeout: 10_000, retryCount: 0,
  }),
});

const ERC20_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transferFrom", type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      orderId:       string;
      repayAmount:   number;   // borrowed USDC to pull back to vault
      walletAddress: string;
    };

    const { orderId, repayAmount, walletAddress } = body;

    if (!orderId || !repayAmount || repayAmount <= 0 || !walletAddress) {
      return new Response("Missing required fields", { status: 400 });
    }

    if (settledOrders.has(orderId)) {
      console.log(`[settle] already settled orderId=${orderId} — skipping`);
      return Response.json({ ok: true, orderId, alreadySettled: true });
    }

    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
    const hasVault  = VAULT_ADDRESS && VAULT_ADDRESS !== ZERO_ADDR;
    const serverPk  = process.env.POLYMARKET_PRIVATE_KEY;

    if (!hasVault || !serverPk) {
      // No on-chain vault — nothing to settle
      return Response.json({ ok: true, orderId, skipped: true });
    }

    const repayRaw = BigInt(Math.round(repayAmount * 1_000_000));
    const rpcUrl   = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
    const account  = privateKeyToAccount(serverPk as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain:     POLYGON_CHAIN,
      transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }),
    });

    // Verify the user's balance is sufficient (SELL should have settled by now)
    const userBal = await publicClient.readContract({
      address:      USDCe_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "balanceOf",
      args:         [walletAddress as `0x${string}`],
    }) as bigint;

    if (userBal < repayRaw) {
      return new Response(
        `SELL proceeds not yet available — user balance $${(Number(userBal) / 1e6).toFixed(2)} < repay $${repayAmount.toFixed(2)}. Try again in a few seconds.`,
        { status: 409 },
      );
    }

    // Pull repayment from user wallet → engine (user pre-approved this in the close flow)
    const pullHash = await walletClient.writeContract({
      address:      USDCe_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "transferFrom",
      args:         [walletAddress as `0x${string}`, account.address, repayRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: pullHash, timeout: 30_000 });
    console.log(`[settle] pulled $${repayAmount.toFixed(2)} USDC.e from user to engine`);

    // Engine approves vault, then repays
    const approveHash = await walletClient.writeContract({
      address:      USDCe_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "approve",
      args:         [VAULT_ADDRESS, repayRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 });

    const repayHash = await walletClient.writeContract({
      address:      VAULT_ADDRESS,
      abi:          leveragedVaultAbi,
      functionName: "repay",
      args:         [repayRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: repayHash, timeout: 30_000 });
    console.log(`[settle] vault repay: $${repayAmount.toFixed(2)} USDC.e`);

    settledOrders.add(orderId);
    return Response.json({ ok: true, orderId, closeTxHash: pullHash });
  } catch (err: any) {
    console.error("[settle] error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

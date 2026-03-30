import { NextRequest } from "next/server";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POLYGON_CHAIN, USDCe_ADDRESS, VAULT_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi } from "@/lib/vaultAbi";
import { repayToVault } from "@/server/vaultState";

/**
 * POST /api/vault/repay-from-wallet
 *
 * Pulls USDC from the user's wallet into the engine, then repays the vault.
 * Use this to clear a stuck totalBorrowed when the engine has no USDC.
 *
 * Requires the user to have pre-approved the engine address for `amount` USDC.
 *
 * Body: { walletAddress: string, amount: number }
 */

const ERC20_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transferFrom", type: "function", stateMutability: "nonpayable",
    inputs:  [
      { name: "from",   type: "address" },
      { name: "to",     type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const publicClient = createPublicClient({
  chain:     POLYGON_CHAIN,
  transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com", {
    timeout: 10_000, retryCount: 0,
  }),
});

export async function POST(req: NextRequest) {
  const serverPk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!serverPk) return new Response("No server key configured", { status: 500 });

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (!VAULT_ADDRESS || VAULT_ADDRESS === ZERO_ADDR) {
    return new Response("Vault not configured", { status: 500 });
  }

  let walletAddress: string;
  let amount: number;
  try {
    const body = await req.json() as { walletAddress: string; amount: number };
    walletAddress = body.walletAddress;
    amount        = body.amount;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!walletAddress || !amount || amount <= 0) {
    return new Response("Missing walletAddress or amount", { status: 400 });
  }

  const amountRaw = BigInt(Math.round(amount * 1_000_000));
  const account   = privateKeyToAccount(serverPk as `0x${string}`);

  try {
    const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
    const walletClient = createWalletClient({
      account,
      chain:     POLYGON_CHAIN,
      transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }),
    });

    // Step 1: Pull USDC from user wallet → engine (requires user pre-approval)
    const pullHash = await walletClient.writeContract({
      address:      USDCe_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "transferFrom",
      args:         [walletAddress as `0x${string}`, account.address, amountRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: pullHash, timeout: 30_000 });
    console.log(`[vault/repay-from-wallet] pulled $${amount.toFixed(2)} USDC from ${walletAddress}`);

    // Step 2: Engine approves vault to pull USDC
    const approveHash = await walletClient.writeContract({
      address:      USDCe_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "approve",
      args:         [VAULT_ADDRESS, amountRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 });

    // Step 3: Vault repay
    const repayHash = await walletClient.writeContract({
      address:      VAULT_ADDRESS,
      abi:          leveragedVaultAbi,
      functionName: "repay",
      args:         [amountRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: repayHash, timeout: 30_000 });

    repayToVault(amount);
    console.log(`[vault/repay-from-wallet] vault repaid $${amount.toFixed(2)} USDC`);

    return Response.json({ ok: true, repaid: amount, txHash: repayHash });
  } catch (e: any) {
    console.error("[vault/repay-from-wallet] error:", e);
    return new Response(`Repay failed: ${e.message}`, { status: 500 });
  }
}

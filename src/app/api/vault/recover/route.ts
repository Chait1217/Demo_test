import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POLYGON_CHAIN, USDCe_ADDRESS, VAULT_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

/**
 * POST /api/vault/recover
 *
 * Sweeps any USDC sitting in the engine wallet back into the vault via repay().
 * Call this to recover USDC that was transferred to the engine wallet but whose
 * corresponding vault.repay() failed (e.g. due to the now-fixed ordering bug).
 *
 * Body: { amount?: number }  — USDC amount to repay (default: full engine balance)
 */

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve",   type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;

const publicClient = createPublicClient({
  chain:     POLYGON_CHAIN,
  transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com", {
    timeout: 10_000, retryCount: 0,
  }),
});

export async function POST(req: Request) {
  const serverPk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!serverPk) return new Response("No server key configured", { status: 500 });

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (!VAULT_ADDRESS || VAULT_ADDRESS === ZERO_ADDR) {
    return new Response("Vault not configured", { status: 500 });
  }

  const account = privateKeyToAccount(serverPk as `0x${string}`);

  // Determine how much to repay: use explicit amount or full engine balance
  let amountRaw: bigint;
  try {
    const body = await req.json() as { amount?: number };
    if (body.amount && body.amount > 0) {
      amountRaw = BigInt(Math.round(body.amount * 1_000_000));
    } else {
      amountRaw = await publicClient.readContract({
        address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf",
        args: [account.address],
      }) as bigint;
    }
  } catch {
    amountRaw = await publicClient.readContract({
      address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf",
      args: [account.address],
    }) as bigint;
  }

  if (amountRaw === 0n) {
    return Response.json({ ok: true, message: "Engine wallet has no USDC to recover" });
  }

  try {
    const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
    const walletClient = createWalletClient({
      account,
      chain:     POLYGON_CHAIN,
      transport: http(rpcUrl, { timeout: 30_000, retryCount: 1 }),
    });

    // Approve vault to pull USDC from engine
    const approveHash = await walletClient.writeContract({
      address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [VAULT_ADDRESS, amountRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 });

    // Repay vault
    const repayHash = await walletClient.writeContract({
      address: VAULT_ADDRESS, abi: leveragedVaultAbi, functionName: "repay",
      args: [amountRaw],
    });
    await publicClient.waitForTransactionReceipt({ hash: repayHash, timeout: 30_000 });

    const usdcRepaid = Number(amountRaw) / 1_000_000;
    console.log(`[vault/recover] repaid $${usdcRepaid.toFixed(2)} USDC to vault`);
    return Response.json({ ok: true, repaid: usdcRepaid });
  } catch (e: any) {
    return new Response(`Recovery failed: ${e.message}`, { status: 500 });
  }
}

import { NextRequest } from "next/server";
import { parseUnits } from "viem";
import { ethers } from "ethers";
import { closePolymarketPosition } from "@/server/polymarketClient";
import { recordClosePosition } from "@/server/positionsStore";
import { VAULT_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

function getVaultWriteContract() {
  const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(pk, provider);
  return new ethers.Contract(VAULT_ADDRESS, leveragedVaultAbi as any, signer);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { orderId, repayAmount } = body as { orderId: string; repayAmount: number };

    if (!orderId) return new Response("Missing orderId", { status: 400 });

    // 1. Close Polymarket position (only if real order, not simulated)
    if (!orderId.startsWith("sim_") && process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        await closePolymarketPosition(orderId);
      } catch (e: any) {
        console.error("Polymarket close failed:", e.message);
        // Non-fatal, continue to record closure
      }
    }

    // 2. Repay vault
    const ZERO = "0x0000000000000000000000000000000000000000";
    const hasVault = VAULT_ADDRESS && VAULT_ADDRESS !== ZERO;

    if (hasVault && repayAmount && repayAmount > 0 && process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        const vault = getVaultWriteContract();
        const raw = parseUnits(repayAmount.toString(), 6);
        await vault.repay(raw);
      } catch (e: any) {
        console.warn("Vault repay failed (non-fatal):", e.message);
      }
    }

    // 3. Record closure
    recordClosePosition(orderId);

    return Response.json({ ok: true, orderId });
  } catch (err: any) {
    console.error("Trade close error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

import { NextRequest } from "next/server";
import { parseUnits } from "viem";
import { ethers } from "ethers";
import { closePolymarketPosition } from "@/server/polymarketClient";
import { recordClosePosition } from "@/server/positionsStore";
import { VAULT_ADDRESS } from "@/lib/constants";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

function getVaultWriteContract() {
  const rpcUrl = process.env.POLYGON_RPC_URL;
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!rpcUrl || !pk || !VAULT_ADDRESS) {
    throw new Error("Vault or RPC not configured");
  }
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(pk, provider);
  return new ethers.Contract(VAULT_ADDRESS, leveragedVaultAbi as any, signer);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { orderId, repayAmount } = body as {
    orderId: string;
    repayAmount: number;
  };

  if (!orderId) {
    return new Response("Missing orderId", { status: 400 });
  }

  await closePolymarketPosition(orderId);
  if (repayAmount && repayAmount > 0) {
    const vault = getVaultWriteContract();
    const raw = parseUnits(repayAmount.toString(), 6);
    await vault.repay(raw);
  }

  recordClosePosition(orderId);

  return Response.json({ ok: true });
}


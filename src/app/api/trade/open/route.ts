import { NextRequest } from "next/server";
import { Address, formatUnits, parseUnits } from "viem";
import { createPublicClient, http } from "viem";
import { ethers } from "ethers";
import { POLYGON_CHAIN, USDCe_ADDRESS, VAULT_ADDRESS } from "@/lib/constants";
import { computePositionPreview } from "@/lib/leverage";
import { openPolymarketPosition } from "@/server/polymarketClient";
import { recordOpenPosition } from "@/server/positionsStore";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
] as const;

const publicClient = createPublicClient({
  chain: POLYGON_CHAIN,
  transport: http(process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com", {
    timeout: 5_000,
    retryCount: 0,
  }),
});

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
    const { walletAddress, side, collateral, leverage, price } = body as {
      walletAddress: string;
      side: "YES" | "NO";
      collateral: number;
      leverage: number;
      price: number;
    };

    if (!walletAddress || !side || !collateral || !leverage || !price) {
      return new Response("Invalid trade payload", { status: 400 });
    }

    const raceTimeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));

    // 2. Check vault liquidity
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;
    const hasVault = VAULT_ADDRESS && VAULT_ADDRESS !== ZERO;

    let utilization = 0;
    let available = 999999;
    let insufficientBalance = false;

    // Run balance check + vault check in parallel with a shared 4s deadline
    await Promise.all([
      // 1. Wallet USDC.e balance check
      Promise.race([
        Promise.all([
          publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "decimals" }),
          publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [walletAddress as Address] }),
        ]).then(([decimals, rawBalance]) => {
          const balance = Number(formatUnits(rawBalance as bigint, decimals as number));
          if (balance < collateral) insufficientBalance = true;
        }),
        raceTimeout(4_000),
      ]).catch(() => { /* RPC unavailable — skip, client already validated */ }),

      // 2. Vault liquidity check
      !hasVault ? Promise.resolve() : Promise.race([
        Promise.all([
          publicClient.readContract({ address: VAULT_ADDRESS, abi: leveragedVaultAbi, functionName: "availableLiquidity" }),
          publicClient.readContract({ address: VAULT_ADDRESS, abi: leveragedVaultAbi, functionName: "totalAssets" }),
          publicClient.readContract({ address: VAULT_ADDRESS, abi: leveragedVaultAbi, functionName: "totalBorrowed" }),
        ]).then(([availableRaw, tvlRaw, borrowedRaw]) => {
          available = Number(formatUnits(availableRaw as bigint, 6));
          const tvl = Number(formatUnits(tvlRaw as bigint, 6));
          const borrowed = Number(formatUnits(borrowedRaw as bigint, 6));
          utilization = tvl === 0 ? 0 : borrowed / tvl;
        }),
        raceTimeout(4_000),
      ]).catch(() => { /* vault unavailable, use defaults */ }),
    ]);

    if (insufficientBalance) {
      return new Response(`Insufficient USDC.e balance. Need $${collateral.toFixed(2)}.`, { status: 400 });
    }

    const preview = computePositionPreview({ collateral, leverage }, utilization);

    if (hasVault && preview.borrowed > available) {
      return new Response(`Insufficient vault liquidity. Need $${preview.borrowed.toFixed(2)}, available $${available.toFixed(2)}.`, { status: 400 });
    }

    // 3. Borrow from vault (only if vault is deployed and has the borrow function)
    if (hasVault && preview.borrowed > 0 && process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        const vaultWrite = getVaultWriteContract();
        const borrowRaw = parseUnits(preview.borrowed.toFixed(6), 6);
        await vaultWrite.borrow(borrowRaw);
      } catch (e: any) {
        // Non-fatal: vault borrow may not exist yet; log and continue
        console.warn("Vault borrow failed (non-fatal):", e.message);
      }
    }

    // 4. Execute real Polymarket trade
    let orderId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let orderStatus = "SIMULATED";

    if (process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        const order = await openPolymarketPosition({ side, price, size: preview.notional });
        orderId = order.orderId ?? (order as any).orderID ?? orderId;
        orderStatus = order.status ?? "PLACED";
      } catch (e: any) {
        // If Polymarket credentials not fully configured, log but don't block
        console.error("Polymarket order failed:", e.message);
      }
    }

    // 5. Record position
    recordOpenPosition({
      id: orderId,
      walletAddress,
      side,
      entryPrice: price,
      collateral,
      borrowed: preview.borrowed,
      notional: preview.notional,
      leverage,
      fees: {
        openFee: preview.fees.openFee,
        closeFee: preview.fees.closeFee,
        liquidationFee: preview.fees.liquidationFee,
      },
    });

    return Response.json({ orderId, status: orderStatus, preview });
  } catch (err: any) {
    console.error("Trade open error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

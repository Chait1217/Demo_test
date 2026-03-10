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
  transport: http(),
});

function getVaultReadClient() {
  return publicClient;
}

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
  const {
    walletAddress,
    side,
    collateral,
    leverage,
    price,
  }: {
    walletAddress: string;
    side: "YES" | "NO";
    collateral: number;
    leverage: number;
    price: number;
  } = body;

  if (!walletAddress || !side || !collateral || !leverage || !price) {
    return new Response("Invalid trade payload", { status: 400 });
  }

  // 1. Check wallet USDC.e balance on Polygon
  const [decimals, rawBalance] = await Promise.all([
    publicClient.readContract({
      address: USDCe_ADDRESS,
      abi: ERC20_ABI,
      functionName: "decimals",
    }),
    publicClient.readContract({
      address: USDCe_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress as Address],
    }),
  ]);

  const balance = Number(formatUnits(rawBalance as bigint, decimals as number));
  if (balance < collateral) {
    return new Response("Insufficient USDC.e balance in wallet.", {
      status: 400,
    });
  }

  // 2. Check on-chain vault liquidity and compute borrow
  const vaultClient = getVaultReadClient();
  const [availableRaw, tvlRaw, borrowedRaw] = await Promise.all([
    vaultClient.readContract({
      address: VAULT_ADDRESS,
      abi: leveragedVaultAbi,
      functionName: "availableLiquidity",
    }),
    vaultClient.readContract({
      address: VAULT_ADDRESS,
      abi: leveragedVaultAbi,
      functionName: "totalAssets",
    }),
    vaultClient.readContract({
      address: VAULT_ADDRESS,
      abi: leveragedVaultAbi,
      functionName: "totalBorrowed",
    }),
  ]);

  const available = Number(formatUnits(availableRaw as bigint, 6));
  const tvl = Number(formatUnits(tvlRaw as bigint, 6));
  const borrowed = Number(formatUnits(borrowedRaw as bigint, 6));
  const utilization = tvl === 0 ? 0 : borrowed / tvl;

  const preview = computePositionPreview(
    { collateral, leverage },
    utilization
  );

  if (preview.borrowed > available) {
    return new Response("Not enough vault liquidity for requested leverage.", {
      status: 400,
    });
  }

  // 3. Borrow from vault on-chain via margin engine (server signer)
  const vaultWrite = getVaultWriteContract();
  const borrowRaw = parseUnits(preview.borrowed.toString(), 6);
  await vaultWrite.borrow(borrowRaw);

  const size = preview.notional; // simplified: 1 USDC = 1 outcome token notionally

  const order = await openPolymarketPosition({
    side,
    price,
    size,
  });

  recordOpenPosition({
    id: order.orderID,
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

  return Response.json({
    orderId: order.orderID,
    status: order.status,
    preview,
  });
}


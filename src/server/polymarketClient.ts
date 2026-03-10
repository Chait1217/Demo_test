import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import {
  POLYMARKET_API_HOST,
  POLYMARKET_MARKET_TOKEN_ID_YES,
  POLYMARKET_MARKET_TOKEN_ID_NO,
} from "@/lib/constants";

let fullClient: ClobClient | null = null;

async function getFullClient(): Promise<ClobClient> {
  if (fullClient) return fullClient;

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;

  if (!privateKey || !funder) {
    throw new Error("Polymarket credentials are not configured.");
  }

  const signer = new Wallet(privateKey);
  const bootstrapClient = new ClobClient(POLYMARKET_API_HOST, 137, signer as any);
  const apiCreds = await bootstrapClient.createOrDeriveApiKey();

  fullClient = new ClobClient(
    POLYMARKET_API_HOST,
    137,
    signer as any,
    apiCreds,
    0,
    funder
  );

  return fullClient;
}

export interface OpenPositionParams {
  side: "YES" | "NO";
  price: number;
  size: number;
}

export async function openPolymarketPosition(params: OpenPositionParams) {
  const c = await getFullClient();

  const tokenID =
    params.side === "YES"
      ? POLYMARKET_MARKET_TOKEN_ID_YES
      : POLYMARKET_MARKET_TOKEN_ID_NO;

  if (!tokenID) throw new Error("Polymarket token ID not configured.");

  const response = await c.createAndPostOrder(
    {
      tokenID,
      price: params.price,
      size: params.size,
      side: params.side === "YES" ? Side.BUY : Side.SELL,
    },
    {
      tickSize: "0.01",
      negRisk: false,
    },
    OrderType.GTC
  );

  return response;
}

export async function closePolymarketPosition(orderId: string) {
  const c = await getFullClient();
  await c.cancelOrder(orderId);
}


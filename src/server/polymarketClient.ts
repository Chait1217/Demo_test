import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import {
  POLYMARKET_API_HOST,
  POLYMARKET_MARKET_TOKEN_ID_YES,
  POLYMARKET_MARKET_TOKEN_ID_NO,
} from "@/lib/constants";

let client: ClobClient | null = null;

function getClient() {
  if (client) return client;

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;

  if (!privateKey || !funder) {
    throw new Error("Polymarket credentials are not configured.");
  }

  const signer = new Wallet(privateKey);
  client = new ClobClient(POLYMARKET_API_HOST, 137, signer as any);

  return client;
}

export interface OpenPositionParams {
  side: "YES" | "NO";
  price: number;
  size: number;
}

export async function openPolymarketPosition(params: OpenPositionParams) {
  const c = getClient();
  const apiCreds = await c.createOrDeriveApiKey();
  // Recreate client with API creds and EOA signature type 0
  const fullClient = new ClobClient(
    POLYMARKET_API_HOST,
    137,
    (c as any).signer,
    apiCreds,
    0,
    process.env.POLYMARKET_FUNDER_ADDRESS
  );

  const tokenID =
    params.side === "YES"
      ? POLYMARKET_MARKET_TOKEN_ID_YES
      : POLYMARKET_MARKET_TOKEN_ID_NO;

  if (!tokenID) throw new Error("Polymarket token ID not configured.");

  const response = await fullClient.createAndPostOrder(
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
  const c = getClient();
  const apiCreds = await c.createOrDeriveApiKey();
  const fullClient = new ClobClient(
    POLYMARKET_API_HOST,
    137,
    (c as any).signer,
    apiCreds,
    0,
    process.env.POLYMARKET_FUNDER_ADDRESS
  );

  await fullClient.cancelOrder(orderId);
}


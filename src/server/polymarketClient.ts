import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import {
  POLYMARKET_API_HOST,
  POLYMARKET_GAMMA_HOST,
  IRAN_MARKET_SLUG,
} from "@/lib/constants";

let fullClient: ClobClient | null = null;
let cachedTokenIds: { yes: string; no: string } | null = null;

async function getTokenIds(): Promise<{ yes: string; no: string }> {
  if (cachedTokenIds) return cachedTokenIds;

  // Check env first
  const envYes = process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES;
  const envNo = process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO;
  if (envYes && envNo) {
    cachedTokenIds = { yes: envYes, no: envNo };
    return cachedTokenIds;
  }

  // Auto-discover from Gamma API
  const res = await fetch(`${POLYMARKET_GAMMA_HOST}/markets?slug=${IRAN_MARKET_SLUG}`);
  if (!res.ok) throw new Error("Failed to fetch market token IDs");
  const data = await res.json();
  const market = Array.isArray(data) ? data[0] : data;
  const tokens: { token_id: string; outcome: string }[] = market?.tokens ?? [];
  const yesToken = tokens.find((t) => t.outcome?.toLowerCase() === "yes");
  const noToken = tokens.find((t) => t.outcome?.toLowerCase() === "no");
  if (!yesToken || !noToken) throw new Error("Could not find YES/NO token IDs for Iran market");
  cachedTokenIds = { yes: yesToken.token_id, no: noToken.token_id };
  return cachedTokenIds;
}

async function getFullClient(): Promise<ClobClient> {
  if (fullClient) return fullClient;

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;

  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY not configured.");

  const signer = new Wallet(privateKey);
  const bootstrap = new ClobClient(POLYMARKET_API_HOST, 137, signer as any);
  const apiCreds = await bootstrap.createOrDeriveApiKey();

  fullClient = new ClobClient(
    POLYMARKET_API_HOST,
    137,
    signer as any,
    apiCreds,
    0,
    funder ?? signer.address
  );

  return fullClient;
}

export interface OpenPositionParams {
  side: "YES" | "NO";
  price: number;
  size: number;
}

export async function openPolymarketPosition(params: OpenPositionParams) {
  const [c, tokenIds] = await Promise.all([getFullClient(), getTokenIds()]);
  const tokenID = params.side === "YES" ? tokenIds.yes : tokenIds.no;

  const response = await c.createAndPostOrder(
    {
      tokenID,
      price: params.price,
      size: params.size,
      side: params.side === "YES" ? Side.BUY : Side.SELL,
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTC
  );

  return response;
}

export async function closePolymarketPosition(orderId: string) {
  const c = await getFullClient();
  await c.cancelOrder(orderId);
}

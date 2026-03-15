/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import {
  POLYMARKET_API_HOST,
  POLYMARKET_GAMMA_HOST,
  IRAN_MARKET_SLUG,
} from "@/lib/constants";

let fullClient: ClobClient | null = null;
let cachedTokenIds: { yes: string; no: string } | null = null;

/** Parse YES/NO token IDs from a Gamma market object.
 *  Handles both array and JSON-string forms of clobTokenIds / tokens. */
function extractTokenIds(
  market: Record<string, unknown>
): { yes: string; no: string } | null {
  // Form 1: tokens array with {token_id, outcome} objects
  const tokensRaw = market.tokens;
  if (Array.isArray(tokensRaw)) {
    const yes = (tokensRaw as { token_id: string; outcome: string }[]).find(
      (t) => t.outcome?.toLowerCase() === "yes"
    );
    const no = (tokensRaw as { token_id: string; outcome: string }[]).find(
      (t) => t.outcome?.toLowerCase() === "no"
    );
    if (yes?.token_id && no?.token_id)
      return { yes: yes.token_id, no: no.token_id };
  }

  // Form 2: clobTokenIds (array or JSON string) + outcomes (array or JSON string)
  let clobIds: string[] = [];
  try {
    const raw = market.clobTokenIds;
    clobIds = Array.isArray(raw) ? (raw as string[]) : JSON.parse(raw as string);
  } catch { /* ignore */ }

  let outcomes: string[] = [];
  try {
    const raw = market.outcomes;
    outcomes = Array.isArray(raw) ? (raw as string[]) : JSON.parse(raw as string);
  } catch { /* ignore */ }

  if (clobIds.length >= 2) {
    // Match by outcomes array when available, otherwise assume [yes, no] order
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const noIdx  = outcomes.findIndex((o) => o.toLowerCase() === "no");
    const yes = clobIds[yesIdx !== -1 ? yesIdx : 0];
    const no  = clobIds[noIdx  !== -1 ? noIdx  : 1];
    if (yes && no) return { yes, no };
  }

  return null;
}

export async function getTokenIds(): Promise<{ yes: string; no: string }> {
  if (cachedTokenIds) return cachedTokenIds;

  const envYes = process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES;
  const envNo  = process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO;
  if (envYes && envNo) {
    cachedTokenIds = { yes: envYes, no: envNo };
    return cachedTokenIds;
  }

  // Strategy 1: events endpoint (returns nested markets with full token data)
  try {
    const res = await fetch(
      `${POLYMARKET_GAMMA_HOST}/events?slug=${IRAN_MARKET_SLUG}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (res.ok) {
      const data = await res.json();
      const event = Array.isArray(data) ? data[0] : data;
      const markets: Record<string, unknown>[] = (event?.markets as Record<string, unknown>[]) ?? [];
      for (const m of markets) {
        const ids = extractTokenIds(m);
        if (ids) { cachedTokenIds = ids; return ids; }
      }
    }
  } catch { /* fall through */ }

  // Strategy 2: direct markets slug lookup
  try {
    const res = await fetch(
      `${POLYMARKET_GAMMA_HOST}/markets?slug=${IRAN_MARKET_SLUG}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (res.ok) {
      const data = await res.json();
      const market = Array.isArray(data) ? data[0] : data;
      if (market) {
        const ids = extractTokenIds(market as Record<string, unknown>);
        if (ids) { cachedTokenIds = ids; return ids; }
      }
    }
  } catch { /* fall through */ }

  throw new Error("Could not find YES/NO token IDs for Iran market");
}

async function getFullClient(): Promise<ClobClient> {
  if (fullClient) return fullClient;

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funder     = process.env.POLYMARKET_FUNDER_ADDRESS;

  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY not configured.");

  const signer = new Wallet(privateKey);

  // Bootstrap to derive API credentials
  const bootstrap = new ClobClient(POLYMARKET_API_HOST, 137, signer as any);
  const apiCreds  = await bootstrap.createOrDeriveApiKey();

  fullClient = new ClobClient(
    POLYMARKET_API_HOST,
    137,
    signer as any,
    apiCreds,
    0, // EOA / L1 signature
    funder ?? signer.address,
  );

  return fullClient;
}

export interface OpenPositionParams {
  side:  "YES" | "NO";
  price: number;
  size:  number;
}

export async function openPolymarketPosition(params: OpenPositionParams) {
  const [c, tokenIds] = await Promise.all([getFullClient(), getTokenIds()]);
  const tokenID = params.side === "YES" ? tokenIds.yes : tokenIds.no;

  // size in CLOB is number of outcome tokens, not USD notional
  const tokenCount = params.price > 0 ? params.size / params.price : params.size;

  const response = await c.createAndPostOrder(
    {
      tokenID,
      price: params.price,
      size:  tokenCount,
      side:  Side.BUY, // always BUY the chosen outcome token (YES or NO)
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTC
  );

  return response;
}

export async function closePolymarketPosition(orderId: string) {
  const c = await getFullClient();
  // cancelOrder cancels an open GTC order
  await (c as any).cancelOrder({ orderID: orderId });
}

export function resetClient() {
  fullClient     = null;
  cachedTokenIds = null;
}

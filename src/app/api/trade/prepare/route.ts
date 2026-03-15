import { NextRequest } from "next/server";
import { getTokenIds } from "@/server/polymarketClient";
import { computePositionPreview } from "@/lib/leverage";

const CONTRACTS = {
  exchange:        "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  negRiskExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
};
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function getExchangeAddress(tokenId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/neg-risk?token_id=${tokenId}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (res.ok) {
      const data = await res.json() as { neg_risk?: boolean };
      if (data.neg_risk) return CONTRACTS.negRiskExchange;
    }
  } catch { /* network error — fall back to standard exchange */ }
  return CONTRACTS.exchange;
}

// Rounding helpers (mirrors CLOB client helpers.js for 0.01 tick size)
const RC = { price: 2, size: 2, amount: 4 };

function roundDown(n: number, d: number) { const f = 10 ** d; return Math.floor(n * f) / f; }
function roundNormal(n: number, d: number) { const f = 10 ** d; return Math.round(n * f) / f; }
function roundUp(n: number, d: number) { const f = 10 ** d; return Math.ceil(n * f) / f; }
function decimalPlaces(n: number) { const s = n.toString(); const i = s.indexOf("."); return i === -1 ? 0 : s.length - i - 1; }

function parseUnits6(value: number): string {
  // Avoid floating-point drift by working in integers
  return Math.round(value * 1_000_000).toString();
}

function getBuyAmounts(size: number, price: number) {
  const rawPrice = roundNormal(price, RC.price);
  let rawTaker = roundDown(size, RC.size); // tokens you receive
  let rawMaker = rawTaker * rawPrice;      // USDC you spend
  if (decimalPlaces(rawMaker) > RC.amount) {
    rawMaker = roundUp(rawMaker, RC.amount + 4);
    if (decimalPlaces(rawMaker) > RC.amount) rawMaker = roundDown(rawMaker, RC.amount);
  }
  return {
    makerAmount: parseUnits6(rawMaker), // USDC (collateral in)
    takerAmount: parseUnits6(rawTaker), // tokens (outcome shares out)
  };
}

export async function POST(req: NextRequest) {
  try {
    const { walletAddress, side, collateral, leverage, price, yesTokenId, noTokenId } = await req.json() as {
      walletAddress: string;
      side: "YES" | "NO";
      collateral: number;
      leverage: number;
      price: number;
      yesTokenId?: string;
      noTokenId?: string;
    };

    if (!walletAddress || !side || !collateral || !leverage || !price) {
      return new Response("Invalid payload", { status: 400 });
    }

    // Use client-supplied token IDs first (avoids a redundant Gamma API call
    // and works even when the API is unreachable server-side).
    let tokenId: string;
    if (yesTokenId && noTokenId) {
      tokenId = side === "YES" ? yesTokenId : noTokenId;
    } else {
      const tokenIds = await getTokenIds();
      tokenId = side === "YES" ? tokenIds.yes : tokenIds.no;
    }

    // Size in tokens = collateral USDC / price.
    // The order's makerAmount must equal what the user's wallet actually holds;
    // Polymarket checks balanceOf(maker) on-chain and rejects orders where
    // makerAmount > balance.  Leverage is tracked in our position store but the
    // on-chain order only uses the user's own collateral.
    const preview    = computePositionPreview({ collateral, leverage }, 0);
    const tokenCount = price > 0 ? collateral / price : collateral;

    const { makerAmount, takerAmount } = getBuyAmounts(tokenCount, price);

    const [exchangeAddress, salt, l1Timestamp] = await Promise.all([
      getExchangeAddress(tokenId).then(addr => { console.log(`[prepare] tokenId=${tokenId.slice(0,10)}… exchange=${addr}`); return addr; }),
      Promise.resolve(Math.round(Math.random() * Date.now()).toString()),
      Promise.resolve(Math.floor(Date.now() / 1000)),
    ]);

    // Unsigned order struct — matches the EIP-712 Order type exactly
    const orderStruct = {
      salt,
      maker:          walletAddress,
      signer:         walletAddress,
      taker:          ZERO_ADDRESS,
      tokenId,
      makerAmount,
      takerAmount,
      expiration:     "0",
      nonce:          "0",
      feeRateBps:     "0",
      side:           0,  // BUY
      signatureType:  0,  // EOA
    };

    return Response.json({
      orderStruct,
      exchangeAddress,
      l1Timestamp,
      l1Nonce: 0,
      preview,
    });
  } catch (err: any) {
    console.error("[prepare] error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

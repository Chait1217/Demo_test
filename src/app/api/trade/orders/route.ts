import { NextRequest } from "next/server";
import { POLYMARKET_API_HOST } from "@/lib/constants";

// ── HMAC helpers (mirrored from submit/route.ts) ─────────────────────────────

function base64ToBuffer(b64: string): ArrayBuffer {
  const s   = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

// NOTE: HMAC is built WITHOUT query params — matches Polymarket's CLOB client behaviour
// (same pattern used in submit/route.ts for /balance-allowance/update)
async function buildHmacSig(secret: string, ts: string, method: string, pathNoQuery: string): Promise<string> {
  const message = ts + method + pathNoQuery;
  const key     = await globalThis.crypto.subtle.importKey("raw", base64ToBuffer(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf  = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufferToBase64url(sigBuf);
}

function makeAuthHeaders(walletAddress: string, hmac: string, ts: string, creds: { key: string; passphrase: string }) {
  return {
    POLY_ADDRESS:    walletAddress,
    POLY_SIGNATURE:  hmac,
    POLY_TIMESTAMP:  ts,
    POLY_API_KEY:    creds.key,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

async function deriveApiCreds(walletAddress: string, l1Sig: string, l1Timestamp: number) {
  const l1Headers: Record<string, string> = {
    POLY_ADDRESS:   walletAddress,
    POLY_SIGNATURE: l1Sig,
    POLY_TIMESTAMP: String(l1Timestamp),
    POLY_NONCE:     "0",
  };

  let raw: Record<string, string> | null = null;
  try {
    const r = await fetch(`${POLYMARKET_API_HOST}/auth/api-key`, {
      method: "POST", headers: { "Content-Type": "application/json", ...l1Headers }, body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    if (r.ok) raw = await r.json();
  } catch { /* fall through */ }

  if (!raw?.apiKey) {
    const r = await fetch(`${POLYMARKET_API_HOST}/auth/derive-api-key`, {
      headers: l1Headers, signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) throw new Error(`Polymarket auth failed (${r.status}): ${await r.text()}`);
    raw = await r.json();
  }

  if (!raw?.apiKey) throw new Error("Polymarket returned no API key");
  return { key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase };
}

const CTF_EXCHANGE      = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

async function getExchangeAddress(tokenId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/neg-risk?token_id=${tokenId}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (res.ok) {
      const data = await res.json() as { neg_risk?: boolean };
      if (data.neg_risk) return NEG_RISK_EXCHANGE;
    }
  } catch { /* use default */ }
  return CTF_EXCHANGE;
}

/** Convert a decimal token ID (uint256) to 0x-prefixed 64-char hex — what the CLOB expects */
function tokenIdToHex(tokenId: string): string {
  try {
    const hex = BigInt(tokenId).toString(16);
    return `0x${hex.padStart(64, "0")}`;
  } catch {
    return tokenId; // already hex or unrecognised — pass through
  }
}

/**
 * Query the CLOB balance-allowance endpoint for a conditional token.
 * Returns the number of tokens held in the user's Polymarket proxy wallet,
 * or 0 if the request fails.
 */
async function getConditionalTokenBalance(
  walletAddress: string,
  creds: { key: string; secret: string; passphrase: string },
  tokenId: string,
): Promise<number> {
  const ts      = String(Math.floor(Date.now() / 1000));
  const hexId   = tokenIdToHex(tokenId);
  console.log(`[orders] checking balance for token ${tokenId.slice(0, 10)}… (hex: ${hexId.slice(0, 12)}…)`);

  // Step 1: tell CLOB to refresh its cache from on-chain state
  try {
    const updatePath = "/balance-allowance/update";
    const updateHmac = await buildHmacSig(creds.secret, ts, "GET", updatePath);
    await fetch(
      `${POLYMARKET_API_HOST}${updatePath}?asset_type=1&token_id=${hexId}`,
      {
        headers: makeAuthHeaders(walletAddress, updateHmac, ts, creds),
        signal: AbortSignal.timeout(6_000),
      },
    );
  } catch { /* non-fatal */ }

  // Step 2: read the (now refreshed) balance
  try {
    const readPath = "/balance-allowance";
    const readHmac = await buildHmacSig(creds.secret, ts, "GET", readPath);
    const res = await fetch(
      `${POLYMARKET_API_HOST}${readPath}?asset_type=1&token_id=${hexId}`,
      {
        headers: makeAuthHeaders(walletAddress, readHmac, ts, creds),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (res.ok) {
      const data = await res.json();
      const balance = Number(data.balance ?? data.balance_allowance?.balance ?? 0);
      console.log(`[orders] conditional balance for token ${tokenId.slice(0, 10)}…: ${balance}`);
      return balance;
    }
    console.warn(`[orders] balance-allowance returned ${res.status}: ${await res.text()}`);
  } catch (e: any) {
    console.warn("[orders] balance check failed:", e.message);
  }
  return 0;
}

export interface RecoveredPosition {
  orderId:         string;
  tokenId:         string;
  tokenCount:      number;
  side:            "YES" | "NO";
  entryPrice:      number;
  status:          string;
  exchangeAddress: string;
}

export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get("walletAddress");
    const l1Signature   = req.nextUrl.searchParams.get("l1Signature");
    const l1Timestamp   = req.nextUrl.searchParams.get("l1Timestamp");
    // Token IDs for the market — passed by the client so we know which balances to check
    const yesTokenId    = req.nextUrl.searchParams.get("yesTokenId") ?? "";
    const noTokenId     = req.nextUrl.searchParams.get("noTokenId")  ?? "";

    if (!walletAddress || !l1Signature || !l1Timestamp) {
      return new Response("Missing required params: walletAddress, l1Signature, l1Timestamp", { status: 400 });
    }

    const creds = await deriveApiCreds(walletAddress, l1Signature, Number(l1Timestamp));

    // ── 1. Fetch active orders from the CLOB ──────────────────────────────────
    const ts       = String(Math.floor(Date.now() / 1000));
    const ordPath  = "/data/orders";
    const ordHmac  = await buildHmacSig(creds.secret, ts, "GET", ordPath);

    const ordRes = await fetch(`${POLYMARKET_API_HOST}${ordPath}`, {
      headers: makeAuthHeaders(walletAddress, ordHmac, ts, creds),
      signal: AbortSignal.timeout(12_000),
    });

    const enriched: RecoveredPosition[] = [];

    if (ordRes.ok) {
      const raw      = await ordRes.json();
      const orders: Record<string, unknown>[] = Array.isArray(raw) ? raw : ((raw as any).data ?? []);
      console.log(`[orders] fetched ${orders.length} total orders for ${walletAddress.slice(0, 10)}…`);

      // Keep only active BUY orders where the user has received tokens or is waiting for a fill
      const activeBuys = orders.filter((o) => {
        const side        = String(o.side ?? "").toUpperCase();
        const status      = String(o.status ?? "").toUpperCase();
        const sizeMatched = Number(o.size_matched ?? o.matched_size ?? 0);
        return (
          side === "BUY" &&
          (status === "LIVE" || (status === "MATCHED" && sizeMatched > 0))
        );
      });

      console.log(`[orders] ${activeBuys.length} active BUY orders`);

      for (const o of activeBuys) {
        const tokenId      = String(o.asset_id ?? o.tokenId ?? "");
        const status       = String(o.status ?? "").toUpperCase();
        const sizeMatched  = Number(o.size_matched  ?? o.matched_size  ?? 0);
        const originalSize = Number(o.original_size ?? o.size          ?? 0);
        const tokenCount   = status === "MATCHED" ? sizeMatched : originalSize;
        const outcome      = String(o.outcome ?? "").toLowerCase();
        const side: "YES" | "NO" = outcome === "no" ? "NO" : "YES";
        const exchangeAddress    = await getExchangeAddress(tokenId);

        enriched.push({
          orderId:         String(o.id ?? ""),
          tokenId,
          tokenCount,
          side,
          entryPrice:      Number(o.price ?? 0),
          status:          String(o.status ?? ""),
          exchangeAddress,
        });
      }
    } else {
      console.warn(`[orders] CLOB orders endpoint returned ${ordRes.status}`);
    }

    // ── 2. Check conditional token balances directly (catches old/pruned orders) ─
    // This is the primary recovery path: even if orders no longer appear in the
    // CLOB order history, the tokens are still held in the user's proxy wallet.
    const tokenChecks: { tokenId: string; side: "YES" | "NO" }[] = [];
    if (yesTokenId) tokenChecks.push({ tokenId: yesTokenId, side: "YES" });
    if (noTokenId)  tokenChecks.push({ tokenId: noTokenId,  side: "NO"  });

    for (const { tokenId, side } of tokenChecks) {
      if (!tokenId) continue;
      // Skip if already covered by a live order entry
      if (enriched.some((p) => p.tokenId === tokenId)) continue;

      const balance = await getConditionalTokenBalance(walletAddress, creds, tokenId);
      if (balance > 0) {
        const exchangeAddress = await getExchangeAddress(tokenId);
        enriched.push({
          orderId:         `balance-${tokenId.slice(0, 16)}`,
          tokenId,
          tokenCount:      balance,
          side,
          entryPrice:      0,  // unknown — shown as N/A in UI
          status:          "BALANCE",
          exchangeAddress,
        });
        console.log(`[orders] recovered ${balance} ${side} tokens for ${walletAddress.slice(0, 10)}… via balance check`);
      }
    }

    console.log(`[orders] returning ${enriched.length} recoverable positions`);
    return Response.json(enriched);
  } catch (err: any) {
    console.error("[orders] error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

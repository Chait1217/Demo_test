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

async function buildHmacSig(secret: string, ts: string, method: string, path: string): Promise<string> {
  const message = ts + method + path;
  const key     = await globalThis.crypto.subtle.importKey("raw", base64ToBuffer(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf  = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufferToBase64url(sigBuf);
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

    if (!walletAddress || !l1Signature || !l1Timestamp) {
      return new Response("Missing required params: walletAddress, l1Signature, l1Timestamp", { status: 400 });
    }

    const creds = await deriveApiCreds(walletAddress, l1Signature, Number(l1Timestamp));

    const ts   = String(Math.floor(Date.now() / 1000));
    const path = "/data/orders";
    const hmac = await buildHmacSig(creds.secret, ts, "GET", path);

    const res = await fetch(`${POLYMARKET_API_HOST}${path}`, {
      headers: {
        POLY_ADDRESS:    walletAddress,
        POLY_SIGNATURE:  hmac,
        POLY_TIMESTAMP:  ts,
        POLY_API_KEY:    creds.key,
        POLY_PASSPHRASE: creds.passphrase,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[orders] CLOB error ${res.status}: ${text}`);
      return new Response(`CLOB error (${res.status}): ${text}`, { status: res.status });
    }

    const raw      = await res.json();
    // CLOB returns either an array or { data: [...] }
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

    console.log(`[orders] ${activeBuys.length} active BUY orders to recover`);

    // Enrich with exchange address (parallel, but limit concurrency to avoid hammering CLOB)
    const enriched: RecoveredPosition[] = await Promise.all(
      activeBuys.map(async (o) => {
        const tokenId      = String(o.asset_id ?? o.tokenId ?? "");
        const status       = String(o.status ?? "").toUpperCase();
        const sizeMatched  = Number(o.size_matched  ?? o.matched_size  ?? 0);
        const originalSize = Number(o.original_size ?? o.size          ?? 0);
        const tokenCount   = status === "MATCHED" ? sizeMatched : originalSize;
        const outcome      = String(o.outcome ?? "").toLowerCase();
        const side: "YES" | "NO" = outcome === "no" ? "NO" : "YES";
        const exchangeAddress    = await getExchangeAddress(tokenId);

        return {
          orderId:  String(o.id ?? ""),
          tokenId,
          tokenCount,
          side,
          entryPrice:      Number(o.price ?? 0),
          status:          String(o.status ?? ""),
          exchangeAddress,
        };
      }),
    );

    return Response.json(enriched);
  } catch (err: any) {
    console.error("[orders] error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

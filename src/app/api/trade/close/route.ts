import { NextRequest } from "next/server";
import { parseUnits } from "viem";
import { ethers } from "ethers";
import { recordClosePosition } from "@/server/positionsStore";
import { VAULT_ADDRESS, POLYMARKET_API_HOST } from "@/lib/constants";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

function getVaultWriteContract() {
  const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
  const pk     = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer   = new ethers.Wallet(pk, provider);
  return new ethers.Contract(VAULT_ADDRESS, leveragedVaultAbi as any, signer);
}

// ── HMAC (mirrors submit/route.ts) ───────────────────────────────────────────

function base64ToBuffer(b64: string): ArrayBuffer {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
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

async function buildHmacSig(secret: string, ts: string, method: string, path: string, body?: string): Promise<string> {
  const message   = ts + method + path + (body ?? "");
  const key       = await globalThis.crypto.subtle.importKey("raw", base64ToBuffer(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf    = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufferToBase64url(sigBuf);
}

// ── Derive API creds from user's L1 EIP-712 signature ────────────────────────

async function deriveApiCreds(walletAddress: string, l1Sig: string, l1Timestamp: number, l1Nonce: number) {
  const l1Headers: Record<string, string> = {
    POLY_ADDRESS:   walletAddress,
    POLY_SIGNATURE: l1Sig,
    POLY_TIMESTAMP: String(l1Timestamp),
    POLY_NONCE:     String(l1Nonce),
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

// ── Cancel a GTC order ────────────────────────────────────────────────────────

async function cancelOrder(
  walletAddress: string,
  creds: { key: string; secret: string; passphrase: string },
  orderId: string,
) {
  const ts      = String(Math.floor(Date.now() / 1000));
  const path    = `/order/${orderId}`;
  const hmac    = await buildHmacSig(creds.secret, ts, "DELETE", path);

  const res = await fetch(`${POLYMARKET_API_HOST}${path}`, {
    method: "DELETE",
    headers: {
      POLY_ADDRESS:    walletAddress,
      POLY_SIGNATURE:  hmac,
      POLY_TIMESTAMP:  ts,
      POLY_API_KEY:    creds.key,
      POLY_PASSPHRASE: creds.passphrase,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket cancel failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      orderId:      string;
      repayAmount:  number;
      // user's L1 auth signature (only needed for real orders)
      walletAddress?: string;
      l1Signature?:   string;
      l1Timestamp?:   number;
      l1Nonce?:       number;
    };

    const { orderId, repayAmount, walletAddress, l1Signature, l1Timestamp, l1Nonce } = body;
    if (!orderId) return new Response("Missing orderId", { status: 400 });

    // ── 1. Cancel on Polymarket ───────────────────────────────────────────────
    const isSimulated = orderId.startsWith("sim_") || orderId.startsWith("placed_");
    if (!isSimulated && walletAddress && l1Signature && l1Timestamp != null) {
      try {
        const creds = await deriveApiCreds(walletAddress, l1Signature, l1Timestamp, l1Nonce ?? 0);
        await cancelOrder(walletAddress, creds, orderId);
        console.log("[close] order cancelled on Polymarket:", orderId);
      } catch (e: any) {
        // Non-fatal: order may already be filled/expired — log and continue
        console.warn("[close] Polymarket cancel non-fatal:", e.message);
      }
    }

    // ── 2. Repay vault ────────────────────────────────────────────────────────
    const ZERO     = "0x0000000000000000000000000000000000000000";
    const hasVault = VAULT_ADDRESS && VAULT_ADDRESS !== ZERO;

    if (hasVault && repayAmount > 0 && process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        const vault = getVaultWriteContract();
        await vault.repay(parseUnits(repayAmount.toFixed(6), 6));
      } catch (e: any) {
        console.warn("[close] vault repay non-fatal:", e.message);
      }
    }

    // ── 3. Record closure ─────────────────────────────────────────────────────
    recordClosePosition(orderId);

    return Response.json({ ok: true, orderId });
  } catch (err: any) {
    console.error("[close] error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

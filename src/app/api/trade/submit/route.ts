import { NextRequest } from "next/server";
import { Address, formatUnits, parseUnits } from "viem";
import { createPublicClient, http } from "viem";
import { ethers } from "ethers";
import { POLYGON_CHAIN, USDCe_ADDRESS, VAULT_ADDRESS, POLYMARKET_API_HOST } from "@/lib/constants";
import { computePositionPreview } from "@/lib/leverage";
import { recordOpenPosition } from "@/server/positionsStore";
import { leveragedVaultAbi } from "@/lib/vaultAbi";

const ERC20_ABI = [
  { constant: true, inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], type: "function" },
  { constant: true, inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], type: "function" },
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
  const pk     = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer   = new ethers.Wallet(pk, provider);
  return new ethers.Contract(VAULT_ADDRESS, leveragedVaultAbi as any, signer);
}

// ── Polymarket auth: derive API creds from user's L1 EIP-712 signature ──────

async function deriveApiCreds(
  walletAddress: string,
  l1Sig: string,
  l1Timestamp: number,
  l1Nonce: number,
): Promise<{ key: string; secret: string; passphrase: string }> {
  const l1Headers: Record<string, string> = {
    POLY_ADDRESS:   walletAddress,
    POLY_SIGNATURE: l1Sig,
    POLY_TIMESTAMP: String(l1Timestamp),
    POLY_NONCE:     String(l1Nonce),
  };

  // Try to create a new API key first; fall back to deriving an existing one
  let raw: Record<string, string> | null = null;

  try {
    const createRes = await fetch(`${POLYMARKET_API_HOST}/auth/api-key`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...l1Headers },
      body:    "{}",
      signal:  AbortSignal.timeout(8_000),
    });
    if (createRes.ok) raw = await createRes.json();
  } catch { /* network error — fall through to derive */ }

  if (!raw?.apiKey) {
    const deriveRes = await fetch(`${POLYMARKET_API_HOST}/auth/derive-api-key`, {
      headers: l1Headers,
      signal:  AbortSignal.timeout(8_000),
    });
    if (!deriveRes.ok) {
      const text = await deriveRes.text();
      throw new Error(`Polymarket auth failed (${deriveRes.status}): ${text}`);
    }
    raw = await deriveRes.json();
  }

  if (!raw?.apiKey) throw new Error("Polymarket returned no API key");
  return { key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase };
}

// ── HMAC signature (mirrors clob-client signing/hmac.js) ────────────────────

function base64ToBuffer(b64: string): ArrayBuffer {
  const sanitised = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(sanitised);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes  = new Uint8Array(buf);
  let binary   = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

async function buildHmacSig(secret: string, ts: string, method: string, path: string, body?: string): Promise<string> {
  const message   = ts + method + path + (body ?? "");
  const keyData   = base64ToBuffer(secret);
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf    = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return bufferToBase64url(sigBuf);
}

// ── POST a pre-signed order to the Polymarket CLOB ──────────────────────────

async function postSignedOrder(
  walletAddress: string,
  creds: { key: string; secret: string; passphrase: string },
  orderWithSig: Record<string, unknown>,
): Promise<{ orderId?: string; orderID?: string; status?: string }> {
  const ts   = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ order: orderWithSig, orderType: "GTC", expose_neg_risk: false });
  const hmac = await buildHmacSig(creds.secret, ts, "POST", "/order", body);

  const res = await fetch(`${POLYMARKET_API_HOST}/order`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      POLY_ADDRESS:   walletAddress,
      POLY_SIGNATURE: hmac,
      POLY_TIMESTAMP: ts,
      POLY_API_KEY:   creds.key,
      POLY_PASSPHRASE: creds.passphrase,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket order rejected (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      // wallet identity
      walletAddress:  string;
      // L1 auth signature (ClobAuth EIP-712)
      l1Signature:    string;
      l1Timestamp:    number;
      l1Nonce:        number;
      // pre-signed Polymarket order
      orderStruct:    Record<string, unknown>;
      orderSignature: string;
      // trade params (for vault + position recording)
      side:       "YES" | "NO";
      collateral: number;
      leverage:   number;
      price:      number;
    };

    const {
      walletAddress, l1Signature, l1Timestamp, l1Nonce,
      orderStruct, orderSignature,
      side, collateral, leverage, price,
    } = body;

    if (!walletAddress || !l1Signature || !orderStruct || !orderSignature) {
      return new Response("Missing required fields", { status: 400 });
    }

    // ── 1. Check wallet balance ──────────────────────────────────────────────
    const raceTimeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
    let insufficientBalance = false;

    await Promise.race([
      Promise.all([
        publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [walletAddress as Address] }),
      ]).then(([decimals, rawBal]) => {
        if (Number(formatUnits(rawBal as bigint, decimals as number)) < collateral) {
          insufficientBalance = true;
        }
      }),
      raceTimeout(4_000),
    ]).catch(() => { /* RPC timeout — skip check */ });

    if (insufficientBalance) {
      return new Response(`Insufficient USDC.e balance. Need $${collateral.toFixed(2)}.`, { status: 400 });
    }

    // ── 2. Vault borrow ──────────────────────────────────────────────────────
    const ZERO    = "0x0000000000000000000000000000000000000000" as Address;
    const hasVault = VAULT_ADDRESS && VAULT_ADDRESS !== ZERO;
    const preview  = computePositionPreview({ collateral, leverage }, 0);

    if (hasVault && preview.borrowed > 0 && process.env.POLYMARKET_PRIVATE_KEY) {
      try {
        const vault     = getVaultWriteContract();
        const borrowRaw = parseUnits(preview.borrowed.toFixed(6), 6);
        await vault.borrow(borrowRaw);
      } catch (e: any) {
        console.warn("[submit] vault borrow failed (non-fatal):", e.message);
      }
    }

    // ── 3. Derive API creds from user's L1 signature ─────────────────────────
    const creds = await deriveApiCreds(walletAddress, l1Signature, l1Timestamp, l1Nonce);

    // ── 4. Post the pre-signed order ─────────────────────────────────────────
    const orderWithSig = { ...orderStruct, signature: orderSignature };
    const orderResp    = await postSignedOrder(walletAddress, creds, orderWithSig);

    const orderId    = orderResp.orderId ?? orderResp.orderID ?? `placed_${Date.now()}`;
    const orderStatus = orderResp.status ?? "PLACED";

    // ── 5. Record position ───────────────────────────────────────────────────
    recordOpenPosition({
      id:           orderId,
      walletAddress,
      side,
      entryPrice:   price,
      collateral,
      borrowed:     preview.borrowed,
      notional:     preview.notional,
      leverage,
      fees: {
        openFee:         preview.fees.openFee,
        closeFee:        preview.fees.closeFee,
        liquidationFee:  preview.fees.liquidationFee,
      },
    });

    return Response.json({ orderId, status: orderStatus, preview });
  } catch (err: any) {
    console.error("[submit] error:", err);
    return new Response(err.message ?? "Internal error", { status: 500 });
  }
}

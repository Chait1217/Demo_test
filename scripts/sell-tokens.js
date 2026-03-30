/**
 * Sell all orphaned CTF outcome tokens for a given wallet.
 *
 * Usage:
 *   node scripts/sell-tokens.js [tokenId]
 *
 *   If tokenId is omitted the script reads all tokenIds from the server
 *   positions store and sells every one that has a non-zero balance.
 *
 * Required env vars in .env.local:
 *   USER_PRIVATE_KEY   — private key of the wallet holding the tokens
 *   POLYGON_RPC_URL    — Alchemy / Infura Polygon RPC
 */

"use strict";
require("dotenv").config({ path: ".env.local" });
const { ethers } = require("ethers");

// ── constants ────────────────────────────────────────────────────────────────
const PRIVATE_KEY      = process.env.USER_PRIVATE_KEY;
const RPC_URL          = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
const CLOB_HOST        = "https://clob.polymarket.com";
const CTF_TOKEN_ADDR   = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_EXCHANGE_ADDR  = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE  = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const CHAIN_ID         = 137;

// token IDs to try (from the known market; extend as needed)
const KNOWN_TOKEN_IDS = (process.env.KNOWN_TOKEN_IDS ?? "").split(",").filter(Boolean);

const ERC1155_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

// ── helpers ──────────────────────────────────────────────────────────────────

async function getApiCreds(wallet) {
  const ts    = Math.floor(Date.now() / 1000);
  const nonce = 0;
  const domain = {
    name: "ClobAuthDomain", version: "1",
    chainId: CHAIN_ID,
  };
  const types = { ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "uint256" },
    { name: "message",   type: "string"  },
  ]};
  const value = {
    address:   wallet.address,
    timestamp: String(ts),
    nonce,
    message:   "This message attests that I control the given wallet",
  };

  const l1Sig = await wallet._signTypedData(domain, types, value);

  const headers = {
    "Content-Type":   "application/json",
    "POLY_ADDRESS":   wallet.address,
    "POLY_SIGNATURE": l1Sig,
    "POLY_TIMESTAMP": String(ts),
    "POLY_NONCE":     String(nonce),
  };

  // Try POST first (create-or-derive); fall back to GET (fetch existing)
  let r = await fetch(`${CLOB_HOST}/auth/api-key`, {
    method: "POST", headers, body: "{}",
  });
  if (r.status === 401 || r.status === 404) {
    r = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "GET", headers });
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Could not fetch API key: ${r.status} — ${body}`);
  }
  const creds = await r.json();
  return { ...creds, l1Sig, ts };
}

function buildHmacHeaders(creds, method, path, body) {
  const ts     = String(Math.floor(Date.now() / 1000));
  // Only append body to message when it is actually provided (matches Polymarket SDK)
  const msg    = ts + method.toUpperCase() + path + (body !== undefined ? body : "");
  const crypto = require("crypto");
  const secret = Buffer.from(
    creds.secret.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, ""),
    "base64",
  );
  // Use standard base64 (keeps = padding) then convert to URL-safe (+ → -, / → _)
  const sigB64    = crypto.createHmac("sha256", secret).update(msg).digest("base64");
  const sig       = sigB64.replace(/\+/g, "-").replace(/\//g, "_");
  return {
    "POLY_ADDRESS":    creds.address ?? "",
    "POLY_SIGNATURE":  sig,
    "POLY_TIMESTAMP":  ts,
    "POLY_API_KEY":    creds.apiKey,
    "POLY_PASSPHRASE": creds.passphrase,
    "Content-Type":    "application/json",
  };
}

async function sweepBook(tokenId, tokensToSell) {
  const r = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
  if (!r.ok) throw new Error(`Order book fetch failed: ${r.status}`);
  const book = await r.json();
  const bids = (book.bids ?? []).map((b) => ({
    price: parseFloat(b.price),
    size:  parseFloat(b.size ?? "0"),
  }));
  if (bids.length === 0) throw new Error("No bids on the book — no buyers right now");
  let cum = 0;
  let sweepPx = bids[bids.length - 1].price;
  for (const bid of bids) {
    cum += bid.size;
    if (cum >= tokensToSell) { sweepPx = bid.price; break; }
  }
  // round to 2 dp (Polymarket tick), minimum 0.01
  return Math.max(Math.round(sweepPx * 100) / 100, 0.01);
}

async function buildAndSignOrder(wallet, exchangeAddress, tokenId, makerAmountUnits, tickPrice) {
  const makerAmountRaw = (BigInt(Math.floor(makerAmountUnits * 1e6 / 10_000)) * 10_000n).toString();
  const takerAmountRaw = (Math.floor(makerAmountUnits * tickPrice * 1_000_000 / 100) * 100).toString();
  const ZERO = "0x0000000000000000000000000000000000000000";

  const order = {
    salt:       String(Math.round(Math.random() * Date.now())),
    maker:      wallet.address,
    signer:     wallet.address,
    taker:      ZERO,
    tokenId:    tokenId,
    makerAmount: makerAmountRaw,
    takerAmount: takerAmountRaw,
    expiration: "0",
    nonce:      "0",
    feeRateBps: "0",
    side:       1, // SELL
    signatureType: 0,
  };

  const domain = {
    name: "Polymarket CTF Exchange", version: "1",
    chainId: CHAIN_ID,
    verifyingContract: exchangeAddress,
  };
  const types = { Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ]};
  const value = { ...order, salt: BigInt(order.salt), tokenId: BigInt(order.tokenId),
    makerAmount: BigInt(order.makerAmount), takerAmount: BigInt(order.takerAmount),
    expiration: 0n, nonce: 0n, feeRateBps: 0n };

  const sig = await wallet._signTypedData(domain, types, value);
  return { orderStruct: order, signature: sig };
}

async function postSellOrder(creds, orderStruct, signature) {
  const body = JSON.stringify({ order: orderStruct, owner: creds.address ?? creds.walletAddress ?? "", orderType: "GTC", signature });
  const headers = { ...buildHmacHeaders(creds, "POST", "/order", body), "Content-Type": "application/json" };
  const r = await fetch(`${CLOB_HOST}/order`, { method: "POST", headers, body });
  const txt = await r.text();
  if (!r.ok) throw new Error(`POST /order failed (${r.status}): ${txt}`);
  return JSON.parse(txt);
}

async function waitForFill(creds, orderId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const headers = buildHmacHeaders(creds, "GET", `/order/${orderId}`, undefined);
    const r = await fetch(`${CLOB_HOST}/order/${orderId}`, { headers });
    if (!r.ok) continue;
    const o = await r.json();
    const status = o.status?.toUpperCase?.() ?? "";
    if (status === "MATCHED" || status === "FILLED") return true;
    if (status === "CANCELLED") return false;
    const remaining = parseFloat(o.size_remaining ?? o.sizeRemaining ?? "0");
    if (remaining === 0) return true;
  }
  return false; // timed out
}

async function cancelOrder(creds, orderId) {
  const body = JSON.stringify({ orderID: orderId });
  const headers = { ...buildHmacHeaders(creds, "DELETE", "/order", body), "Content-Type": "application/json" };
  await fetch(`${CLOB_HOST}/order`, { method: "DELETE", headers, body }).catch(() => {});
}

// ── main ─────────────────────────────────────────────────────────────────────

async function sellToken(wallet, ctf, creds, tokenId, exchangeAddress) {
  const balRaw = await ctf.balanceOf(wallet.address, tokenId);
  if (balRaw.eq(0)) {
    console.log(`  Token ${tokenId}: balance is 0 — nothing to sell.`);
    return;
  }
  const tokensHeld = parseFloat(ethers.utils.formatUnits(balRaw, 6));
  console.log(`  Balance: ${tokensHeld.toFixed(4)} tokens`);

  // Check/set ERC-1155 approval
  const approved = await ctf.isApprovedForAll(wallet.address, exchangeAddress);
  if (!approved) {
    console.log("  Approving exchange to transfer tokens…");
    const tx = await ctf.connect(wallet).setApprovalForAll(exchangeAddress, true, {
      maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
      maxFeePerGas:         ethers.utils.parseUnits("150", "gwei"),
    });
    await tx.wait();
    console.log("  Approved ✅");
  }

  // Sweep the book for fill price
  const tickPrice = await sweepBook(tokenId, tokensHeld);
  console.log(`  Sweep price: ${tickPrice} (≈ $${(tokensHeld * tickPrice).toFixed(2)} USDC)`);

  const { orderStruct, signature } = await buildAndSignOrder(wallet, exchangeAddress, tokenId, tokensHeld, tickPrice);
  const result = await postSellOrder(creds, orderStruct, signature);
  const orderId = result.orderID ?? result.orderId ?? result.order_id;
  console.log(`  Order posted: ${orderId}`);

  console.log("  Waiting up to 60s for fill…");
  const filled = await waitForFill(creds, orderId, 60_000);
  if (filled) {
    console.log("  ✅ Filled! USDC should appear in your wallet shortly.");
    return;
  }

  // Not filled — cancel and repost at floor bid
  console.log("  Not filled in 60s, cancelling and reposting at floor price…");
  await cancelOrder(creds, orderId);
  const floorRes = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`);
  const floorBook = await floorRes.json();
  const floorBids = floorBook.bids ?? [];
  if (floorBids.length === 0) throw new Error("Still no bids after 60s — market may be illiquid.");
  const floorPx = Math.max(Math.round(parseFloat(floorBids[floorBids.length - 1].price) * 100) / 100, 0.01);
  console.log(`  Reposting at floor bid: ${floorPx}`);

  const { orderStruct: o2, signature: s2 } = await buildAndSignOrder(wallet, exchangeAddress, tokenId, tokensHeld, floorPx);
  const r2 = await postSellOrder(creds, o2, s2);
  const id2 = r2.orderID ?? r2.orderId ?? r2.order_id;
  console.log(`  Repost order: ${id2}`);
  const filled2 = await waitForFill(creds, id2, 120_000);
  if (filled2) {
    console.log("  ✅ Filled at floor price!");
  } else {
    console.log(`  ⚠  Still not filled. Order ${id2} is live on Polymarket — it will fill when buyers appear.`);
    console.log(`     Check: https://polymarket.com open orders for your wallet.`);
  }
}

async function main() {
  if (!PRIVATE_KEY) {
    console.error("❌  USER_PRIVATE_KEY not set in .env.local");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Wallet:", wallet.address);

  const matic = await provider.getBalance(wallet.address);
  if (matic.eq(0)) {
    console.error("❌  No MATIC for gas. Send some MATIC to", wallet.address);
    process.exit(1);
  }
  console.log("MATIC:", ethers.utils.formatEther(matic));

  const ctf = new ethers.Contract(CTF_TOKEN_ADDR, ERC1155_ABI, wallet);

  // Collect token IDs: CLI arg → KNOWN_TOKEN_IDS env var → local /api/market auto-discovery
  const cliTokenId = process.argv[2];
  let tokenIds = [];
  if (cliTokenId) tokenIds.push(cliTokenId.trim());
  if (KNOWN_TOKEN_IDS.length) tokenIds.push(...KNOWN_TOKEN_IDS);

  if (tokenIds.length === 0) {
    // Try to auto-discover from the running local Next.js app
    const appPort = process.env.APP_PORT ?? "3000";
    try {
      console.log(`\nNo tokenId supplied — querying local app at http://localhost:${appPort}/api/market …`);
      const mRes = await fetch(`http://localhost:${appPort}/api/market`, { signal: AbortSignal.timeout(5_000) });
      if (mRes.ok) {
        const mData = await mRes.json();
        if (mData.yesTokenId) tokenIds.push(mData.yesTokenId);
        if (mData.noTokenId)  tokenIds.push(mData.noTokenId);
        console.log(`  Found tokenIds from market API: ${tokenIds.join(", ")}`);
      }
    } catch { /* app not running or network error — fall through */ }
  }

  if (tokenIds.length === 0) {
    console.error(
      "\n❌  No token ID found.\n" +
      "    Usage: node scripts/sell-tokens.js <tokenId>\n" +
      "    Or start the app (npm run dev) so the script can auto-discover IDs.\n" +
      "    Or set KNOWN_TOKEN_IDS=<id1>,<id2> in .env.local"
    );
    process.exit(1);
  }

  // Deduplicate
  tokenIds = [...new Set(tokenIds)];
  console.log(`\nChecking ${tokenIds.length} token ID(s)…`);

  // Get API creds once
  console.log("\nAuthenticating with Polymarket CLOB…");
  const creds = await getApiCreds(wallet);
  creds.address = wallet.address;
  console.log("API key:", creds.apiKey?.slice(0, 8) + "…");

  for (const tokenId of tokenIds) {
    console.log(`\n── Token ${tokenId}`);
    // Try CTF exchange first, fall back to NegRisk
    let exchangeAddress = CTF_EXCHANGE_ADDR;
    const balCTF = await ctf.balanceOf(wallet.address, tokenId).catch(() => ethers.BigNumber.from(0));
    if (balCTF.eq(0)) {
      console.log("  No balance at CTF exchange — skipping.");
      continue;
    }
    try {
      await sellToken(wallet, ctf, creds, tokenId, exchangeAddress);
    } catch (err) {
      console.error("  ❌ Error:", err.message ?? err);
      // Try NegRisk exchange as fallback
      console.log("  Retrying with NegRisk exchange…");
      try {
        await sellToken(wallet, ctf, creds, tokenId, NEG_RISK_EXCHANGE);
      } catch (err2) {
        console.error("  ❌ NegRisk also failed:", err2.message ?? err2);
      }
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\n❌  Fatal:", err.message ?? err);
  process.exit(1);
});

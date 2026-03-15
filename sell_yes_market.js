const { createWalletClient, createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');

const RPC       = 'https://polygon-mainnet.g.alchemy.com/v2/FzDAk79QkZrzaNRAeyrtW';
const ENGINE_PK = '0x9b28df711df38e75a08977d3b7173ce931aab6b5dbd37035b8fe1225751758eb';
const CTF_EX    = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CTF       = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const TOKEN_YES = '38397507750621893057346880033441136112987238933685677349709401910643842844855';
const OLD_ORDER = '0x29d8800e5370e324698ae917bc489cc577ecbeb97ba2215d9e312cfea9fee01c';
const ZERO      = '0x0000000000000000000000000000000000000000';
const HOST      = 'https://clob.polymarket.com';

const account = privateKeyToAccount(ENGINE_PK);
const pub = createPublicClient({ chain: polygon, transport: http(RPC) });
const wal = createWalletClient({ account, chain: polygon, transport: http(RPC) });

function bufToB64url(buf) {
  let bin = '';
  new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_');
}
function b64ToArr(b64) {
  const s = b64.replace(/-/g,'+').replace(/_/g,'/').replace(/[^A-Za-z0-9+/=]/g,'');
  const bin = atob(s); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function hmac(secret, ts, method, path, body = '') {
  const key = await crypto.subtle.importKey('raw', b64ToArr(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bufToB64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + method + path + body)));
}

async function getApiCreds() {
  const ts = String(Math.floor(Date.now() / 1000));
  const l1sig = await wal.signTypedData({
    domain: { name: 'ClobAuthDomain', version: '1', chainId: polygon.id },
    types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
    primaryType: 'ClobAuth',
    message: { address: account.address, timestamp: ts, nonce: 0n, message: 'This message attests that I control the given wallet' },
  });
  const h = { POLY_ADDRESS: account.address, POLY_SIGNATURE: l1sig, POLY_TIMESTAMP: ts, POLY_NONCE: '0' };
  let r = await fetch(`${HOST}/auth/api-key`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: '{}' });
  if (!r.ok) r = await fetch(`${HOST}/auth/derive-api-key`, { headers: h });
  const d = await r.json();
  if (!d.apiKey) throw new Error('No API key: ' + JSON.stringify(d));
  return { key: d.apiKey, secret: d.secret, passphrase: d.passphrase };
}

async function cancelOrder(creds, orderId) {
  const ts   = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ orderId });
  const h    = await hmac(creds.secret, ts, 'DELETE', '/order', body);
  const r    = await fetch(`${HOST}/order`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', POLY_ADDRESS: account.address, POLY_SIGNATURE: h, POLY_TIMESTAMP: ts, POLY_API_KEY: creds.key, POLY_PASSPHRASE: creds.passphrase },
    body,
  });
  const text = await r.text();
  console.log('Cancel:', r.status, text);
}

async function postSell(creds, tokenId, bal, price) {
  const makerRaw = (BigInt(Math.floor(Number(bal) / 10_000)) * 10_000n).toString();
  const takerRaw = (Math.floor((Number(makerRaw) / 1e6) * price * 1e6 / 100) * 100).toString();
  const salt     = String(Math.round(Math.random() * Date.now()));

  const sig = await wal.signTypedData({
    domain: { name: 'Polymarket CTF Exchange', version: '1', chainId: polygon.id, verifyingContract: CTF_EX },
    types: {
      Order: [
        { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' }, { name: 'expiration', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
      ],
    },
    primaryType: 'Order',
    message: {
      salt: BigInt(salt), maker: account.address, signer: account.address, taker: ZERO,
      tokenId: BigInt(tokenId), makerAmount: BigInt(makerRaw), takerAmount: BigInt(takerRaw),
      expiration: 0n, nonce: 0n, feeRateBps: 0n, side: 1, signatureType: 0,
    },
  });

  const ts   = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    deferExec: false,
    order: { salt: parseInt(salt), maker: account.address, signer: account.address, taker: ZERO,
      tokenId, makerAmount: makerRaw, takerAmount: takerRaw,
      expiration: '0', nonce: '0', feeRateBps: '0', side: 'SELL', signatureType: 0, signature: sig },
    owner: creds.key, orderType: 'GTC',
  });
  const h   = await hmac(creds.secret, ts, 'POST', '/order', body);
  const r   = await fetch(`${HOST}/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', POLY_ADDRESS: account.address, POLY_SIGNATURE: h, POLY_TIMESTAMP: ts, POLY_API_KEY: creds.key, POLY_PASSPHRASE: creds.passphrase },
    body,
  });
  return r.json();
}

(async () => {
  // 1. Get current order book to find best bid
  const bookRes = await fetch(`${HOST}/book?token_id=${TOKEN_YES}`);
  const book    = await bookRes.json();
  const bids    = book.bids ?? [];
  const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
  console.log('Order book top 5 bids:', bids.slice(0, 5).map(b => `$${b.price} (${parseFloat(b.size).toFixed(0)} tokens)`));

  // 2. Get midpoint as reference
  const midRes  = await fetch(`${HOST}/midpoint?token_id=${TOKEN_YES}`);
  const { mid } = await midRes.json();
  const midPrice = parseFloat(mid);
  console.log('Midpoint price: $' + midPrice);

  // 3. Set sell price = best bid (immediate fill), but at least $0.01
  //    If best bid is way below mid (>50% gap), warn but still proceed
  const sellPrice = Math.max(bestBid, 0.01);
  const roundedSellPrice = Math.round(sellPrice * 100) / 100;
  console.log(`\nSell price: $${roundedSellPrice} (best bid)`);
  console.log(`Midpoint:   $${midPrice}`);

  if (roundedSellPrice < midPrice * 0.5) {
    console.log(`WARNING: best bid ($${roundedSellPrice}) is far below midpoint ($${midPrice}). Selling anyway as requested.`);
  }

  // 4. Get current token balance
  const ERC1155_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }];
  const bal = await pub.readContract({ address: CTF, abi: ERC1155_ABI, functionName: 'balanceOf', args: [account.address, BigInt(TOKEN_YES)] });
  console.log('YES balance:', Number(bal) / 1e6, 'tokens');
  console.log('Expected proceeds: $' + (Number(bal) / 1e6 * roundedSellPrice).toFixed(4));

  if (bal === 0n) { console.log('No tokens to sell.'); return; }

  // 5. Get API creds
  console.log('\nAuthenticating with Polymarket...');
  const creds = await getApiCreds();

  // 6. Cancel existing order
  console.log('Cancelling old order...');
  await cancelOrder(creds, OLD_ORDER);

  // 7. Place new sell at best bid
  console.log(`\nPlacing SELL at $${roundedSellPrice}...`);
  const resp = await postSell(creds, TOKEN_YES, bal, roundedSellPrice);
  console.log('Response:', JSON.stringify(resp, null, 2));

  if (resp.success) {
    const proceeds = Number(bal) / 1e6 * roundedSellPrice;
    console.log(`\nOrder submitted. Expected: $${proceeds.toFixed(4)} USDC → engine wallet once matched.`);
  }
})().catch(console.error);

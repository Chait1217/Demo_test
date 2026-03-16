/**
 * fix-margin-engine.js
 *
 * Sets the vault's marginEngine to the server engine wallet
 * (POLYMARKET_PRIVATE_KEY address). Must be called from the DEPLOYER wallet
 * (vault owner) because setMarginEngine() is onlyOwner.
 *
 * Run this ONCE after the vault is deployed (or whenever the engine wallet changes).
 *
 * Usage:
 *   node scripts/fix-margin-engine.js
 *
 * Requires in .env.local:
 *   DEPLOYER_PRIVATE_KEY    - the wallet that deployed the vault (onlyOwner)
 *   POLYMARKET_PRIVATE_KEY  - the engine wallet that should be set as marginEngine
 *   POLYGON_RPC_URL         - optional
 */

require("dotenv").config({ path: ".env.local" });
const { createWalletClient, createPublicClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { polygon } = require("viem/chains");

const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? "0xEFf6d6282FEe1f31CE498704C3E104624cD5fbB4";

const VAULT_ABI = [
  { name: "marginEngine",    type: "function", stateMutability: "view",       inputs: [],                                outputs: [{ name: "", type: "address" }] },
  { name: "setMarginEngine", type: "function", stateMutability: "nonpayable", inputs: [{ name: "engine", type: "address" }], outputs: []                          },
];

async function main() {
  const deployerPk = process.env.DEPLOYER_PRIVATE_KEY;
  const enginePk   = process.env.POLYMARKET_PRIVATE_KEY;

  if (!deployerPk) { console.error("Missing DEPLOYER_PRIVATE_KEY in .env.local"); process.exit(1); }
  if (!enginePk)   { console.error("Missing POLYMARKET_PRIVATE_KEY in .env.local"); process.exit(1); }

  const deployer     = privateKeyToAccount(deployerPk);
  const engineWallet = privateKeyToAccount(enginePk);
  const rpcUrl       = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";

  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl, { timeout: 20_000 }) });
  const walletClient = createWalletClient({ account: deployer, chain: polygon, transport: http(rpcUrl, { timeout: 30_000 }) });

  console.log(`Vault address:      ${VAULT_ADDRESS}`);
  console.log(`Deployer (owner):   ${deployer.address}`);
  console.log(`Engine wallet:      ${engineWallet.address}`);

  const current = await publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "marginEngine", args: [] });
  console.log(`\nCurrent marginEngine: ${current}`);

  if (current.toLowerCase() === engineWallet.address.toLowerCase()) {
    console.log("✓ marginEngine is already set correctly — nothing to do.");
    return;
  }

  console.log(`\nSetting marginEngine to ${engineWallet.address}…`);
  const txHash = await walletClient.writeContract({
    address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "setMarginEngine",
    args: [engineWallet.address],
  });
  console.log(`Tx: ${txHash}`);
  console.log("Waiting for confirmation…");
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  const updated = await publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "marginEngine", args: [] });
  console.log(`\n✓ marginEngine updated to: ${updated}`);
  console.log(`PolygonScan: https://polygonscan.com/tx/${txHash}`);
  console.log("\nVault borrow/repay will now work from the server engine wallet.");
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });

/**
 * recover-lost-usdc.js
 *
 * Recovers USDC.e that is stuck in the engine wallet because vault.repay()
 * reverted with "not engine" (marginEngine was never updated from the deployer
 * wallet to the server/engine wallet). The USDC.e never reached the vault —
 * it is still in the engine wallet.
 *
 * Usage:
 *   node scripts/recover-lost-usdc.js <userWalletAddress> <amountUSDC>
 *
 * Example:
 *   node scripts/recover-lost-usdc.js 0xAbc123... 1.5
 *
 * Requires:
 *   POLYMARKET_PRIVATE_KEY  - engine wallet private key (in .env.local)
 *   POLYGON_RPC_URL         - optional, defaults to public node
 */

require("dotenv").config({ path: ".env.local" });
const { createWalletClient, createPublicClient, http, formatUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { polygon } = require("viem/chains");

// ⚠️  USDC.e on Polygon PoS — NOT native USDC
const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "transfer",  type: "function", stateMutability: "nonpayable", inputs: [{ name: "to",    type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "decimals",  type: "function", stateMutability: "view",      inputs: [], outputs: [{ name: "", type: "uint8" }] },
];

async function main() {
  const [, , toAddress, amountStr] = process.argv;

  if (!toAddress || !amountStr) {
    console.error("Usage: node scripts/recover-lost-usdc.js <userWalletAddress> <amountUSDC>");
    console.error("Example: node scripts/recover-lost-usdc.js 0xAbc123... 1.5");
    process.exit(1);
  }

  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) { console.error("Missing POLYMARKET_PRIVATE_KEY in .env.local"); process.exit(1); }

  const account      = privateKeyToAccount(pk);
  const rpcUrl       = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl, { timeout: 20_000 }) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl, { timeout: 30_000 }) });

  console.log(`Engine wallet:  ${account.address}`);
  console.log(`Recipient:      ${toAddress}`);
  console.log(`USDC.e token:   ${USDCe_ADDRESS}`);

  const decimals  = await publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "decimals", args: [] });
  const engineBal = await publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  const amountRaw = BigInt(Math.round(parseFloat(amountStr) * 1_000_000));

  console.log(`\nEngine USDC.e balance: $${formatUnits(engineBal, decimals)}`);

  if (engineBal < amountRaw) {
    console.error(`\n✗ Engine only has $${formatUnits(engineBal, decimals)} USDC.e, cannot send $${amountStr}`);
    console.error("Possible reasons:");
    console.error("  • vault.repay() actually succeeded (unlikely — repay is onlyEngine too)");
    console.error("  • The USDC.e was already sent back manually");
    console.error("  • The user sent a different token (check wallet on polygonscan.com)");
    process.exit(1);
  }

  console.log(`\nTransferring $${amountStr} USDC.e from engine → ${toAddress}…`);
  const txHash = await walletClient.writeContract({
    address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "transfer",
    args: [toAddress, amountRaw],
  });

  console.log(`Tx submitted: ${txHash}`);
  console.log("Waiting for confirmation…");
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  const finalBal = await publicClient.readContract({ address: USDCe_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`\n✓ Done! Engine USDC.e balance now: $${formatUnits(finalBal, decimals)}`);
  console.log(`PolygonScan: https://polygonscan.com/tx/${txHash}`);
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });

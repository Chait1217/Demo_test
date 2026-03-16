/**
 * recover-lost-usdc.js
 *
 * Recovers USDC.e from the engine wallet back to a user whose close flow
 * sent repayment for a borrow that never happened (vault borrow failed silently).
 *
 * Usage:
 *   node scripts/recover-lost-usdc.js <userWalletAddress> <amountUSDC>
 *
 * Example:
 *   node scripts/recover-lost-usdc.js 0xYourAddress 1.5
 *
 * Requires:
 *   POLYMARKET_PRIVATE_KEY  - engine wallet private key (in .env.local)
 *   POLYGON_RPC_URL         - optional, defaults to public node
 */

require("dotenv").config({ path: ".env.local" });
const { createWalletClient, createPublicClient, http, formatUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { polygon } = require("viem/chains");

const USDC_ADDRESS = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "transfer",  type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
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
  if (!pk) {
    console.error("Missing POLYMARKET_PRIVATE_KEY in .env.local");
    process.exit(1);
  }

  const account   = privateKeyToAccount(pk);
  const rpcUrl    = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";

  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

  console.log(`Engine wallet: ${account.address}`);
  console.log(`Recipient:     ${toAddress}`);

  // Check engine USDC balance
  const balance = await publicClient.readContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  const decimals = await publicClient.readContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "decimals", args: [],
  });
  const balanceFormatted = formatUnits(balance, decimals);
  console.log(`Engine USDC balance: $${balanceFormatted}`);

  const amountRaw = BigInt(Math.round(parseFloat(amountStr) * 1_000_000));
  if (balance < amountRaw) {
    console.error(`Engine only has $${balanceFormatted} — cannot send $${amountStr}`);
    console.error("The repayment may have gone to the vault. Contact vault admin or check vault balance.");
    process.exit(1);
  }

  console.log(`Sending $${amountStr} USDC.e from engine → ${toAddress}…`);
  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer",
    args: [toAddress, amountRaw],
  });

  console.log(`Tx submitted: ${txHash}`);
  console.log("Waiting for confirmation…");
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  const newBalance = await publicClient.readContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  console.log(`Done! Engine balance now: $${formatUnits(newBalance, decimals)}`);
  console.log(`PolygonScan: https://polygonscan.com/tx/${txHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

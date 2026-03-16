/**
 * recover-lost-usdc.js
 *
 * Recovers USDC.e that ended up in the vault as erroneous repayment.
 * Strategy:
 *   1. If engine wallet already holds the USDC → transfer directly to user
 *   2. Otherwise call vault.borrow(amount) to pull it from the vault, then transfer to user
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

const USDC_ADDRESS  = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? "0xEFf6d6282FEe1f31CE498704C3E104624cD5fbB4";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",      inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "transfer",  type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "decimals",  type: "function", stateMutability: "view",      inputs: [], outputs: [{ name: "", type: "uint8" }] },
];

const VAULT_ABI = [
  { name: "availableLiquidity", type: "function", stateMutability: "view",      inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "borrow",             type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
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
  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

  const amountRaw = BigInt(Math.round(parseFloat(amountStr) * 1_000_000));
  const decimals  = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "decimals", args: [] });

  console.log(`Engine wallet:  ${account.address}`);
  console.log(`Vault address:  ${VAULT_ADDRESS}`);
  console.log(`Recipient:      ${toAddress}`);
  console.log(`Amount:         $${amountStr} USDC.e`);

  // ── Check engine balance ───────────────────────────────────────────────────
  const engineBal = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`\nEngine USDC balance:  $${formatUnits(engineBal, decimals)}`);

  if (engineBal < amountRaw) {
    // Engine doesn't have enough — borrow from the vault to recover the erroneous repayment
    console.log(`Engine balance insufficient — pulling $${amountStr} from vault via borrow()…`);

    const vaultLiquidity = await publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "availableLiquidity", args: [] });
    console.log(`Vault available liquidity: $${formatUnits(vaultLiquidity, decimals)}`);

    if (vaultLiquidity < amountRaw) {
      console.error(`Vault only has $${formatUnits(vaultLiquidity, decimals)} available — cannot recover $${amountStr}`);
      process.exit(1);
    }

    const borrowTx = await walletClient.writeContract({
      address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "borrow", args: [amountRaw],
    });
    console.log(`vault.borrow() tx: ${borrowTx}`);
    console.log("Waiting for confirmation…");
    await publicClient.waitForTransactionReceipt({ hash: borrowTx, timeout: 60_000 });
    console.log(`Borrowed $${amountStr} from vault into engine wallet.`);
  }

  // ── Transfer to user ───────────────────────────────────────────────────────
  console.log(`\nSending $${amountStr} USDC.e from engine → ${toAddress}…`);
  const transferTx = await walletClient.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer", args: [toAddress, amountRaw],
  });
  console.log(`Transfer tx: ${transferTx}`);
  console.log("Waiting for confirmation…");
  await publicClient.waitForTransactionReceipt({ hash: transferTx, timeout: 60_000 });

  const finalBal = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`\nDone! Engine balance now: $${formatUnits(finalBal, decimals)}`);
  console.log(`PolygonScan tx: https://polygonscan.com/tx/${transferTx}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

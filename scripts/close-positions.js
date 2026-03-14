/**
 * Close all open vault positions for a given wallet and return funds.
 *
 * Usage:
 *   node scripts/close-positions.js
 *
 * Required env vars in .env.local:
 *   USER_PRIVATE_KEY   — private key of the wallet with stuck funds
 *   POLYGON_RPC_URL    — Alchemy or Infura Polygon endpoint
 */

require("dotenv").config({ path: ".env.local" });
const { ethers } = require("ethers");

const PRIVATE_KEY  = process.env.USER_PRIVATE_KEY;
const RPC_URL      = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Check both old vault and new vault
const VAULTS = [
  { label: "Old vault", address: "0xB0B97F13a214D173bBAFd63a635b5216BdAdBaf4" },
  { label: "New vault", address: "0xEFf6d6282FEe1f31CE498704C3E104624cD5fbB4" },
];

const VAULT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner_) returns (uint256 shares)",
  "function availableLiquidity() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function checkAndWithdraw(vault, wallet, provider) {
  const shares = await vault.balanceOf(wallet.address);
  if (shares.eq(0)) {
    console.log("  No shares found — skipping.");
    return;
  }

  console.log("  Shares held:", shares.toString());

  const maxAssets = await vault.maxWithdraw(wallet.address);
  const liquid    = await vault.availableLiquidity();
  const tvl       = await vault.totalAssets();

  console.log("  Max withdrawable (USDC.e):", ethers.utils.formatUnits(maxAssets, 6));
  console.log("  Vault liquidity  (USDC.e):", ethers.utils.formatUnits(liquid, 6));
  console.log("  Vault TVL        (USDC.e):", ethers.utils.formatUnits(tvl, 6));

  if (maxAssets.eq(0)) {
    console.log("  ⚠  maxWithdraw is 0 — vault may have insufficient liquidity to cover your shares.");
    console.log("     This can happen if funds were borrowed or the vault has no assets.");
    return;
  }

  console.log(`\n  Withdrawing ${ethers.utils.formatUnits(maxAssets, 6)} USDC.e → ${wallet.address} …`);

  const tx = await vault.connect(wallet).withdraw(
    maxAssets,
    wallet.address, // receiver
    wallet.address, // owner
    {
      maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
      maxFeePerGas:         ethers.utils.parseUnits("150", "gwei"),
    }
  );

  console.log("  Tx sent:", tx.hash);
  console.log("  Waiting for confirmation…");
  const receipt = await tx.wait();
  console.log("  ✅ Confirmed in block", receipt.blockNumber);
  console.log("  Explorer: https://polygonscan.com/tx/" + tx.hash);
}

async function main() {
  if (!PRIVATE_KEY) {
    console.error(
      "\n❌  USER_PRIVATE_KEY is not set in .env.local\n" +
      "    Add this line to your .env.local file:\n\n" +
      "    USER_PRIVATE_KEY=0x<your-private-key>\n\n" +
      "    This must be the private key for wallet: 0x6CcBdc898016F2E49ada47496696d635b8D4fB31\n"
    );
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("\nWallet:      ", wallet.address);

  const maticBal = await provider.getBalance(wallet.address);
  console.log("MATIC balance:", ethers.utils.formatEther(maticBal), "MATIC (for gas)");

  if (maticBal.eq(0)) {
    console.error("\n❌  No MATIC for gas. Send a small amount of MATIC to", wallet.address, "and retry.\n");
    process.exit(1);
  }

  const usdc = new ethers.Contract(USDCe_ADDRESS, ERC20_ABI, provider);
  const usdcBefore = await usdc.balanceOf(wallet.address);
  console.log("USDC.e before:", ethers.utils.formatUnits(usdcBefore, 6), "USDC.e\n");

  let anyFound = false;

  for (const { label, address } of VAULTS) {
    console.log(`── ${label} (${address})`);
    const vault = new ethers.Contract(address, VAULT_ABI, provider);
    const shares = await vault.balanceOf(wallet.address);

    if (!shares.eq(0)) anyFound = true;

    await checkAndWithdraw(vault, wallet, provider);
    console.log();
  }

  if (!anyFound) {
    console.log("⚠  No shares found in either vault for wallet", wallet.address);
    console.log("   The funds may have already been withdrawn, or they are in a different contract.");
  }

  const usdcAfter = await usdc.balanceOf(wallet.address);
  console.log("USDC.e after:", ethers.utils.formatUnits(usdcAfter, 6), "USDC.e");
  const gained = usdcAfter.sub(usdcBefore);
  if (gained.gt(0)) {
    console.log("Recovered:   ", ethers.utils.formatUnits(gained, 6), "USDC.e ✅");
  }
}

main().catch((err) => {
  console.error("\n❌  Error:", err.message ?? err);
  process.exit(1);
});

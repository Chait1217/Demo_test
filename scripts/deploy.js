/**
 * Deploy LeveragedVault to Polygon mainnet.
 *
 * Uses the bundled `solc` compiler — no network download needed.
 *
 * Usage:
 *   node scripts/deploy.js
 *
 * Required env vars in .env.local:
 *   DEPLOYER_PRIVATE_KEY  — private key of the deploying wallet (needs MATIC for gas)
 *   POLYGON_RPC_URL       — Alchemy or Infura Polygon endpoint
 *                           e.g. https://polygon-mainnet.g.alchemy.com/v2/<API_KEY>
 */

require("dotenv").config({ path: ".env.local" });

const fs      = require("fs");
const path    = require("path");
const solc    = require("solc");
const { ethers } = require("ethers");

// ── Config ────────────────────────────────────────────────────────────────────

const PRIVATE_KEY        = process.env.DEPLOYER_PRIVATE_KEY;
const ENGINE_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const RPC_URL            = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
const USDCe_ADDRESS      = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve @openzeppelin/... imports from node_modules */
function findImports(importPath) {
  try {
    const resolved = importPath.startsWith("@")
      ? path.join(__dirname, "../node_modules", importPath)
      : path.join(__dirname, "../contracts", importPath);
    return { contents: fs.readFileSync(resolved, "utf8") };
  } catch {
    return { error: "File not found: " + importPath };
  }
}

// ── Compile ───────────────────────────────────────────────────────────────────

console.log("Compiling LeveragedVault.sol…");

const source = fs.readFileSync(
  path.join(__dirname, "../contracts/LeveragedVault.sol"),
  "utf8"
);

const input = {
  language: "Solidity",
  sources: { "LeveragedVault.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  if (fatal.length) {
    console.error("\n❌  Compilation errors:\n");
    fatal.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
  }
  output.errors
    .filter((e) => e.severity === "warning")
    .forEach((e) => console.warn("⚠ ", e.formattedMessage));
}

const contract  = output.contracts["LeveragedVault.sol"]["LeveragedVault"];
const abi       = contract.abi;
const bytecode  = "0x" + contract.evm.bytecode.object;
console.log("✓  Compilation successful\n");

// ── Deploy ────────────────────────────────────────────────────────────────────

async function main() {
  if (!PRIVATE_KEY) {
    console.error(
      "❌  DEPLOYER_PRIVATE_KEY is not set in .env.local\n" +
      "    Add your private key and re-run: node scripts/deploy.js\n"
    );
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("Deployer:", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("MATIC balance:", ethers.utils.formatEther(balance), "MATIC");

  if (balance.eq(0)) {
    console.error(
      "\n❌  Deployer has 0 MATIC — you need a small amount of MATIC for gas.\n" +
      "    Bridge some MATIC to Polygon mainnet and retry.\n"
    );
    process.exit(1);
  }

  console.log("\nDeploying LeveragedVault to Polygon mainnet…");

  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const vault    = await factory.deploy(
    USDCe_ADDRESS,  // _asset  (USDC.e on Polygon)
    wallet.address, // _owner
    {
      maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
      maxFeePerGas:         ethers.utils.parseUnits("150", "gwei"),
    }
  );

  console.log("Transaction sent:", vault.deployTransaction.hash);
  console.log("Waiting for confirmation…");

  await vault.deployed();
  const address = vault.address;

  console.log("\n✅  LeveragedVault deployed!");
  console.log("    Address:", address);
  console.log("    Tx:     ", vault.deployTransaction.hash);
  console.log("    Explorer: https://polygonscan.com/address/" + address);

  // ── Set marginEngine to the server engine wallet ───────────────────────────
  // The vault constructor sets marginEngine = owner (deployer), but the server
  // uses POLYMARKET_PRIVATE_KEY as the engine wallet. Fix this immediately after
  // deployment so vault.borrow() and vault.repay() work from the server.
  if (ENGINE_PRIVATE_KEY) {
    const engineWallet = new ethers.Wallet(ENGINE_PRIVATE_KEY);
    const engineAddress = engineWallet.address;
    console.log("\nSetting marginEngine to server engine wallet:", engineAddress);
    const vaultContract = new ethers.Contract(address, abi, wallet);
    const tx = await vaultContract.setMarginEngine(engineAddress, {
      maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
      maxFeePerGas:         ethers.utils.parseUnits("150", "gwei"),
    });
    await tx.wait();
    console.log("✓  marginEngine set to", engineAddress);
  } else {
    console.warn(
      "\n⚠  POLYMARKET_PRIVATE_KEY not set — marginEngine left as deployer.\n" +
      "   Run setMarginEngine(<engine-wallet>) manually before using the app."
    );
  }

  // ── Auto-patch .env.local ──────────────────────────────────────────────────
  const envPath = path.join(__dirname, "../.env.local");
  if (fs.existsSync(envPath)) {
    let env = fs.readFileSync(envPath, "utf8");
    env = env.replace(
      /^NEXT_PUBLIC_VAULT_ADDRESS=.*/m,
      "NEXT_PUBLIC_VAULT_ADDRESS=" + address
    );
    fs.writeFileSync(envPath, env);
    console.log("\n✓  .env.local updated — NEXT_PUBLIC_VAULT_ADDRESS=" + address);
  }

  console.log("\nNext: restart your dev server\n  npm run dev\n");
}

main().catch((err) => {
  console.error("\n❌  Deployment failed:", err.message ?? err);
  process.exit(1);
});

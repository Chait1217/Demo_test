import { privateKeyToAccount } from "viem/accounts";

/**
 * Returns the server wallet address (the marginEngine on the vault contract).
 * The client needs this address to send borrowed USDC back to the server
 * before closing a leveraged position so the server can call vault.repay().
 */
export async function GET() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) {
    return Response.json({ address: null });
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  return Response.json({ address: account.address });
}

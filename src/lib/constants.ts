import { Address } from "viem";
import { polygon } from "viem/chains";

export const POLYGON_CHAIN = polygon;

// Official USDC.e on Polygon PoS
export const USDCe_ADDRESS: Address =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Deployed LeveragedVault
export const VAULT_ADDRESS: Address = (
  process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  "0xB0B97F13a214D173bBAFd63a635b5216BdAdBaf4"
) as Address;

export const MARKET_QUESTION = "Will the Iranian regime fall by June 30?";

export const POLYMARKET_API_HOST = "https://clob.polymarket.com";
export const POLYMARKET_GAMMA_HOST = "https://gamma-api.polymarket.com";

export const IRAN_MARKET_SLUG = "will-the-iranian-regime-fall-by-june-30";

export const POLYMARKET_MARKET_TOKEN_ID_YES =
  process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES ?? "";
export const POLYMARKET_MARKET_TOKEN_ID_NO =
  process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO ?? "";

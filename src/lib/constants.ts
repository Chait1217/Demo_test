import { Address } from "viem";
import { polygon } from "viem/chains";

export const POLYGON_CHAIN = polygon;

// Official USDC.e on Polygon PoS
export const USDCe_ADDRESS: Address =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Polymarket exchange contracts that need USDC.e allowance
export const CTF_EXCHANGE_ADDRESS: Address      = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const NEG_RISK_EXCHANGE_ADDRESS: Address = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// Deployed LeveragedVault
export const VAULT_ADDRESS: Address = (
  process.env.NEXT_PUBLIC_VAULT_ADDRESS ??
  "0xEFf6d6282FEe1f31CE498704C3E104624cD5fbB4"
) as Address;

export const MARKET_QUESTION = "Will the Iranian regime fall by June 30?";

export const POLYMARKET_API_HOST = "https://clob.polymarket.com";
export const POLYMARKET_GAMMA_HOST = "https://gamma-api.polymarket.com";

export const IRAN_MARKET_SLUG = "will-the-iranian-regime-fall-by-june-30";

export const POLYMARKET_MARKET_TOKEN_ID_YES =
  process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_YES ?? "";
export const POLYMARKET_MARKET_TOKEN_ID_NO =
  process.env.NEXT_PUBLIC_POLYMARKET_TOKEN_ID_NO ?? "";

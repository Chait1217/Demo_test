// Market data is now fetched client-side directly from Polymarket APIs.
// This route is kept only as a thin proxy fallback for environments
// where the browser cannot reach external APIs directly.
export const dynamic = "force-dynamic";

export interface MarketData {
  question: string;
  marketUrl: string;
  yesPrice: number;
  noPrice: number;
  yesTokenId: string;
  noTokenId: string;
  volume: number;
  liquidity: number;
  spread: number;
  endDate: string;
  priceHistory: { t: number; p: number }[];
}

export async function GET() {
  return Response.json({
    question: "Will the Iranian regime fall by June 30?",
    marketUrl: "https://polymarket.com/event/will-the-iranian-regime-fall-by-june-30",
    yesPrice: 0.5, noPrice: 0.5,
    yesTokenId: "", noTokenId: "",
    volume: 0, liquidity: 0, spread: 0,
    endDate: "2025-06-30", priceHistory: [],
  } satisfies MarketData);
}

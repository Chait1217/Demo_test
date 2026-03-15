// Zero-cache price endpoint — always fetches fresh bid/ask from Polymarket CLOB.
// Called by the client every 500 ms for near-real-time YES/NO prices.
export const dynamic = "force-dynamic";

const CLOB = "https://clob.polymarket.com";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tokenId = searchParams.get("tokenId")?.trim();

  if (!tokenId) {
    return Response.json({ error: "tokenId required" }, { status: 400 });
  }

  try {
    const [sellRes, buyRes] = await Promise.all([
      fetch(`${CLOB}/price?token_id=${tokenId}&side=sell`, { signal: AbortSignal.timeout(4_000) }),
      fetch(`${CLOB}/price?token_id=${tokenId}&side=buy`,  { signal: AbortSignal.timeout(4_000) }),
    ]);

    if (!sellRes.ok || !buyRes.ok) {
      return Response.json({ error: "upstream error" }, { status: 502 });
    }

    const bid = parseFloat((await sellRes.json()).price ?? "0");
    const ask = parseFloat((await buyRes.json()).price  ?? "0");

    if (!(bid > 0 && ask > 0 && bid <= ask && ask <= 1)) {
      return Response.json({ error: "invalid prices" }, { status: 502 });
    }

    const mid = (bid + ask) / 2;
    return Response.json(
      {
        yesPrice: parseFloat(mid.toFixed(4)),
        noPrice:  parseFloat((1 - mid).toFixed(4)),
        spread:   parseFloat((ask - bid).toFixed(4)),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "fetch failed" }, { status: 502 });
  }
}

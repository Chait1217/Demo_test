"use client";

import { useState, useEffect, useRef } from "react";

export interface LivePrices {
  yesPrice: number;
  noPrice:  number;
  spread:   number;
}

const POLL_MS = 500; // poll every 500 ms — fast enough to feel live

export function useLivePrices(yesTokenId: string | undefined): LivePrices | null {
  const [prices, setPrices] = useState<LivePrices | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!yesTokenId) return;

    let cancelled = false;

    async function poll() {
      if (inFlight.current || cancelled) return;
      inFlight.current = true;
      try {
        const r = await fetch(`/api/prices?tokenId=${encodeURIComponent(yesTokenId!)}`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!cancelled && r.ok) {
          const d = await r.json() as LivePrices;
          if (d.yesPrice > 0 && d.noPrice > 0) setPrices(d);
        }
      } catch { /* network hiccup — keep last value */ } finally {
        inFlight.current = false;
      }
    }

    poll(); // immediate first fetch
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [yesTokenId]);

  return prices;
}

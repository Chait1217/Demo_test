"use client";

import { useState, useEffect, useRef } from "react";

// Polymarket CLOB WebSocket — real-time order book & price feed
const WS_CLOB = "wss://ws-subscriptions-clob.polymarket.com/ws/";

export interface LivePrices {
  yesPrice: number;
  noPrice:  number;
  spread:   number;
}

export function useLivePrices(yesTokenId: string | undefined): LivePrices | null {
  const [prices, setPrices] = useState<LivePrices | null>(null);
  const wsRef    = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  useEffect(() => {
    if (!yesTokenId) return;
    activeRef.current = true;

    function connect() {
      if (!activeRef.current) return;
      try {
        const ws = new WebSocket(WS_CLOB);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({
            auth:    {},
            type:    "subscribe",
            channel: "market",
            markets: [yesTokenId],
          }));
        };

        ws.onmessage = ({ data }: MessageEvent<string>) => {
          try {
            const parsed: unknown = JSON.parse(data);
            const msgs: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

            for (const raw of msgs) {
              const msg  = raw as Record<string, unknown>;
              const type = String(msg.event_type ?? msg.type ?? "");

              if (type === "book") {
                // Full order book snapshot — compute best bid/ask mid-price
                const bids = (msg.bids as { price: string }[]) ?? [];
                const asks = (msg.asks as { price: string }[]) ?? [];
                if (bids.length && asks.length) {
                  const bestBid = Math.max(...bids.map((b) => parseFloat(b.price)));
                  const bestAsk = Math.min(...asks.map((a) => parseFloat(a.price)));
                  if (bestBid > 0 && bestAsk > 0 && bestBid <= bestAsk && bestAsk <= 1) {
                    const mid = (bestBid + bestAsk) / 2;
                    setPrices({
                      yesPrice: parseFloat(mid.toFixed(4)),
                      noPrice:  parseFloat((1 - mid).toFixed(4)),
                      spread:   parseFloat((bestAsk - bestBid).toFixed(4)),
                    });
                  }
                }
              } else if (type === "price_change" || type === "last_trade_price") {
                // Incremental price update
                const p = parseFloat(String(msg.price ?? "0"));
                if (p > 0 && p < 1) {
                  setPrices((prev) => ({
                    yesPrice: parseFloat(p.toFixed(4)),
                    noPrice:  parseFloat((1 - p).toFixed(4)),
                    spread:   prev?.spread ?? 0,
                  }));
                }
              }
            }
          } catch { /* ignore malformed messages */ }
        };

        ws.onclose = () => {
          if (activeRef.current) {
            // Reconnect after 1s on unexpected close
            timerRef.current = setTimeout(connect, 1_000);
          }
        };

        ws.onerror = () => ws.close();
      } catch { /* ignore failed connection attempts */ }
    }

    connect();

    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [yesTokenId]);

  return prices;
}

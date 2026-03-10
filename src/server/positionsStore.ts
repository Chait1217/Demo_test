export type PositionSide = "YES" | "NO";

export type PositionState = "OPEN" | "CLOSED";

export interface Position {
  id: string; // Polymarket orderId
  walletAddress: string;
  side: PositionSide;
  entryPrice: number;
  exitPrice?: number;
  collateral: number;
  borrowed: number;
  notional: number;
  leverage: number;
  fees: {
    openFee: number;
    closeFee: number;
    liquidationFee: number;
  };
  state: PositionState;
  openedAt: string;
  closedAt?: string;
  txHash?: string;
}

const positions: Position[] = [];

export function recordOpenPosition(p: Omit<Position, "state" | "openedAt">) {
  positions.push({
    ...p,
    state: "OPEN",
    openedAt: new Date().toISOString(),
  });
}

export function recordClosePosition(orderId: string, exitPrice?: number) {
  const p = positions.find((x) => x.id === orderId);
  if (!p) return;
  p.state = "CLOSED";
  p.exitPrice = exitPrice ?? p.exitPrice;
  p.closedAt = new Date().toISOString();
}

export function getPositionsForWallet(walletAddress: string) {
  const key = walletAddress.toLowerCase();
  return positions.filter((p) => p.walletAddress.toLowerCase() === key);
}


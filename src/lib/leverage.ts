export type Side = "YES" | "NO";

export interface LeverageInputs {
  collateral: number; // in USDC
  leverage: number; // 1x - 5x
}

export interface FeeBreakdown {
  openFee: number;
  closeFee: number;
  liquidationFee: number;
  borrowApr: number;
  vaultShare: number;
  insuranceShare: number;
  treasuryShare: number;
}

export interface PositionPreview extends LeverageInputs {
  borrowed: number;
  notional: number;
  effectiveLeverage: number;
  fees: FeeBreakdown;
}

// Simple kink model: 5% at 0% util, 78% at 100% util with a kink at 80%.
export function borrowAprFromUtilization(util: number): number {
  const u = Math.min(Math.max(util, 0), 1);
  const base = 0.05;
  const max = 0.78;
  const kink = 0.8;

  if (u <= kink) {
    return base + (max - base) * (u / kink) * 0.7;
  }
  const postKink = (u - kink) / (1 - kink);
  return base + (max - base) * (0.7 + 0.3 * postKink);
}

export function computePositionPreview(
  inputs: LeverageInputs,
  utilization: number
): PositionPreview {
  const { collateral, leverage } = inputs;
  const notional = collateral * leverage;
  const borrowed = Math.max(notional - collateral, 0);

  const openFee = notional * 0.004;
  const closeFee = notional * 0.004;
  const liquidationFee = collateral * 0.05;
  const borrowApr = borrowAprFromUtilization(utilization);

  const totalFees = openFee + closeFee;
  const vaultShare = totalFees * 0.5;
  const insuranceShare = totalFees * 0.3;
  const treasuryShare = totalFees * 0.2;

  return {
    collateral,
    leverage,
    borrowed,
    notional,
    effectiveLeverage: collateral > 0 ? notional / collateral : 1,
    fees: {
      openFee,
      closeFee,
      liquidationFee,
      borrowApr,
      vaultShare,
      insuranceShare,
      treasuryShare,
    },
  };
}


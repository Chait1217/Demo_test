// Simple in-memory vault model for prototyping the math and UX.
// In production this should be backed by an on-chain vault contract.

let tvl = 0; // total USDC in vault
let totalBorrowed = 0;
let userShares: Record<string, number> = {};

export function getVaultSnapshot(address?: string) {
  const userShare = address ? userShares[address.toLowerCase()] ?? 0 : 0;
  const available = Math.max(tvl - totalBorrowed, 0);
  const utilization = tvl === 0 ? 0 : totalBorrowed / tvl;

  return {
    tvl,
    totalBorrowed,
    available,
    utilization,
    userShare,
  };
}

export function depositToVault(address: string, amount: number) {
  const key = address.toLowerCase();
  userShares[key] = (userShares[key] ?? 0) + amount;
  tvl += amount;
  return getVaultSnapshot(address);
}

export function withdrawFromVault(address: string, amount: number) {
  const key = address.toLowerCase();
  const current = userShares[key] ?? 0;
  const allowed = Math.min(amount, current);
  userShares[key] = current - allowed;
  tvl = Math.max(tvl - allowed, 0);
  return getVaultSnapshot(address);
}

export function borrowFromVault(amount: number) {
  if (amount <= 0) return getVaultSnapshot();
  totalBorrowed += amount;
  return getVaultSnapshot();
}

export function repayToVault(amount: number) {
  if (amount <= 0) return getVaultSnapshot();
  totalBorrowed = Math.max(totalBorrowed - amount, 0);
  return getVaultSnapshot();
}


/**
 * Simulation state backed by localStorage.
 * Provides a demo $10,000 wallet balance and a pre-seeded $100,000 vault
 * so the app works end-to-end without real on-chain transactions.
 */

const DEMO_WALLET_START = 10_000;  // each new wallet starts with $10k
const DEMO_VAULT_SEED   = 100_000; // "other LPs" already seeded in vault

const wk    = (a: string) => `simw_${a.toLowerCase()}`;
const vk    = (a: string) => `simv_${a.toLowerCase()}`;
const TVL_K = "sim_tvl";

// ── storage helpers ───────────────────────────────────────────────────────────

function rd(key: string, def: number): number {
  if (typeof window === "undefined") return def;
  const raw = localStorage.getItem(key);
  if (raw === null) return def;
  const n = parseFloat(raw);
  return isNaN(n) ? def : n;
}

function wr(key: string, val: number) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, val.toFixed(6));
}

// ── cross-hook reactivity ────────────────────────────────────────────────────

const _subs = new Set<() => void>();

export function subscribeSimState(fn: () => void): () => void {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

function notify() {
  _subs.forEach((fn) => fn());
}

// ── public API ───────────────────────────────────────────────────────────────

export function simWalletBalance(addr: string): number {
  return rd(wk(addr), DEMO_WALLET_START);
}

export function simVaultUserBalance(addr: string): number {
  return rd(vk(addr), 0);
}

export function simVaultTVL(): number {
  return rd(TVL_K, DEMO_VAULT_SEED);
}

export function simDeposit(addr: string, amount: number): void {
  const wb     = simWalletBalance(addr);
  const vb     = simVaultUserBalance(addr);
  const actual = Math.min(amount, wb);
  wr(wk(addr), wb - actual);
  wr(vk(addr), vb + actual);
  wr(TVL_K, simVaultTVL() + actual);
  notify();
}

export function simWithdraw(addr: string, amount: number): void {
  const wb     = simWalletBalance(addr);
  const vb     = simVaultUserBalance(addr);
  const actual = Math.min(amount, vb);
  wr(wk(addr), wb + actual);
  wr(vk(addr), vb - actual);
  wr(TVL_K, Math.max(DEMO_VAULT_SEED, simVaultTVL() - actual));
  notify();
}

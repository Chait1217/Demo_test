"use client";

import { useAccount } from "wagmi";
import { useState, useEffect, useCallback } from "react";
import type { Position } from "@/server/positionsStore";

const STORAGE_KEY = "levmarket_positions";

function loadAll(): Position[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveAll(positions: Position[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
}

// Module-level cache kept in sync with localStorage
let _positions: Position[] = [];
const _listeners = new Set<() => void>();

function notify() {
  _listeners.forEach((fn) => fn());
}

export function addPosition(p: Position) {
  _positions = [p, ..._positions];
  saveAll(_positions);
  notify();
}

export function closePositionLocal(id: string) {
  _positions = _positions.map((p) =>
    p.id === id
      ? { ...p, state: "CLOSED" as const, closedAt: new Date().toISOString() }
      : p
  );
  saveAll(_positions);
  notify();
}

export function usePositions() {
  const { address } = useAccount();
  const [, forceRender] = useState(0);

  useEffect(() => {
    // Load from localStorage on mount
    _positions = loadAll();
    forceRender((n) => n + 1);

    const listener = () => forceRender((n) => n + 1);
    _listeners.add(listener);
    return () => {
      _listeners.delete(listener);
    };
  }, []);

  // Merge server-side positions (in case localStorage was cleared or user is in a new tab)
  useEffect(() => {
    if (!address) return;
    fetch(`/api/positions?walletAddress=${encodeURIComponent(address)}`)
      .then((r) => r.ok ? r.json() : [])
      .then((serverPositions: Position[]) => {
        if (!serverPositions.length) return;
        const local = loadAll();
        const localIds = new Set(local.map((p) => p.id));
        const merged = [
          ...local,
          ...serverPositions.filter((p) => !localIds.has(p.id)),
        ];
        if (merged.length > local.length) {
          saveAll(merged);
          _positions = merged;
          notify();
        }
      })
      .catch(() => { /* server may not have positions, ignore */ });
  }, [address]);

  const walletPositions = address
    ? _positions.filter(
        (p) => p.walletAddress.toLowerCase() === address.toLowerCase()
      )
    : [];

  const refetch = useCallback(() => {
    _positions = loadAll();
    forceRender((n) => n + 1);
  }, []);

  return {
    data: walletPositions,
    isLoading: false,
    refetch,
  };
}

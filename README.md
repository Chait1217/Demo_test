# LevMarket — Leveraged Prediction Terminal

Trade leveraged YES/NO positions on **"Will the Iranian regime fall by June 30?"** powered by Polymarket + a USDC.e vault on Polygon.

## Quick Start

```bash
npm install
cp .env.local.example .env.local
# Fill in POLYMARKET_PRIVATE_KEY for real trade execution
npm run dev
```

## What Works Without Any Config

- ✅ Connect any Polygon wallet (MetaMask, Coinbase, WalletConnect, etc.)
- ✅ Live YES/NO prices from Polymarket
- ✅ Price chart from Polymarket history API
- ✅ Vault stats from 0xB0B97F13a214D173bBAFd63a635b5216BdAdBaf4
- ✅ Position preview (collateral, borrowed, fees)
- ✅ Balance verification before trade
- ✅ Vault liquidity check before leverage
- ✅ Full transaction history per wallet
- ✅ Simulated trades (recorded locally) if no Polymarket key set

## For Real Polymarket Trade Execution

Add to `.env.local`:
```
POLYMARKET_PRIVATE_KEY=<your server wallet private key>
POLYMARKET_FUNDER_ADDRESS=<your server wallet address>
```

This wallet must:
1. Have MATIC for gas on Polygon
2. Have USDC on Polygon for margin
3. Be registered on Polymarket (visit polymarket.com once)

## Vault Address

`0xB0B97F13a214D173bBAFd63a635b5216BdAdBaf4` on Polygon

## Fee Structure

| Fee | Rate | Vault | Insurance | Treasury |
|-----|------|-------|-----------|----------|
| Open/Close | 0.4% of notional | 50% | 30% | 20% |
| Borrow APR | 5%–78% (kink) | 50% | 30% | 20% |
| Liquidation | 5% of collateral | 50% | 30% | 20% |

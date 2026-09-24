# PreStocks Integration

Backstop uses PreStocks as a flagship external evidence source for tokenized pre-IPO assets.

The integration is designed around a simple rule:

> **Only claim what the observed evidence actually proves.**

That makes PreStocks useful to Backstop without turning an issuer API into a fabricated proof of off-chain reserves.

## Why this matters for Stocklana

The PreStocks bounty asks builders to create value using PreStocks tokenized pre-IPO stocks. Backstop's wedge is **acceptance and risk evidence**: a downstream Solana application can ask Backstop what is known about a PreStocks asset before accepting it as collateral, routing it, displaying it, or otherwise relying on it.

The integration uses PreStocks assets directly. It does not mix unrelated private/pre-IPO token providers into the PreStocks path.

## What Backstop checks

For a mint published by PreStocks, the backend gathers independent evidence:

### 1. PreStocks catalogue identity + market data

Backstop fetches PreStocks' live catalogue and matches the requested mint address exactly.

When available, the integration records the published asset identity and issuer-side mark price. The mark price is evidence supplied by PreStocks; it is not treated as an executable DEX quote or as proof of backing.

### 2. Mainnet Solana identity

Backstop reads the actual mint account on Solana mainnet-beta.

For Token-2022 assets, it can inspect the mint's metadata and compare supported identity fields such as symbol, name, and decimals against the PreStocks catalogue.

An identity mismatch is treated as a serious evidence failure rather than being ignored.

### 3. Pyth applicability

The current PreStocks assets are private-company exposure, so Backstop does not use a public-equity Pyth feed as a substitute for their market reference.

This is important: a crypto derivative with a company-like symbol is not automatically the same financial instrument.

### 4. Backstop on-chain verification

The current Backstop program is deployed on Solana devnet, while the real PreStocks assets are on mainnet-beta.

Therefore the current deployment cannot use its devnet registry/snapshot mechanism against a mainnet-only PreStocks mint. The dashboard correctly reports this source as `NOT_APPLICABLE` rather than pretending that no evidence was found.

## Why the current verdict is WARNING

For a real PreStocks asset, the current evidence can establish:

- PreStocks publishes this exact mint;
- PreStocks provides associated market/mark-price data;
- the mint exists on Solana mainnet-beta;
- supported on-chain identity fields can agree with the published identity.

That is meaningful evidence, but it is **not independent proof that the underlying SPV owns a stated quantity of private-company equity**.

Therefore Backstop intentionally caps this path at:

```text
WARNING
```

until an appropriate backing attestation exists.

## What Backstop does NOT claim

Backstop does not claim that:

- the PreStocks API independently proves SPV holdings;
- a mark price proves reserves;
- a token's existence proves legal ownership of the underlying company;
- Pyth public-equity feeds can be substituted for a private-market instrument;
- the current devnet deployment can verify a mainnet-only mint.

This is a feature of the trust model: **missing independent evidence stays missing.**

## The eight known PreStocks assets

The integration currently recognizes the following live catalogue mints verified by the project:

| Symbol | Mint |
|---|---|
| ANDURIL | `PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB` |
| ANTHROPIC | `Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw` |
| FIGUREAI | `PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd` |
| KALSHI | `PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua` |
| NEURALINK | `PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S` |
| OPENAI | `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` |
| POLYMARKET | `Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP` |
| SPACEX | `PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh` |

The source of truth for the live catalogue remains PreStocks itself; this table is a documented snapshot of the assets incorporated into the integration.

## Cluster architecture

```text
PreStocks mainnet-beta
        │
        ├── catalogue identity
        ├── mark price
        └── Token-2022 mint
                │
                ▼
        Backstop evidence API
                │
                ├── identity checks
                ├── applicability checks
                └── verdict

Backstop devnet
        │
        ├── registry
        ├── attested snapshot
        ├── freshness
        └── live supply
```

These are currently separate evidence domains. A future mainnet deployment can connect the Backstop on-chain verification mechanism to an appropriate PreStocks attestor.

## What would be required for VERIFIED backing evidence

A real PreStocks asset could reach a genuine Backstop `VERIFIED` backing state if:

1. Backstop is deployed on the relevant mainnet cluster.
2. The real PreStocks mint is registered.
3. An authorized attestor has legitimate visibility into the underlying backing.
4. That attestor periodically submits signed backing snapshots.
5. Backstop's existing freshness and live-supply-vs-attested-backing checks pass.

The system already contains the verification machinery; the missing piece is the real-world trust relationship and authorized attestation source.

## Token-2022 reconciliation caveat

PreStocks assets use Token-2022 features, including Scaled UI Amount on the observed mints. A future native supply-vs-backing reconciliation must account for the mint's scaling configuration rather than assuming raw supply divided by decimals is the displayed supply.

That is deliberately not treated as implemented proof today. It is a documented engineering requirement for a future mainnet attestation path.

## Relationship to the Pyth bounty

Pyth is central to the **TSLA** reference path, where a public-equity Pyth feed supplies live market-price evidence alongside Backstop's on-chain health checks.

For PreStocks private-market assets, Backstop does not force Pyth into the pipeline where the instrument does not match. That preserves instrument correctness while keeping the Pyth integration meaningful where it actually applies.

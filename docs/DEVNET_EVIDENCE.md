# Devnet Evidence

This document explains how to reproduce the current Backstop devnet evidence. It is intentionally not a permanent list of snapshot addresses: every new snapshot creates a new account and transaction signature.

## What the devnet demo proves

The TSLA demo is the project's complete end-to-end reference path:

```text
Solana devnet mint
      ↓
Backstop registry
      ↓
signed snapshot
      ↓
freshness / expiry
      ↓
live token supply
      ↓
Backstop safety evaluation
      +
Pyth TSLA market price
      ↓
VERIFIED / WARNING / DENY / UNKNOWN
```

This demonstrates the product's core promise: **observable evidence can be turned into a reusable decision for downstream applications.**

It does not prove off-chain facts that the system cannot independently observe.

## Produce current evidence

Run:

```bash
npm run reconcile
```

This reads the current devnet registry, latest snapshot, and live token supply and reports the current safety state.

For a fresh snapshot and explicit transaction signatures:

```bash
npm run devnet:refresh-snapshot
```

Use the transaction signatures printed by that command when a submission form requires current transaction evidence.

## What each transaction proves

### `initialize_asset`

Creates the Backstop asset registry for the selected mint and records the configured attestor.

**Proves:** the asset was registered with Backstop on the target cluster.

**Does not prove:** that the underlying real-world asset or backing is genuine.

### `submit_snapshot`

Creates a signed snapshot containing an attested backing figure and expiry.

**Proves:** the configured attestor submitted an attestation and the program accepted it.

**Does not prove:** that an external auditor independently established the attested figure.

### `evaluate_snapshot`

Runs Backstop's safety check using the current registry, latest snapshot, mint, live supply, and freshness rules.

**Proves:** that the on-chain conditions required by Backstop passed at that point in time.

This is the check a downstream program can use as a circuit-breaker input.

## Stable identifiers

The program ID and demo mint are stable project identifiers; snapshot PDAs and transaction signatures are not.

- **Backstop program:** `8RTR33hW32KTA2eQD92LxD5VCto6FHjzZrRADWGHFuVs`
- **TSLA devnet demo mint:** `AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR`
- **Registry:** `EkwLnwNGXpq1JrvxmoEkCtqTUQotYPfAykXvF9eV9CVC`
- **Attestor:** `LeM3Dt71nbTJYZChitzaeMB2GjRRzDCnWR5VrUPnzvS`

## Pyth evidence

The TSLA demo also reads the configured Pyth market-price feed for independent market evidence.

The Pyth value is deliberately treated as **market-price evidence**, not as proof of backing. A price feed can corroborate the market reference for an asset while Backstop's on-chain registry/snapshot logic handles the separate health checks.

## Current verification model

A healthy TSLA result requires the applicable checks to pass, including:

- registry identity;
- mint identity;
- valid/latest snapshot;
- snapshot freshness;
- live supply within the attested amount;
- Pyth evidence when configured and applicable.

The exact result is time-sensitive because snapshots expire and upstream market data changes.

## Why old snapshot addresses disappear

Every `submit_snapshot` creates a fresh snapshot account and advances the registry's latest-snapshot pointer.

Therefore a historical snapshot address is useful as an audit artifact for that transaction, but it should never be presented as the project's permanently current snapshot.

This file intentionally avoids hardcoding an old snapshot PDA as current evidence.

## Reproducibility checklist

Before recording the final hackathon demo:

```bash
npm run reconcile
curl -s http://localhost:8787/health
curl -s http://localhost:8787/assets/AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR/evidence
npm run mock:consumer
```

Then record the current outputs rather than relying on an old screenshot or transaction signature.

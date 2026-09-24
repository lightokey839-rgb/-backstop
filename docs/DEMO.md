# Backstop Demo

## The story in one sentence

**Backstop is an evidence and safety layer for tokenized assets: it checks what can actually be observed, then gives a time-bound `VERIFIED`, `WARNING`, `DENY`, or `UNKNOWN` decision that another Solana app can consume.**

The demo deliberately uses two complementary cases:

- **TSLA** — the complete Backstop + Pyth path on Solana devnet.
- **PreStocks** — real mainnet Token-2022 assets, demonstrating issuer/catalogue identity and market evidence without pretending that those observations prove SPV backing.

---

## 1. Start the backend + dashboard

```bash
npm run backend
# open http://localhost:8787
```

The dashboard's quick-select row loads from `GET /assets` and includes the TSLA devnet demo asset plus the real PreStocks assets known to the integration.

**Judge takeaway:** this is a working product surface, not a slide-only architecture.

---

## 2. TSLA — the full verification path

Click **TSLA**.

This is the main end-to-end demo. It exercises:

- a real Solana devnet mint;
- a Backstop asset registry;
- a signed backing snapshot;
- snapshot freshness/expiry checks;
- live on-chain token supply;
- a live Pyth TSLA market-price feed;
- a final safety verdict consumed by the dashboard.

Expected result when the snapshot is current and Pyth is reachable:

```text
Backstop: VERIFIED
Pyth: PASS
Overall: VERIFIED
```

The exact evidence is time-sensitive. If a snapshot has expired or an upstream provider is unavailable, the dashboard reports the affected evidence state rather than silently presenting stale data as valid.

If needed, refresh the demo snapshot with the project's existing devnet refresh command.

---

## 3. PreStocks — real private-market token evidence

Select a real PreStocks asset such as **OPENAI** or **ANTHROPIC**.

The dashboard should show:

- **PreStocks: PASS** — the mint is present in PreStocks' live catalogue and has usable issuer-side market data.
- **Mainnet Solana: PASS** — the actual Token-2022 mint identity is inspected and cross-checked against the catalogue where supported.
- **Pyth: NOT_APPLICABLE** — the project does not substitute unrelated crypto-derivative feeds for a private-company equity reference.
- **Backstop: NOT_APPLICABLE** — the current Backstop program is on devnet while these real PreStocks assets are on mainnet-beta.
- **Overall: WARNING** — evidence was observed, but this path does not independently prove underlying SPV backing.

This is intentional. Backstop's core promise is **evidence before acceptance**, not a claim that an API response magically proves off-chain ownership.

See [`PRESTOCKS_INTEGRATION.md`](./PRESTOCKS_INTEGRATION.md) for the exact trust boundary.

---

## 4. Try an unknown mint

Enter a Solana address that is not registered in Backstop and is not a known PreStocks asset.

Expected behavior:

```text
Overall: UNKNOWN
```

The important behavior is that Backstop does **not** manufacture a positive result when evidence is missing.

---

## 5. Show the downstream consumer

```bash
npm run mock:consumer
```

The consumer calls the real `/assets/:mint/evidence` endpoint and turns the evidence into an application decision such as:

```text
ALLOW
```

or

```text
BLOCK
```

with the reasons behind that decision.

If the backend cannot provide evidence, the consumer fails closed rather than defaulting to ALLOW.

**This is the product wedge:** Backstop is useful because another application can consume its verdict instead of rebuilding the same checks itself.

---

## 6. Optional reconciliation proof

For the TSLA devnet path:

```bash
npm run reconcile
```

For a real PreStocks mainnet asset:

```bash
npm run reconcile:mainnet -- --mint Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw
```

The mainnet mode deliberately does not pretend that a devnet Backstop registry exists on mainnet. It reports the evidence that can actually be observed there.

---

## Recommended 60-second judge walkthrough

1. **Open the dashboard:** “Backstop answers one question: should this tokenized asset be accepted by a downstream app?”
2. **Select TSLA:** show `VERIFIED` and the individual Backstop/Pyth evidence cards.
3. **Point at Pyth:** explain that live market price is corroborating market evidence, not proof of backing.
4. **Select OPENAI/ANTHROPIC:** show real PreStocks + mainnet identity evidence and the intentional `WARNING`.
5. **Run the consumer:** show how another application turns Backstop evidence into ALLOW/BLOCK.
6. **Finish:** “Instead of every DeFi application independently deciding whether an asset is healthy, Backstop gives them a reusable evidence layer.”

---

## What the demo does not claim

Backstop does **not** claim that:

- Pyth proves physical or legal ownership of shares;
- a PreStocks API response proves an SPV's underlying holdings;
- an observed token price proves backing exists;
- a devnet Backstop registry verifies a mainnet-only PreStocks mint;
- `VERIFIED` means an auditor independently proved every off-chain fact.

Those boundaries are part of the product's trust model, not footnotes added after the fact.

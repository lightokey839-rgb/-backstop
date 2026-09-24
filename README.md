# Backstop

## Evidence before acceptance.

**Backstop is a Solana-native evidence and safety layer for tokenized assets.**

It helps downstream applications answer a simple question before accepting an asset:

> **"Do the available on-chain and external signals currently support accepting this token?"**

Backstop combines:

* **Solana on-chain evidence** — registry, signed snapshots, live token supply, freshness and expiry checks
* **Pyth market data** — independent live market-price evidence where a valid public-equity feed exists
* **PreStocks evidence** — real PreStocks identity and issuer-side market data for supported pre-IPO tokens
* **Clear verdicts** — `VERIFIED`, `WARNING`, `DENY`, `UNKNOWN`, or `NOT_APPLICABLE`
* **Downstream safety decisions** — applications can use the result as a circuit breaker instead of blindly trusting a token

Backstop is designed for the infrastructure layer underneath lending, trading, collateral, portfolio, and other Solana applications.

---

## The problem

Tokenized stocks and other real-world assets introduce a trust problem.

A Solana application can see a token mint, but that does not automatically tell the application:

* whether the asset is the token it expects
* whether a backing attestation is still fresh
* whether live token supply is consistent with an attested backing amount
* whether an external issuer actually recognizes the mint
* whether the current market price is available
* whether an evidence source is unavailable or simply not applicable

Most applications should not have to rebuild these checks independently.

**Backstop turns those signals into a structured, time-bound evidence result.**

---

# How Backstop works

```text
                    TOKENIZED ASSET
                           │
                           ▼
                  ┌─────────────────┐
                  │     BACKSTOP    │
                  │                 │
                  │ Identity        │
                  │ Backing evidence│
                  │ Market evidence │
                  │ Freshness       │
                  │ Risk checks     │
                  └────────┬────────┘
                           │
                           ▼
             ┌───────────────────────────┐
             │ VERIFIED / WARNING / DENY │
             │ UNKNOWN / NOT_APPLICABLE  │
             └─────────────┬─────────────┘
                           │
                           ▼
                  DOWNSTREAM APPLICATION
                  ┌────────┬────────┬───────┐
                  │ Lending│ DeFi   │Trading│
                  └────────┴────────┴───────┘
```

The important design choice is that **Backstop does not collapse missing evidence into a false positive**.

If a check cannot run, the system can report `NOT_APPLICABLE` or `UNKNOWN` instead of pretending the asset passed.

---

# The live demo

Backstop currently demonstrates two complementary paths.

## 1. TSLA — complete Backstop + Pyth path

The TSLA demo asset exercises the complete verification flow on Solana devnet:

* real devnet SPL mint
* Backstop asset registry
* signed backing snapshot
* snapshot freshness/expiry
* live token supply
* supply-versus-attested-backing reconciliation
* registry/mint identity checks
* live Pyth TSLA market price

A healthy current snapshot can produce:

```text
Backstop:  VERIFIED
Pyth:      OBSERVED
Overall:   VERIFIED
```

Pyth is used as **market-price evidence**.

It is not treated as proof that the underlying shares or reserves exist.

---

## 2. PreStocks — real mainnet asset evidence

Backstop also integrates with the live PreStocks catalogue.

The integration currently recognizes the published PreStocks assets and checks:

1. **PreStocks identity**

   * The exact mint is found in the live PreStocks catalogue.
   * The API provides issuer-side mark-price information.

2. **Solana mainnet identity**

   * The actual mint account is inspected on mainnet-beta.
   * Token-2022 metadata can be cross-checked against the PreStocks catalogue.

3. **Market evidence**

   * The available PreStocks mark price is surfaced as external evidence.

4. **Backstop applicability**

   * Backstop's current program is deployed on devnet.
   * Real PreStocks assets are mainnet-beta assets.
   * Therefore the devnet Backstop registry/snapshot check is explicitly `NOT_APPLICABLE` for those mainnet assets.

A typical result is therefore:

```text
PreStocks:       PASS
Mainnet Solana:  PASS
Pyth:            NOT_APPLICABLE
Backstop:        NOT_APPLICABLE
Overall:         WARNING
```

That `WARNING` is intentional.

It means:

> **The asset's identity and external market evidence were observed, but this evidence does not independently prove SPV backing.**

---

# Why the verdict matters

Backstop separates different kinds of evidence instead of treating every signal as proof of everything.

| Verdict          | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `VERIFIED`       | Required Backstop checks currently pass                                            |
| `WARNING`        | Useful evidence exists, but the complete verification conditions are not satisfied |
| `DENY`           | A required identity/safety check failed                                            |
| `UNKNOWN`        | The system cannot establish the required state                                     |
| `NOT_APPLICABLE` | That check cannot legitimately run for this asset/path                             |

This distinction is central to Backstop.

**Unavailable evidence is not automatically a failure.
Observed market data is not automatically proof of backing.
An issuer's claim is not automatically an independent attestation.**

---

# Why Solana?

Backstop is built around Solana-native state and transaction execution.

The core verification path uses:

* Anchor
* Solana accounts
* SPL token mint state
* on-chain asset registries
* signed snapshot transactions
* live token supply
* freshness and expiry enforcement
* program-level evaluation suitable for downstream CPI/circuit-breaker use

The core idea is simple:

```text
Register asset
      ↓
Attest backing
      ↓
Store snapshot on Solana
      ↓
Read current mint state
      ↓
Check freshness + supply
      ↓
Return safety decision
```

A downstream protocol does not need to trust a screenshot, dashboard badge, or static JSON file.

It can consume a structured verification result backed by Solana state.

---

# Why Pyth?

Pyth is used where market-price information can provide useful independent evidence.

For the TSLA demo:

```text
Backstop on-chain health
        +
Pyth live TSLA market price
        ↓
combined evidence
```

This allows a downstream application to see both:

* whether the Backstop on-chain health checks are currently satisfied
* what the external market-data layer currently reports

Pyth therefore performs real work in the system rather than being included as a decorative integration.

**Important:** Pyth market price does not prove physical ownership or backing.

---

# Why PreStocks?

PreStocks is the project's flagship pre-IPO asset integration.

Backstop consumes the real PreStocks catalogue and matches assets by their exact Solana mint address.

The current verified catalogue includes:

| Asset      | Mint                                          |
| ---------- | --------------------------------------------- |
| ANDURIL    | `PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB` |
| ANTHROPIC  | `Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw` |
| FIGUREAI   | `PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd` |
| KALSHI     | `PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua` |
| NEURALINK  | `PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S` |
| OPENAI     | `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` |
| POLYMARKET | `Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP` |
| SPACEX     | `PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh` |

These addresses were obtained from the live PreStocks catalogue rather than guessed from names or documentation.

### What Backstop verifies

For a known PreStocks mint, Backstop can observe:

* PreStocks catalogue identity
* PreStocks mark price
* mainnet mint existence
* Token-2022 identity
* relevant metadata
* consistency between catalogue information and on-chain identity

### What Backstop does not claim

Backstop does **not** independently prove that:

* an SPV owns a particular number of private-company shares
* physical/legal ownership exists
* PreStocks' reported backing is independently attested
* a quoted price proves reserves exist

Those claims would require a separate trusted attestation source.

Backstop deliberately does not manufacture that evidence.

---

# Architecture

```text
┌──────────────────────────────────────────────────────┐
│                    BACKSTOP API                      │
│                                                      │
│  Evidence aggregation + verdict evaluation           │
└───────────────┬───────────────┬──────────────────────┘
                │               │
        ┌───────▼──────┐ ┌──────▼───────┐
        │   Backstop   │ │ External     │
        │   Solana     │ │ Evidence     │
        │   Program    │ │              │
        └───────┬──────┘ ├──────────────┤
                │         │ PreStocks    │
                │         │ Pyth         │
                │         │ Mainnet RPC  │
                │         └──────────────┘
                │
        ┌───────▼─────────────────────┐
        │ Registry / Snapshot / Mint  │
        │ Supply / Freshness / Expiry │
        └─────────────────────────────┘
```

The backend normalizes these independent sources into one evidence response.

---

# Example API

### Health

```http
GET /health
```

### Asset evidence

```http
GET /assets/:mint/evidence
```

Example:

```bash
curl -s \
  http://localhost:8787/assets/AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR/evidence
```

The response contains the individual evidence sources and the resulting verdict.

### Asset list

```http
GET /assets
```

The dashboard uses this to expose the available demo assets.

---

# Downstream consumer

Backstop is intended to be consumed by applications rather than used only as a dashboard.

The repository includes a mock downstream consumer:

```bash
npm run mock:consumer
```

It calls the real evidence endpoint and converts the result into an application-level decision.

Conceptually:

```text
Backstop evidence
       ↓
consumer evaluates verdict
       ↓
ALLOW / BLOCK
```

If the backend cannot provide the required evidence, the consumer fails closed rather than defaulting to `ALLOW`.

That is the circuit-breaker use case Backstop is designed to support.

---

# Trust model

Backstop distinguishes between **observation** and **truth**.

A signed snapshot proves that the configured attestor submitted a particular claim at a particular time.

It does not, by itself, prove that the attested number is economically true.

Therefore the trust model is explicit:

```text
Issuer / Attestor
       │
       │ signed attestation
       ▼
Backstop snapshot
       │
       ├── freshness
       ├── expiry
       ├── live supply
       └── identity
              │
              ▼
        safety decision
```

The attestor is part of the trust boundary.

A production deployment would require an appropriate trusted attestor such as an issuer, custodian, auditor, or other entity with legitimate access to the underlying backing information.

---

# Mainnet vs devnet

The current demonstration intentionally uses two environments.

### Backstop

```text
Solana devnet
```

### Real PreStocks assets

```text
Solana mainnet-beta
```

This matters because a devnet program cannot read or register a mainnet-only mint.

Therefore the dashboard does **not** pretend that the devnet Backstop registry has verified a real mainnet PreStocks asset.

Instead:

```text
PreStocks mainnet evidence
        +
Mainnet Solana identity
        +
Backstop NOT_APPLICABLE
        ↓
honest WARNING verdict
```

A future production deployment could place Backstop on mainnet and configure a legitimate attestor for the relevant asset.

---

# Current program

**Backstop program ID:**

```text
8RTR33hW32KTA2eQD92LxD5VCto6FHjzZrRADWGHFuVs
```

**Network:**

```text
Solana devnet
```

**Attestor used by the demo:**

```text
LeM3Dt71nbTJYZChitzaeMB2GjRRzDCnWR5VrUPnzvS
```

**TSLA demo mint:**

```text
AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR
```

---

# Project structure

```text
backstop/
├── programs/
│   └── backstop/
│       └── src/
│           └── lib.rs
│
├── backend/
│   ├── server.ts
│   ├── onchain.ts
│   └── integrations/
│       ├── prestocks.ts
│       └── pyth.ts
│
├── frontend/
│   ├── index.html
│   ├── app.css
│   └── app.js
│
├── scripts/
│   ├── lib/
│   ├── refresh-snapshot.ts
│   └── ...
│
├── docs/
│   ├── DEMO.md
│   ├── DEVNET_EVIDENCE.md
│   ├── PRESTOCKS_INTEGRATION.md
│   └── SUBMISSION_CHECKLIST.md
│
└── Anchor.toml
```

---

# Running locally

Install dependencies:

```bash
npm install
```

Start the backend:

```bash
npm run backend
```

Open:

```text
http://localhost:8787
```

For live Pyth evidence, configure the Pyth API key through the environment:

```bash
export PYTH_API_KEY="YOUR_PYTH_API_KEY"
```

Do not commit API keys or other secrets to the repository.

---

# Testing

The project includes tests for the on-chain program, LiteSVM behavior, backend evidence aggregation, and adversarial/failure cases.

The final submission should be verified locally with:

```bash
anchor build --ignore-keys --no-idl -- --skip-tools-install
npm test
npm run test:litesvm
npx tsc --noEmit
```

The current project verification record includes:

```text
Rust tests       26/26
LiteSVM tests    16/16
Backend tests    23/23
TypeScript       PASS
Devnet deploy    PASS
```

The final local run should be treated as authoritative before submission.

---

# Failure handling

Backstop is designed to degrade explicitly.

Examples:

### Pyth unavailable

```text
Pyth → UNKNOWN / unavailable
```

The entire evidence system does not silently claim Pyth passed.

### PreStocks unavailable

```text
PreStocks → unavailable
```

The dashboard reports the source state rather than inventing data.

### Asset not recognized

```text
UNKNOWN
```

Rather than treating an unknown token as safe.

### Check cannot legitimately run

```text
NOT_APPLICABLE
```

For example, the current devnet Backstop program cannot inspect a mainnet-only PreStocks asset.

### Downstream evidence unavailable

The example consumer fails closed:

```text
BLOCK
```

rather than assuming the asset is safe.

---

# What Backstop is — and is not

## Backstop is

* an evidence aggregation layer
* an on-chain asset health checker
* a freshness-aware snapshot verifier
* a market-data cross-reference layer
* a PreStocks identity/evidence integration
* a downstream circuit-breaker primitive

## Backstop is not

* a proof-of-physical-share-ownership system
* a universal real-world-asset verifier
* an independent auditor of issuer reserves
* a guarantee that an issuer's attestation is truthful
* a replacement for legal or custody due diligence

These boundaries are intentional.

---

# Stocklana alignment

Backstop is built around the Stocklana challenge of making tokenized assets more useful and safer to use on Solana.

The product wedge is:

> **Give Solana applications an evidence layer they can consult before accepting a tokenized asset.**

That creates a reusable infrastructure primitive for applications such as:

* tokenized-stock lending
* collateral systems
* trading applications
* portfolio applications
* DeFi protocols
* asset discovery and analytics
* automated risk controls

Instead of each application independently deciding what a token means, Backstop provides a common evidence interface.

---

# PreStocks bounty

Backstop uses PreStocks as a real external asset source rather than a simulated integration.

The integration:

* consumes the live PreStocks catalogue
* recognizes the published PreStocks token set
* matches assets by exact mint
* reads issuer-side mark-price evidence
* checks the corresponding mainnet Token-2022 mint
* cross-checks available identity metadata
* exposes the resulting evidence through the Backstop API and dashboard

The integration is deliberately scoped to **PreStocks assets** rather than mixing unrelated private/pre-IPO tokens into the bounty integration.

See:

```text
docs/PRESTOCKS_INTEGRATION.md
```

for the detailed evidence and trust model.

---

# Pyth bounty

Pyth is integrated as live market data in the TSLA verification path.

The Pyth signal is used as:

```text
market-price evidence
```

alongside:

```text
Backstop on-chain health
```

This makes market data part of the actual verification workflow rather than a standalone price display.

The integration is intentionally conservative:

**Pyth price ≠ proof of backing.**

---

# Demo flow

For the fastest demonstration:

### 1. Start Backstop

```bash
npm run backend
```

### 2. Open the dashboard

```text
http://localhost:8787
```

### 3. Select TSLA

Show:

```text
Backstop       VERIFIED
Pyth           PASS / OBSERVED
Overall        VERIFIED
```

### 4. Select a PreStocks asset

For example:

```text
OPENAI
```

Show:

```text
PreStocks       PASS
Mainnet Solana   PASS
Pyth             NOT_APPLICABLE
Backstop         NOT_APPLICABLE
Overall          WARNING
```

### 5. Show the downstream consumer

```bash
npm run mock:consumer
```

This demonstrates how another application can consume the evidence rather than relying on the dashboard itself.

The complete walkthrough is in:

```text
docs/DEMO.md
```

---

# Known limitations and next step

The current hackathon implementation deliberately stops short of claiming independent proof of private-company backing.

For a real mainnet deployment of Backstop against a PreStocks asset, the missing production trust path would be:

1. deploy Backstop to mainnet-beta
2. register the actual PreStocks mint
3. establish a legitimate attestor relationship
4. receive periodic signed backing snapshots
5. reconcile those snapshots against the correct Token-2022 supply representation

PreStocks Token-2022 assets can also use extensions such as Scaled UI Amount, so production supply reconciliation must account for the actual mint extension state rather than assuming a simple raw-decimal conversion.

That is a future production integration, not something the hackathon demo pretends already exists.

---

# Why this can become infrastructure

The dashboard is only the visible demonstration.

The more important primitive is the evidence endpoint and on-chain verification model:

```text
Asset
  ↓
Evidence
  ↓
Verdict
  ↓
Application decision
```

A lending protocol could use it before accepting collateral.

A trading application could use it before enabling an asset.

A portfolio application could surface evidence freshness.

An automated agent could refuse to interact with an asset whose evidence is stale or contradictory.

The same verification layer can therefore sit underneath many different tokenized-asset applications.

---

# Built for the hackathon. Designed to keep running.

Backstop's hackathon implementation focuses on one clear wedge:

**make tokenized assets easier for Solana applications to evaluate before accepting them.**

The demo proves the idea with real Solana state, real external evidence, real Pyth market data, and real PreStocks assets — while keeping the trust boundaries explicit.

---

## Links

**GitHub:** `TODO — add repository URL`

**Live demo:** `TODO — add deployed dashboard URL`

**Demo video:** `TODO — add video URL`

---

## License

See the repository license for the applicable terms.

# Legacy scripts

These four scripts are early build-log artifacts (originally `day1`,
`day3`, `day4`, and `mvp-demo`), kept for provenance rather than deleted.
**None of them send a transaction to the deployed Backstop Anchor
program.** Each says so explicitly in its own header comment and console
output.

| Script | What it actually does |
|---|---|
| `day1-cli-check.ts` | Local-only model of the crypto core (canonical JSON → SHA-256 → Ed25519 → coverage → status). No RPC call at all. |
| `day3-reconciliation.ts` | Reads one real devnet mint's live supply, then builds a locally-fabricated attestation with a throwaway keypair to exercise the signing/coverage math. Targets an old test mint, not the current TSLA devnet mint. |
| `day4-adversarial.ts` | Adversarial tests (wrong mint, expired, tampered signature, under-backed) against `day1`'s local model. Same old test mint as `day3`. |
| `mvp-demo.ts` | Fully offline walkthrough of the status model with hand-picked example numbers. |

**Why they don't reflect the deployed program's actual verification path:**
the on-chain program (`programs/backstop/src/lib.rs`) authenticates a
snapshot submission through the submitting Solana transaction's own
signature from the registered attestor keypair — a native, runtime-checked
signer, not a detached Ed25519 signature the program parses and verifies
itself. The detached-signature dance in `day1`/`day3`/`day4` was an early
design exploration that predates the deployed program and was not carried
into it. Don't cite these scripts as evidence of what the live program
checks.

**What to run instead for something real:**
- `npm run devnet:mint` — creates a real devnet mint and registers/snapshots it (`scripts/day2-real-mint.ts`)
- `npm run devnet:refresh-snapshot` — publishes a fresh, real snapshot (`scripts/refresh-snapshot.ts`)
- `npm run reconcile` / `npm run reconcile:mainnet` — reads real on-chain state and reports it (`scripts/reconcile.ts`)
- `npm run test:litesvm` — real adversarial tests against the actual compiled program (`programs/backstop/tests/backstop_litesvm.rs`)

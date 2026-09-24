# Stocklana Submission Checklist

This checklist is organized around the current Stocklana judging model: a real user/problem, a working end-to-end demo, a clear reason to use Solana, and strong execution around one focused wedge.

## 1. Product story

- [x] Backstop has one clear wedge: **evidence and safety decisions for tokenized assets**.
- [x] The primary user/problem is clear: downstream Solana applications need a reusable way to assess whether an asset should be accepted.
- [x] The product produces explicit, time-bound verdicts: `VERIFIED`, `WARNING`, `DENY`, and `UNKNOWN`.
- [x] The dashboard demonstrates the product instead of relying on slides.
- [x] The downstream consumer demonstrates that another application can use the verdict.

## 2. Main-track requirements

- [x] Working end-to-end Solana demo.
- [x] Real on-chain state is used for the TSLA reference path.
- [x] The project explains why this belongs on Solana: the verification layer can inspect and reconcile token/mint state and expose a machine-readable safety decision to Solana applications.
- [x] The project avoids claiming that it independently proves off-chain ownership or physical reserves.
- [ ] **YOU:** Record the final demo/video.
- [ ] **YOU:** Add the final GitHub repository link to the submission.
- [ ] **YOU:** Add the final live-demo link if one is deployed.

## 3. PreStocks bounty

- [x] PreStocks is integrated directly through its published catalogue/API.
- [x] The integration recognizes the real PreStocks tokenized pre-IPO assets used by the project.
- [x] Mainnet Token-2022 identity is checked where supported.
- [x] PreStocks market/mark-price evidence is surfaced.
- [x] The integration is clearly separated from unrelated private/pre-IPO token providers.
- [x] The documentation explains the actual value proposition: downstream apps can inspect PreStocks evidence before accepting or relying on an asset.
- [x] The documentation does not falsely claim that PreStocks API data proves SPV backing.
- [ ] **YOU:** Re-check the final Stocklana page immediately before submission for any last-minute bounty wording or eligibility changes.

## 4. Pyth bounty

- [x] Pyth is integrated into a working Solana application.
- [x] TSLA uses a real Pyth public-equity market-price feed.
- [x] The Pyth value changes the evidence presented by the application rather than being decorative data.
- [x] Pyth is explicitly treated as market-price evidence, not proof of physical backing.
- [x] The integration has a clear role alongside Backstop's on-chain health checks.
- [ ] **YOU:** Verify the final live Pyth response immediately before recording the demo.
- [ ] **YOU:** Keep the Pyth API key out of the repository and screenshots.

## 5. Demo readiness

- [x] Dashboard starts with `npm run backend`.
- [x] TSLA quick-select/demo path works.
- [x] PreStocks asset path works against the real catalogue.
- [x] Unknown-mint behavior is explicit.
- [x] Backend failure states are surfaced instead of hidden.
- [x] Downstream consumer fails closed when evidence cannot be obtained.
- [ ] **YOU:** Run `npm run reconcile` immediately before recording.
- [ ] **YOU:** Refresh the TSLA snapshot if needed.
- [ ] **YOU:** Run the final smoke-test commands after the last code change.

## 6. Engineering verification

Latest project status to verify before submission:

- [x] TypeScript compile: `npx tsc --noEmit` passes.
- [x] Backend tests: 23/23 passing in the latest verified project state.
- [x] LiteSVM tests: 16 passing in the latest verified project state.
- [x] Rust unit tests: 26/26 passing in the latest verified project state.
- [x] Devnet deployment exists and the program ID is known.
- [ ] **YOU:** Re-run the exact local build/test commands after any final source change.
- [ ] **YOU:** Verify the deployed program contains the final code if the last changes require redeployment.

## 7. Security / trust-model checks

- [x] No Pyth key committed to source control.
- [x] No machine-specific absolute paths in the documented run path.
- [x] Unknown evidence does not silently become VERIFIED.
- [x] PreStocks evidence does not silently become VERIFIED backing evidence.
- [x] Pyth market price does not silently become backing evidence.
- [x] Devnet Backstop verification is not represented as mainnet verification.
- [x] Historical snapshot signatures are not presented as permanently current.

## 8. Final submission package

Before pressing submit, confirm that the repository contains:

- [ ] `README.md` — judge-facing product explanation.
- [ ] `docs/DEMO.md` — exact demo walkthrough.
- [ ] `docs/PRESTOCKS_INTEGRATION.md` — PreStocks technical proof and trust boundary.
- [ ] `docs/DEVNET_EVIDENCE.md` — reproducible on-chain evidence instructions.
- [ ] `docs/SUBMISSION_CHECKLIST.md` — final shipping checklist.
- [ ] Working GitHub repository URL.
- [ ] Working demo URL, if available.
- [ ] Demo video URL, if required/used.

## 9. Final judge-facing message

The submission should make these four facts obvious without requiring the judge to read the entire repository:

1. **Problem:** Solana apps need trustworthy, reusable evidence before accepting tokenized assets.
2. **Product:** Backstop observes on-chain identity/health plus applicable external market evidence and returns a machine-readable verdict.
3. **Why Solana:** the core verification path operates directly against Solana mint, registry, snapshot, and supply state and is consumable by Solana applications.
4. **Proof:** TSLA demonstrates the complete Backstop + Pyth path; real PreStocks assets demonstrate the external identity/market evidence path.

The goal is not to claim that Backstop proves every real-world fact. The goal is to show that it gives applications a disciplined, reusable answer to **"what evidence do we have right now, and should we accept this asset?"**

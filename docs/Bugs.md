## Bugs and Build Issues Encountered

### 1. Anchor / Solana toolchain installation failure

**Problem:** Anchor 1.1.2 required Solana 3.1.10, but the local `agave-install`/Solana toolchain initially had a broken or incomplete installation. `anchor test` and related SBPF builds failed while trying to activate Solana 3.1.10.

**Fix:** Removed the corrupted Solana cache, reinstalled Solana 3.1.10 with `agave-install`, installed the required platform tools, and used:

```bash
anchor build --ignore-keys --no-idl -- --skip-tools-install
```

The build subsequently passed.

---

### 2. Anchor automatically changed the program ID

**Problem:** During an Anchor build, `declare_id!` in `programs/backstop/src/lib.rs` was automatically changed from the intended deployed program ID to:

```text
EHyakY8jK5mx1tybEQQytCgW8KbHRMsEFNW9tPXwj5Mz
```

This did not match the actual Backstop deployment.

**Fix:** Restored the intended program ID:

```text
8RTR33hW32KTA2eQD92LxD5VCto6FHjzZrRADWGHFuVs
```

The program was then rebuilt and verified against the deployed program.

---

### 3. PreStocks asset mismatch

**Problem:** The TSLA demo asset is a Backstop devnet asset and is not a PreStocks asset. Attempting to treat the TSLA mint as a PreStocks asset produced:

```text
mint_not_registered_as_known_prestocks_asset
```

**Fix:** PreStocks was changed to an optional evidence source. Assets that are not published PreStocks tokens are explicitly returned as `NOT_APPLICABLE` instead of being treated as an error.

The OpenAI PreStocks mint was then verified against the live PreStocks catalog.

---

### 4. Incorrect / incomplete PreStocks mint assumptions

**Problem:** Earlier development relied on assumptions about the PreStocks token roster and mints.

**Fix:** The integration was updated using the live PreStocks catalog as the source of truth. Known PreStocks mints are mapped from the published catalog rather than guessed.

---

### 5. Pyth entitlement / feed access problems

**Problem:** Some equity feeds, including AAPL and NVDA during development, returned HTTP 403 because the available Pyth endpoint/API entitlement did not provide access to those feeds.

**Fix:** Pyth was deliberately made **optional evidence**, not a required dependency for Backstop verification. The TSLA feed was successfully integrated and verified through Hermes.

---

### 6. Pyth evidence could have been misinterpreted as backing proof

**Problem:** A market-price feed could easily be presented as if it proved that physical shares or reserves actually existed.

**Fix:** The verdict/evidence semantics were tightened so Pyth is explicitly treated as market-price evidence only. The project does not claim that Pyth proves physical ownership or backing.

---

### 7. Vercel dashboard returned 404

**Problem:** The GitHub repository contains the frontend under:

```text
frontend/
  index.html
  app.css
  app.js
```

but Vercel was initially configured with the repository root (`./`) as the Root Directory. The deployed site therefore returned a 404.

**Fix:** Changed Vercel's Root Directory to:

```text
frontend
```

The dashboard then loaded successfully.

---

### 8. Vercel frontend showed "Failed to fetch"

**Problem:** The frontend originally called the API with relative URLs:

```text
/assets/:mint/evidence
/health
```

When deployed on Vercel, those requests were sent to the Vercel domain instead of the Render backend.

**Fix:** Changed the frontend to call:

```text
https://backstop-ysx4.onrender.com/assets/:mint/evidence
https://backstop-ysx4.onrender.com/health
```

---

### 9. Cross-origin requests were blocked by CORS

**Problem:** After the frontend was correctly pointed at Render, browser requests from the Vercel domain were blocked because the backend had no CORS headers and did not handle browser `OPTIONS` requests.

**Fix:** Added:

```text
Access-Control-Allow-Origin: https://backstop-blue.vercel.app
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Accept, Content-Type
```

and added an `OPTIONS` response with HTTP 204.

Production verification confirmed:

```text
HTTP/2 204
access-control-allow-origin: https://backstop-blue.vercel.app
```

---

### 10. Render port compatibility had to be verified

**Problem:** Render provides its own `PORT`, rather than always using the local development port `8787`.

**Fix:** The backend already uses:

```ts
const PORT = Number(process.env.PORT ?? 8787);
```

This was tested with `PORT=10000`, confirming that the backend works correctly with Render's assigned port.

---

### 11. Render dependency audit warnings

**Problem:** Render reported:

```text
9 vulnerabilities
6 moderate
3 high
```

during `npm install`.

**Status:** This did not block the build or deployment. No forced dependency upgrade was applied because blindly using `npm audit fix --force` could introduce breaking dependency changes.

---

## Final Verification After Fixes

The project reached a working state with:

* Anchor/SBPF build passing
* Rust tests passing
* LiteSVM tests passing
* Backend tests passing
* TypeScript check passing
* Devnet deployment verified
* Render backend live
* Public `/health` endpoint working
* Public `/assets/:mint/evidence` endpoint working
* Vercel dashboard serving correctly
* Vercel → Render CORS working
* Backstop TSLA verdict: `VERIFIED`
* Pyth TSLA evidence: `OBSERVED`
* PreStocks correctly returning `NOT_APPLICABLE` for the TSLA demo
* OpenAI PreStocks asset producing the intended `WARNING` because Backstop has no registry/snapshot for that asset on the deployed network

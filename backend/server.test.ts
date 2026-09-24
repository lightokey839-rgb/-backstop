import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateEvidence, type EvidenceBundle } from "./server.js";
import type { PythEvidence } from "./integrations/pyth.js";
import type { PreStocksEvidence } from "./integrations/prestocks.js";

const NOT_APPLICABLE_PYTH: PythEvidence = {
  source: "PYTH",
  status: "NOT_APPLICABLE",
  feedId: null,
  reason: "No public-equity Pyth feed applies to this symbol.",
};

const OBSERVED_USABLE_PYTH: PythEvidence = {
  source: "PYTH",
  status: "OBSERVED",
  price: "25000000000",
  confidence: "10000000",
  exponent: -8,
  publishTime: Math.floor(Date.now() / 1000),
  feedId: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  checks: { fresh: true, confidenceAcceptable: true, usable: true },
};

const NOT_A_PRESTOCKS_ASSET: PreStocksEvidence = {
  source: "PRESTOCKS",
  status: "UNAVAILABLE",
  symbol: null,
  name: null,
  mint: "SomeRandomMint111111111111111111111111111",
  endpoint: "https://prestocks.com/api/prestocks",
  reason: "mint_not_registered_as_known_prestocks_asset",
};

const NOT_A_PRESTOCKS_MINT = {
  status: "UNAVAILABLE",
  reason: "not_a_known_prestocks_mint",
};

function baseEvidence(overrides: Partial<EvidenceBundle>): EvidenceBundle {
  return {
    backstop: { safe: false, status: "UNKNOWN", reason: "registry_not_found" },
    prestocks: NOT_A_PRESTOCKS_ASSET,
    mainnetSolana: NOT_A_PRESTOCKS_MINT,
    pyth: NOT_APPLICABLE_PYTH,
    networks: { backstop: "devnet", prestocksAsset: null },
    ...overrides,
  };
}

test("VERIFIED when Backstop is safe on-chain and Pyth confirms a usable price", () => {
  const result = evaluateEvidence(
    baseEvidence({
      backstop: { safe: true, status: "VERIFIED", assetId: "TSLA" },
      pyth: OBSERVED_USABLE_PYTH,
    })
  );

  assert.equal(result.verdict, "VERIFIED");
  assert.equal(result.evidenceDisplay.backstop.display, "PASS");
  assert.equal(result.evidenceDisplay.pyth.display, "PASS");
});

test('WARNING when PreStocks + mainnet identity are observed but Backstop has no registry (the "OPENAI" case)', () => {
  const result = evaluateEvidence(
    baseEvidence({
      backstop: { safe: false, status: "UNKNOWN", reason: "registry_not_found" },
      prestocks: {
        source: "PRESTOCKS",
        status: "OBSERVED",
        symbol: "OPENAI",
        name: "OpenAI PreStocks",
        mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
        markPrice: "1045.55",
        tokenPrice: "1040.14",
        supply: "2826.5",
        endpoint: "https://prestocks.com/api/prestocks",
      },
      mainnetSolana: {
        status: "OBSERVED",
        expectedSymbol: "OPENAI",
        expectedName: "OpenAI PreStocks",
        expectedDecimals: 9,
        parsed: {
          decimals: 9,
          extensions: [
            {
              extension: "tokenMetadata",
              state: { symbol: "OPENAI", name: "OpenAI PreStocks" },
            },
          ],
        },
      },
      networks: { backstop: "devnet", prestocksAsset: "mainnet-beta" },
    })
  );

  assert.equal(result.verdict, "WARNING");
  assert.equal(result.evidenceDisplay.backstop.display, "NOT_APPLICABLE");
  assert.equal(result.evidenceDisplay.prestocks.display, "PASS");
});

test("DENY when Backstop reports the live supply exceeds attested backing", () => {
  const result = evaluateEvidence(
    baseEvidence({
      backstop: { safe: false, status: "UNDER_BACKED", assetId: "TSLA" },
    })
  );

  assert.equal(result.verdict, "DENY");
});

test("DENY on a symbol mismatch between PreStocks and on-chain token metadata", () => {
  const result = evaluateEvidence(
    baseEvidence({
      prestocks: {
        source: "PRESTOCKS",
        status: "OBSERVED",
        symbol: "OPENAI",
        name: "OpenAI PreStocks",
        mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
        markPrice: "1045.55",
        tokenPrice: null,
        supply: null,
        endpoint: "https://prestocks.com/api/prestocks",
      },
      mainnetSolana: {
        status: "OBSERVED",
        expectedSymbol: "OPENAI",
        expectedDecimals: 9,
        parsed: {
          decimals: 9,
          extensions: [
            {
              extension: "tokenMetadata",
              state: { symbol: "DEFINITELY_NOT_OPENAI", name: "OpenAI PreStocks" },
            },
          ],
        },
      },
      networks: { backstop: "devnet", prestocksAsset: "mainnet-beta" },
    })
  );

  assert.equal(result.verdict, "DENY");
  assert.match(result.reasons[0] ?? "", /symbol mismatch/i);
});

test("DENY on a decimals mismatch between the expected and on-chain mint", () => {
  const result = evaluateEvidence(
    baseEvidence({
      prestocks: {
        source: "PRESTOCKS",
        status: "OBSERVED",
        symbol: "OPENAI",
        name: "OpenAI PreStocks",
        mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
        markPrice: "1045.55",
        tokenPrice: null,
        supply: null,
        endpoint: "https://prestocks.com/api/prestocks",
      },
      mainnetSolana: {
        status: "OBSERVED",
        expectedSymbol: "OPENAI",
        expectedDecimals: 9,
        parsed: { decimals: 6 },
      },
      networks: { backstop: "devnet", prestocksAsset: "mainnet-beta" },
    })
  );

  assert.equal(result.verdict, "DENY");
  assert.match(result.reasons[0] ?? "", /decimals mismatch/i);
});

test("UNKNOWN (not WARNING) when no evidence source recognizes the asset at all", () => {
  const result = evaluateEvidence(baseEvidence({}));

  assert.equal(result.verdict, "UNKNOWN");
});

test("WARNING when a snapshot is stale, even with no other applicable evidence", () => {
  const result = evaluateEvidence(
    baseEvidence({
      backstop: { safe: false, status: "STALE", assetId: "TSLA" },
    })
  );

  assert.equal(result.verdict, "WARNING");
  assert.equal(result.evidenceDisplay.backstop.display, "FAIL");
});

test("evidenceDisplay marks Pyth NOT_APPLICABLE (not FAIL/UNKNOWN) for a private company", () => {
  const result = evaluateEvidence(baseEvidence({}));

  assert.equal(result.evidenceDisplay.pyth.display, "NOT_APPLICABLE");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESTOCKS_ASSETS,
  prestocksAssetForMint,
  prestocksAssetForSymbol,
  getPreStocksEvidence,
} from "./prestocks.js";

test("prestocksAssetForMint finds every known PreStocks asset by its mint address", () => {
  for (const asset of Object.values(PRESTOCKS_ASSETS)) {
    assert.deepEqual(prestocksAssetForMint(asset.mint), asset);
  }
});

test("prestocksAssetForMint returns undefined for a mint that isn't a known PreStocks asset", () => {
  assert.equal(
    prestocksAssetForMint("11111111111111111111111111111111111111111"),
    undefined
  );
});

test("prestocksAssetForSymbol is case-insensitive", () => {
  assert.deepEqual(prestocksAssetForSymbol("openai"), PRESTOCKS_ASSETS.OPENAI);
  assert.deepEqual(prestocksAssetForSymbol("OpenAI"), PRESTOCKS_ASSETS.OPENAI);
});

test("getPreStocksEvidence returns UNAVAILABLE for an unrecognized mint without making a network call", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = (async () => {
    called = true;
    throw new Error("fetch should not have been called");
  }) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(
      "11111111111111111111111111111111111111111"
    );

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "mint_not_registered_as_known_prestocks_asset");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence handles a malformed (non-array) upstream response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ not: "an array" }), { status: 200 })) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.ANTHROPIC.mint);

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "unexpected_response_shape");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence handles an empty upstream response body", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.OPENAI.mint);

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "empty_response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence handles invalid JSON in the upstream response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response("{not valid json", { status: 200 })) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.SPACEX.mint);

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "invalid_json_response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence handles a non-2xx upstream response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response("Service Unavailable", { status: 503 })) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.KALSHI.mint);

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "http_503");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence handles the asset being absent from an otherwise well-formed response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.NEURALINK.mint);

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "asset_missing_from_catalog_response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence parses a well-formed upstream response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          name: PRESTOCKS_ASSETS.ANTHROPIC.name,
          symbol: PRESTOCKS_ASSETS.ANTHROPIC.symbol,
          contract_address: PRESTOCKS_ASSETS.ANTHROPIC.mint,
          markPrice: 1048.1,
          tokenPrice: 1040.14,
          supply: 7381.86,
        },
      ]),
      { status: 200 }
    )) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.ANTHROPIC.mint);

    assert.equal(evidence.status, "OBSERVED");

    if (evidence.status === "OBSERVED") {
      assert.equal(evidence.markPrice, "1048.1");
      assert.equal(evidence.tokenPrice, "1040.14");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPreStocksEvidence rejects a non-finite mark price rather than passing it through", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          name: PRESTOCKS_ASSETS.FIGUREAI.name,
          symbol: PRESTOCKS_ASSETS.FIGUREAI.symbol,
          contract_address: PRESTOCKS_ASSETS.FIGUREAI.mint,
          markPrice: "not-a-number",
        },
      ]),
      { status: 200 }
    )) as typeof fetch;

  try {
    const evidence = await getPreStocksEvidence(PRESTOCKS_ASSETS.FIGUREAI.mint);

    assert.equal(evidence.status, "UNAVAILABLE");
    assert.equal(evidence.reason, "mark_price_invalid");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

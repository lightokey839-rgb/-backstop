import { test } from "node:test";
import assert from "node:assert/strict";

import { pythFeedForSymbol, getPythEvidence, PYTH_EQUITY_FEEDS } from "./pyth.js";

test("pythFeedForSymbol resolves known public-equity symbols, case-insensitively", () => {
  assert.equal(pythFeedForSymbol("TSLA"), PYTH_EQUITY_FEEDS.TSLA);
  assert.equal(pythFeedForSymbol("tsla"), PYTH_EQUITY_FEEDS.TSLA);
  assert.equal(pythFeedForSymbol("AAPL"), PYTH_EQUITY_FEEDS.AAPL);
  assert.equal(pythFeedForSymbol("NVDA"), PYTH_EQUITY_FEEDS.NVDA);
});

test("pythFeedForSymbol returns undefined for private PreStocks companies", () => {
  // These must never resolve to a feed: no public stock exists to quote.
  assert.equal(pythFeedForSymbol("ANTHROPIC"), undefined);
  assert.equal(pythFeedForSymbol("OPENAI"), undefined);
  assert.equal(pythFeedForSymbol("SPACEX"), undefined);
  assert.equal(pythFeedForSymbol("ANDURIL"), undefined);
});

test("pythFeedForSymbol returns undefined for an unrecognized symbol", () => {
  assert.equal(pythFeedForSymbol("NOT_A_REAL_TICKER"), undefined);
});

test("getPythEvidence reports NOT_APPLICABLE (not UNAVAILABLE) for a symbol with no configured feed", async () => {
  const evidence = await getPythEvidence("ANTHROPIC");

  assert.equal(evidence.status, "NOT_APPLICABLE");
  assert.equal(evidence.feedId, null);
});

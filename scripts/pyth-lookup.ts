/**
 * Small Pyth Hermes debugging utility. Consolidates what were two
 * unwired, ad hoc scripts at the repo root (test-pyth.ts,
 * test-pyth-price.ts) into one, using the same HermesClient construction
 * as the real integration (backend/integrations/pyth.ts) rather than a
 * separate, inconsistent auth pattern.
 *
 * As of the August 26, 2026 Pyth Core upgrade, Hermes requires an API key
 * for sustained use -- set PYTH_API_KEY or expect empty/rejected results.
 *
 * Usage:
 *   tsx scripts/pyth-lookup.ts search TSLA        # list feeds matching "TSLA"
 *   tsx scripts/pyth-lookup.ts price TSLA          # latest price for a known symbol
 *   tsx scripts/pyth-lookup.ts price 0x16da...32f1 # latest price for a raw feed ID
 */
import { HermesClient } from "@pythnetwork/hermes-client";

import { pythFeedForSymbol } from "../backend/integrations/pyth.js";

function createClient(): HermesClient {
  const url = process.env.PYTH_HERMES_URL?.trim() || "https://pyth.dourolabs.app/hermes";
  const apiKey = process.env.PYTH_API_KEY?.trim();

  return new HermesClient(url, apiKey ? { accessToken: apiKey } : undefined);
}

async function search(query: string | undefined): Promise<void> {
  const client = createClient();
  const feeds = await client.getPriceFeeds(query ? { query } : undefined);

  console.log(`Matched ${feeds.length} feed(s)${query ? ` for "${query}"` : ""}.\n`);

  for (const feed of feeds.slice(0, 20)) {
    console.log(JSON.stringify(feed, null, 2));
  }

  if (feeds.length > 20) {
    console.log(`\n...and ${feeds.length - 20} more (narrow your query to see them).`);
  }
}

async function price(symbolOrFeedId: string): Promise<void> {
  const looksLikeFeedId = /^(0x)?[0-9a-fA-F]{64}$/.test(symbolOrFeedId);
  const feedId = looksLikeFeedId
    ? symbolOrFeedId.replace(/^0x/, "")
    : pythFeedForSymbol(symbolOrFeedId);

  if (!feedId) {
    console.error(
      `No known Pyth feed for "${symbolOrFeedId}". Known symbols: TSLA, AAPL, NVDA. Pass a raw 64-hex-char feed ID instead for anything else.`
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient();
  const result = await client.getLatestPriceUpdates([feedId], { parsed: true });

  console.log(JSON.stringify(result.parsed?.[0] ?? { note: "no data returned" }, null, 2));
}

async function main() {
  const [command, arg] = process.argv.slice(2);

  if (command === "search") {
    await search(arg);
  } else if (command === "price" && arg) {
    await price(arg);
  } else {
    console.log("Usage:");
    console.log("  tsx scripts/pyth-lookup.ts search [query]");
    console.log("  tsx scripts/pyth-lookup.ts price <symbol|feedId>");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Pyth lookup failed:");
  console.error(error);
  process.exitCode = 1;
});

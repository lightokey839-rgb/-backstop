import { HermesClient } from "@pythnetwork/hermes-client";

const HERMES_URL =
  process.env.PYTH_HERMES_URL?.trim() ||
  "https://pyth.dourolabs.app/hermes";

const DEFAULT_PYTH_MAX_AGE_SECONDS = 300;
const DEFAULT_PYTH_MAX_CONFIDENCE_BPS = 100;
const DEFAULT_PYTH_FETCH_TIMEOUT_MS = 8_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return value;
}

const PYTH_MAX_AGE_SECONDS = envNumber(
  "PYTH_MAX_AGE_SECONDS",
  DEFAULT_PYTH_MAX_AGE_SECONDS
);

const PYTH_MAX_CONFIDENCE_BPS = envNumber(
  "PYTH_MAX_CONFIDENCE_BPS",
  DEFAULT_PYTH_MAX_CONFIDENCE_BPS
);

const PYTH_FETCH_TIMEOUT_MS = envNumber(
  "PYTH_FETCH_TIMEOUT_MS",
  DEFAULT_PYTH_FETCH_TIMEOUT_MS
);

// Public equity price feeds Backstop knows how to cross-check. TSLA/USD's
// feed ID was verified against Pyth's own Insights page
// (insights.pyth.network/price-feeds/Equity.US.TSLA%2FUSD ->
// 0x16da...32f1) on 2026-09-22. AAPL and NVDA were not independently
// re-verified to the same standard in this pass -- spot-check them against
// https://docs.pyth.network/price-feeds/pro/price-feed-ids before relying
// on them for anything beyond this demo. A wrong ID fails safe: Hermes
// returns "price feed not found" rather than a plausible-looking wrong
// price, so an error here is a broken lookup, not a silent
// misattribution.
//
// This module intentionally has no entries for ANTHROPIC, OPENAI, or
// SPACEX: those are private companies with no listed public stock, so no
// "Equity.US.*" feed can legitimately exist for them. (Pyth separately
// launched Pyth.Index.ANTHROPIC/USD and Pyth.Index.OPENAI/USD on
// 2026-09-17 as an "informational, indicative" private-market index
// product, explicitly distinct from Pyth Pro / Hermes equity feeds and not
// verified here to have the same access model -- see
// docs/PRESTOCKS_INTEGRATION.md for why this module does not wire that up
// yet. Pyth also lists unrelated feeds that merely contain these
// companies' names, e.g. a Binance perpetual-futures funding rate
// FundingRate.Binance.ANTHROPIC/USDT -- that is a crypto derivative, not
// an equity reference price, and is never an appropriate substitute here.)
export const PYTH_EQUITY_FEEDS = {
  TSLA: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
} as const;

export type PythEvidence =
  | {
      source: "PYTH";
      status: "OBSERVED";
      price: string;
      confidence: string;
      exponent: number;
      publishTime: number;
      feedId: string;
      checks: {
        fresh: boolean;
        confidenceAcceptable: boolean;
        usable: boolean;
      };
    }
  | {
      source: "PYTH";
      status: "UNAVAILABLE";
      feedId: string;
      reason: string;
    }
  | {
      source: "PYTH";
      status: "NOT_APPLICABLE";
      feedId: null;
      reason: string;
    };

function normalizeFeedId(feedId: string): string {
  return feedId.startsWith("0x")
    ? feedId.slice(2)
    : feedId;
}

function createHermesClient(): HermesClient {
  const apiKey = process.env.PYTH_API_KEY?.trim();

  return new HermesClient(
    HERMES_URL,
    apiKey
      ? {
          accessToken: apiKey,
        }
      : undefined
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * As of the August 26, 2026 Pyth Core upgrade, Hermes requires an API key
 * for sustained use; unauthenticated requests are rate-limited or refused.
 * Set PYTH_API_KEY, or expect Pyth evidence to come back UNAVAILABLE.
 */
function classifyHermesError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "timeout") {
    return "timeout";
  }

  console.error("Pyth Hermes request failed:", error);

  if (/401|unauthoriz/i.test(message)) {
    return "unauthorized_missing_or_invalid_api_key";
  }

  if (/429|rate.?limit/i.test(message)) {
    return "rate_limited";
  }

  return "network_error";
}

async function getPythPriceRaw(
  feedId: string
): Promise<PythEvidence> {
  const normalizedFeedId = normalizeFeedId(feedId);

  try {
    const hermes = createHermesClient();

    const updates = await withTimeout(
      hermes.getLatestPriceUpdates([normalizedFeedId], { parsed: true }),
      PYTH_FETCH_TIMEOUT_MS
    );

    const parsed = updates.parsed?.[0];

    if (!parsed) {
      return {
        source: "PYTH",
        status: "UNAVAILABLE",
        feedId: normalizedFeedId,
        reason: "price_feed_not_found",
      };
    }

    const priceData = parsed.price;

    if (!priceData) {
      return {
        source: "PYTH",
        status: "UNAVAILABLE",
        feedId: normalizedFeedId,
        reason: "price_data_missing",
      };
    }

    const publishTime = priceData.publish_time;
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = now - publishTime;

    const fresh =
      ageSeconds >= 0 &&
      ageSeconds <= PYTH_MAX_AGE_SECONDS;

    let confidenceAcceptable = false;

    try {
      const price = BigInt(priceData.price);
      const confidence = BigInt(priceData.conf);

      confidenceAcceptable =
        price > 0n &&
        confidence >= 0n &&
        confidence * 10000n <=
          price * BigInt(Math.round(PYTH_MAX_CONFIDENCE_BPS));
    } catch {
      confidenceAcceptable = false;
    }

    return {
      source: "PYTH",
      status: "OBSERVED",
      feedId: normalizedFeedId,
      price: priceData.price,
      confidence: priceData.conf,
      exponent: priceData.expo,
      publishTime,
      checks: {
        fresh,
        confidenceAcceptable,
        usable: fresh && confidenceAcceptable,
      },
    };
  } catch (error) {
    return {
      source: "PYTH",
      status: "UNAVAILABLE",
      feedId: normalizedFeedId,
      reason: classifyHermesError(error),
    };
  }
}

export function pythFeedForSymbol(
  symbol: string
): string | undefined {
  const normalizedSymbol = symbol.toUpperCase();

  return PYTH_EQUITY_FEEDS[
    normalizedSymbol as keyof typeof PYTH_EQUITY_FEEDS
  ];
}

export async function getPythEvidence(
  assetSymbol: string
): Promise<PythEvidence> {
  const normalizedSymbol = assetSymbol.toUpperCase();
  const feedId = pythFeedForSymbol(normalizedSymbol);

  if (!feedId) {
    // Structurally absent, not a failed lookup: either this symbol has no
    // public listing (e.g. a private company) so no equity feed can exist,
    // or Backstop simply hasn't been configured with one yet. Either way
    // this is a NOT_APPLICABLE evidence source, not an UNKNOWN/failed one.
    return {
      source: "PYTH",
      status: "NOT_APPLICABLE",
      feedId: null,
      reason: `No public-equity Pyth feed applies to ${normalizedSymbol}.`,
    };
  }

  return getPythPriceRaw(feedId);
}

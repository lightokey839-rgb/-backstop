/**
 * PreStocks integration.
 *
 * PreStocks (https://prestocks.com) issues Solana Token-2022 tokens that
 * track the value of Special Purpose Vehicles (SPVs) holding equity in
 * pre-IPO private companies. PreStocks' own materials describe the tokens
 * as "backed 1:1 by SPV exposure" -- that is PreStocks' claim about itself,
 * not something this module (or Backstop generally) independently proves.
 * PreStocks tokens do not grant legal ownership, voting rights, dividends,
 * or information rights in the referenced company, and are not endorsed by
 * the companies they track.
 *
 * What this module actually does: fetch PreStocks' own public catalogue
 * (identity, mark price, supply) for the mints Backstop knows about, and
 * report it as observed evidence. It does NOT verify SPV backing -- nobody
 * outside PreStocks and its custodian can, without a published, signed
 * attestation feed, which PreStocks does not currently expose. See
 * `evaluateEvidence` in server.ts for how this evidence is (and is not)
 * used in an overall verdict.
 *
 * Endpoint verified live on 2026-09-22: a real GET to
 * https://prestocks.com/api/prestocks returns a JSON array covering all
 * PreStocks tokens (no query params, no per-symbol filtering). Each entry
 * looks like:
 *   {
 *     "name": "Anthropic PreStocks", "symbol": "ANTHROPIC",
 *     "contract_address": "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
 *     "markPrice": 1048.10, "markValuation": 1717154427917,
 *     "tokenPrice": 1040.14, "impliedValuation": 1704113773967,
 *     "supply": 7381.865568658, "image": "...", "external_url": "..."
 *   }
 * `markPrice` is PreStocks' own issuer-published indicative/fair-value
 * price. `tokenPrice` is closer to a live secondary-market price (still
 * issuer-reported, not the same as an executable DEX quote). Third-party
 * PreStocks tooling built for the same hackathon independently confirms
 * this shape and endpoint, and the contract_address values below were
 * cross-checked against that live response.
 *
 * PreStocks mints reportedly use the Token-2022 "Scaled UI Amount"
 * extension (issuer-adjustable display multiplier). The `supply` figure
 * above is therefore a UI-scaled amount, not necessarily raw base units
 * divided by 10^decimals -- anything that reconciles PreStocks supply
 * against a raw on-chain `mint.supply` read must account for that
 * multiplier explicitly. Backstop does not currently do this (see
 * docs/PRESTOCKS_INTEGRATION.md).
 */

const PRESTOCKS_CATALOG_URL =
  process.env.PRESTOCKS_CATALOG_URL?.trim() ||
  "https://prestocks.com/api/prestocks";

const PRESTOCKS_MAINNET_RPC =
  process.env.PRESTOCKS_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

const FETCH_TIMEOUT_MS = envInt("PRESTOCKS_FETCH_TIMEOUT_MS", 8_000);

// Successful catalogue fetches are cached briefly in-memory so that a
// dashboard checking several assets in a row (or a user hitting refresh)
// doesn't hammer PreStocks' production API with duplicate requests.
const CATALOG_CACHE_TTL_MS = envInt("PRESTOCKS_CATALOG_CACHE_MS", 15_000);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Known PreStocks assets. Every mint address below was read directly from
 * a live response from PRESTOCKS_CATALOG_URL -- none are guessed or
 * derived. This is the full roster PreStocks published at verification
 * time (8 tokens); PreStocks may add more over time, in which case this
 * list will lag until updated.
 */
export const PRESTOCKS_ASSETS = {
  ANDURIL: {
    symbol: "ANDURIL",
    name: "Anduril PreStocks",
    mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/anduril",
  },
  ANTHROPIC: {
    symbol: "ANTHROPIC",
    name: "Anthropic PreStocks",
    mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/anthropic",
  },
  FIGUREAI: {
    symbol: "FIGUREAI",
    name: "Figure AI PreStocks",
    mint: "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/figureai",
  },
  KALSHI: {
    symbol: "KALSHI",
    name: "Kalshi PreStocks",
    mint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/kalshi",
  },
  NEURALINK: {
    symbol: "NEURALINK",
    name: "Neuralink PreStocks",
    mint: "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/neuralink",
  },
  OPENAI: {
    symbol: "OPENAI",
    name: "OpenAI PreStocks",
    mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/openai",
  },
  POLYMARKET: {
    symbol: "POLYMARKET",
    name: "Polymarket PreStocks",
    mint: "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/polymarket",
  },
  SPACEX: {
    symbol: "SPACEX",
    name: "SpaceX PreStocks",
    mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
    decimals: 9,
    externalUrl: "https://www.prestocks.com/spacex",
  },
} as const;

export type PreStocksAsset =
  (typeof PRESTOCKS_ASSETS)[keyof typeof PRESTOCKS_ASSETS];

export type PreStocksEvidence =
  | {
      source: "PRESTOCKS";
      status: "OBSERVED";
      symbol: string;
      name: string;
      mint: string;
      markPrice: string;
      tokenPrice: string | null;
      supply: string | null;
      endpoint: string;
    }
  | {
      source: "PRESTOCKS";
      status: "UNAVAILABLE";
      symbol: string | null;
      name: string | null;
      mint: string;
      endpoint: string;
      reason: string;
    };

type CatalogEntry = {
  name?: unknown;
  symbol?: unknown;
  contract_address?: unknown;
  markPrice?: unknown;
  tokenPrice?: unknown;
  supply?: unknown;
};

let catalogCache: { fetchedAt: number; entries: CatalogEntry[] } | null = null;
let inFlightFetch: Promise<CatalogEntry[]> | null = null;

function assetForMint(mint: string): PreStocksAsset | undefined {
  return Object.values(PRESTOCKS_ASSETS).find((asset) => asset.mint === mint);
}

export function prestocksAssetForMint(mint: string): PreStocksAsset | undefined {
  return assetForMint(mint);
}

export function prestocksAssetForSymbol(symbol: string): PreStocksAsset | undefined {
  const normalized = symbol.toUpperCase();

  return Object.values(PRESTOCKS_ASSETS).find(
    (asset) => asset.symbol === normalized
  );
}

async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * Fetch and cache the full PreStocks catalogue. A single in-flight fetch
 * is shared across concurrent callers so a burst of requests (e.g. a
 * dashboard loading several cards at once) triggers one upstream call, not
 * one per card.
 */
async function fetchCatalog(): Promise<CatalogEntry[]> {
  const now = Date.now();

  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.entries;
  }

  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async () => {
    const response = await fetchWithTimeout(PRESTOCKS_CATALOG_URL);

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    const text = await response.text();

    if (!text.trim()) {
      throw new Error("empty_response");
    }

    let data: unknown;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("invalid_json_response");
    }

    if (!Array.isArray(data)) {
      throw new Error("unexpected_response_shape");
    }

    const entries = data as CatalogEntry[];
    catalogCache = { fetchedAt: Date.now(), entries };

    return entries;
  })();

  try {
    return await inFlightFetch;
  } finally {
    inFlightFetch = null;
  }
}

function toFiniteNumberString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return value;
  }

  return null;
}

/**
 * Classify a raised error into one of a small set of stable reason codes.
 * The raw error (which can contain internal detail, e.g. stack traces or
 * upstream error bodies) is logged server-side only -- API consumers get a
 * safe, stable code.
 */
function classifyFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof Error && error.name === "TimeoutError") {
    return "timeout";
  }

  if (/^http_\d+$/.test(message)) {
    return message;
  }

  if (
    message === "empty_response" ||
    message === "invalid_json_response" ||
    message === "unexpected_response_shape"
  ) {
    return message;
  }

  console.error("PreStocks catalogue fetch failed:", error);

  return "network_error";
}

export async function getPreStocksEvidence(mint: string): Promise<PreStocksEvidence> {
  const asset = assetForMint(mint);

  if (!asset) {
    return {
      source: "PRESTOCKS",
      status: "UNAVAILABLE",
      symbol: null,
      name: null,
      mint,
      endpoint: PRESTOCKS_CATALOG_URL,
      reason: "mint_not_registered_as_known_prestocks_asset",
    };
  }

  let entries: CatalogEntry[];

  try {
    entries = await fetchCatalog();
  } catch (error) {
    return {
      source: "PRESTOCKS",
      status: "UNAVAILABLE",
      symbol: asset.symbol,
      name: asset.name,
      mint: asset.mint,
      endpoint: PRESTOCKS_CATALOG_URL,
      reason: classifyFetchError(error),
    };
  }

  const entry = entries.find(
    (candidate) =>
      typeof candidate.contract_address === "string" &&
      candidate.contract_address === asset.mint
  );

  if (!entry) {
    return {
      source: "PRESTOCKS",
      status: "UNAVAILABLE",
      symbol: asset.symbol,
      name: asset.name,
      mint: asset.mint,
      endpoint: PRESTOCKS_CATALOG_URL,
      reason: "asset_missing_from_catalog_response",
    };
  }

  const markPrice = toFiniteNumberString(entry.markPrice);

  if (markPrice === null) {
    return {
      source: "PRESTOCKS",
      status: "UNAVAILABLE",
      symbol: asset.symbol,
      name: asset.name,
      mint: asset.mint,
      endpoint: PRESTOCKS_CATALOG_URL,
      reason: "mark_price_invalid",
    };
  }

  return {
    source: "PRESTOCKS",
    status: "OBSERVED",
    symbol: asset.symbol,
    name: asset.name,
    mint: asset.mint,
    markPrice,
    tokenPrice: toFiniteNumberString(entry.tokenPrice),
    supply: toFiniteNumberString(entry.supply),
    endpoint: PRESTOCKS_CATALOG_URL,
  };
}

export { PRESTOCKS_MAINNET_RPC, PRESTOCKS_CATALOG_URL };

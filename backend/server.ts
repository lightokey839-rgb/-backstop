import http from "node:http";
import { readFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";

import { getPythEvidence } from "./integrations/pyth.js";
import type { PythEvidence } from "./integrations/pyth.js";

import {
  getPreStocksEvidence,
  prestocksAssetForMint,
  PRESTOCKS_ASSETS,
  PRESTOCKS_MAINNET_RPC,
} from "./integrations/prestocks.js";
import type { PreStocksEvidence } from "./integrations/prestocks.js";

import { PROGRAM_ID, readAssetHealth, withRpcRetry } from "./onchain.js";

const PORT = Number(process.env.PORT ?? 8787);

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// The devnet mint created by `npm run devnet:mint` (scripts/day2-real-mint.ts)
// for the TSLA regression/demo path. Overridable because a fresh run of
// that script mints a new address -- this is demo convenience, not a
// protocol constant (unlike PROGRAM_ID, which is fixed by the deployed
// program).
const DEMO_TSLA_MINT =
  process.env.BACKSTOP_DEMO_MINT?.trim() ||
  "AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR";

const connection = new Connection(RPC_URL, "confirmed");
const mainnetConnection = new Connection(PRESTOCKS_MAINNET_RPC, "confirmed");

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);

  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });

  res.end(payload);
}

// ---------------------------------------------------------------------
// Verdict / evidence normalization
// ---------------------------------------------------------------------
//
// Every evidence source below is independently classified into one of
// four states before it ever reaches the dashboard:
//   PASS           the check ran and came back healthy
//   FAIL           the check ran and came back unhealthy
//   UNKNOWN        the check should apply here, but could not be
//                  completed right now (network/API failure, or nothing
//                  registered yet) -- this *could* change to PASS/FAIL
//   NOT_APPLICABLE the check structurally does not apply to this asset
//                  (e.g. no public equity feed can exist for a private
//                  company; a mainnet-only mint has no devnet registry
//                  because Backstop's program isn't deployed there)
//
// The distinction between UNKNOWN and NOT_APPLICABLE matters: an absent
// Pyth feed for a private pre-IPO company is not a bug or an outage, and
// showing it the same way as a real failure would make a healthy system
// look broken.

export type DisplayStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";

export type EvidenceDisplay = {
  display: DisplayStatus;
  detail: string;
};

export type VerificationVerdict = "VERIFIED" | "WARNING" | "DENY" | "UNKNOWN";

export type VerificationResult = {
  verdict: VerificationVerdict;
  reasons: string[];
  evidenceDisplay: {
    backstop: EvidenceDisplay;
    prestocks: EvidenceDisplay;
    mainnetSolana: EvidenceDisplay;
    pyth: EvidenceDisplay;
  };
};

export type BackstopEvidence = {
  safe: boolean;
  status: string;
  assetId?: string;
  reason?: string;
};

export type MainnetSolanaEvidence = {
  status: string;
  reason?: string;
  expectedSymbol?: string;
  expectedName?: string;
  expectedDecimals?: number;
  parsed?: Record<string, unknown> | null;
};

export type EvidenceBundle = {
  backstop: BackstopEvidence;
  prestocks: PreStocksEvidence;
  mainnetSolana: MainnetSolanaEvidence;
  pyth: PythEvidence;
  networks: {
    backstop: string;
    prestocksAsset: string | null;
  };
};

function backstopDisplay(evidence: EvidenceBundle): EvidenceDisplay {
  const { backstop, networks } = evidence;

  if (backstop.safe) {
    return {
      display: "PASS",
      detail:
        "On-chain registration, freshness, and supply-vs-backing checks all pass.",
    };
  }

  if (backstop.status === "UNDER_BACKED") {
    return {
      display: "FAIL",
      detail: "Live on-chain supply exceeds the attested backing.",
    };
  }

  if (backstop.status === "STALE") {
    return {
      display: "FAIL",
      detail: "The latest snapshot has expired.",
    };
  }

  if (networks.prestocksAsset === "mainnet-beta") {
    return {
      display: "NOT_APPLICABLE",
      detail:
        "Backstop's registry/snapshot program is deployed on devnet; this asset lives on mainnet, so the on-chain check does not apply unless/until Backstop is deployed there for this asset.",
    };
  }

  return {
    display: "UNKNOWN",
    detail: backstop.reason
      ? `No usable Backstop registry/snapshot yet (${backstop.reason}).`
      : "No usable Backstop registry/snapshot yet for this asset.",
  };
}

function prestocksDisplay(prestocks: PreStocksEvidence): EvidenceDisplay {
  if (prestocks.status === "OBSERVED") {
    return {
      display: "PASS",
      detail:
        "PreStocks' own published identity and mark price were retrieved.",
    };
  }

  if (prestocks.reason === "mint_not_registered_as_known_prestocks_asset") {
    return {
      display: "NOT_APPLICABLE",
      detail: "This mint is not one of PreStocks' published tokens.",
    };
  }

  return {
    display: "UNKNOWN",
    detail: `PreStocks catalogue lookup failed (${prestocks.reason}).`,
  };
}

function mainnetSolanaDisplay(
  mainnetSolana: MainnetSolanaEvidence
): EvidenceDisplay {
  if (mainnetSolana.status === "OBSERVED") {
    return {
      display: "PASS",
      detail:
        "The mint exists on Solana mainnet with the expected Token-2022 identity.",
    };
  }

  if (
    mainnetSolana.reason === "not_a_known_prestocks_mint" ||
    mainnetSolana.reason === "mint_not_registered_as_known_prestocks_asset"
  ) {
    return {
      display: "NOT_APPLICABLE",
      detail:
        "This mint is not a known PreStocks asset, so there is no mainnet identity to confirm.",
    };
  }

  return {
    display: "UNKNOWN",
    detail: mainnetSolana.reason
      ? `Mainnet mint lookup failed (${mainnetSolana.reason}).`
      : "Mainnet mint lookup failed.",
  };
}

function pythDisplay(pyth: PythEvidence): EvidenceDisplay {
  if (pyth.status === "NOT_APPLICABLE") {
    return { display: "NOT_APPLICABLE", detail: pyth.reason };
  }

  if (pyth.status === "OBSERVED") {
    if (pyth.checks.usable) {
      return {
        display: "PASS",
        detail: "Pyth price observed and passed freshness/confidence checks.",
      };
    }

    return {
      display: "FAIL",
      detail: !pyth.checks.fresh
        ? "Pyth price is stale."
        : "Pyth price confidence interval exceeds the configured threshold.",
    };
  }

  return {
    display: "UNKNOWN",
    detail: `Pyth lookup failed (${pyth.reason}).`,
  };
}

export function evaluateEvidence(evidence: EvidenceBundle): VerificationResult {
  const evidenceDisplay = {
    backstop: backstopDisplay(evidence),
    prestocks: prestocksDisplay(evidence.prestocks),
    mainnetSolana: mainnetSolanaDisplay(evidence.mainnetSolana),
    pyth: pythDisplay(evidence.pyth),
  };

  const reasons: string[] = [];

  const bothObserved =
    evidence.prestocks.status === "OBSERVED" &&
    evidence.mainnetSolana.status === "OBSERVED";

  if (bothObserved) {
    const extensions = evidence.mainnetSolana.parsed?.extensions;
    const observedDecimals = evidence.mainnetSolana.parsed?.decimals;

    if (
      typeof observedDecimals === "number" &&
      typeof evidence.mainnetSolana.expectedDecimals === "number" &&
      observedDecimals !== evidence.mainnetSolana.expectedDecimals
    ) {
      return {
        verdict: "DENY",
        reasons: [
          `Decimals mismatch: PreStocks/Backstop expect ${evidence.mainnetSolana.expectedDecimals}, but Solana mint reports ${observedDecimals}.`,
        ],
        evidenceDisplay,
      };
    }

    if (Array.isArray(extensions)) {
      const metadataExtension = extensions.find(
        (extension) =>
          extension &&
          typeof extension === "object" &&
          "extension" in extension &&
          extension.extension === "tokenMetadata"
      ) as { state?: { symbol?: unknown; name?: unknown } } | undefined;

      const observedSymbol = metadataExtension?.state?.symbol;
      const observedName = metadataExtension?.state?.name;

      if (
        typeof observedSymbol === "string" &&
        observedSymbol !== evidence.prestocks.symbol
      ) {
        return {
          verdict: "DENY",
          reasons: [
            `Token symbol mismatch: PreStocks expects ${evidence.prestocks.symbol}, but Solana metadata reports ${observedSymbol}.`,
          ],
          evidenceDisplay,
        };
      }

      if (
        typeof observedName === "string" &&
        observedName !== evidence.prestocks.name
      ) {
        return {
          verdict: "DENY",
          reasons: [
            `Token name mismatch: PreStocks expects ${evidence.prestocks.name}, but Solana metadata reports ${observedName}.`,
          ],
          evidenceDisplay,
        };
      }
    }
  }

  if (evidence.backstop.status === "STALE") {
    reasons.push("Backstop snapshot is stale.");
  } else if (evidence.backstop.status === "UNDER_BACKED") {
    return {
      verdict: "DENY",
      reasons: [
        "Backstop reports the live supply exceeds the attested backing.",
      ],
      evidenceDisplay,
    };
  } else if (evidence.backstop.safe) {
    reasons.push("Backstop on-chain checks are healthy.");
  } else if (evidence.backstop.status === "UNKNOWN") {
    reasons.push("Backstop has no usable registry/snapshot for this asset.");
  }

  if (evidence.prestocks.status === "OBSERVED") {
    reasons.push("PreStocks identity and market data were observed.");
  } else if (
    evidence.prestocks.status === "UNAVAILABLE" &&
    evidence.prestocks.reason ===
      "mint_not_registered_as_known_prestocks_asset"
  ) {
    reasons.push(
      "PreStocks evidence is not applicable: this mint is not a known PreStocks asset."
    );
  } else {
    reasons.push("PreStocks evidence is unavailable.");
  }

  if (evidence.mainnetSolana.status === "OBSERVED") {
    reasons.push("Solana mainnet confirms the known PreStocks mint exists.");
  }

  if (evidence.pyth.status === "OBSERVED") {
    if (evidence.pyth.checks.usable) {
      reasons.push(
        "Pyth market-price evidence was observed and passed freshness/confidence checks."
      );
    } else {
      if (!evidence.pyth.checks.fresh) {
        reasons.push("Pyth market-price evidence is stale.");
      }

      if (!evidence.pyth.checks.confidenceAcceptable) {
        reasons.push(
          "Pyth market-price evidence confidence exceeds the configured threshold."
        );
      }
    }
  } else if (evidence.pyth.status === "NOT_APPLICABLE") {
    reasons.push(evidence.pyth.reason);
  } else {
    reasons.push("Pyth price evidence is unavailable for this asset.");
  }

  if (bothObserved) {
    return {
      verdict: "WARNING",
      reasons,
      evidenceDisplay,
    };
  }

  if (
    evidence.backstop.safe &&
    evidence.pyth.status === "OBSERVED" &&
    evidence.pyth.checks.usable
  ) {
    return {
      verdict: "VERIFIED",
      reasons,
      evidenceDisplay,
    };
  }

  // A WARNING means real, applicable evidence was found but didn't clear
  // the bar for VERIFIED -- e.g. a genuine PreStocks/mainnet identity
  // match with no Backstop registry yet, or a stale snapshot. That is
  // different from an asset no evidence source recognizes at all (every
  // source NOT_APPLICABLE or simply never-checked UNKNOWN), which should
  // surface as UNKNOWN rather than implying something concerning was
  // found. `reasons` alone doesn't distinguish these, since a
  // NOT_APPLICABLE source still contributes an explanatory reason string
  // -- so gate on whether any source actually resolved to PASS or FAIL.
  const hasConcreteEvidence = Object.values(evidenceDisplay).some(
    (item) => item.display === "PASS" || item.display === "FAIL"
  );

  if (hasConcreteEvidence && reasons.length > 0) {
    return {
      verdict: "WARNING",
      reasons,
      evidenceDisplay,
    };
  }

  return {
    verdict: "UNKNOWN",
    reasons:
      reasons.length > 0
        ? reasons
        : ["No evidence source recognizes or has data for this asset."],
    evidenceDisplay,
  };
}

// ---------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------

async function getAsset(mintText: string) {
  const mint = new PublicKey(mintText);

  const account = await withRpcRetry("get mint account", () =>
    connection.getParsedAccountInfo(mint)
  );

  if (!account.value) {
    throw new Error("mint_account_not_found");
  }

  return {
    mint: mint.toBase58(),
    network: "devnet",
    owner: account.value.owner.toBase58(),
    account: account.value,
  };
}

async function getHealth(mintText: string) {
  return readAssetHealth(connection, new PublicKey(mintText));
}

/**
 * Best-effort mapping from an on-chain Backstop `asset_id` string to a
 * symbol worth trying against Pyth. Deliberately not a hand-maintained
 * whitelist: `pythFeedForSymbol` (in integrations/pyth.ts) is the actual
 * source of truth for which symbols have a real feed, and safely returns
 * "not applicable" for anything else. Keeping a second, separate list
 * here in sync with that one is a maintenance hazard for no real safety
 * benefit.
 */
function symbolFromAssetId(assetId: string | undefined): string | undefined {
  const trimmed = assetId?.trim();

  return trimmed ? trimmed.toUpperCase() : undefined;
}

async function getMainnetMintEvidence(mintText: string) {
  const asset = prestocksAssetForMint(mintText);

  if (!asset) {
    return {
      status: "UNAVAILABLE",
      reason: "mint_not_registered_as_known_prestocks_asset",
    };
  }

  const mint = new PublicKey(mintText);

  // Every RPC call below can fail for reasons that have nothing to do
  // with this mint (upstream outage, rate limiting, network partition).
  // That must degrade this one evidence source to UNAVAILABLE, not crash
  // the whole /evidence response -- the other three sources (Backstop,
  // PreStocks, Pyth) are independently useful even if this one is down.
  let account: Awaited<ReturnType<typeof mainnetConnection.getParsedAccountInfo>>;

  try {
    account = await withRpcRetry("get mainnet mint account", () =>
      mainnetConnection.getParsedAccountInfo(mint)
    );
  } catch (error) {
    console.error("Mainnet mint lookup failed:", error);

    return {
      status: "UNAVAILABLE",
      reason: "mainnet_rpc_unreachable",
      mint: mint.toBase58(),
    };
  }

  if (!account.value) {
    return {
      status: "UNAVAILABLE",
      reason: "mainnet_mint_account_not_found",
      mint: mint.toBase58(),
    };
  }

  const parsed = account.value.data;

  let parsedInfo: Record<string, unknown> | undefined;
  let parsedType: string | undefined;

  if ("parsed" in parsed && parsed.parsed && typeof parsed.parsed === "object") {
    const parsedValue = parsed.parsed as { type?: unknown; info?: unknown };

    parsedType =
      typeof parsedValue.type === "string" ? parsedValue.type : undefined;

    if (parsedValue.info && typeof parsedValue.info === "object") {
      parsedInfo = parsedValue.info as Record<string, unknown>;
    }
  }

  return {
    status: "OBSERVED",
    network: "mainnet-beta",
    owner: account.value.owner.toBase58(),
    program:
      account.value.owner.toBase58() ===
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        ? "spl-token-2022"
        : "other",
    type: parsedType ?? null,
    mint: mint.toBase58(),
    expectedSymbol: asset.symbol,
    expectedName: asset.name,
    expectedDecimals: asset.decimals,
    parsed: parsedInfo ?? null,
  };
}

async function getEvidence(mintText: string) {
  const prestocksAsset = prestocksAssetForMint(mintText);

  let backstop: BackstopEvidence;

  try {
    backstop = await getHealth(mintText);
  } catch {
    backstop = {
      safe: false,
      status: "UNKNOWN",
      reason: "backstop_health_unavailable",
    };
  }

  const prestocks = await getPreStocksEvidence(mintText);

  const mainnetSolana: MainnetSolanaEvidence = prestocksAsset
    ? await getMainnetMintEvidence(mintText)
    : {
        status: "UNAVAILABLE",
        reason: "not_a_known_prestocks_mint",
      };

  let symbol: string | undefined = prestocksAsset?.symbol;

  if (!symbol) {
    symbol = symbolFromAssetId(backstop.assetId);
  }

  const pyth: PythEvidence = symbol
    ? await getPythEvidence(symbol)
    : {
        source: "PYTH",
        status: "NOT_APPLICABLE",
        feedId: null,
        reason: "No symbol mapping available for this asset.",
      };

  const evidence: EvidenceBundle = {
    backstop,
    prestocks,
    mainnetSolana,
    pyth,
    networks: {
      backstop: "devnet",
      prestocksAsset: prestocksAsset ? "mainnet-beta" : null,
    },
  };

  return {
    mint: mintText,
    assetId: prestocksAsset?.symbol ?? backstop.assetId ?? null,
    symbol: symbol ?? null,
    networks: evidence.networks,
    backstop,
    prestocks,
    mainnetSolana,
    pyth,
    verification: evaluateEvidence(evidence),
  };
}

function listKnownAssets() {
  return [
    {
      symbol: "TSLA",
      name: "Tesla, Inc. (Backstop devnet regression asset)",
      mint: DEMO_TSLA_MINT,
      network: "devnet",
      kind: "backstop_native_demo",
    },
    ...Object.values(PRESTOCKS_ASSETS).map((asset) => ({
      symbol: asset.symbol,
      name: asset.name,
      mint: asset.mint,
      network: "mainnet-beta",
      kind: "prestocks",
      externalUrl: asset.externalUrl,
    })),
  ];
}

// ---------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------

async function serveFrontendFile(
  res: http.ServerResponse,
  fileName: string,
  contentType: string
) {
  const file = await readFile(new URL(`../frontend/${fileName}`, import.meta.url));

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });

  res.end(file);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method !== "GET") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    if (url.pathname === "/") {
      return serveFrontendFile(res, "index.html", "text/html; charset=utf-8");
    }

    if (url.pathname === "/app.css") {
      return serveFrontendFile(res, "app.css", "text/css; charset=utf-8");
    }

    if (url.pathname === "/app.js") {
      return serveFrontendFile(
        res,
        "app.js",
        "application/javascript; charset=utf-8"
      );
    }

    if (url.pathname === "/api") {
      return json(res, 200, {
        service: "Backstop API",
        network: "devnet",
        endpoints: [
          "GET /health",
          "GET /assets",
          "GET /assets/:mint",
          "GET /assets/:mint/health",
          "GET /assets/:mint/evidence",
        ],
      });
    }

    if (url.pathname === "/health") {
      try {
        const slot = await withRpcRetry("get slot", () =>
          connection.getSlot("confirmed")
        );

        return json(res, 200, {
          ok: true,
          service: "backstop-api",
          network: "devnet",
          programId: PROGRAM_ID.toBase58(),
          slot,
        });
      } catch (error) {
        // The API process itself is up and answering -- it's the RPC
        // dependency that's unreachable. Say so specifically instead of
        // falling through to a generic 500, which would look like this
        // server crashed rather than an upstream being down.
        console.error("Devnet RPC unreachable for /health:", error);

        return json(res, 503, {
          ok: false,
          service: "backstop-api",
          network: "devnet",
          programId: PROGRAM_ID.toBase58(),
          reason: "devnet_rpc_unreachable",
        });
      }
    }

    if (url.pathname === "/assets") {
      return json(res, 200, { assets: listKnownAssets() });
    }

    const healthMatch = url.pathname.match(/^\/assets\/([^/]+)\/health$/);

    if (healthMatch) {
      try {
        return json(res, 200, await getHealth(healthMatch[1]!));
      } catch (error) {
        return json(res, 400, {
          error: "invalid_or_unreadable_asset",
          message: String(error),
        });
      }
    }

    const evidenceMatch = url.pathname.match(/^\/assets\/([^/]+)\/evidence$/);

    if (evidenceMatch) {
      try {
        return json(res, 200, await getEvidence(evidenceMatch[1]!));
      } catch (error) {
        return json(res, 400, {
          error: "invalid_or_unreadable_asset",
          message: String(error),
        });
      }
    }

    const assetMatch = url.pathname.match(/^\/assets\/([^/]+)$/);

    if (assetMatch) {
      try {
        return json(res, 200, await getAsset(assetMatch[1]!));
      } catch (error) {
        return json(res, 400, {
          error: "invalid_or_unreadable_asset",
          message: String(error),
        });
      }
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);

    return json(res, 500, { error: "internal_server_error" });
  }
});

// Only bind a port when this file is run directly (`tsx backend/server.ts`
// / `npm run backend`) -- not when it's imported for its exports (e.g.
// `evaluateEvidence` from a test file), which would otherwise start a
// real, unwanted HTTP server as a side effect of `import`.
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`Backstop API listening on http://localhost:${PORT}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`PreStocks RPC: ${PRESTOCKS_MAINNET_RPC}`);
  });
}

export { server };

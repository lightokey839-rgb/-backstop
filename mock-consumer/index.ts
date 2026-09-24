/**
 * Mock downstream consumer: a stand-in for a lending/collateral protocol
 * that checks Backstop's API before deciding whether to accept a
 * tokenized asset. This is "mock" in the sense that it is not a real
 * lending protocol -- it makes real HTTP calls to a real (locally running)
 * Backstop API and uses real response data to decide ALLOW/BLOCK, end to
 * end: real asset -> identity/evidence -> Backstop verdict -> explanation
 * -> downstream decision.
 *
 * Usage:
 *   npm run backend                 # in one terminal
 *   npm run mock:consumer           # in another
 *
 * Configure which mints to check with BACKSTOP_CONSUMER_MINTS (comma
 * separated); defaults to the TSLA devnet demo asset plus one PreStocks
 * mainnet asset, to show the gate working across both regimes.
 */

const API_URL =
  process.env.BACKSTOP_API_URL?.trim() || "http://localhost:8787";

const DEFAULT_MINTS = [
  "AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR", // TSLA, devnet regression asset
  "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw", // ANTHROPIC, PreStocks mainnet
];

const MINTS = (process.env.BACKSTOP_CONSUMER_MINTS?.trim()
  ? process.env.BACKSTOP_CONSUMER_MINTS.split(",").map((mint) => mint.trim())
  : DEFAULT_MINTS
).filter(Boolean);

type EvidenceResponse = {
  mint: string;
  assetId: string | null;
  symbol: string | null;
  verification?: {
    verdict: "VERIFIED" | "WARNING" | "DENY" | "UNKNOWN";
    reasons: string[];
  };
};

type GateDecision = "ALLOW COLLATERAL" | "BLOCK COLLATERAL";

/**
 * The actual downstream policy: only a VERIFIED verdict allows collateral
 * admission. Everything else -- WARNING, DENY, UNKNOWN, or a request that
 * failed outright -- blocks. This mirrors a real risk gate: silence or
 * ambiguity is not consent, and a network failure must fail closed rather
 * than silently letting an unverified asset through.
 */
function decide(verdict: string | undefined): GateDecision {
  return verdict === "VERIFIED" ? "ALLOW COLLATERAL" : "BLOCK COLLATERAL";
}

async function checkMint(mint: string): Promise<void> {
  console.log(`\nAsset: ${mint}`);

  let evidence: EvidenceResponse;

  try {
    const response = await fetch(`${API_URL}/assets/${mint}/evidence`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.log(`  Backstop API returned HTTP ${response.status}.`);
      console.log(`  Consumer decision: ${decide(undefined)} (fail closed: bad response)`);
      return;
    }

    evidence = (await response.json()) as EvidenceResponse;
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";

    console.log(`  Could not reach Backstop API (${reason}).`);
    console.log(`  Consumer decision: ${decide(undefined)} (fail closed: API unreachable)`);
    return;
  }

  const verdict = evidence.verification?.verdict;

  console.log(`  Asset ID:     ${evidence.assetId ?? "(unknown)"}`);
  console.log(`  Backstop verdict: ${verdict ?? "UNKNOWN"}`);

  for (const reason of evidence.verification?.reasons ?? []) {
    console.log(`    - ${reason}`);
  }

  console.log(`  Consumer decision: ${decide(verdict)}`);
}

async function main() {
  console.log("========================================");
  console.log(" MOCK CONSUMER: downstream risk gate demo");
  console.log("========================================");
  console.log(`Backstop API: ${API_URL}`);

  for (const mint of MINTS) {
    await checkMint(mint);
  }

  console.log("\n========================================");
}

main().catch((error) => {
  console.error("Mock consumer failed:");
  console.error(error);
  process.exitCode = 1;
});

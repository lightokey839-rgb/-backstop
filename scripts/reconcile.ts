/**
 * Real reconciliation CLI: reads actual on-chain state (no fabricated
 * attestations, no local models) and reports what Backstop can and cannot
 * currently confirm for a given mint.
 *
 * Usage:
 *   tsx scripts/reconcile.ts                          # TSLA, devnet (default)
 *   tsx scripts/reconcile.ts --mint <address>
 *   tsx scripts/reconcile.ts --mint <address> --cluster mainnet
 *
 * On devnet: derives the Backstop registry PDA, reads the registry and its
 * latest snapshot (if any), reads the live SPL token supply, and applies
 * the same freshness/coverage checks `evaluate_snapshot` enforces
 * on-chain -- via the exact same `readAssetHealth` function the backend
 * API uses, not a re-implementation of it.
 *
 * On mainnet: Backstop's program is not deployed there, so this
 * deliberately does not attempt a registry lookup (which would just be an
 * expensive way to print "not found"). Instead it reads the mint's live
 * decimals/supply directly, and if the mint is a known PreStocks asset,
 * fetches PreStocks' own published identity and mark price. This is the
 * honest ceiling of what is independently checkable for a PreStocks asset
 * today -- see docs/PRESTOCKS_INTEGRATION.md for why that is not the same
 * as a backing verdict.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

import { DEVNET_RPC_URL, readAssetHealth, registryPda } from "./lib/backstop-client.js";
import {
  getPreStocksEvidence,
  prestocksAssetForMint,
  PRESTOCKS_MAINNET_RPC,
} from "../backend/integrations/prestocks.js";

const DEFAULT_MINT = "AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR";

function parseArgs(argv: string[]): { mint: string; cluster: "devnet" | "mainnet" } {
  let mint = process.env.BACKSTOP_DEMO_MINT?.trim() || DEFAULT_MINT;
  let cluster: "devnet" | "mainnet" = "devnet";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mint" && argv[i + 1]) {
      mint = argv[i + 1]!;
      i++;
    } else if (argv[i] === "--cluster" && argv[i + 1]) {
      const value = argv[i + 1]!;

      if (value !== "devnet" && value !== "mainnet") {
        throw new Error(`--cluster must be "devnet" or "mainnet", got "${value}"`);
      }

      cluster = value;
      i++;
    }
  }

  return { mint, cluster };
}

function printKeyValue(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

async function reconcileDevnet(mint: PublicKey): Promise<void> {
  const connection = new Connection(DEVNET_RPC_URL, "confirmed");
  const [registry] = registryPda(mint);

  console.log("Cluster:            devnet");
  console.log("Backstop program:    deployed here");
  console.log(`Registry PDA:        ${registry.toBase58()}`);
  console.log("");

  const health = await readAssetHealth(connection, mint);

  if (!("registry" in health)) {
    console.log(`[UNKNOWN] No Backstop registry found for this mint (${health.reason}).`);
    console.log("Register it first with: npm run devnet:mint");
    return;
  }

  console.log(`Asset ID:            ${health.assetId ?? "(unknown)"}`);

  if (!("checks" in health) || !health.checks) {
    const reason = "reason" in health ? health.reason : "unknown";
    console.log(`[UNKNOWN] Registry exists but has no usable snapshot yet (${reason}).`);
    return;
  }

  printKeyValue("Snapshot PDA:", health.snapshot);
  printKeyValue("On-chain status:", health.status);
  printKeyValue("Live supply:", health.liveSupply);
  printKeyValue("Observed supply (snapshot):", health.observedSupply);
  printKeyValue("Attested backing:", health.attestedBacking);
  printKeyValue("Coverage (bps):", health.coverageBps);
  printKeyValue("Snapshot timestamp:", health.timestamp);
  printKeyValue("Snapshot expires at:", health.expiresAt);
  printKeyValue("Attestor:", health.attestor);
  console.log("");
  console.log("Checks:");
  printKeyValue("  snapshot marked VERIFIED", health.checks.snapshotVerified);
  printKeyValue("  fresh (not expired)", health.checks.fresh);
  printKeyValue("  live supply <= backing", health.checks.liveSupplyWithinBacking);
  printKeyValue("  registry binding matches", health.checks.registryMatches);
  printKeyValue("  mint binding matches", health.checks.mintMatches);
  console.log("");
  console.log(health.safe ? "[PASS] Backstop considers this asset safe." : "[FAIL] Backstop does not consider this asset safe right now.");

  if (!health.checks.fresh) {
    console.log("Hint: run `npm run devnet:refresh-snapshot` to publish a fresh attestation.");
  }
}

async function reconcileMainnet(mint: PublicKey): Promise<void> {
  console.log("Cluster:             mainnet-beta");
  console.log("Backstop program:    NOT deployed here (devnet only, as of this build)");
  console.log("[NOT APPLICABLE] Skipping registry/snapshot lookup -- there is nothing to find.");
  console.log("");

  const connection = new Connection(PRESTOCKS_MAINNET_RPC, "confirmed");

  try {
    const mintInfo = await getMint(connection, mint);

    printKeyValue("Live decimals:", mintInfo.decimals);
    printKeyValue("Live supply (raw units):", mintInfo.supply.toString());
  } catch (error) {
    console.log(`[UNKNOWN] Could not read the mint account on mainnet: ${String(error)}`);
  }

  const asset = prestocksAssetForMint(mint.toBase58());

  if (!asset) {
    console.log("\n[NOT APPLICABLE] This is not one of PreStocks' published tokens.");
    return;
  }

  console.log("");
  const evidence = await getPreStocksEvidence(mint.toBase58());

  if (evidence.status === "OBSERVED") {
    console.log(`[PASS] PreStocks catalogue confirms ${evidence.name} (${evidence.symbol}).`);
    printKeyValue("PreStocks mark price (USD):", evidence.markPrice);
    printKeyValue("PreStocks token price (USD):", evidence.tokenPrice ?? "n/a");
    printKeyValue("PreStocks reported supply:", evidence.supply ?? "n/a");
    console.log(
      "\nNote: this confirms identity and PreStocks' own published price -- it is not an independent check of SPV backing. See docs/PRESTOCKS_INTEGRATION.md."
    );
  } else {
    console.log(`[UNKNOWN] PreStocks catalogue lookup did not return this asset (${evidence.reason}).`);
  }
}

async function main() {
  const { mint: mintText, cluster } = parseArgs(process.argv.slice(2));
  const mint = new PublicKey(mintText);

  console.log("========================================");
  console.log(" BACKSTOP RECONCILIATION");
  console.log("========================================");
  console.log(`Mint: ${mint.toBase58()}\n`);

  if (cluster === "devnet") {
    await reconcileDevnet(mint);
  } else {
    await reconcileMainnet(mint);
  }

  console.log("\n========================================");
}

main().catch((error) => {
  console.error("\nReconciliation failed:");
  console.error(error);
  process.exitCode = 1;
});

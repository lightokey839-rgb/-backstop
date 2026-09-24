import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import crypto from "node:crypto";

import {
  BACKSTOP_ADMIN,
  DEVNET_RPC_URL,
  buildEvaluateSnapshotIx,
  buildSubmitSnapshotIx,
  loadKeypair,
  registryPda,
  sendWithRetry,
  snapshotPda,
} from "./lib/backstop-client.js";

// Overridable so this script can refresh a different devnet asset without
// editing source -- the default is the TSLA devnet regression mint this
// project has used throughout.
const MINT = new PublicKey(
  process.env.BACKSTOP_DEMO_MINT?.trim() ||
    "AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR"
);

// The wallet running this script must be the registered attestor for
// MINT's registry. For this project's demo setup that is the same key as
// BACKSTOP_ADMIN (one wallet plays both roles); a production deployment
// would very likely use a separate, dedicated attestor key -- see
// `update_attestor` / scripts/rotate-attestor.ts for how to change it.
const EXPECTED_ATTESTOR = BACKSTOP_ADMIN;

async function confirm(connection: Connection, signature: string): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < 90_000) {
    const status = await connection.getSignatureStatuses([signature]);
    const value = status.value[0];

    if (value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
    }

    if (
      value?.confirmationStatus === "confirmed" ||
      value?.confirmationStatus === "finalized"
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for transaction: ${signature}`);
}

async function main() {
  console.log("========================================");
  console.log(" BACKSTOP SNAPSHOT REFRESH");
  console.log("========================================\n");

  const connection = new Connection(DEVNET_RPC_URL, "confirmed");
  const payer = loadKeypair();

  console.log("Wallet:", payer.publicKey.toBase58());

  if (!payer.publicKey.equals(EXPECTED_ATTESTOR)) {
    throw new Error(
      [
        "Wallet is not the registered Backstop attestor.",
        `Expected: ${EXPECTED_ATTESTOR.toBase58()}`,
        `Actual:   ${payer.publicKey.toBase58()}`,
      ].join("\n")
    );
  }

  const [registry] = registryPda(MINT);

  console.log("Mint:", MINT.toBase58());
  console.log("Registry:", registry.toBase58());

  /*
   * Read the real supply directly from Devnet.
   */
  const mintInfo = await getMint(connection, MINT);
  const observedSupply = mintInfo.supply;

  console.log("Observed supply:", observedSupply.toString());
  console.log("Decimals:", mintInfo.decimals);

  /*
   * Make a unique 32-byte snapshot ID: first 8 bytes are the current
   * timestamp, the rest are random, preventing PDA collisions.
   */
  const snapshotId = Buffer.alloc(32);
  snapshotId.writeBigUInt64LE(BigInt(Date.now()), 0);
  crypto.randomFillSync(snapshotId, 8);

  /*
   * For this controlled devnet demonstration, the attested backing equals
   * the observed supply. This does NOT claim real-world stock ownership.
   */
  const attestedBacking = observedSupply;

  /*
   * Keep the demo snapshot fresh for 7 days -- comfortably inside the
   * on-chain MAX_SNAPSHOT_VALIDITY_SECS cap (30 days) added to
   * submit_snapshot.
   */
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiresAt = now + 7n * 24n * 60n * 60n;

  const [snapshot] = snapshotPda(registry, snapshotId);

  console.log("Snapshot:", snapshot.toBase58());
  console.log("Attested backing:", attestedBacking.toString());
  console.log("Expires at:", expiresAt.toString());

  console.log("\nSubmitting fresh snapshot...");

  const submitIx = buildSubmitSnapshotIx({
    attestor: payer.publicKey,
    registry,
    snapshot,
    mint: MINT,
    snapshotId,
    attestedBacking,
    expiresAt,
  });

  const submitSignature = await sendWithRetry(
    connection,
    payer,
    submitIx,
    "Snapshot transaction"
  );

  console.log("Snapshot transaction:", submitSignature);
  await confirm(connection, submitSignature);
  console.log("\u2705 Snapshot submitted.");

  console.log("\nEvaluating fresh snapshot...");

  const evaluateIx = buildEvaluateSnapshotIx({ registry, snapshot, mint: MINT });

  const evaluationSignature = await sendWithRetry(
    connection,
    payer,
    evaluateIx,
    "Evaluation transaction"
  );

  console.log("Evaluation transaction:", evaluationSignature);
  await confirm(connection, evaluationSignature);
  console.log("\u2705 Snapshot evaluation completed.");

  console.log("\n========================================");
  console.log(" REFRESH COMPLETE");
  console.log("========================================");
  console.log("Mint:", MINT.toBase58());
  console.log("Registry:", registry.toBase58());
  console.log("Snapshot:", snapshot.toBase58());
  console.log("Supply:", observedSupply.toString());
  console.log("Backing:", attestedBacking.toString());
  console.log("Expires:", expiresAt.toString());
  console.log("Snapshot transaction:", submitSignature);
  console.log("Evaluation transaction:", evaluationSignature);
  console.log("\nExpected Backstop snapshot status: VERIFIED");
}

main().catch((error) => {
  console.error("\n\u274c Snapshot refresh failed:");
  console.error(error);
  process.exitCode = 1;
});

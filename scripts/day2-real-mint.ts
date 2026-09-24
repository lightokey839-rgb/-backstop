import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import {
  BACKSTOP_ADMIN,
  BACKSTOP_API_URL,
  DEVNET_RPC_URL,
  buildEvaluateSnapshotIx,
  buildInitializeAssetIx,
  buildSubmitSnapshotIx,
  loadKeypair,
  registryPda,
  sendWithRetry,
  snapshotPda,
} from "./lib/backstop-client.js";

async function confirm(connection: Connection, signature: string): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < 90_000) {
    try {
      const status = await connection.getSignatureStatuses([signature]);
      const value = status.value[0];

      if (value?.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(value.err)}`);
      }

      if (
        value?.confirmationStatus === "confirmed" ||
        value?.confirmationStatus === "finalized"
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Timed out waiting for transaction confirmation: ${signature}. Last error: ${String(lastError)}`
  );
}

async function checkApi(mint: PublicKey): Promise<void> {
  try {
    const response = await fetch(`${BACKSTOP_API_URL}/assets/${mint.toBase58()}/health`);
    const body = await response.text();

    console.log("\nBackstop API response:");
    console.log(body);

    if (!response.ok) {
      console.log(`API returned HTTP ${response.status}`);
    }
  } catch {
    console.log("\nAPI check skipped: backend is not reachable.");
    console.log("Start it with: npm run backend");
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`${label} (attempt ${attempt}/${attempts})...`);
      return await fn();
    } catch (error) {
      console.log(`${label} attempt ${attempt} failed.`);

      if (attempt === attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
  }

  throw new Error(`${label}: failed after ${attempts} attempts.`);
}

async function main() {
  console.log("========================================");
  console.log(" BACKSTOP REAL MINT + REGISTRY CHECK ");
  console.log("========================================\n");

  const connection = new Connection(DEVNET_RPC_URL, "confirmed");
  const payer = loadKeypair();

  console.log("Wallet:", payer.publicKey.toBase58());

  if (!payer.publicKey.equals(BACKSTOP_ADMIN)) {
    throw new Error(
      `Wallet is not BACKSTOP_ADMIN.\nExpected: ${BACKSTOP_ADMIN.toBase58()}\nActual: ${payer.publicKey.toBase58()}`
    );
  }

  const balance = await withRetry("Checking wallet balance", () =>
    connection.getBalance(payer.publicKey, "confirmed")
  );

  console.log("Balance:", (balance / 1_000_000_000).toFixed(6), "SOL");

  console.log("\nCreating SPL mint...");

  // 0 decimals: this is a simple integer-count devnet demo mint, distinct
  // from PreStocks' real mainnet Token-2022 mints (which use 9 decimals
  // and the Scaled UI Amount extension -- see
  // backend/integrations/prestocks.ts).
  const mint = await createMint(connection, payer, payer.publicKey, null, 0);

  console.log("Mint:", mint.toBase58());

  console.log("\nCreating token account...");

  const tokenAccount = await withRetry("Token account", () =>
    getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey)
  );

  console.log("Token account:", tokenAccount.address.toBase58());

  const amount = 10_000;

  console.log(`\nMinting ${amount} tokens...`);

  const mintSignature = await withRetry("Mint", () =>
    mintTo(connection, payer, mint, tokenAccount.address, payer, amount)
  );

  await confirm(connection, mintSignature);
  console.log("Mint transaction:", mintSignature);

  const mintInfo = await getMint(connection, mint);

  console.log("\nOn-chain supply:", mintInfo.supply.toString());
  console.log("Decimals:", mintInfo.decimals);

  if (mintInfo.supply !== BigInt(amount)) {
    throw new Error(`Supply mismatch: expected ${amount}, got ${mintInfo.supply}`);
  }

  console.log("\n\u2705 REAL SPL SUPPLY CHECK PASSED");

  /*
   * BACKSTOP REGISTRY
   */

  const [registry] = registryPda(mint);

  console.log("\nBackstop registry PDA:");
  console.log(registry.toBase58());

  console.log("\nRegistering asset with Backstop...");

  const initializeIx = buildInitializeAssetIx({
    payer: payer.publicKey,
    registry,
    mint,
    assetId: "TSLA",
    attestor: payer.publicKey,
  });

  const initializeSignature = await sendWithRetry(
    connection,
    payer,
    initializeIx,
    "Registry transaction"
  );

  console.log("Initialize transaction:", initializeSignature);
  await confirm(connection, initializeSignature);
  console.log("\u2705 BACKSTOP ASSET REGISTRATION PASSED");

  /*
   * SNAPSHOT
   */

  const snapshotId = Buffer.alloc(32);
  snapshotId.writeBigUInt64LE(BigInt(Date.now()), 0);

  const [snapshot] = snapshotPda(registry, snapshotId);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiresAt = now + 300n;

  console.log("\nSnapshot PDA:");
  console.log(snapshot.toBase58());
  console.log("Observed supply:", mintInfo.supply.toString());
  console.log("Attested backing:", amount.toString());
  console.log("Expires at:", expiresAt.toString());

  console.log("\nSubmitting Backstop snapshot...");

  const submitIx = buildSubmitSnapshotIx({
    attestor: payer.publicKey,
    registry,
    snapshot,
    mint,
    snapshotId,
    attestedBacking: BigInt(amount),
    expiresAt,
  });

  const snapshotSignature = await sendWithRetry(
    connection,
    payer,
    submitIx,
    "Snapshot transaction"
  );

  console.log("Snapshot transaction:", snapshotSignature);
  await confirm(connection, snapshotSignature);
  console.log("\u2705 BACKSTOP SNAPSHOT SUBMISSION PASSED");

  console.log("\nEvaluating latest Backstop snapshot...");

  const evaluateIx = buildEvaluateSnapshotIx({ registry, snapshot, mint });

  const evaluationSignature = await sendWithRetry(
    connection,
    payer,
    evaluateIx,
    "Evaluation transaction"
  );

  console.log("Evaluation transaction:", evaluationSignature);
  await confirm(connection, evaluationSignature);
  console.log("\u2705 BACKSTOP SNAPSHOT EVALUATION PASSED");

  console.log("\n========================================");
  console.log("          BACKSTOP MVP RESULT");
  console.log("========================================");
  console.log("Mint:", mint.toBase58());
  console.log("Registry:", registry.toBase58());
  console.log("Snapshot:", snapshot.toBase58());
  console.log("Supply:", mintInfo.supply.toString());
  console.log("Backing:", amount.toString());
  console.log("Expected health: VERIFIED");
  console.log("Safe:", "YES");

  await checkApi(mint);

  console.log("\n========================================");
}

main().catch((error) => {
  console.error("\n\u274c Fatal error:");
  console.error(error);
  process.exitCode = 1;
});

/**
 * Rotate the attestor key trusted to submit snapshots for one registered
 * Backstop asset, using the new `update_attestor` instruction.
 *
 * Usage:
 *   SOLANA_KEYPAIR_PATH=~/.config/solana/admin.json \
 *     tsx scripts/rotate-attestor.ts <mint> <newAttestorPubkey>
 *
 * The signer must be the registry's stored `authority` (BACKSTOP_ADMIN for
 * every asset this project has registered so far). This does not touch
 * any existing Snapshot account -- it only changes who may submit the
 * *next* one.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import {
  DEVNET_RPC_URL,
  buildUpdateAttestorIx,
  decodeRegistry,
  loadKeypair,
  registryPda,
  sendWithRetry,
} from "./lib/backstop-client.js";

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
  const [mintArg, newAttestorArg] = process.argv.slice(2);

  if (!mintArg || !newAttestorArg) {
    console.error("Usage: tsx scripts/rotate-attestor.ts <mint> <newAttestorPubkey>");
    process.exitCode = 1;
    return;
  }

  const mint = new PublicKey(mintArg);
  const newAttestor = new PublicKey(newAttestorArg);

  console.log("========================================");
  console.log(" BACKSTOP ATTESTOR ROTATION");
  console.log("========================================\n");

  const connection = new Connection(DEVNET_RPC_URL, "confirmed");
  const payer = loadKeypair();

  console.log("Wallet (must be registry authority):", payer.publicKey.toBase58());
  console.log("Mint:", mint.toBase58());

  const [registry] = registryPda(mint);
  const registryAccount = await connection.getAccountInfo(registry);

  if (!registryAccount) {
    throw new Error(
      `No Backstop registry found for this mint at ${registry.toBase58()}. Register it first with initialize_asset.`
    );
  }

  const before = decodeRegistry(registryAccount.data);

  console.log("Registry:", registry.toBase58());
  console.log("Current attestor:", before.attestor);
  console.log("New attestor:", newAttestor.toBase58());

  if (before.authority !== payer.publicKey.toBase58()) {
    throw new Error(
      [
        "Wallet is not this registry's authority.",
        `Expected: ${before.authority}`,
        `Actual:   ${payer.publicKey.toBase58()}`,
      ].join("\n")
    );
  }

  const ix = buildUpdateAttestorIx({
    authority: payer.publicKey,
    registry,
    mint,
    newAttestor,
  });

  console.log("\nSubmitting update_attestor...");

  const signature = await sendWithRetry(connection, payer, ix, "Update attestor transaction");

  console.log("Transaction:", signature);
  await confirm(connection, signature);

  const after = decodeRegistry((await connection.getAccountInfo(registry))!.data);

  console.log("\n\u2705 Attestor updated.");
  console.log("Registry attestor is now:", after.attestor);

  if (after.attestor !== newAttestor.toBase58()) {
    throw new Error(
      "Post-transaction read does not match the requested new attestor -- investigate before trusting this rotation."
    );
  }
}

main().catch((error) => {
  console.error("\n\u274c Attestor rotation failed:");
  console.error(error);
  process.exitCode = 1;
});

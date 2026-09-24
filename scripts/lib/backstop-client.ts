/**
 * Shared helpers for the CLI scripts that send real transactions to the
 * Backstop program (devnet:mint, refresh-snapshot, rotate-attestor).
 *
 * This project talks to the Anchor program by hand-encoding raw
 * instruction bytes rather than through the generated Anchor TypeScript
 * client, so these scripts have no `anchor build`/IDL dependency to stay
 * runnable. Anchor's instruction discriminator -- sha256("global:<name>")
 * truncated to 8 bytes -- is a stable, documented part of Anchor's wire
 * format, not something specific to this project.
 *
 * Account-layout reads (registry/snapshot decoding, PDA derivation) live
 * in backend/onchain.ts and are re-exported here so every script and the
 * backend agree on exactly one definition of the on-chain layout.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  PROGRAM_ID,
  BACKSTOP_ADMIN,
  registryPda,
  snapshotPda,
  decodeRegistry,
  decodeSnapshot,
  statusName,
  readAssetHealth,
  withRpcRetry,
} from "../../backend/onchain.js";

export {
  PROGRAM_ID,
  BACKSTOP_ADMIN,
  registryPda,
  snapshotPda,
  decodeRegistry,
  decodeSnapshot,
  statusName,
  readAssetHealth,
  withRpcRetry,
};

export const DEVNET_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";

export const BACKSTOP_API_URL =
  process.env.BACKSTOP_API_URL?.trim() || "http://localhost:8787";

/**
 * Resolves the local Solana CLI keypair path the same way `solana` and
 * `anchor` do: SOLANA_KEYPAIR_PATH if set, otherwise
 * ~/.config/solana/id.json for whoever is running the script. Never
 * hardcode one machine's home directory here -- that was the bug this
 * replaces.
 */
export function defaultKeypairPath(): string {
  return (
    process.env.SOLANA_KEYPAIR_PATH?.trim() ||
    path.join(os.homedir(), ".config", "solana", "id.json")
  );
}

export function loadKeypair(keypairPath = defaultKeypairPath()): Keypair {
  const resolved = keypairPath.startsWith("~")
    ? path.join(os.homedir(), keypairPath.slice(1))
    : keypairPath;

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `No Solana keypair found at ${resolved}. Set SOLANA_KEYPAIR_PATH, or run 'solana-keygen new' first.`
    );
  }

  const secret = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function discriminator(name: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

export function encodeString(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length, 0);
  return Buffer.concat([length, data]);
}

export function encodeU64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export function encodeI64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(value);
  return buffer;
}

export function encodePubkey(value: PublicKey): Buffer {
  return Buffer.from(value.toBytes());
}

export function buildInitializeAssetIx(params: {
  payer: PublicKey;
  registry: PublicKey;
  mint: PublicKey;
  assetId: string;
  attestor: PublicKey;
}): TransactionInstruction {
  const data = Buffer.concat([
    discriminator("initialize_asset"),
    encodeString(params.assetId),
    encodePubkey(params.attestor),
  ]);

  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.registry, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

export function buildSubmitSnapshotIx(params: {
  attestor: PublicKey;
  registry: PublicKey;
  snapshot: PublicKey;
  mint: PublicKey;
  snapshotId: Buffer;
  attestedBacking: bigint;
  expiresAt: bigint;
}): TransactionInstruction {
  const data = Buffer.concat([
    discriminator("submit_snapshot"),
    encodeU64(params.attestedBacking),
    params.snapshotId,
    encodeI64(params.expiresAt),
  ]);

  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.attestor, isSigner: true, isWritable: true },
      { pubkey: params.registry, isSigner: false, isWritable: true },
      { pubkey: params.snapshot, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

/**
 * Encodes `update_attestor(new_attestor: Pubkey)`, matching the
 * `UpdateAttestor` account order in programs/backstop/src/lib.rs exactly:
 * authority (signer, read-only), registry (mut), mint (read-only).
 */
export function buildUpdateAttestorIx(params: {
  authority: PublicKey;
  registry: PublicKey;
  mint: PublicKey;
  newAttestor: PublicKey;
}): TransactionInstruction {
  const data = Buffer.concat([
    discriminator("update_attestor"),
    encodePubkey(params.newAttestor),
  ]);

  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.registry, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
    ],
    data,
  };
}

export function buildEvaluateSnapshotIx(params: {
  registry: PublicKey;
  snapshot: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.registry, isSigner: false, isWritable: false },
      { pubkey: params.snapshot, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
    ],
    data: discriminator("evaluate_snapshot"),
  };
}

export async function sendWithRetry(
  connection: Connection,
  payer: Keypair,
  instruction: TransactionInstruction,
  label: string,
  attempts = 5
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`${label}: attempt ${attempt}/${attempts}...`);

      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction().add(instruction);

      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
      transaction.feePayer = payer.publicKey;
      transaction.sign(payer);

      return await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
    } catch (error) {
      console.log(`${label}: attempt ${attempt} failed.`);

      if (attempt === attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  throw new Error(`${label}: failed after ${attempts} attempts.`);
}

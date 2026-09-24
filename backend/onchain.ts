/**
 * Shared on-chain layout + decode helpers for the Backstop Anchor program.
 *
 * Used by both the backend API (server.ts) and the CLI scripts (reconcile,
 * refresh-snapshot, rotate-attestor, day2) so there is exactly one place
 * that understands the AssetRegistry/Snapshot account layout. If the
 * on-chain struct layout ever changes, update it here once.
 *
 * This intentionally does not use the Anchor TypeScript client/IDL --
 * this project reads and writes raw account/instruction bytes directly
 * (see scripts/lib/backstop-client.ts for the instruction-encoding side),
 * so there is no generated IDL artifact to keep in sync with `anchor
 * build`. The byte layout here must match programs/backstop/src/lib.rs's
 * `AssetRegistry` and `Snapshot` structs exactly.
 */

import { Connection, PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "8RTR33hW32KTA2eQD92LxD5VCto6FHjzZrRADWGHFuVs"
);

export const BACKSTOP_ADMIN = new PublicKey(
  "LeM3Dt71nbTJYZChitzaeMB2GjRRzDCnWR5VrUPnzvS"
);

export function registryPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("registry"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function snapshotPda(
  registry: PublicKey,
  snapshotId: Buffer | Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot"), registry.toBuffer(), Buffer.from(snapshotId)],
    PROGRAM_ID
  );
}

function readU8(data: Buffer, offset: number): number {
  return data.readUInt8(offset);
}

function readU32(data: Buffer, offset: number): number {
  return data.readUInt32LE(offset);
}

function readU16(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

function readI64(data: Buffer, offset: number): number {
  return Number(data.readBigInt64LE(offset));
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readString(
  data: Buffer,
  offset: number
): { value: string; next: number } {
  const length = readU32(data, offset);
  const start = offset + 4;
  const end = start + length;

  return { value: data.subarray(start, end).toString("utf8"), next: end };
}

/** Mirrors `AssetRegistry` in programs/backstop/src/lib.rs. */
export function decodeRegistry(data: Buffer) {
  let offset = 8; // Anchor account discriminator

  const authority = readPubkey(data, offset);
  offset += 32;

  const mint = readPubkey(data, offset);
  offset += 32;

  const attestor = readPubkey(data, offset);
  offset += 32;

  const latestSnapshot = readPubkey(data, offset);
  offset += 32;

  const latestSnapshotId = data.subarray(offset, offset + 32).toString("hex");
  offset += 32;

  const initialized = readU8(data, offset) !== 0;
  offset += 1;

  const hasSnapshot = readU8(data, offset) !== 0;
  offset += 1;

  const assetIdResult = readString(data, offset);

  return {
    authority,
    mint,
    attestor,
    latestSnapshot,
    latestSnapshotId,
    initialized,
    hasSnapshot,
    assetId: assetIdResult.value,
  };
}

export type DecodedRegistry = ReturnType<typeof decodeRegistry>;

/** Mirrors `Snapshot` in programs/backstop/src/lib.rs. */
export function decodeSnapshot(data: Buffer) {
  let offset = 8; // Anchor account discriminator

  const registry = readPubkey(data, offset);
  offset += 32;

  const assetIdResult = readString(data, offset);
  offset = assetIdResult.next;

  const mint = readPubkey(data, offset);
  offset += 32;

  const observedSupply = readU64(data, offset);
  offset += 8;

  const attestedBacking = readU64(data, offset);
  offset += 8;

  const coverageBps = readU16(data, offset);
  offset += 2;

  const snapshotId = data.subarray(offset, offset + 32).toString("hex");
  offset += 32;

  const timestamp = readI64(data, offset);
  offset += 8;

  const expiresAt = readI64(data, offset);
  offset += 8;

  const attestor = readPubkey(data, offset);
  offset += 32;

  const statusByte = readU8(data, offset);

  return {
    registry,
    mint,
    attestor,
    assetId: assetIdResult.value,
    observedSupply,
    attestedBacking,
    coverageBps,
    snapshotId,
    timestamp,
    expiresAt,
    statusByte,
  };
}

export type DecodedSnapshot = ReturnType<typeof decodeSnapshot>;

/** `SnapshotStatus` discriminant, as Borsh-serialized by Anchor (u8). */
export function statusName(status: number): string {
  switch (status) {
    case 0:
      return "VERIFIED";
    case 1:
      return "UNDER_BACKED";
    default:
      return "UNKNOWN";
  }
}

export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  throw new Error(`${label} failed: ${String(lastError)}`);
}

/**
 * Reads an asset's full Backstop health off whichever cluster `connection`
 * points at: registry -> latest snapshot -> live token supply, then
 * applies the same freshness/coverage checks `evaluate_snapshot` enforces
 * on-chain. Shared by the backend API and scripts/reconcile.ts so there is
 * one definition of "safe" instead of two that could quietly drift apart.
 *
 * Backstop's program is currently deployed on devnet only -- calling this
 * with a mainnet connection for a mint that has no devnet counterpart will
 * correctly (and cheaply) come back `status: "UNKNOWN", reason:
 * "registry_not_found"`, since there is nothing at that PDA on that
 * cluster. Callers that know an asset is mainnet-only (e.g. a PreStocks
 * asset) should generally not present that as a failure -- see
 * `backstopDisplay` in backend/server.ts for how the API distinguishes
 * "not applicable on this cluster" from "genuinely unknown".
 */
export async function readAssetHealth(connection: Connection, mint: PublicKey) {
  const [registryAddress] = registryPda(mint);

  const registryAccount = await withRpcRetry("get registry account", () =>
    connection.getAccountInfo(registryAddress)
  );

  if (!registryAccount) {
    return {
      mint: mint.toBase58(),
      safe: false,
      status: "UNKNOWN",
      reason: "registry_not_found",
    };
  }

  const registry = decodeRegistry(registryAccount.data);

  if (!registry.hasSnapshot) {
    return {
      mint: mint.toBase58(),
      registry: registryAddress.toBase58(),
      safe: false,
      status: "UNKNOWN",
      reason: "no_snapshot",
      assetId: registry.assetId,
    };
  }

  const snapshotAddress = new PublicKey(registry.latestSnapshot);

  const snapshotAccount = await withRpcRetry("get snapshot account", () =>
    connection.getAccountInfo(snapshotAddress)
  );

  if (!snapshotAccount) {
    return {
      mint: mint.toBase58(),
      registry: registryAddress.toBase58(),
      safe: false,
      status: "UNKNOWN",
      reason: "latest_snapshot_not_found",
    };
  }

  const snapshot = decodeSnapshot(snapshotAccount.data);

  const liveSupply = await withRpcRetry("get token supply", () =>
    connection.getTokenSupply(mint)
  );

  const liveSupplyRaw = BigInt(liveSupply.value.amount);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const expired = now > snapshot.expiresAt;
  const underBacked = liveSupplyRaw > snapshot.attestedBacking;

  const snapshotStatus = statusName(snapshot.statusByte);

  let status = snapshotStatus;

  if (expired) {
    status = "STALE";
  } else if (underBacked) {
    status = "UNDER_BACKED";
  }

  const safe =
    snapshotStatus === "VERIFIED" &&
    !expired &&
    !underBacked &&
    snapshot.mint === mint.toBase58() &&
    snapshot.registry === registryAddress.toBase58();

  return {
    mint: mint.toBase58(),
    assetId: snapshot.assetId,
    registry: registryAddress.toBase58(),
    snapshot: snapshotAddress.toBase58(),
    status,
    safe,
    observedSupply: snapshot.observedSupply.toString(),
    liveSupply: liveSupply.value.amount,
    attestedBacking: snapshot.attestedBacking.toString(),
    coverageBps: snapshot.coverageBps,
    timestamp: snapshot.timestamp.toString(),
    expiresAt: snapshot.expiresAt.toString(),
    attestor: snapshot.attestor,
    checks: {
      snapshotVerified: snapshotStatus === "VERIFIED",
      fresh: !expired,
      liveSupplyWithinBacking: !underBacked,
      registryMatches: snapshot.registry === registryAddress.toBase58(),
      mintMatches: snapshot.mint === mint.toBase58(),
    },
  };
}

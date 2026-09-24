/**
 * LEGACY / HISTORICAL: day 1 of this project's build log.
 *
 * A self-contained, local-only model of the cryptographic core (canonical
 * JSON -> SHA-256 -> Ed25519 sign/verify -> coverage -> status). It never
 * calls devnet RPC and never sends a transaction to the deployed Backstop
 * program. Kept for provenance and as a minimal, dependency-light way to
 * sanity-check the crypto primitives in isolation.
 *
 * IMPORTANT: the deployed Anchor program (programs/backstop/src/lib.rs)
 * does NOT verify detached Ed25519 attestations the way this script does.
 * It authenticates a snapshot submission via the submitting Solana
 * transaction's own signature from the registered attestor keypair. Do
 * not read this file as documentation of the on-chain verification path
 * -- see docs/PRESTOCKS_INTEGRATION.md and the README's Trust Model
 * section for that.
 */
import crypto from "node:crypto";
import nacl from "tweetnacl";

type Attestation = {
  attestation_id: string;
  asset_symbol: string;
  token_mint: string;
  raw_supply: number;
  multiplier: number;
  effective_supply: number;
  backing_quantity: number;
  unit: string;
  snapshot_id: number;
  timestamp: string;
  expires_at: string;
  attestor_id: string;
  attestor_pubkey: string;
  nonce: string;
  source: "DEMO" | "XSTOCKS_PUBLIC_POR" | "BACKPACK_MINT_EVENT";
  corporate_action_state: "NONE" | "SPLIT_PENDING" | "HALTED" | "DELISTED";
};

const SAFETY_BUFFER_BPS = 0; // 1.00%

/**
 * Deterministically serialize an object.
 *
 * JSON.stringify() alone is not enough because object key order
 * can differ between systems. Backstop needs the exact same bytes
 * to be produced every time before hashing/signing.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const object = value as Record<string, unknown>;

  const keys = Object.keys(object).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

/**
 * SHA-256 hash of the canonical attestation.
 */
function hashAttestation(attestation: Attestation): Buffer {
  const canonical = canonicalize(attestation);

  return crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest();
}

/**
 * Calculate coverage in basis points.
 *
 * 10000 bps = 100%
 */
function calculateCoverageBps(
  backing: number,
  supply: number,
): number {
  if (supply <= 0) {
    throw new Error("Supply must be greater than zero.");
  }

  return Math.floor((backing / supply) * 10_000);
}

/**
 * Determine Backstop health status.
 */
function determineStatus(
  signatureValid: boolean,
  attestation: Attestation,
  coverageBps: number,
): "VERIFIED" | "UNDER_BACKED" | "STALE" | "INVALID" {
  if (!signatureValid) {
    return "INVALID";
  }

  const now = Date.now();
  const expiry = new Date(attestation.expires_at).getTime();

  if (expiry < now) {
    return "STALE";
  }

  if (coverageBps < 10_000 + SAFETY_BUFFER_BPS) {
    return "UNDER_BACKED";
  }

  return "VERIFIED";
}

async function main() {
  console.log("========================================");
  console.log("        BACKSTOP DAY 1 CORE CHECK       ");
  console.log("========================================");
  console.log(
    "Local cryptographic-core model only: no devnet RPC call, no Backstop program transaction."
  );
  console.log("========================================\n");

  // Temporary demo values.
  // Later these will come from Solana + a real/demo backing provider.
  const attestation: Attestation = {
    attestation_id: "demo-attestation-001",
    asset_symbol: "SNDK",
    token_mint: "DEMO_SNDK_DEVNET_MINT",
    raw_supply: 10_000,
    multiplier: 1.0,
    effective_supply: 10_000,
    backing_quantity: 10_000,
    unit: "shares",
    snapshot_id: 1,
    timestamp: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attestor_id: "demo-attestor-01",
    attestor_pubkey: "",
    nonce: "1",
    source: "DEMO",
    corporate_action_state: "NONE",
  };

  // Generate a temporary Ed25519 keypair.
  // This represents our demo attestor.
  const keypair = nacl.sign.keyPair();

  attestation.attestor_pubkey = Buffer.from(
    keypair.publicKey,
  ).toString("base64");

  // Hash the canonical attestation.
  const documentHash = hashAttestation(attestation);

  // Sign the hash.
  const signature = nacl.sign.detached(
    documentHash,
    keypair.secretKey,
  );

  // Verify the signature.
  const signatureValid = nacl.sign.detached.verify(
    documentHash,
    signature,
    keypair.publicKey,
  );

  // Calculate coverage.
  const coverageBps = calculateCoverageBps(
    attestation.backing_quantity,
    attestation.effective_supply,
  );

  const status = determineStatus(
    signatureValid,
    attestation,
    coverageBps,
  );

  console.log(`Asset:           ${attestation.asset_symbol}`);
  console.log(`Supply:          ${attestation.effective_supply}`);
  console.log(`Backing:         ${attestation.backing_quantity}`);
  console.log(
    `Hash:            ${documentHash.toString("hex")}`,
  );
  console.log(
    `Signature:       ${signatureValid ? "VALID" : "INVALID"}`,
  );
  console.log(
    `Coverage:        ${(coverageBps / 100).toFixed(2)}%`,
  );
  console.log(`Status:          ${status}`);
  console.log(
    `Source:          ${attestation.source}`,
  );
  console.log(
    `Safety buffer:   ${SAFETY_BUFFER_BPS / 100}%`,
  );

  console.log("\n========================================");

  if (
    signatureValid &&
    status === "VERIFIED"
  ) {
    console.log("✅ DAY 1 CRYPTOGRAPHIC CHECK PASSED");
  } else {
    console.log("❌ DAY 1 CHECK FAILED");
    process.exitCode = 1;
  }

  console.log("========================================");
}

main().catch((error) => {
  console.error("\n❌ Fatal error:");
  console.error(error);
  process.exitCode = 1;
});
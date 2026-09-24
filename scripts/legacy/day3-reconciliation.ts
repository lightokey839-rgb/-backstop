/**
 * LEGACY / HISTORICAL: day 3 of this project's build log.
 *
 * Reads a real devnet mint's live supply (this part is a genuine RPC
 * call), then builds and hashes a locally-fabricated "attestation" with a
 * freshly-generated, throwaway Ed25519 keypair purely to exercise the
 * signing/coverage math -- that signature proves nothing about the mint
 * above other than that this script ran. It never invokes the Backstop
 * program. MINT_ADDRESS below is an earlier test mint, not the TSLA
 * devnet mint scripts/day2-real-mint.ts and scripts/refresh-snapshot.ts
 * use today.
 *
 * For a real, current on-chain reconciliation report, use
 * `npm run reconcile` (scripts/reconcile.ts) instead.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

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
  source: "DEMO";
  corporate_action_state: "NONE";
};

const MINT_ADDRESS =
  "AC9Yj9dLtvjn89bRnwJQRRnXeKKgVd5dMR1GHFn95pkR";

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
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(object[key])}`,
    )
    .join(",")}}`;
}

function hashAttestation(
  attestation: Attestation,
): Buffer {
  return crypto
    .createHash("sha256")
    .update(canonicalize(attestation), "utf8")
    .digest();
}

function loadKeypair(): Keypair {
  const keypairPath =
    process.env.SOLANA_KEYPAIR_PATH?.trim() ||
    path.join(os.homedir(), ".config", "solana", "id.json");

  const secret = JSON.parse(
    fs.readFileSync(keypairPath, "utf8"),
  );

  return Keypair.fromSecretKey(
    Uint8Array.from(secret),
  );
}

function calculateCoverageBps(
  backing: number,
  supply: number,
): number {
  if (supply <= 0) {
    throw new Error(
      "On-chain supply must be greater than zero.",
    );
  }

  return Math.floor(
    (backing / supply) * 10_000,
  );
}

function determineStatus(
  signatureValid: boolean,
  mintMatches: boolean,
  attestation: Attestation,
  coverageBps: number,
):
  | "VERIFIED"
  | "UNDER_BACKED"
  | "STALE"
  | "INVALID"
  | "ASSET_MAPPING_ERROR" {

  if (!mintMatches) {
    return "ASSET_MAPPING_ERROR";
  }

  if (!signatureValid) {
    return "INVALID";
  }

  if (
    new Date(attestation.expires_at).getTime() <
    Date.now()
  ) {
    return "STALE";
  }

  if (coverageBps < 10_000) {
    return "UNDER_BACKED";
  }

  return "VERIFIED";
}

async function main() {
  console.log("========================================");
  console.log(
    "  BACKSTOP DAY 3 DEVNET READ + MODEL",
  );
  console.log("This script does not invoke the Backstop program.");
  console.log("========================================\n");

  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed",
  );

  const payer = loadKeypair();

  console.log(
    "Wallet:",
    payer.publicKey.toBase58(),
  );

  console.log(
    "Target mint:",
    MINT_ADDRESS,
  );

  // --------------------------------------------------
  // 1. Read the REAL on-chain supply
  // --------------------------------------------------

  const mintInfo = await getMint(
    connection,
    new PublicKey(MINT_ADDRESS),
  );

  const onChainSupply =
    Number(mintInfo.supply);

  console.log(
    "\nOn-chain supply:",
    onChainSupply,
  );

  // --------------------------------------------------
  // 2. Create a signed backing attestation
  // --------------------------------------------------

  const keypair = nacl.sign.keyPair();

  const attestation: Attestation = {
    attestation_id:
      "demo-reconciliation-001",

    asset_symbol:
      "SNDK",

    token_mint:
      MINT_ADDRESS,

    raw_supply:
      onChainSupply,

    multiplier:
      1.0,

    effective_supply:
      onChainSupply,

    backing_quantity:
      10_000,

    unit:
      "shares",

    snapshot_id:
      1,

    timestamp:
      new Date().toISOString(),

    expires_at:
      new Date(
        Date.now() + 10 * 60 * 1000,
      ).toISOString(),

    attestor_id:
      "demo-attestor-01",

    attestor_pubkey:
      Buffer.from(
        keypair.publicKey,
      ).toString("base64"),

    nonce:
      "1",

    source:
      "DEMO",

    corporate_action_state:
      "NONE",
  };

  // --------------------------------------------------
  // 3. Hash and sign the attestation
  // --------------------------------------------------

  const documentHash =
    hashAttestation(attestation);

  const signature =
    nacl.sign.detached(
      documentHash,
      keypair.secretKey,
    );

  // --------------------------------------------------
  // 4. Verify the signature
  // --------------------------------------------------

  const signatureValid =
    nacl.sign.detached.verify(
      documentHash,
      signature,
      keypair.publicKey,
    );

  // --------------------------------------------------
  // 5. Verify asset identity
  // --------------------------------------------------

  const mintMatches =
    attestation.token_mint ===
    MINT_ADDRESS;

  // --------------------------------------------------
  // 6. Reconcile backing against supply
  // --------------------------------------------------

  const coverageBps =
    calculateCoverageBps(
      attestation.backing_quantity,
      onChainSupply,
    );

  const status =
    determineStatus(
      signatureValid,
      mintMatches,
      attestation,
      coverageBps,
    );

  // --------------------------------------------------
  // 7. Display final result
  // --------------------------------------------------

  console.log(
    "\nAttested backing:",
    attestation.backing_quantity,
  );

  console.log(
    "On-chain supply:",
    onChainSupply,
  );

  console.log(
    "Mint matches:",
    mintMatches ? "YES" : "NO",
  );

  console.log(
    "Signature:",
    signatureValid
      ? "VALID"
      : "INVALID",
  );

  console.log(
    "Coverage:",
    `${(coverageBps / 100).toFixed(2)}%`,
  );

  console.log(
    "Status:",
    status,
  );

  console.log(
    "\nDocument hash:",
    documentHash.toString("hex"),
  );

  console.log("\n========================================");

  if (
    signatureValid &&
    mintMatches &&
    status === "VERIFIED"
  ) {
    console.log(
      "✅ DAY 3 LOCAL MODEL CHECK PASSED",
    );
  } else {
    console.log(
      "❌ DAY 3 LOCAL MODEL CHECK FAILED",
    );

    process.exitCode = 1;
  }

  console.log("========================================");
}

main().catch((error) => {
  console.error("\n❌ Fatal error:");
  console.error(error);
  process.exitCode = 1;
});

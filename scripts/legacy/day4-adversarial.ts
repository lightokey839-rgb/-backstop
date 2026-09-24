/**
 * LEGACY / HISTORICAL: day 4 of this project's build log.
 *
 * Adversarial tests against the local cryptographic-core model from
 * scripts/legacy/day1-cli-check.ts (wrong mint, expired attestation,
 * tampered signature, under-backed). It does not invoke the Backstop
 * program, and targets the same earlier test mint as day3, not the
 * current TSLA devnet mint.
 *
 * The real adversarial tests -- run against the actual deployed program
 * via LiteSVM -- live in programs/backstop/tests/backstop_litesvm.rs (see
 * wrong_attestor_cannot_submit, wrong_mint_cannot_be_used,
 * expired_snapshot_is_unsafe, under_backed_snapshot_is_unsafe,
 * fake_registry_attack_path_cannot_create_authoritative_registry, and the
 * attestor-rotation/expiry-cap tests added alongside them). Run those with
 * `npm run test:litesvm`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
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
  backing_quantity: number;
  timestamp: string;
  expires_at: string;
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

  return `{${Object.keys(object)
    .sort()
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

function coverageBps(
  backing: number,
  supply: number,
): number {
  return Math.floor((backing / supply) * 10_000);
}

function status(
  signatureValid: boolean,
  mintMatches: boolean,
  attestation: Attestation,
  coverage: number,
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

  if (coverage < 10_000) {
    return "UNDER_BACKED";
  }

  return "VERIFIED";
}

function createSignedAttestation(
  backing: number,
  mint: string = MINT_ADDRESS,
  expired = false,
) {
  const keypair = nacl.sign.keyPair();

  const attestation: Attestation = {
    attestation_id:
      `day4-${Date.now()}-${backing}`,
    asset_symbol: "SNDK",
    token_mint: mint,
    backing_quantity: backing,
    timestamp: new Date().toISOString(),
    expires_at: new Date(
      Date.now() +
        (expired ? -60_000 : 10 * 60_000),
    ).toISOString(),
  };

  const hash = hashAttestation(attestation);

  const signature = nacl.sign.detached(
    hash,
    keypair.secretKey,
  );

  return {
    attestation,
    hash,
    signature,
    publicKey: keypair.publicKey,
  };
}

function runTest(
  name: string,
  supply: number,
  signed: ReturnType<typeof createSignedAttestation>,
  expected:
    | "VERIFIED"
    | "UNDER_BACKED"
    | "STALE"
    | "INVALID"
    | "ASSET_MAPPING_ERROR",
  tamperSignature = false,
) {
  let signature = signed.signature;

  if (tamperSignature) {
    signature = new Uint8Array(signature);

    const firstByte = signature.at(0);
    if (firstByte === undefined) {
      throw new Error("Signature is unexpectedly empty");
    }
    signature[0] = firstByte ^ 0xff;
  }

  const signatureValid = nacl.sign.detached.verify(
    signed.hash,
    signature,
    signed.publicKey,
  );

  const mintMatches =
    signed.attestation.token_mint ===
    MINT_ADDRESS;

  const coverage = coverageBps(
    signed.attestation.backing_quantity,
    supply,
  );

  const result = status(
    signatureValid,
    mintMatches,
    signed.attestation,
    coverage,
  );

  const passed = result === expected;

  console.log(
    `${passed ? "✅" : "❌"} ${name}`,
  );

  console.log(
    `   Supply: ${supply}`,
  );

  console.log(
    `   Backing: ${signed.attestation.backing_quantity}`,
  );

  console.log(
    `   Coverage: ${(coverage / 100).toFixed(2)}%`,
  );

  console.log(
    `   Expected: ${expected}`,
  );

  console.log(
    `   Actual:   ${result}`,
  );

  console.log("");

  return passed;
}

async function main() {
  console.log("========================================");
  console.log(
    " BACKSTOP DAY 4 ADVERSARIAL MODEL TEST",
  );
  console.log("This script tests local helper logic only.");
  console.log("It does not invoke the Backstop program.");
  console.log("========================================\n");

  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed",
  );

  const mintInfo = await getMint(
    connection,
    new PublicKey(MINT_ADDRESS),
  );

  const onChainSupply =
    Number(mintInfo.supply);

  console.log(
    "Real on-chain supply:",
    onChainSupply,
  );

  console.log("");

  let passed = 0;
  let total = 0;

  // TEST 1: Healthy asset
  total++;
  if (
    runTest(
      "Healthy backing",
      onChainSupply,
      createSignedAttestation(
        10_000,
      ),
      "VERIFIED",
    )
  ) {
    passed++;
  }

  // TEST 2: Under-backed asset
  total++;
  if (
    runTest(
      "Under-backed asset",
      onChainSupply,
      createSignedAttestation(
        9_000,
      ),
      "UNDER_BACKED",
    )
  ) {
    passed++;
  }

  // TEST 3: Wrong mint
  total++;
  if (
    runTest(
      "Wrong token mint",
      onChainSupply,
      createSignedAttestation(
        10_000,
        Keypair.generate()
          .publicKey
          .toBase58(),
      ),
      "ASSET_MAPPING_ERROR",
    )
  ) {
    passed++;
  }

  // TEST 4: Expired attestation
  total++;
  if (
    runTest(
      "Expired attestation",
      onChainSupply,
      createSignedAttestation(
        10_000,
        MINT_ADDRESS,
        true,
      ),
      "STALE",
    )
  ) {
    passed++;
  }

  // TEST 5: Tampered signature
  total++;
  if (
    runTest(
      "Tampered signature",
      onChainSupply,
      createSignedAttestation(
        10_000,
      ),
      "INVALID",
      true,
    )
  ) {
    passed++;
  }

  console.log("========================================");
  console.log(
    `RESULT: ${passed}/${total} adversarial tests passed`,
  );
  console.log("========================================");

  if (passed !== total) {
    process.exitCode = 1;
  } else {
    console.log(
      "\n✅ DAY 4 ADVERSARIAL MODEL TESTS PASSED",
    );
  }
}

main().catch((error) => {
  console.error("\n❌ Fatal error:");
  console.error(error);
  process.exitCode = 1;
});

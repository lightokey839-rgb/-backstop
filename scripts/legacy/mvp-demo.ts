/**
 * LEGACY / HISTORICAL: an early, fully offline walkthrough of Backstop's
 * status model using hand-picked example numbers. No devnet RPC call, no
 * Backstop program transaction, no real reserve evidence -- see the
 * console output it prints for the same disclaimer at runtime.
 *
 * For a live, real demonstration, run the backend (`npm run backend`) and
 * open the dashboard, or run `npm run reconcile`.
 */
type SnapshotStatus = "VERIFIED" | "UNDER_BACKED";
type HealthState = SnapshotStatus | "STALE";

type Scenario = {
  name: string;
  asset: string;
  observedSupply: bigint;
  attestedBacking: bigint;
  expiresAt: number;
  now: number;
};

function calculateCoverageBps(
  observedSupply: bigint,
  attestedBacking: bigint,
): number {
  if (observedSupply === 0n) {
    return 10_000;
  }

  const coverage =
    (attestedBacking * 10_000n) / observedSupply;

  return Number(coverage > 10_000n ? 10_000n : coverage);
}

function snapshotStatus(
  observedSupply: bigint,
  attestedBacking: bigint,
): SnapshotStatus {
  return observedSupply <= attestedBacking
    ? "VERIFIED"
    : "UNDER_BACKED";
}

function healthState(
  status: SnapshotStatus,
  expiresAt: number,
  now: number,
): HealthState {
  if (now >= expiresAt) {
    return "STALE";
  }

  return status;
}

function isSafe(state: HealthState): boolean {
  return state === "VERIFIED";
}

function printScenario(scenario: Scenario): void {
  const coverageBps = calculateCoverageBps(
    scenario.observedSupply,
    scenario.attestedBacking,
  );
  const status = snapshotStatus(
    scenario.observedSupply,
    scenario.attestedBacking,
  );
  const state = healthState(
    status,
    scenario.expiresAt,
    scenario.now,
  );

  console.log(`\n${scenario.name}`);
  console.log(`Asset: ${scenario.asset}`);
  console.log(
    `Token supply: ${scenario.observedSupply.toString()}`,
  );
  console.log(
    `Attested backing: ${scenario.attestedBacking.toString()}`,
  );
  console.log(
    `Coverage: ${(coverageBps / 100).toFixed(2)}%`,
  );
  console.log(`Status: ${state}`);
  console.log(`Safe: ${isSafe(state)}`);
}

const now = 1_800_000_000;

const scenarios: Scenario[] = [
  {
    name: "SAFE",
    asset: "TSLA",
    observedSupply: 10_000n,
    attestedBacking: 10_000n,
    expiresAt: now + 300,
    now,
  },
  {
    name: "UNSAFE",
    asset: "TSLA",
    observedSupply: 10_500n,
    attestedBacking: 10_000n,
    expiresAt: now + 300,
    now,
  },
  {
    name: "STALE",
    asset: "TSLA",
    observedSupply: 10_000n,
    attestedBacking: 10_000n,
    expiresAt: now,
    now,
  },
];

console.log("Backstop MVP demo");
console.log(
  "Offline model demo: controlled examples, not an on-chain test or real reserve evidence.",
);

for (const scenario of scenarios) {
  printScenario(scenario);
}

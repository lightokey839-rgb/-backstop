const TSLA_MINT =
  "AznKjEBysg2hQXABxfquXNTTwavMz7mFMaBjYSUUX5fR";

const OPENAI_MINT =
  "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";

const mintInput = document.getElementById("mintInput");
const verifyButton = document.getElementById("verifyButton");
const dashboard = document.getElementById("dashboard");
const loading = document.getElementById("loading");
const errorBox = document.getElementById("errorBox");
const rawEvidence = document.getElementById("rawEvidence");
const rawToggle = document.getElementById("rawToggle");

function $(id) {
  return document.getElementById(id);
}

function formatNumber(value, decimals = 2) {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return String(value);
  }

  return number.toLocaleString(undefined, {
    maximumFractionDigits: decimals
  });
}

function formatPrice(value) {
  if (value === undefined || value === null || value === "") {
    return "—";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return String(value);
  }

  return `$${number.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  })}`;
}

function formatBoolean(value) {
  if (value === true) {
    return "PASS";
  }

  if (value === false) {
    return "FAIL";
  }

  return "—";
}

function statusClass(status) {
  if (!status) {
    return "status-unknown";
  }

  return `status-${String(status)
    .toLowerCase()
    .replace(/\s+/g, "_")}`;
}

function setStatus(elementId, status) {
  const element = $(elementId);

  if (!element) {
    return;
  }

  element.textContent = status || "UNKNOWN";
  element.className = `evidence-status ${statusClass(status)}`;
}

function setText(elementId, value) {
  const element = $(elementId);

  if (!element) {
    return;
  }

  element.textContent =
    value === undefined || value === null || value === ""
      ? "—"
      : String(value);
}

function setCheck(elementId, value) {
  const element = $(elementId);

  if (!element) {
    return;
  }

  element.textContent = formatBoolean(value);

  element.className =
    value === true
      ? "check-pass"
      : value === false
        ? "check-fail"
        : "";
}

function getPythPrice(pyth) {
  if (!pyth) {
    return null;
  }

  if (pyth.price !== undefined && typeof pyth.price === "number") {
    return pyth.price;
  }

  const rawPrice = Number(pyth.price);

  if (!Number.isFinite(rawPrice)) {
    return null;
  }

  const exponent = Number(pyth.exponent ?? 0);

  return rawPrice * Math.pow(10, exponent);
}

function getPythConfidence(pyth) {
  if (!pyth) {
    return null;
  }

  if (pyth.confidence === undefined) {
    return null;
  }

  const rawConfidence = Number(pyth.confidence);

  if (!Number.isFinite(rawConfidence)) {
    return null;
  }

  const exponent = Number(pyth.exponent ?? 0);

  return rawConfidence * Math.pow(10, exponent);
}

function renderReasons(reasons) {
  const container = $("verdictReasons");

  container.innerHTML = "";

  if (!Array.isArray(reasons) || reasons.length === 0) {
    return;
  }

  for (const reason of reasons) {
    const div = document.createElement("div");
    div.className = "reason";
    div.textContent = reason;
    container.appendChild(div);
  }
}

function renderSummary(evidenceDisplay) {
  const container = $("evidenceSummary");

  container.innerHTML = "";

  if (!evidenceDisplay) {
    return;
  }

  const entries = [
    ["Backstop", evidenceDisplay.backstop],
    ["PreStocks", evidenceDisplay.prestocks],
    ["Solana identity", evidenceDisplay.mainnetSolana],
    ["Pyth", evidenceDisplay.pyth]
  ];

  for (const [name, value] of entries) {
    if (!value) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "summary-item";

    const left = document.createElement("span");
    left.textContent = name;

    const right = document.createElement("span");
    right.textContent = value.status || "UNKNOWN";
    right.className = statusClass(value.status);

    row.appendChild(left);
    row.appendChild(right);

    container.appendChild(row);
  }
}

function renderBackstop(backstop) {
  if (!backstop) {
    setStatus("backstopStatus", "UNKNOWN");
    setText("backstopDetail", "No Backstop evidence returned.");
    return;
  }

  setStatus("backstopStatus", backstop.status);

  let detail = backstop.reason || "";

  if (backstop.safe === true) {
    detail = "Backstop on-chain checks are healthy.";
  }

  setText(
    "backstopDetail",
    detail || "Backstop evidence observed."
  );

  setText(
    "liveSupply",
    formatNumber(backstop.liveSupply, 6)
  );

  setText(
    "attestedBacking",
    formatNumber(backstop.attestedBacking, 6)
  );

  if (backstop.coverageBps !== undefined) {
    setText(
      "coverage",
      `${(Number(backstop.coverageBps) / 100).toFixed(2)}%`
    );
  } else {
    setText("coverage", "—");
  }

  const checks = backstop.checks || {};

  setCheck("snapshotVerified", checks.snapshotVerified);
  setCheck("backstopFresh", checks.fresh);
  setCheck(
    "supplyWithinBacking",
    checks.liveSupplyWithinBacking
  );
  setCheck("registryMatches", checks.registryMatches);
  setCheck("mintMatches", checks.mintMatches);
}

function renderPyth(pyth) {
  if (!pyth) {
    setStatus("pythStatus", "UNKNOWN");
    setText("pythDetail", "No Pyth evidence returned.");
    return;
  }

  setStatus("pythStatus", pyth.status);

  setText(
    "pythDetail",
    pyth.reason ||
      (pyth.status === "OBSERVED"
        ? "Pyth market-price evidence was observed."
        : "Pyth evidence is not applicable.")
  );

  const price = getPythPrice(pyth);

  if (price !== null) {
    setText("pythPrice", formatPrice(price));
  } else {
    setText("pythPrice", "—");
  }

  const confidence = getPythConfidence(pyth);

  if (confidence !== null) {
    setText("pythConfidence", formatPrice(confidence));
  } else {
    setText("pythConfidence", "—");
  }

  setText("pythExponent", pyth.exponent);

  const checks = pyth.checks || {};

  setCheck("pythFresh", checks.fresh);
  setCheck(
    "pythConfidenceCheck",
    checks.confidenceAcceptable
  );
  setCheck("pythUsable", checks.usable);
}

function renderPreStocks(prestocks) {
  if (!prestocks) {
    setStatus("prestocksStatus", "UNKNOWN");
    setText(
      "prestocksDetail",
      "No PreStocks evidence returned."
    );
    return;
  }

  setStatus("prestocksStatus", prestocks.status);

  setText(
    "prestocksDetail",
    prestocks.reason ||
      (prestocks.status === "OBSERVED"
        ? "PreStocks identity and market data were observed."
        : "PreStocks evidence is not applicable.")
  );

  setText(
    "prestocksName",
    prestocks.name || prestocks.symbol
  );

  setText(
    "prestocksPrice",
    formatPrice(prestocks.markPrice)
  );

  setText(
    "prestocksTokenPrice",
    formatPrice(prestocks.tokenPrice)
  );

  setText(
    "prestocksNetwork",
    prestocks.network || "mainnet-beta"
  );
}

function renderSolana(solana) {
  if (!solana) {
    setStatus("solanaStatus", "UNKNOWN");
    setText(
      "solanaDetail",
      "No Solana identity evidence returned."
    );
    return;
  }

  setStatus(
    "solanaStatus",
    solana.status || "OBSERVED"
  );

  setText(
    "solanaDetail",
    solana.reason ||
      "Solana token identity was observed."
  );

  setText(
    "solanaNetwork",
    solana.network
  );

  setText(
    "solanaProgram",
    solana.program
  );

  const parsed = solana.parsed || {};

  setText(
    "solanaDecimals",
    parsed.decimals
  );

  setText(
    "solanaSymbol",
    parsed.expectedSymbol
  );
}

function renderVerdict(verification) {
  const verdict = verification?.verdict || "UNKNOWN";

  const badge = $("verdictBadge");

  badge.textContent = verdict;
  badge.className =
    `verdict-badge verdict-${verdict.toLowerCase()}`;

  setText("verdictText", verdict);

  const icon = $("verdictIcon");

  if (verdict === "VERIFIED") {
    icon.textContent = "✓";
  } else if (verdict === "WARNING") {
    icon.textContent = "!";
  } else if (verdict === "DENY") {
    icon.textContent = "×";
  } else {
    icon.textContent = "•";
  }

  let summary = "";

  if (verdict === "VERIFIED") {
    summary =
      "The available evidence passed Backstop's configured health checks.";
  } else if (verdict === "WARNING") {
    summary =
      "Evidence was observed, but one or more verification layers are incomplete or not applicable.";
  } else if (verdict === "DENY") {
    summary =
      "The available evidence contains a failing condition.";
  } else {
    summary =
      "There is not enough applicable evidence to produce a verified result.";
  }

  setText("verdictSummary", summary);

  renderReasons(verification?.reasons);
}

function renderEvidence(data) {
  dashboard.classList.remove("hidden");

  const mint =
    data.mint ||
    data.asset?.mint ||
    mintInput.value.trim();

  const assetId =
    data.assetId ||
    data.symbol ||
    data.asset?.symbol ||
    "Unknown asset";

  setText("assetName", assetId);
  setText("assetMint", mint);

  const backstop = data.backstop;
  const prestocks = data.prestocks;
  const pyth = data.pyth;
  const solana = data.mainnetSolana;

  renderBackstop(backstop);
  renderPreStocks(prestocks);
  renderPyth(pyth);
  renderSolana(solana);
  renderVerdict(data.verification);

  renderSummary(data.verification?.evidenceDisplay);

  rawEvidence.textContent = JSON.stringify(
    data,
    null,
    2
  );
}

async function verifyAsset(mint) {
  const cleanMint = String(mint || "").trim();

  if (!cleanMint) {
    showError("Enter a Solana token mint.");
    return;
  }

  hideError();

  dashboard.classList.add("hidden");
  loading.classList.remove("hidden");

  verifyButton.disabled = true;
  verifyButton.textContent = "Checking...";

  try {
    const response = await fetch(
      `/assets/${encodeURIComponent(cleanMint)}/evidence`,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error ||
          data?.message ||
          `Request failed with HTTP ${response.status}`
      );
    }

    mintInput.value = cleanMint;

    renderEvidence(data);

    dashboard.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (error) {
    console.error(error);

    showError(
      error?.message ||
        "Unable to retrieve evidence from Backstop."
    );
  } finally {
    loading.classList.add("hidden");

    verifyButton.disabled = false;
    verifyButton.textContent = "Verify";
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function hideError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

verifyButton.addEventListener("click", () => {
  verifyAsset(mintInput.value);
});

mintInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    verifyAsset(mintInput.value);
  }
});

document.querySelectorAll(".quick-button").forEach((button) => {
  button.addEventListener("click", () => {
    const mint = button.dataset.mint;

    mintInput.value = mint;

    verifyAsset(mint);
  });
});

rawToggle.addEventListener("click", () => {
  const isHidden = rawEvidence.classList.contains("hidden");

  if (isHidden) {
    rawEvidence.classList.remove("hidden");
    rawToggle.textContent = "Hide raw evidence";
  } else {
    rawEvidence.classList.add("hidden");
    rawToggle.textContent = "Show raw evidence";
  }
});

async function checkHealth() {
  try {
    const response = await fetch("/health");

    if (!response.ok) {
      throw new Error("Backend health check failed");
    }

    return await response.json();
  } catch (error) {
    console.warn("Health check failed:", error);
    return null;
  }
}

checkHealth().then((health) => {
  if (health?.ok) {
    document.body.dataset.backend = "online";
  } else {
    document.body.dataset.backend = "offline";
  }
});
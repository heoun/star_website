/**
 * Google Sheets -> GitHub Actions dispatcher for listings sync.
 *
 * Supports:
 * - Manual publish from a custom Sheets menu ("Listings -> Publish Now")
 * - Optional debounced auto-publish via installable onEdit trigger
 *
 * Setup:
 * 1) In Apps Script project settings, add Script Properties:
 *    - GH_TOKEN (required, fine-grained token with Actions: Write + Contents: Read/Write on this repo)
 *    - GH_OWNER (optional, default: "heoun")
 *    - GH_REPO (optional, default: "star_website")
 *    - GH_WORKFLOW_FILE (optional, default: "sync-listings.yml")
 *    - GH_REF (optional, default: "main")
 *    - AUTO_COOLDOWN_SECONDS (optional, default: "300")
 * 2) Add an installable trigger for function autoPublishOnEdit if you want automatic push.
 */

const DEFAULT_SCRIPT_PROPERTIES = {
  GH_OWNER: "heoun",
  GH_REPO: "star_website",
  GH_WORKFLOW_FILE: "sync-listings.yml",
  GH_REF: "main",
  AUTO_COOLDOWN_SECONDS: "300"
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Listings")
    .addItem("Publish Now", "publishListingsNow")
    .addItem("Check Publish Config", "checkPublishConfig")
    .addToUi();
}

function publishListingsNow() {
  dispatchSyncWorkflow_({ force: true, reason: "manual_publish" });
}

function autoPublishOnEdit(e) {
  if (!e) {
    return;
  }
  dispatchSyncWorkflow_({ force: false, reason: "auto_edit" });
}

function checkPublishConfig() {
  const props = PropertiesService.getScriptProperties();
  ensureDefaultProperties_(props);

  const missing = [];
  if (!props.getProperty("GH_TOKEN")) {
    missing.push("GH_TOKEN");
  }

  const summary = [
    missing.length ? ("Missing: " + missing.join(", ")) : "Config looks valid.",
    "Owner: " + props.getProperty("GH_OWNER"),
    "Repo: " + props.getProperty("GH_REPO"),
    "Workflow: " + props.getProperty("GH_WORKFLOW_FILE"),
    "Ref: " + props.getProperty("GH_REF"),
    "Cooldown(s): " + props.getProperty("AUTO_COOLDOWN_SECONDS"),
    "Last dispatch at: " + (props.getProperty("LAST_DISPATCH_AT") || "never"),
    "Last dispatch reason: " + (props.getProperty("LAST_DISPATCH_REASON") || "n/a")
  ].join("\n");

  SpreadsheetApp.getUi().alert("Listings Publish Config", summary, SpreadsheetApp.getUi().ButtonSet.OK);
}

function dispatchSyncWorkflow_(options) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    const props = PropertiesService.getScriptProperties();
    ensureDefaultProperties_(props);
    const config = loadConfig_(props);

    if (!options.force && !canDispatchNow_(props, config.cooldownSeconds)) {
      Logger.log("Skipped dispatch due to cooldown window.");
      return;
    }

    const url =
      "https://api.github.com/repos/" +
      config.owner +
      "/" +
      config.repo +
      "/actions/workflows/" +
      encodeURIComponent(config.workflowFile) +
      "/dispatches";

    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      headers: {
        Authorization: "Bearer " + config.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      payload: JSON.stringify({ ref: config.ref })
    });

    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code < 200 || code >= 300) {
      throw new Error("GitHub dispatch failed (" + code + "): " + body);
    }

    const nowMs = Date.now();
    props.setProperty("LAST_DISPATCH_MS", String(nowMs));
    props.setProperty("LAST_DISPATCH_AT", new Date(nowMs).toISOString());
    props.setProperty("LAST_DISPATCH_REASON", options.reason || "unknown");
    Logger.log("Sync workflow dispatched successfully.");
  } finally {
    lock.releaseLock();
  }
}

function canDispatchNow_(props, cooldownSeconds) {
  const lastDispatchMs = Number(props.getProperty("LAST_DISPATCH_MS") || "0");
  if (!lastDispatchMs) {
    return true;
  }
  const cooldownMs = Math.max(0, cooldownSeconds) * 1000;
  return Date.now() - lastDispatchMs >= cooldownMs;
}

function ensureDefaultProperties_(props) {
  Object.keys(DEFAULT_SCRIPT_PROPERTIES).forEach(function (key) {
    if (!props.getProperty(key)) {
      props.setProperty(key, DEFAULT_SCRIPT_PROPERTIES[key]);
    }
  });
}

function loadConfig_(props) {
  const token = props.getProperty("GH_TOKEN");
  if (!token) {
    throw new Error("Missing GH_TOKEN in Script Properties.");
  }

  return {
    token: token,
    owner: props.getProperty("GH_OWNER"),
    repo: props.getProperty("GH_REPO"),
    workflowFile: props.getProperty("GH_WORKFLOW_FILE"),
    ref: props.getProperty("GH_REF"),
    cooldownSeconds: Number(props.getProperty("AUTO_COOLDOWN_SECONDS") || "300")
  };
}

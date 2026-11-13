// SMP version + self-update helpers.
//
// Single source of truth: the root package.json version. The server reads it at
// boot, the CLI prints it, and the panel compares it against the latest GitHub
// release (stable or pre-release) to decide whether an update is available.
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(__dirname, "../..");

// Change these two once the repository exists on GitHub. Until then the panel
// shows a "not configured" placeholder instead of calling a missing repository.
// SMP_REPO=owner/name overrides it (useful to test the check against any repo).
const DEFAULT_OWNER = "SMP-Panel";
const DEFAULT_NAME = "SMP";
export const REPO_SLUG = (process.env.SMP_REPO || "").trim() || `${DEFAULT_OWNER}/${DEFAULT_NAME}`;
export const REPO_OWNER = REPO_SLUG.split("/")[0] || "";
export const REPO_NAME = REPO_SLUG.split("/")[1] || "";

export const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases`;
export const RELEASES_LATEST_API = `${RELEASES_API}/latest`;
export const RELEASES_FEED = `https://github.com/${REPO_SLUG}/releases`;
export const REPO_CONFIGURED = Boolean(REPO_OWNER && REPO_NAME);

const USER_AGENT = "SMP-Panel";

/** Reads a package.json and returns its version, or null when unreadable. */
function readPackageVersion(pkgPath) {
  try {
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

/** The version the running panel was built from. */
export function appVersion() {
  return readPackageVersion(join(ROOT_DIR, "package.json")) || "0.0.0";
}

/** True for `1.2.3`, false for `1.2.3-rc.1` / `1.2.3-beta`. */
export function isStableVersion(version) {
  const v = String(version || "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * Comparison for dotted numeric versions (a pre-release sorts below the matching
 * stable release). Returns >0 when `a` is newer than `b`.
 */
export function compareVersions(a, b) {
  const parse = (v) => String(v || "0.0.0").trim().replace(/^v/i, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  const sa = String(a || "").includes("-") ? 1 : 0;
  const sb = String(b || "").includes("-") ? 1 : 0;
  return sa - sb;
}

/** Turns a GitHub tag (`v0.1.2`, `smp-0.1.2`) into a bare version. */
function normalizeTag(tag) {
  return String(tag || "").trim().replace(/^[^\d]*/, "");
}

async function githubFetch(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function pickNewest(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => compareVersions(normalizeTag(b.tag_name), normalizeTag(a.tag_name)))[0];
}

/**
 * Latest published release.
 *
 * Prefers the newest non-draft release (stable or pre-release) so the panel
 * always offers the most recent build, since the release workflow publishes a
 * pre-release on every push. Falls back to `/releases/latest` when the listing
 * cannot be read.
 */
export async function fetchLatestRelease() {
  if (!REPO_CONFIGURED) {
    const err = new Error("GitHub repository is not configured yet");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  let release = null;
  try {
    const list = await githubFetch(`${RELEASES_API}?per_page=30`);
    const published = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft);
    const stable = pickNewest(published.filter((r) => !r.prerelease));
    const pre = pickNewest(published.filter((r) => r.prerelease));
    // A pre-release can be newer than the last stable (0.1.1-rc > 0.1.0).
    if (stable && pre) release = compareVersions(normalizeTag(pre.tag_name), normalizeTag(stable.tag_name)) > 0 ? pre : stable;
    else release = stable || pre || null;
  } catch (e) {
    if (e?.code === "NOT_CONFIGURED" || e?.status === 404) throw e;
  }

  if (!release) release = await githubFetch(RELEASES_LATEST_API);
  const version = normalizeTag(release.tag_name);
  return {
    version,
    name: release.name || release.tag_name || version,
    isPrerelease: Boolean(release.prerelease),
    publishedAt: release.published_at || null,
    url: release.html_url || RELEASES_FEED,
    notes: release.body || "",
    configured: REPO_CONFIGURED,
    feedUrl: RELEASES_FEED,
  };
}

/**
 * Compares the running version with the latest release. Never throws: failures
 * come back as `{ ok: false, code, error }` so the UI can render a placeholder.
 */
export async function checkForUpdate() {
  const current = appVersion();
  try {
    const release = await fetchLatestRelease();
    return {
      ok: true,
      current,
      configured: REPO_CONFIGURED,
      checking: false,
      checkedAt: Date.now(),
      latest: release.version,
      latestName: release.name,
      isPrerelease: release.isPrerelease,
      publishedAt: release.publishedAt,
      releaseUrl: release.url,
      releaseNotes: release.notes,
      feedUrl: release.feedUrl,
      updateAvailable: compareVersions(release.version, current) > 0,
      error: null,
      code: null,
    };
  } catch (e) {
    const status = e?.status || 0;
    const notConfigured = e?.code === "NOT_CONFIGURED" || status === 404;
    const message = notConfigured
      ? `The GitHub repository ${REPO_SLUG} is not available yet.`
      : e?.message || String(e);
    return {
      ok: false,
      current,
      configured: REPO_CONFIGURED,
      checking: false,
      checkedAt: Date.now(),
      latest: null,
      latestName: null,
      isPrerelease: false,
      publishedAt: null,
      releaseUrl: null,
      releaseNotes: "",
      feedUrl: RELEASES_FEED,
      updateAvailable: false,
      error: message,
      code: notConfigured ? "NOT_CONFIGURED" : status === 403 ? "RATE_LIMITED" : "CHECK_FAILED",
    };
  }
}

export const EMPTY_UPDATE_STATE = Object.freeze({
  ok: null,
  current: "0.0.0",
  configured: false,
  checking: false,
  checkedAt: null,
  latest: null,
  latestName: null,
  isPrerelease: false,
  publishedAt: null,
  releaseUrl: null,
  releaseNotes: "",
  feedUrl: RELEASES_FEED,
  updateAvailable: false,
  error: null,
  code: null,
});

// One check per panel process: the sidebar dot and the settings view both ask.
let cachedState = { ...EMPTY_UPDATE_STATE, current: appVersion() };
let inFlight = null;
const MIN_CHECK_INTERVAL = 5 * 60 * 1000;

/** In-process cache so opening Settings does not re-hit the GitHub API. */
export async function getUpdateState({ force = false, minIntervalMs = MIN_CHECK_INTERVAL } = {}) {
  if (!force && inFlight) return inFlight;
  if (!force && cachedState.checkedAt && Date.now() - cachedState.checkedAt < minIntervalMs && !cachedState.checking) {
    return cachedState;
  }
  cachedState = { ...cachedState, checking: true, current: appVersion() };
  const run = (async () => {
    try {
      cachedState = await checkForUpdate();
    } finally {
      inFlight = null;
    }
    return cachedState;
  })();
  inFlight = run;
  return run;
}

/** Optimistic patch used while an update is being installed. */
export function setUpdateState(patch) {
  cachedState = { ...cachedState, ...patch };
  return cachedState;
}

export function peekUpdateState() {
  return cachedState;
}

/**
 * Installs the target release.
 *
 * Placeholder until the GitHub repository exists: it reports the step that would
 * run and the file that would be replaced, without touching the installation.
 *
 * When the repository is live this must:
 *   1. download the release asset (`smp.zip` / `smp.tar.gz`) plus its checksum,
 *   2. verify the checksum and unpack into a staging directory,
 *   3. stop the panel (the route already stopped every server),
 *   4. swap the installation directory and relaunch the launcher.
 *
 * Callers must stop every running server before calling this.
 */
export async function applyUpdate({ target = "", current = "" } = {}) {
  const wanted = String(target || "").trim();
  const from = String(current || "").trim();
  if (!from) {
    return { ok: false, code: "NO_VERSION", message: "The running version could not be read from package.json." };
  }
  if (!REPO_CONFIGURED) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "Self-update is not available yet: the GitHub repository is still a placeholder. Download the release manually from the releases page.",
      steps: [
        { id: "stop-servers", label: "Close all active servers", status: "done" },
        { id: "download", label: `Download ${wanted || "the latest release"} from GitHub`, status: "pending" },
        { id: "verify", label: "Verify the release checksum", status: "pending" },
        { id: "install", label: "Replace the installation files", status: "pending" },
        { id: "restart", label: "Restart the panel", status: "pending" },
      ],
    };
  }
  return {
    ok: false,
    code: "NOT_IMPLEMENTED",
    message: `The updater for ${REPO_SLUG} is not wired up yet.`,
    steps: [],
  };
}
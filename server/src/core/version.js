// SMP version + self-update helpers.
//
// Single source of truth: the root package.json version. The server reads it at
// boot, the CLI prints it, and the panel compares it against the GitHub releases
// of the selected channel (stable or experimental) to decide whether an update
// is available.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { tmpdir } from "os";
import AdmZip from "adm-zip";
import { x as untar } from "tar";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(__dirname, "../../..");

// The GitHub repository that publishes the releases this panel updates from.
// SMP_REPO=owner/name overrides it (useful to test against another repo).
const DEFAULT_OWNER = "cp-mario";
const DEFAULT_NAME = "SMP";
export const REPO_SLUG = (process.env.SMP_REPO || "").trim() || `${DEFAULT_OWNER}/${DEFAULT_NAME}`;
export const REPO_OWNER = REPO_SLUG.split("/")[0] || "";
export const REPO_NAME = REPO_SLUG.split("/")[1] || "";

export const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases`;
export const RELEASES_LATEST_API = `${RELEASES_API}/latest`;
export const RELEASES_FEED = `https://github.com/${REPO_SLUG}/releases`;
export const REPO_API = `https://api.github.com/repos/${REPO_SLUG}`;
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

// ============ CHANNELS ============
// stable        -> only releases published without the "pre-release" flag
// experimental  -> every published release, including pre-releases
export const CHANNELS = ["stable", "experimental"];
export const CHANNEL_LABELS = { stable: "Stable", experimental: "Experimental" };
export const CHANNEL_HINTS = {
  stable: "Only final releases. Recommended for everyday use.",
  experimental: "Pre-releases included: new builds arrive first, but may be unstable. ",
};

/** Accepts `experimental`, `exp`, `true`… and falls back to `stable`. */
export function normalizeChannel(channel) {
  const v = String(channel || "").trim().toLowerCase();
  return v.startsWith("exp") || v === "beta" || v === "pre" || v === "prerelease" || v === "true" || v === "1" ? "experimental" : "stable";
}

/**
 * Channel implied by the running version: a pre-release build (0.1.2-rc.1) starts
 * on experimental, a final one (0.1.2) on stable.
 */
export function defaultChannel(version = appVersion()) {
  return isStableVersion(version) ? "stable" : "experimental";
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

function toRelease(release) {
  const version = normalizeTag(release.tag_name);
  return {
    version,
    name: release.name || release.tag_name || version,
    isPrerelease: Boolean(release.prerelease),
    publishedAt: release.published_at || null,
    url: release.html_url || RELEASES_FEED,
    notes: release.body || "",
    assets: Array.isArray(release.assets) ? release.assets : [],
    configured: REPO_CONFIGURED,
    feedUrl: RELEASES_FEED,
  };
}

/** Distinguishes "no such repository" from "repository with no releases". */
async function assertRepoExists() {
  try {
    await githubFetch(REPO_API);
  } catch (e) {
    if (e?.status === 404) {
      const err = new Error(`The GitHub repository ${REPO_SLUG} does not exist.`);
      err.code = "NOT_CONFIGURED";
      throw err;
    }
    throw e;
  }
}

/**
 * Newest published release for a channel.
 *
 * experimental: every non-draft release, pre-releases included.
 * stable:       only releases published without the pre-release flag.
 *
 * Uses the GitHub API, which carries the prerelease flag and the release
 * assets, and falls back to the releases Atom feed (github.com, no API rate
 * limit) when the API answers 403 (rate limit exceeded).
 */
export async function fetchLatestRelease({ channel = "stable" } = {}) {
  if (!REPO_CONFIGURED) {
    const err = new Error("GitHub repository is not configured yet");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const wantPrerelease = normalizeChannel(channel) === "experimental";
  try {
    return await fetchLatestReleaseViaApi(wantPrerelease);
  } catch (e) {
    if (e?.status !== 403) throw e;
    return await fetchLatestReleaseViaFeed(wantPrerelease);
  }
}

async function fetchLatestReleaseViaApi(wantPrerelease) {
  let release = null;

  try {
    const list = await githubFetch(`${RELEASES_API}?per_page=30`);
    const published = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft);
    release = pickNewest(wantPrerelease ? published : published.filter((r) => !r.prerelease));
  } catch (e) {
    if (e?.code === "NOT_CONFIGURED" || e?.status === 403) throw e;
    if (e?.status !== 404) throw e;
    await assertRepoExists();
  }

  // Stable falls back to /releases/latest, which also ignores pre-releases.
  if (!release && !wantPrerelease) {
    release = await githubFetch(RELEASES_LATEST_API).catch(async (e) => {
      if (e?.status === 403) throw e;
      await assertRepoExists();
      const err = new Error("No stable release published yet.");
      err.code = "NO_RELEASES";
      throw err;
    });
  }

  if (!release) {
    const err = new Error(wantPrerelease ? "No releases published yet." : "No stable release published yet.");
    err.code = "NO_RELEASES";
    throw err;
  }

  return toRelease(release);
}

/** Extracts the tag names from the releases Atom feed (newest first). */
function parseFeedTags(xml) {
  const tags = [];
  for (const m of String(xml).matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const t = m[0].match(/<title>([^<]+)<\/title>/);
    if (t) tags.push(t[1].trim());
  }
  return tags;
}

/**
 * Rate-limit-proof fallback: the Atom feed lists every published release, and
 * /releases/latest redirects to the newest non-prerelease release page.
 */
async function fetchLatestReleaseViaFeed(wantPrerelease) {
  const noRelease = () => {
    const err = new Error(wantPrerelease ? "No releases published yet." : "No stable release published yet.");
    err.code = "NO_RELEASES";
    return err;
  };

  const res = await fetch(wantPrerelease ? `${RELEASES_FEED}.atom` : `${RELEASES_FEED}/latest`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw noRelease();
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }

  let tag = null;
  if (wantPrerelease) {
    tag = parseFeedTags(await res.text())[0] || null;
  } else {
    const title = (await res.text()).match(/<title>([^<]+)<\/title>/i)?.[1] || "";
    tag = title.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] || null;
  }

  if (!tag) throw noRelease();
  const version = normalizeTag(tag);
  return {
    version,
    name: tag,
    isPrerelease: wantPrerelease && version.includes("-"),
    publishedAt: null,
    url: `${RELEASES_FEED}/tag/${tag}`,
    notes: "",
    assets: [],
    configured: REPO_CONFIGURED,
    feedUrl: RELEASES_FEED,
  };
}

/**
 * Compares the running version with the channel's newest release. Never throws:
 * failures come back as `{ ok: false, code, error }` so the UI can render them.
 */
export async function checkForUpdate({ channel = "stable" } = {}) {
  const current = appVersion();
  const wanted = normalizeChannel(channel);
  const fallback = defaultChannel(current);

  try {
    const release = await fetchLatestRelease({ channel: wanted });
    return {
      ...emptyState(current, fallback, wanted),
      ok: true,
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
    const code = e?.code || (status === 403 ? "RATE_LIMITED" : "CHECK_FAILED");
    return {
      ...emptyState(current, fallback, wanted),
      ok: false,
      configured: REPO_CONFIGURED,
      checking: false,
      checkedAt: Date.now(),
      error: e?.message || String(e),
      code,
    };
  }
}

function emptyState(current, fallback, channel) {
  return {
    ...EMPTY_UPDATE_STATE,
    current: current || "0.0.0",
    defaultChannel: fallback,
    channel,
  };
}

export const EMPTY_UPDATE_STATE = Object.freeze({
  ok: null,
  current: "0.0.0",
  defaultChannel: "stable",
  channel: "stable",
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

// One check per channel and panel process: the sidebar dot and the settings view
// both ask for the same thing.
const cache = new Map();
const inFlight = new Map();
const MIN_CHECK_INTERVAL = 5 * 60 * 1000;

/** In-process cache so opening Settings does not re-hit the GitHub API. */
export async function getUpdateState({ force = false, channel = "", minIntervalMs = MIN_CHECK_INTERVAL } = {}) {
  const wanted = normalizeChannel(channel || readStoredChannel());
  const cached = cache.get(wanted);

  if (!force && cached?.checkedAt && Date.now() - cached.checkedAt < minIntervalMs && !cached.checking) return cached;
  if (!force && inFlight.has(wanted)) return inFlight.get(wanted);

  const pending = { ...EMPTY_UPDATE_STATE, current: appVersion(), defaultChannel: defaultChannel(), channel: wanted, checking: true };
  cache.set(wanted, pending);

  const run = (async () => {
    try {
      const state = await checkForUpdate({ channel: wanted });
      cache.set(wanted, state);
      return state;
    } finally {
      inFlight.delete(wanted);
    }
  })();
  inFlight.set(wanted, run);
  return run;
}

// The stored channel lives in the panel database; the route injects it so this
// module stays free of database imports.
let storedChannel = "";
export function setStoredChannel(channel) {
  storedChannel = normalizeChannel(channel);
}
function readStoredChannel() {
  return storedChannel;
}

export function peekUpdateState(channel = "") {
  return cache.get(normalizeChannel(channel || readStoredChannel())) || null;
}

// ============ SELF-UPDATE ============

// The panel exits with this code after handing an update to the detached updater
// when a terminal launcher (start.js) owns it. The launcher then waits for the
// file swap and restarts the panel in the foreground, so the terminal stays
// blocked and Ctrl+C keeps working. Must match start.js.
export const UPDATE_RESTART_EXIT = 86;

function updateSteps() {
  return [
    { id: "stop-servers", label: "Close all active servers", status: "done" },
    { id: "resolve", label: "Find the release on GitHub", status: "pending" },
    { id: "download", label: "Download the release source", status: "pending" },
    { id: "verify", label: "Verify the release checksum", status: "pending" },
    { id: "install", label: "Replace the installation files", status: "pending" },
    { id: "restart", label: "Restart the panel", status: "pending" },
  ];
}

function setStep(steps, id, status) {
  const step = steps.find((s) => s.id === id);
  if (step) step.status = status;
}

function fail(steps, id, code, message, extra = {}) {
  setStep(steps, id, "failed");
  return { ok: false, code, message, steps, ...extra };
}

/** The release record for an explicit version (no API call needed to apply it). */
function releaseForVersion(version) {
  const bare = String(version || "").trim().replace(/^v/i, "");
  return {
    version: bare,
    name: `v${bare}`,
    isPrerelease: bare.includes("-"),
    publishedAt: null,
    url: `${RELEASES_FEED}/tag/v${bare}`,
    notes: "",
    assets: [],
    configured: REPO_CONFIGURED,
    feedUrl: RELEASES_FEED,
  };
}

/**
 * Removes stage folders left behind by an update that failed (or whose panel
 * died before the updater could swap the files). A stage is only dropped once
 * the panel process that created it is gone.
 */
function cleanupStaleStages() {
  let names = [];
  try { names = readdirSync(ROOT_DIR); } catch { return; }
  for (const name of names) {
    const m = /^\.update-(\d+)-\d+$/.exec(name);
    if (!m) continue;
    const owner = Number(m[1]);
    if (owner === process.pid) continue;
    let alive = false;
    try { process.kill(owner, 0); alive = true; } catch { alive = false; }
    if (alive) continue;
    try { rmSync(join(ROOT_DIR, name), { recursive: true, force: true }); } catch { /* removed on the next update */ }
  }
}

/**
 * Detached updater: waits for the panel process to exit, moves the old
 * installation into a trash folder (same volume => instant rename), moves the
 * staged tree in its place, drops the trash and relaunches the launcher.
 * It runs from a temp directory so the installation can be wiped completely.
 * Everything is logged to <SMP_DATA_DIR|~/.smp>/update.log, and the relaunch
 * is verified: if the panel exits immediately it is retried once.
 */
const UPDATER_HELPER = `
import { spawn } from "child_process";
import { appendFileSync, openSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";

const [, , pidArg, stageDir, installDir, entry, statusFile, relaunchArg] = process.argv;
const pid = Number(pidArg);
// A terminal launcher (start.js) owns the panel: it stays alive across the swap
// and restarts the panel itself, so the user keeps control of the process.
const shouldRelaunch = relaunchArg !== "0";
const port = Number(process.env.SMP_PORT || process.env.PORT || 3001);
// The first launch after an update may install dependencies and build the web
// panel, so allow a generous window before declaring the relaunch failed.
const panelTimeoutMs = 300000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logPath = join(process.env.SMP_DATA_DIR || join(homedir(), ".smp"), "update.log");
const log = (msg) => { try { appendFileSync(logPath, "[" + new Date().toISOString() + "] " + msg + "\\n"); } catch {} };

/** Hands the swap result to the launcher waiting on the status file. */
function report(ok, extra) {
  if (!statusFile) return;
  try { writeFileSync(statusFile, JSON.stringify({ ok: ok, at: Date.now(), ...(extra || {}) })); } catch {}
}

async function waitExit(p, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(p, 0); } catch { return true; }
    await sleep(250);
  }
  return false;
}

/** True once the relaunched panel answers its health check. */
async function panelIsUp() {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const info = await res.json().catch(() => null);
    return Boolean(info && info.service === "smp");
  } catch {
    return false;
  }
}

/**
 * Waits for the panel to answer. The launcher installs dependencies and builds
 * the web app first, so this can take a while; it only gives up early when the
 * launcher died without ever starting the panel.
 */
async function waitPanel(timeoutMs, child) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await panelIsUp()) return true;
    if (child && child.exitCode !== null && child.exitCode !== 0) return false;
    await sleep(1000);
  }
  return false;
}

/** Starts the launcher again, detached from this helper, in the new tree. */
function relaunch() {
  let out = "ignore";
  try { mkdirSync(dirname(logPath), { recursive: true }); out = openSync(logPath, "a"); } catch {}
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: installDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, SMP_PORT: String(port), PORT: String(port), SMP_UPDATE_RELAUNCH: "1" },
    });
    child.on("error", (e) => log("relaunch: error: " + e.message));
    child.on("exit", (code) => log("relaunch: launcher exited with code " + code));
    child.unref();
    return child;
  } catch (e) {
    log("relaunch: spawn failed: " + e.message);
    return null;
  }
}

if (!pid || !stageDir || !installDir) process.exit(1);
log("updater started: pid=" + pid + " stage=" + stageDir + " install=" + installDir);
if (!(await waitExit(pid, 120000))) {
  log("updater: the panel did not exit; nothing was changed");
  report(false, { error: "the panel did not exit" });
  process.exit(1);
}
log("updater: panel exited");
await sleep(1000);

const stageBase = basename(stageDir);
const tree = join(stageDir, "tree");
const trash = join(stageDir, "trash");
if (!existsSync(tree)) {
  log("updater: no staged tree in " + stageDir + "; nothing was changed");
  report(false, { error: "the staged tree is missing" });
  process.exit(1);
}
mkdirSync(trash, { recursive: true });

// Move the old installation aside, then the new one in. A single entry that
// cannot be moved must not abort the swap half-way.
let failing = 0;
for (const name of readdirSync(installDir)) {
  if (name === stageBase) continue;
  try { renameSync(join(installDir, name), join(trash, name)); } catch (e) { failing++; log("updater: could not set aside " + name + ": " + e.message); }
}

for (const name of readdirSync(tree)) {
  try { renameSync(join(tree, name), join(installDir, name)); } catch (e) { failing++; log("updater: could not install " + name + ": " + e.message); }
}

log("updater: files swapped" + (failing ? " (" + failing + " entries failed, see above)" : ""));

try { rmSync(trash, { recursive: true, force: true }); } catch (e) { log("updater: could not remove trash: " + e.message); }
try { rmSync(stageDir, { recursive: true, force: true }); } catch (e) { log("updater: could not remove stage: " + e.message); }
log("updater: discarded " + stageBase);

// The terminal launcher (start.js) is still running and restarts the panel in
// the foreground, so the user keeps the terminal and can stop it with Ctrl+C.
if (!shouldRelaunch) {
  log("updater: files swapped; the terminal launcher will restart the panel");
  report(true);
  process.exit(0);
}

let child = relaunch();
let up = child ? await waitPanel(panelTimeoutMs, child) : false;
if (!up && child && child.exitCode !== null) {
  log("updater: the launcher exited without starting the panel; launching it again");
  await sleep(1000);
  child = relaunch();
  up = child ? await waitPanel(panelTimeoutMs, child) : false;
}
log("updater: " + (up ? "panel relaunched (http://localhost:" + port + ")" : "relaunch FAILED"));
if (!up) process.exit(1);
`;

/** Writes the helper to a temp dir and starts it detached for this panel PID. */
function spawnUpdater({ stage, installDir, entry, pid, relaunch = true, statusFile = "" }) {
  const helperPath = join(tmpdir(), `smp-update-${pid}-${Date.now()}.mjs`);
  writeFileSync(helperPath, UPDATER_HELPER);
  const child = spawn(process.execPath, [helperPath, String(pid), stage, installDir, entry, statusFile, relaunch ? "1" : "0"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = new Error(`Download failed: GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Source archive for a tag: zip on Windows (Expand-Archive), tar.gz elsewhere. */
function sourceArchiveUrl(tag) {
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  return { ext, url: `https://github.com/${REPO_SLUG}/archive/refs/tags/${encodeURIComponent(tag)}.${ext}` };
}

/**
 * Downloads the release source archive, trying the `v<version>` tag first and
 * the bare version tag second.
 */
async function downloadSource(version, destPath) {
  let lastErr = null;
  for (const tag of [`v${version}`, version]) {
    const { ext, url } = sourceArchiveUrl(tag);
    try {
      await downloadFile(url, destPath);
      return { ext, tag };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Download failed");
}

/**
 * Updates the installation the way the installers work: picks the channel's
 * release from GitHub (stable = final releases only, experimental =
 * pre-releases included), downloads the release source archive (tar.gz on
 * Linux/macOS, zip on Windows), stages it inside the installation directory,
 * then hands over to a detached updater that closes the panel and replaces every
 * old file with the new tree.
 *
 * When the panel was started by a terminal launcher (start.js sets
 * SMP_UPDATE_STATUS), the updater only swaps the files and reports back: the
 * launcher stays in the foreground and restarts the panel itself, so the
 * terminal keeps control of the process. Otherwise the updater relaunches the
 * launcher detached.
 *
 * ROOT_DIR is /opt/smp on Linux and %LOCALAPPDATA%\SMP on Windows, both
 * writable by the user running the panel (no admin needed).
 *
 * Callers must stop every running server before calling this. The panel (or
 * CLI) process must exit after this resolves for the swap to happen.
 */
export async function applyUpdate({ target = "", current = "", channel = "stable" } = {}) {
  const from = String(current || "").trim();
  const wanted = String(target || "").trim();
  const steps = updateSteps();

  if (!from) return fail(steps, "install", "NO_VERSION", "The running version could not be read from package.json.");
  if (!REPO_CONFIGURED) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "Self-update is not available: the GitHub repository is not configured. Download the release manually from the releases page.",
      steps,
    };
  }

  let release = null;
  let version = wanted.replace(/^v/i, "");

  try {
    release = wanted ? releaseForVersion(wanted) : await fetchLatestRelease({ channel });
    if (!release) return fail(steps, "resolve", "NO_RELEASE", `No release found for version ${wanted}.`);
    version = release.version;
    setStep(steps, "resolve", "done");

    if (compareVersions(version, from) <= 0) {
      return {
        ok: false,
        code: "UP_TO_DATE",
        message: `Already up to date (${from}).`,
        version: from,
        releaseUrl: release.url,
        steps,
      };
    }

    cleanupStaleStages();
    const stage = join(ROOT_DIR, `.update-${process.pid}-${Date.now()}`);
    mkdirSync(stage, { recursive: true });
    // Every failure before the detached updater takes over drops the stage, so
    // no `.update-*` folder is left behind in the installation directory.
    const stageFail = (id, code, message) => {
      try { rmSync(stage, { recursive: true, force: true }); } catch { /* removed by cleanupStaleStages */ }
      return fail(steps, id, code, message);
    };
    try {
      const archivePath = join(stage, "source");
      let downloaded;
      try {
        downloaded = await downloadSource(version, archivePath);
      } catch (e) {
        return stageFail("download", e?.status === 404 ? "NO_SOURCE" : "DOWNLOAD_FAILED", `Could not download the ${version} source archive: ${e?.message || e}`);
      }
      setStep(steps, "download", "done");

      // Checksum is optional: releases may publish `<archive>.sha256`.
      const sumAsset = release.assets.find((a) => a?.name === `${downloaded.tag}.${downloaded.ext}.sha256` || a?.name === `source.${downloaded.ext}.sha256`);
      let checksumVerified = false;
      if (sumAsset) {
        const sumPath = join(stage, "checksum.sha256");
        await downloadFile(sumAsset.browser_download_url, sumPath);
        const hex = (readFileSync(sumPath, "utf8").match(/\b[a-f0-9]{64}\b/i) || [])[0];
        if (!hex) return fail(steps, "verify", "CHECKSUM_INVALID", "The release checksum asset has no SHA-256 digest.");
        if (sha256File(archivePath).toLowerCase() !== hex.toLowerCase()) {
          return fail(steps, "verify", "CHECKSUM_MISMATCH", "Checksum mismatch: the downloaded source is corrupted.");
        }
        checksumVerified = true;
        setStep(steps, "verify", "done");
      } else {
        setStep(steps, "verify", "skipped");
      }

      const unpacked = join(stage, "unpacked");
      let srcRoot = unpacked;
      try {
        // `tar` extracts relative to an existing cwd (ENOENT otherwise), and
        // the zip path expects the folder to be there as well.
        mkdirSync(unpacked, { recursive: true });
        if (downloaded.ext === "zip") {
          new AdmZip(archivePath).extractAllTo(unpacked, true);
          // GitHub zips wrap the tree in a SMP-<version> folder.
          if (!existsSync(join(srcRoot, "package.json"))) {
            const entry = readdirSync(unpacked).find((n) => n.startsWith("SMP-") && existsSync(join(unpacked, n, "package.json")));
            if (entry) srcRoot = join(unpacked, entry);
          }
        } else {
          await untar({ file: archivePath, cwd: unpacked, strip: 1 });
        }
      } catch (e) {
        return stageFail("install", "EXTRACT_FAILED", `Could not unpack the source archive: ${e?.message || e}`);
      }

      if (!existsSync(join(srcRoot, "package.json"))) {
        return stageFail("install", "NO_SOURCE", "The archive does not look like an SMP source tree.");
      }

      // Build the new tree inside the stage (same volume => instant renames),
      // keeping the installed dependencies so the first launch is fast.
      const tree = join(stage, "tree");
      mkdirSync(tree, { recursive: true });
      for (const name of readdirSync(srcRoot)) renameSync(join(srcRoot, name), join(tree, name));

      // Release archives already exclude development-only files through
      // .gitattributes, but older archives (and local trees) may still carry
      // them: keep the installation as small as a fresh install.
      for (const rel of [".github", ".junie", "dev.js", "web/tests", "web/README.md", "web/scripts"]) {
        try { rmSync(join(tree, rel), { recursive: true, force: true }); } catch { /* best effort */ }
      }

      for (const rel of ["node_modules", "server/node_modules", "web/node_modules"]) {
        const old = join(ROOT_DIR, rel);
        const dst = join(tree, rel);
        if (existsSync(old) && !existsSync(dst)) {
          try { mkdirSync(dirname(dst), { recursive: true }); renameSync(old, dst); } catch { /* reinstalled on first launch */ }
        }
      }

      // Hand over to the detached updater and let this process exit.
      setStep(steps, "install", "pending");
      const entry = join(ROOT_DIR, "start.js");
      // start.js is attached to a terminal and stays alive across the swap: it
      // restarts the panel in the foreground (Ctrl+C keeps working) once the
      // updater reports the result. Without it the updater relaunches detached.
      const statusFile = process.env.SMP_UPDATE_STATUS || "";
      try {
        spawnUpdater({ stage, installDir: ROOT_DIR, entry, pid: process.pid, relaunch: !statusFile, statusFile });
      } catch (e) {
        return stageFail("install", "SPAWN_FAILED", `Could not start the updater: ${e?.message || e}`);
      }
      setStep(steps, "install", "done");
      setStep(steps, "restart", "done");

      return {
        ok: true,
        code: "OK",
        restarting: true,
        message: `SMP ${version} is being installed in ${ROOT_DIR}. The panel will close, update and restart.`,
        version,
        previousVersion: from,
        channel: normalizeChannel(channel),
        releaseUrl: release.url,
        checksumVerified,
        steps,
      };
    } catch (e) {
      // Extraction/tree failures happen before the updater takes over.
      rmSync(stage, { recursive: true, force: true });
      throw e;
    }
  } catch (e) {
    const status = e?.status || 0;
    const code = e?.code || (status === 403 ? "RATE_LIMITED" : "UPDATE_FAILED");
    return { ok: false, code, message: e?.message || String(e), steps };
  }
}
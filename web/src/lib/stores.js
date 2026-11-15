import { api, ApiError } from "./api.js";
export { api, ApiError };

const API_BASE = "/api";

const serverPath = (id) => encodeURIComponent(id);
const modPath = (serverId, modId) => `/servers/${encodeURIComponent(serverId)}/mods/${encodeURIComponent(modId)}`;

export async function loadServers({ updates = false } = {}) {
  const { servers } = await api(`/servers${updates ? "?updates=1" : ""}`, { cache: true });
  return servers || [];
}

export async function loadServer(id, { updates = true } = {}) {
  const data = await api(`/servers/${serverPath(id)}${updates ? "?updates=1" : "?updates=0"}`, { cache: true });
  return data?.server || data || null;
}

export async function loadLoaders() {
  const { loaders } = await api("/loaders");
  return loaders || [];
}

export async function allocatePorts(loader, requested = null) {
  return await api("/ports/allocate", { method: "POST", body: JSON.stringify({ loader, requested }), retries: 0 });
}

export async function checkPort(port, protocol = "tcp", { family = 4 } = {}) {
  return await api("/ports/check", { method: "POST", body: JSON.stringify({ port, protocol, family }), retries: 0 });
}

export async function loadMinecraftVersions() {
  const data = await api("/jar/versions?loader=vanilla&channel=release", { timeout: 45000 });
  const items = Array.isArray(data.items)
    ? data.items
    : (data.versions || []).map((v) => (typeof v === "string" ? { id: v } : v));
  const versions = items
    .filter((v) => v && v.stable !== false && /^\d+(?:\.\d+)+/.test(String(v.id)) && !/(pre|rc|beta|snapshot)/i.test(String(v.id)))
    .map((v) => String(v.id));
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
  return [...new Set(versions)];
}

/**
 * Managed runtimes offered by the panel. This index is fixed, so the settings
 * grid renders on first paint; only the installed flags come from the server.
 */
export const MANAGED_JAVA_VERSIONS = [
  { id: "8", major: 8, name: "Java 8 (LTS)", lts: true },
  { id: "11", major: 11, name: "Java 11 (LTS)", lts: true },
  { id: "17", major: 17, name: "Java 17 (LTS)", lts: true },
  { id: "21", major: 21, name: "Java 21 (LTS)", lts: true },
  { id: "22", major: 22, name: "Java 22", lts: false },
  { id: "23", major: 23, name: "Java 23", lts: false },
  { id: "24", major: 24, name: "Java 24", lts: false },
  { id: "25", major: 25, name: "Java 25 (LTS)", lts: true },
];

export async function loadJavaInstalled() {
  const data = await api("/java/installed");
  const installed = data.installed || [];
  return {
    installed,
    installedIds: installed.map((j) => String(j.id)),
    javaDir: data.javaDir || "",
  };
}

export async function loadJava() {
  try {
    const data = await api("/java");
    return {
      available: data.available || [],
      installed: data.installed || [],
      detected: data.detected || data.java || [],
      runtimes: data.runtimes || [],
      defaultVersion: data.defaultVersion || null,
      javaDir: data.javaDir || "",
    };
  } catch {
    const [runtimes, detected] = await Promise.all([api("/java/runtimes").catch(() => ({})), api("/java/detect").catch(() => ({}))]);
    return { available: [], installed: [], detected: detected.java || detected.detected || [], runtimes: runtimes.runtimes || [], defaultVersion: null, javaDir: "" };
  }
}

export async function installJavaVersion(version) {
  return await api("/java/install", { method: "POST", body: JSON.stringify({ version }), timeout: 600000 });
}

export async function uninstallJavaVersion(version) {
  return await api(`/java/${encodeURIComponent(version)}`, { method: "DELETE" });
}

export async function loadVersions(loader, channel = "all") {
  const data = await api(`/jar/versions?loader=${encodeURIComponent(loader)}&channel=${encodeURIComponent(channel)}`);
  const items = Array.isArray(data?.items) ? data.items : (data?.versions || []).map((id) => ({ id, stable: true, channel: "stable" }));
  return { items, latest: data?.latest || null, loader: data?.loader || null, channel: data?.channel || channel, error: data?.error || null };
}

export async function loadLatestVersion(loader, channel = "stable") {
  return await api(`/jar/latest?loader=${encodeURIComponent(loader)}&channel=${encodeURIComponent(channel)}`);
}

export async function loadLoaderVersions(loader, version, channel = "all") {
  if (!loader || !version) return { items: [], supported: false };
  const data = await api(`/jar/loader-versions?loader=${encodeURIComponent(loader)}&version=${encodeURIComponent(version)}&channel=${encodeURIComponent(channel)}`);
  const latest = (data?.latest && typeof data.latest === "object") ? data.latest : { default: data?.latest || null };
  return { items: Array.isArray(data?.items) ? data.items : [], supported: !!data?.supported, latest, error: data?.error || null, channel: data?.channel || channel };
}

export function installServerJar(loader, version, serverId, channel = "all", loaderBuild = "") {
  const lb = loaderBuild ? `&loaderVersion=${encodeURIComponent(loaderBuild)}` : "";
  return api(`/jar/download?loader=${encodeURIComponent(loader)}&version=${encodeURIComponent(version || "latest-stable")}&serverId=${encodeURIComponent(serverId)}&channel=${encodeURIComponent(channel)}${lb}`, { method: "GET", timeout: 300000, retries: 0 });
}

export async function createServer(data) {
  const { id } = await api("/servers", { method: "POST", body: JSON.stringify(data) });
  let install = null;
  let installError = null;
  try {
    install = await installServerJar(data.loader, data.loader_version, id, data.loader_channel || "all", data.loader_build || "");
  } catch (e) {
    installError = e?.message || String(e);
  }
  return { id, install, installError };
}

export async function updateServer(id, data) {
  return await api(`/servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data), timeout: 3600000, retries: 0 });
}

export async function addServerPort(id, data) {
  return await api(`/servers/${encodeURIComponent(id)}/ports`, { method: "POST", body: JSON.stringify(data), retries: 0 });
}

export async function autoFixServerPorts(id) {
  return await api(`/servers/${encodeURIComponent(id)}/ports/autofix`, { method: "POST", retries: 0 });
}

export async function updateServerPort(id, portId, data) {
  return await api(`/servers/${encodeURIComponent(id)}/ports/${encodeURIComponent(portId)}`, { method: "PATCH", body: JSON.stringify(data), retries: 0 });
}

export async function deleteServerPort(id, portId) {
  return await api(`/servers/${encodeURIComponent(id)}/ports/${encodeURIComponent(portId)}`, { method: "DELETE", retries: 0 });
}

export async function loadServerRaw(id) {
  const data = await api(`/servers/${encodeURIComponent(id)}/data/raw`);
  return data.row || {};
}

export async function saveServerRaw(id, row) {
  return await api(`/servers/${encodeURIComponent(id)}/data/raw`, { method: "POST", body: JSON.stringify(row) });
}

export async function updateModpack(id) {
  return await api(`/servers/${encodeURIComponent(id)}/update-modpack`, { method: "POST", timeout: 600000, retries: 0 });
}

export async function deleteServer(id) {
  return await api(`/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function acceptServerEula(serverId, accepted = true) {
  return await api(`/servers/${encodeURIComponent(serverId)}/eula`, { method: "POST", body: JSON.stringify({ accepted }) });
}

export async function startServer(id) {
  return await api(`/servers/${encodeURIComponent(id)}/start`, { method: "POST", timeout: 120000, retries: 0 });
}

export async function stopServer(id) {
  return await api(`/servers/${encodeURIComponent(id)}/stop`, { method: "POST", timeout: 3600000, retries: 0 });
}

export async function forceStopServer(id) {
  return await api(`/servers/${encodeURIComponent(id)}/force-stop`, { method: "POST", timeout: 30000, retries: 0 });
}

export async function restartServer(id) {
  return await api(`/servers/${encodeURIComponent(id)}/restart`, { method: "POST", timeout: 180000, retries: 0 });
}

export async function loadServerSftp(id) {
  return await api(`/servers/${encodeURIComponent(id)}/sftp`);
}

export async function saveMotd(serverId, value) {
  await api(`/servers/${encodeURIComponent(serverId)}/motd`, { method: "POST", body: JSON.stringify({ motd: value }) });
}

export async function searchMods(q, source = "modrinth", loader = null) {
  if (!q || q.length < 2) return [];
  const data = await api(`/mods/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}${loader ? "&loader=" + encodeURIComponent(loader) : ""}`);
  return data.results || [];
}

export async function loadModSources() {
  const data = await api("/mods/sources");
  return data.sources || [];
}

export async function searchStore({ q = "", source = "modrinth", type = "mod", loader = "", gameVersion = "", limit = 20, offset = 0, sort = "relevance" } = {}) {
  const params = new URLSearchParams({
    q, source, type,
    ...(loader ? { loader } : {}),
    ...(gameVersion ? { game_version: gameVersion } : {}),
    limit: String(limit),
    offset: String(offset),
    sort,
  });
  const data = await api(`/mods/search?${params.toString()}`);
  return {
    results: data.results || [],
    total: data.total || 0,
    offset: data.offset || 0,
    limit: data.limit || limit,
    configured: data.configured !== false,
    error: data.error || null,
  };
}

export async function loadStoreProject(source, projectId, { loader = "", gameVersion = "", includeVersions = false } = {}) {
  const params = new URLSearchParams({ source, project_id: projectId });
  if (loader) params.set("loader", loader);
  if (gameVersion) params.set("game_version", gameVersion);
  if (includeVersions) params.set("include_versions", "1");
  const data = await api(`/mods/project?${params.toString()}`);
  if (data.error) throw new Error(data.error);
  return { project: data.project || null, versions: data.versions || [] };
}

export async function loadStoreVersions(source, projectId, { loader = "", gameVersion = "", limit = 100 } = {}) {
  const params = new URLSearchParams({ source, project_id: projectId, limit: String(limit) });
  if (loader) params.set("loader", loader);
  if (gameVersion) params.set("game_version", gameVersion);
  const data = await api(`/mods/versions?${params.toString()}`);
  if (data.error) throw new Error(data.error);
  return data.versions || [];
}

export async function lookupModHash({ sha1 = "", sha512 = "", loader = "", gameVersion = "" } = {}) {
  const params = new URLSearchParams();
  if (sha1) params.set("sha1", sha1);
  if (sha512) params.set("sha512", sha512);
  if (loader) params.set("loader", loader);
  if (gameVersion) params.set("game_version", gameVersion);
  const data = await api(`/mods/hash?${params.toString()}`);
  return data.found ? data : null;
}

export async function loadModUpdates(serverId, { force = false } = {}) {
  const data = await api(`/servers/${encodeURIComponent(serverId)}/mods/updates${force ? "?force=1" : ""}`, { timeout: 120000, retries: 0 });
  return data.updates || [];
}

export async function updateMod(serverId, modId) {
  return await api(`/servers/${encodeURIComponent(serverId)}/mods/${encodeURIComponent(modId)}/update`, { method: "POST", timeout: 300000, retries: 0 });
}

export async function scanMods(serverId) {
  return await api(`/servers/${encodeURIComponent(serverId)}/mods/scan`, { method: "POST", timeout: 180000, retries: 0 });
}

export async function installModpack(data) {
  return await api("/servers/from-modpack", { method: "POST", body: JSON.stringify(data), timeout: 1800000, retries: 0 });
}

export async function uploadModpack(file) {
  const form = new FormData();
  form.append("file", file);
  return await apiUpload("/modpacks/upload", form, { timeout: 600000 });
}

export async function apiUpload(path, form, { method = "POST", headers = {}, timeout = 120000 } = {}) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer;
  if (ctrl) timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method, body: form, headers, signal: ctrl?.signal });
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) throw new ApiError((data && (data.error || data.message)) || text || `Upload failed (${res.status})`, { status: res.status, data });
    return data || {};
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError("Upload timed out");
    if (e instanceof ApiError) throw e;
    throw new ApiError(`Upload failed: ${e?.message || e}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadModVersions(projectId, { source = "modrinth", loader = null, gameVersion = "" } = {}) {
  return await loadStoreVersions(source, projectId, { loader: loader || "", gameVersion });
}

export async function installMod(targetId, mod) {
  return await api(`/servers/${encodeURIComponent(targetId)}/mods`, {
    method: "POST",
    body: JSON.stringify({ source: "modrinth", enabled: 1, ...mod }),
    timeout: 600000,
    retries: 0,
  });
}

export async function toggleMod(serverId, modId, enabled) {
  await api(modPath(serverId, modId), { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
}

export async function removeMod(serverId, modId) {
  await api(modPath(serverId, modId), { method: "DELETE" });
}

export async function createBackup(serverId, { name = "", protected: isProtected = false } = {}) {
  return await api(`/servers/${encodeURIComponent(serverId)}/backups`, {
    method: "POST",
    body: JSON.stringify({ name, protected: isProtected }),
    timeout: 3600000,
    retries: 0,
  });
}

export async function loadBackups(serverId) {
  return await api(`/servers/${encodeURIComponent(serverId)}/backups`);
}

export async function deleteBackups(serverId, ids) {
  return await api(`/servers/${encodeURIComponent(serverId)}/backups`, {
    method: "DELETE",
    body: JSON.stringify({ ids }),
    timeout: 3600000,
    retries: 0,
  });
}

export async function pruneBackups(serverId) {
  return await api(`/servers/${encodeURIComponent(serverId)}/backups/prune`, {
    method: "POST",
    timeout: 3600000,
    retries: 0,
  });
}

export async function renameBackup(serverId, backupId, { name, protected: isProtected } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (isProtected !== undefined) body.protected = isProtected;
  const res = await api(`/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res.backup || null;
}

export async function protectBackup(serverId, backupId, isProtected) {
  return await renameBackup(serverId, backupId, { protected: isProtected });
}

export async function deleteBackup(serverId, backupId) {
  await api(`/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}`, { method: "DELETE" });
}

export async function deleteAllBackups(serverId) {
  return await api(`/servers/${encodeURIComponent(serverId)}/backups`, { method: "DELETE", timeout: 3600000, retries: 0 });
}

export async function restoreBackup(serverId, backupId) {
  return await api(`/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}/restore`, {
    method: "POST",
    timeout: 3600000,
    retries: 0,
  });
}

export function backupDownloadUrl(serverId, backupId, format = "tar.zst") {
  const fmt = format === "zip" ? "zip" : "tar.zst";
  return `${API_BASE}/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}/download?format=${fmt}`;
}

export async function saveSettings(key, value) {
  await api("/settings", { method: "POST", body: JSON.stringify({ key, value }) });
}

export async function loadSettings() {
  const { settings } = await api("/settings");
  return settings || {};
}

export async function loadSystemInfo() {
  return await api("/system");
}

export async function uploadFile(serverId, path, file, { onProgress = null } = {}) {
  const form = new FormData();
  form.append("file", file);
  const suffix = path ? "?path=" + encodeURIComponent(path) : "";
  if (!onProgress || typeof XMLHttpRequest === "undefined") {
    const res = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}/upload${suffix}`, { method: "POST", body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      throw new ApiError((data && (data.error || data.message)) || text || `Upload failed (${res.status})`, { status: res.status, data });
    }
    return res.json();
  }

  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/servers/${encodeURIComponent(serverId)}/upload${suffix}`);
    xhr.upload.addEventListener("error", () => reject(new ApiError("Upload failed (network error)")));
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total, percent: Math.round((e.loaded / e.total) * 100) });
    });
    xhr.addEventListener("load", () => {
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* keep text */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data || {});
      reject(new ApiError((data && (data.error || data.message)) || `Upload failed (${xhr.status})`, { status: xhr.status, data }));
    });
    xhr.addEventListener("error", () => reject(new ApiError("Upload failed (network error)")));
    xhr.send(form);
  });
}

// ---------- Panel updates ----------

/** Cached server-side state: current version plus the latest release of a channel. */
export async function loadUpdateState(channel) {
  const q = channel ? `?channel=${encodeURIComponent(channel)}` : "";
  return await api(`/updates${q}`, { retries: 0, timeout: 25000 });
}

/** Forces a fresh check against the GitHub releases feed. */
export async function checkForUpdate(channel) {
  return await api("/updates/check", { method: "POST", body: JSON.stringify(channel ? { channel } : {}), retries: 0, timeout: 25000 });
}

/** Stops every running server and applies the target release. */
export async function applyUpdate(version, channel) {
  return await api("/updates/apply", { method: "POST", body: JSON.stringify(channel ? { version, channel } : { version }), retries: 0, timeout: 300000 });
}

/** Stops every running server and exits the panel process. */
export async function shutdownPanel(reason = "Panel shutdown requested from the web UI") {
  return await api("/updates/shutdown", { method: "POST", body: JSON.stringify({ reason }), retries: 0, timeout: 30000 });
}

// ---------- Danger zone ----------

/** Data directory (`~/.smp` by default) and the panel installation directory. */
export async function loadPanelPaths() {
  return await api("/panel/paths", { retries: 0 });
}

/**
 * Deletes servers, managed Java runtimes, the panel installation or everything.
 * `confirm` must be the exact phrase the second confirmation step asks for.
 * Server/Java-only wipes keep the panel running; the panel install closes it.
 */
export async function wipePanelData(scope, confirm) {
  return await api("/panel/wipe", { method: "POST", body: JSON.stringify({ scope, confirm }), retries: 0, timeout: 60000 });
}

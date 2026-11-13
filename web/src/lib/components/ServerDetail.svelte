<script>
  import { onMount, onDestroy } from "svelte";
  import {
    api, startServer, stopServer, forceStopServer, restartServer, removeMod,
    deleteServer, updateServer, updateModpack, installServerJar, loadLoaders,
    addServerPort, updateServerPort, deleteServerPort, autoFixServerPorts,
    loadSystemInfo, loadServer, loadJava,
    loadModUpdates, updateMod, scanMods, uploadFile, loadServerRaw, saveServerRaw,
  } from "../stores.js";
  import { toasts } from "../toast.js";
  import { router } from "../router.js";
  import ConsolePanel from "./dashboard/ConsolePanel.svelte";
  import FileManager from "./dashboard/FileManager.svelte";
  import ResourceGraph from "./dashboard/ResourceGraph.svelte";
  import MemoryJvmInput from "./MemoryJvmInput.svelte";
  import StoreBrowser from "./StoreBrowser.svelte";
  import { shortHash, modFolderForLoader } from "../storeBrowser.js";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import Alert from "./ui/Alert.svelte";
  import Panel from "./ui/Panel.svelte";
  import Tabs from "./ui/Tabs.svelte";
  import Modal from "./ui/Modal.svelte";
  import TextField from "./ui/TextField.svelte";
  import TextArea from "./ui/TextArea.svelte";
  import Select from "./ui/Select.svelte";
  import Switch from "./ui/Switch.svelte";
  import Spinner from "./ui/Spinner.svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import KeyValueList from "./ui/KeyValueList.svelte";
  import ConfirmDialog from "./ui/ConfirmDialog.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import Icon from "./ui/Icon.svelte";
  import MotdModal from "./server/MotdModal.svelte";
  import LoaderModal from "./server/LoaderModal.svelte";
  import BackupsTab from "./server/BackupsTab.svelte";

  let { id } = $props();

  let server = $state(null);
  let loading = $state(true);
  let loadError = $state("");
  let activeTab = $state("console");
  let busy = $state("");
  let statusTimer = null;
  let cleanupExtra = null;

  let sftp = $state(null);
  let sftpCopied = $state(false);
  let sftpCopyTimer = null;

  let showDeleteModal = $state(false);
  let deleteBusy = $state(false);

  let showForceStopModal = $state(false);
  let forceStopBusy = $state(false);

  let showRawModal = $state(false);
  let rawText = $state("");
  let rawOriginal = $state("");
  let rawError = $state("");
  let rawBusy = $state(false);
  let rawAck = $state(false);

  let showLoaderModal = $state(false);
  let loaders = $state([]);

  let updateBusy = $state(false);
  let updatesBusy = $state(false);
  let portEdits = $state({});
  let portBusy = $state(false);
  let extraLabel = $state("");
  let extraPort = $state("");
  let extraProtocol = $state("tcp");
  let extraBusy = $state(false);
  let autoBusy = $state(false);
  let portPanelEl = $state(null);
  let systemInfo = $state(null);
  let javaRuntimes = $state([]);
  let jvmEdit = $state({ memoryMb: 2048, jvmArgs: "", javaVersion: "21", saving: false });
  let jvmPanelEl = $state(null);
  let customCommand = $state("");
  let customCommandBusy = $state(false);
  let customCommandEl = $state(null);

  let modUpdates = $state([]);
  let updatesLoading = $state(false);
  let updateAllBusy = $state(false);
  let scanBusy = $state(false);
  let modDropActive = $state(false);
  let modUploadBusy = $state(false);
  let modFileInput = $state(null);
  let storeOpen = $state(false);
  let storeTarget = $state("");
  let modsLoadedOnce = $state(false);
  const updatesById = $derived(Object.fromEntries((modUpdates || []).map((u) => [u.mod_id, u])));
  const updateCount = $derived((modUpdates || []).length);

  let showMotdModal = $state(false);
  let iconNonce = $state(Date.now());
  let iconError = $state(false);

  const canEditJvm = $derived(!!server && (server.java === true || (loaders.find((l) => l.id === server.loader)?.java === true)));
  const isBedrock = $derived(server?.loader === "bedrock");
  const isEndstone = $derived(server?.loader === "endstone");
  const loaderName = $derived(loaders.find((l) => l.id === server?.loader)?.name || server?.loader || "Vanilla");
  const packName = $derived(server?.modpack?.title || "Modpack");
  const packVersion = $derived(server?.modpack?.version || server?.modpack?.version_id || "—");
  const editablePorts = $derived(server?.ports || []);
  const isCustomLoader = $derived(server?.loader === "custom" || server?.loader_custom === true);
  const visiblePorts = $derived(isCustomLoader ? (server?.ports || []).filter((p) => p.custom) : (server?.ports || []));
  const strictPorts = $derived(!!server?.strict_ports);
  const customCommandSaved = $derived(commandText(server?.exec));
  const customCommandDirty = $derived(!!server && customCommand.trim() !== customCommandSaved.trim());
  const connections = $derived.by(() => {
    if (!server) return [];
    const rows = [];
    const push = (label, port, protocol) => {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return;
      const proto = String(protocol || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
      const key = `${proto}:${n}`;
      if (rows.some((r) => r.key === key)) return;
      rows.push({ key, label, address: `localhost:${n}`, protocol: proto.toUpperCase() });
    };
    const ports = server.ports || [];
    const game = ports.find((p) => p.role === "game");
    const gamePort = game?.port ?? server.port;
    if (server.loader === "bedrock" || server.loader === "endstone") {
      push(server.loader === "endstone" ? "Bedrock (Endstone)" : "Bedrock", gamePort, game?.protocol || "udp");
    } else {
      push(server.loader === "velocity" ? "Java (proxy)" : "Java", gamePort, game?.protocol || "tcp");
      const bedrock = ports.find((p) => p.role === "bedrock");
      if (bedrock) push("Bedrock", bedrock.port, bedrock.protocol);
    }
    for (const p of ports) {
      if (p.custom && /geyser|bedrock/i.test(String(p.label || ""))) push(p.label, p.port, p.protocol);
    }
    return rows;
  });
  const portDirty = $derived(editablePorts.some((p) => String(portEdits[p.role] ?? p.port) !== String(p.port)));
  const portHelp = $derived((isBedrock || isEndstone) ? {
    game: "Jugadores por IPv4 (server-port, UDP)",
    game_v6: "Jugadores por IPv6 (server-portv6, UDP)",
  } : {
    game: "Player connections (Java: server-port, TCP 25565)",
    query: "Server list / monitoring query (UDP; follows the game port by default)",
    rcon: "Remote console for admin tools (TCP 25575)",
    game_v6: "Bedrock IPv6 listener (UDP)",
    bedrock: "Bedrock Edition listener (UDP)",
  });
  const jvmDirty = $derived(!!server && (
    jvmEdit.memoryMb !== parseMemMb(server.memory_max) ||
    (jvmEdit.jvmArgs || "") !== (server.jvm_args || "") ||
    (jvmEdit.javaVersion || "") !== (server.java_version || "21")
  ));

  function parseMemMb(v) {
    const m = String(v || "").match(/^(\d+)\s*(G|GB|M|MB)?$/i);
    if (!m) return 2048;
    const n = parseInt(m[1], 10);
    const u = (m[2] || "M").toUpperCase();
    return u === "G" || u === "GB" ? n * 1024 : n;
  }

  function parseExecValue(value) {
    if (!value) return null;
    if (typeof value === "object" && !Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(String(value));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function commandText(value) {
    const exec = parseExecValue(value);
    if (!exec) return "";
    if (typeof exec.raw === "string" && exec.raw.trim()) return exec.raw.trim();
    const command = String(exec.command || "").trim();
    if (!command) return "";
    const args = Array.isArray(exec.args) ? exec.args.map((a) => String(a)) : [];
    return [command, ...args].join(" ");
  }

  function splitCommand(raw) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    const text = String(raw || "");
    while ((match = re.exec(text))) tokens.push(match[1] ?? match[2] ?? match[3]);
    return tokens;
  }

  async function loadDetail({ quiet = false, updates = false } = {}) {
    try {
      const data = await loadServer(id, { updates });
      // Quiet polls do not refetch update info; keep the last known result so the
      // Settings panel does not flicker or lose its update button every 5 seconds.
      if (!updates && server) {
        if (data.update == null && server.update) data.update = server.update;
        if (data.modpack) data.modpack = { ...data.modpack, ...server.modpack, update: data.modpack.update || server.modpack?.update || null };
        else if (server.modpack) data.modpack = server.modpack;
      }
      // The 5s poll must not repaint the whole page when nothing changed.
      if (typeof data.has_icon === "boolean") iconError = !data.has_icon;
      const changed = !server || JSON.stringify(server) !== JSON.stringify(data);
      // Never overwrite the field the user is typing in (the source of the "jumping" inputs).
      const editingJvm = !!(jvmPanelEl && typeof document !== "undefined" && jvmPanelEl.contains(document.activeElement));
      const editingPort = !!(portPanelEl && typeof document !== "undefined" && portPanelEl.contains(document.activeElement));
      const editingCommand = !!(customCommandEl && typeof document !== "undefined" && customCommandEl.contains(document.activeElement));
      if (changed) server = data;
      if (!editingPort) syncPortEdits();
      if (!editingJvm) {
        const source = server || data;
        jvmEdit.memoryMb = parseMemMb(source.memory_max);
        jvmEdit.jvmArgs = source.jvm_args || "";
        jvmEdit.javaVersion = source.java_version || "21";
      }
      if (!editingCommand) customCommand = commandText((server || data).exec);
      if (!quiet || !editingJvm) loadError = "";
    } catch (e) {
      if (!quiet && !server) loadError = e?.message || String(e);
    } finally {
      loading = false;
    }
  }

  async function loadSftp() {
    try {
      const data = await api(`/servers/${id}/sftp`);
      if (!sftp || JSON.stringify(sftp) !== JSON.stringify(data)) sftp = data;
    } catch {
      if (!sftp) sftp = null;
    }
  }

  function sftpUri() {
    if (!sftp) return null;
    const host = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : (sftp.host || "127.0.0.1");
    return `sftp://${encodeURIComponent(sftp.username || "")}@${host}:${sftp.port || 2222}/`;
  }

  async function copySftpUri() {
    const uri = sftpUri();
    if (!uri) return;
    try {
      await navigator.clipboard.writeText(uri);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = uri;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { toasts.error("Could not copy the SFTP address"); }
      ta.remove();
    }
    sftpCopied = true;
    if (sftpCopyTimer) clearTimeout(sftpCopyTimer);
    sftpCopyTimer = setTimeout(() => { sftpCopied = false; }, 1800);
  }

  function openSftp() {
    const uri = sftpUri();
    if (!uri) return;
    if (!sftp?.enabled) return toasts.warning("Enable SFTP in the Files tab first.");
    if (!sftp?.hasPassword) return toasts.warning("Set an SFTP password in the Files tab first.");
    window.location.href = uri;
  }

  onMount(() => {
    let cancelled = false;
    (async () => {
      try { systemInfo = await loadSystemInfo(); } catch { systemInfo = null; }
      try { loaders = await loadLoaders(); } catch { loaders = []; }
      try { javaRuntimes = (await loadJava()).runtimes || []; } catch { javaRuntimes = []; }
      if (cancelled) return;
      await Promise.all([loadDetail({ updates: true }), loadSftp()]);
      if (cancelled) return;
      // Polling only while the tab is visible: a background panel should not keep
      // hitting the API every 5 s (battery / CPU / server load).
      const poll = () => {
        if (document.visibilityState === "hidden") return;
        loadDetail({ quiet: true }); loadSftp();
      };
      statusTimer = setInterval(poll, 5000);
      const onSrv = () => loadDetail({ quiet: true });
      const onVisible = () => { if (document.visibilityState === "visible") poll(); };
      window.addEventListener("smp:server-changed", onSrv);
      document.addEventListener("visibilitychange", onVisible);
      cleanupExtra = () => {
        if (statusTimer) clearInterval(statusTimer);
        window.removeEventListener("smp:server-changed", onSrv);
        document.removeEventListener("visibilitychange", onVisible);
      };
    })();
    return () => { cancelled = true; cleanupExtra?.(); };
  });

  onDestroy(() => {
    if (sftpCopyTimer) clearTimeout(sftpCopyTimer);
  });

  async function runAction(label, fn, okMessage) {
    busy = label;
    try {
      await fn();
      await loadDetail({ quiet: true });
      if (okMessage) toasts.success(okMessage);
    } catch (e) {
      if (e?.data?.eulaRequired) window.dispatchEvent(new CustomEvent("smp:eula", { detail: { id, action: label } }));
      else toasts.error(`${label} failed`, e);
    } finally {
      busy = "";
    }
  }

  const handleStart = () => runAction("start", () => startServer(id), "Server started");
  const handleStop = () => runAction("stop", () => stopServer(id), "Server stopped");
  const handleRestart = () => runAction("restart", () => restartServer(id), "Server restarted");
  const handleRemoveMod = (modId) => runAction("mods", async () => { await removeMod(id, modId); }, "Mod removed");

  async function handleForceStop() {
    if (!server || forceStopBusy) return;
    forceStopBusy = true;
    try {
      const res = await forceStopServer(id);
      showForceStopModal = false;
      await loadDetail({ quiet: true });
      if (res?.stopped === false) toasts.warning(res?.message || "The server process was not running in this panel session.");
      else toasts.success("Server process killed");
    } catch (e) {
      toasts.error("Could not force stop the server", e);
    } finally {
      forceStopBusy = false;
    }
  }

  async function saveJvmSettings() {
    if (!server || !canEditJvm || !jvmDirty || jvmEdit.saving) return;
    jvmEdit.saving = true;
    try {
      await updateServer(id, { memory_max: `${jvmEdit.memoryMb}M`, jvm_args: jvmEdit.jvmArgs, java_version: jvmEdit.javaVersion || "" });
      await loadDetail({ quiet: true });
      toasts.success("Java / RAM / JVM saved. Restart the server to apply Java changes.");
    } catch (e) {
      toasts.error("Could not save settings", e);
    } finally {
      jvmEdit.saving = false;
    }
  }

  async function saveCustomCommand() {
    if (!server || !isCustomLoader || customCommandBusy || !customCommandDirty) return;
    const raw = customCommand.trim();
    const tokens = splitCommand(raw);
    if (!tokens.length) return toasts.error("Write the full start command");
    const [command, ...args] = tokens;
    customCommandBusy = true;
    try {
      await updateServer(id, { exec: { type: "custom", command, args, jar: server.jar || "server.jar", manual: true, raw } });
      await loadDetail({ quiet: true });
      toasts.success("Start command saved. Restart the server to apply it.");
    } catch (e) {
      toasts.error("Could not save the start command", e);
    } finally {
      customCommandBusy = false;
    }
  }

  function syncPortEdits() {
    const edits = {};
    for (const p of server?.ports || []) edits[p.role] = String(p.port);
    portEdits = edits;
  }

  async function savePorts() {
    if (!server || !portDirty || portBusy) return;
    const loaderPorts = {};
    const extraPorts = [];
    for (const p of server.ports || []) {
      const value = Number(portEdits[p.role]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return toasts.error(`${p.label}: port must be between 1 and 65535`);
      }
      if (value === Number(p.port)) continue;
      if (p.custom && p.id) extraPorts.push({ id: p.id, port: value });
      else loaderPorts[p.role] = value;
    }
    if (!Object.keys(loaderPorts).length && !extraPorts.length) return;
    portBusy = true;
    try {
      if (Object.keys(loaderPorts).length) await updateServer(id, { ports: loaderPorts });
      for (const ep of extraPorts) await updateServerPort(id, ep.id, { port: ep.port });
      await loadDetail({ quiet: true });
      syncPortEdits();
      toasts.success(`Ports saved${server.online === 1 ? " · restart to apply" : ""}`);
    } catch (e) {
      toasts.error("Could not save ports", e);
      await loadDetail({ quiet: true }).catch(() => {});
    } finally {
      portBusy = false;
    }
  }

  async function addExtraPort() {
    if (!server || extraBusy) return;
    const label = extraLabel.trim();
    const port = Number(extraPort);
    if (!label) return toasts.error("Give the port a name (for example Geyser)");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return toasts.error("Port must be between 1 and 65535");
    }
    extraBusy = true;
    try {
      await addServerPort(id, { label, port, protocol: extraProtocol });
      extraLabel = "";
      extraPort = "";
      await loadDetail({ quiet: true });
      syncPortEdits();
      toasts.success(`Reserved ${extraProtocol.toUpperCase()} ${port} for ${label}`);
    } catch (e) {
      toasts.error("Could not reserve port", e);
    } finally {
      extraBusy = false;
    }
  }

  async function removeExtraPort(p) {
    if (extraBusy || !p?.id) return;
    extraBusy = true;
    try {
      await deleteServerPort(id, p.id);
      await loadDetail({ quiet: true });
      syncPortEdits();
      toasts.success(`Released ${p.label} (${p.protocol.toUpperCase()} ${p.port})`);
    } catch (e) {
      toasts.error("Could not release port", e);
    } finally {
      extraBusy = false;
    }
  }

  async function autoFixPorts() {
    if (!server || autoBusy) return;
    autoBusy = true;
    try {
      const res = await autoFixServerPorts(id);
      await loadDetail({ quiet: true });
      syncPortEdits();
      const moved = res?.moved || [];
      toasts.success(moved.length ? `Moved ${moved.length} port(s) to free values` : "All ports are already free");
    } catch (e) {
      toasts.error("Could not auto-assign ports", e);
      await loadDetail({ quiet: true }).catch(() => {});
    } finally {
      autoBusy = false;
    }
  }

  async function setStrictPorts(checked) {
    if (!server) return;
    try {
      await updateServer(id, { strict_ports: checked });
      await loadDetail({ quiet: true });
      toasts.success(checked ? "Strict port mode enabled" : "Strict port mode disabled");
    } catch (e) {
      toasts.error("Could not change strict port mode", e);
      await loadDetail({ quiet: true }).catch(() => {});
    }
  }

  function openDeleteModal() { showDeleteModal = true; }

  async function handleDeleteServer() {
    if (!server) return;
    if (server.online === 1) return toasts.warning("Stop the server before deleting it.");
    deleteBusy = true;
    try {
      await deleteServer(id);
      showDeleteModal = false;
      toasts.success("Server deleted");
      router.navigate("/");
    } catch (e) {
      toasts.error("Could not delete the server", e);
    } finally {
      deleteBusy = false;
    }
  }

  function openLoaderModal() { showLoaderModal = true; }

  async function openRawModal() {
    showRawModal = true;
    rawText = "";
    rawOriginal = "";
    rawError = "";
    rawAck = false;
    rawBusy = false;
    try {
      const row = await loadServerRaw(id);
      rawOriginal = JSON.stringify(row, null, 2);
      rawText = rawOriginal;
    } catch (e) {
      rawError = e?.message || String(e);
    }
  }

  function resetRawText() {
    rawText = rawOriginal;
    rawError = "";
  }

  function formatRawJson() {
    try {
      rawText = JSON.stringify(JSON.parse(rawText), null, 2);
      rawError = "";
    } catch (e) {
      rawError = `Invalid JSON: ${e?.message || e}`;
    }
  }

  async function saveRawConfig() {
    rawError = "";
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      rawError = `Invalid JSON: ${e?.message || e}`;
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      rawError = "The JSON must be an object with server columns.";
      return;
    }
    if (parsed.id !== undefined && server && parsed.id !== server.id) {
      rawError = "The id column is read-only and cannot be changed.";
      return;
    }
    rawBusy = true;
    try {
      await saveServerRaw(id, parsed);
      showRawModal = false;
      toasts.success("Raw server data updated");
      await loadDetail({ quiet: true, updates: true });
    } catch (e) {
      rawError = e?.message || String(e);
    } finally {
      rawBusy = false;
    }
  }

  async function handleUpdateToLatest() {
    if (!server?.update?.recommended) return;
    if (server.online === 1) return toasts.warning("Stop the server before updating it.");
    updateBusy = true;
    try {
      const ch = server.update.channel || server.loader_channel || "stable";
      await updateServer(id, { loader_version: server.update.recommended, loader_channel: ch, loader_build: "" });
      await installServerJar(server.loader, server.update.recommended, id, ch, "");
      await loadDetail({ quiet: true, updates: true });
      toasts.success(`Server updated to ${server.update.recommended}`);
    } catch (e) {
      toasts.error("Update failed", e);
    } finally {
      updateBusy = false;
    }
  }

  async function checkForUpdates() {
    if (!server) return;
    updatesBusy = true;
    try {
      await loadDetail({ quiet: true, updates: true });
      if (server.online === 1) toasts.warning("Stop the server to check for updates.");
    } catch (e) {
      toasts.error("Could not check for updates", e);
    } finally {
      updatesBusy = false;
    }
  }

  async function handleUpdateModpack() {
    if (!server?.modpack?.update?.recommended) return;
    if (server.online === 1) return toasts.warning("Stop the server before updating the modpack.");
    updateBusy = true;
    try {
      const res = await updateModpack(id);
      await loadDetail({ quiet: true, updates: true });
      toasts.success(res?.unchanged ? "The modpack is already up to date" : `Modpack updated to ${res?.version || "latest"}`);
    } catch (e) {
      toasts.error("Modpack update failed", e);
    } finally {
      updateBusy = false;
    }
  }

  async function loadModUpdatesList({ force = false } = {}) {
    updatesLoading = true;
    try {
      modUpdates = await loadModUpdates(id, { force });
    } catch (e) {
      modUpdates = [];
      if (force) toasts.error("Could not check for updates", e);
    } finally {
      updatesLoading = false;
    }
  }

  $effect(() => {
    if (activeTab === "mods" && server && !modsLoadedOnce) {
      modsLoadedOnce = true;
      loadModUpdatesList();
    }
  });

  async function handleUpdateMod(modId) {
    try {
      const res = await updateMod(id, modId);
      toasts.success(`Updated to ${res?.version || "latest"}`);
      await loadDetail({ quiet: true });
      await loadModUpdatesList({ force: true });
    } catch (e) {
      toasts.error("Update failed", e);
    }
  }

  async function handleUpdateAll() {
    if (!updateCount) return;
    updateAllBusy = true;
    let done = 0;
    let failed = 0;
    try {
      for (const update of [...modUpdates]) {
        try {
          await updateMod(id, update.mod_id);
          done++;
        } catch {
          failed++;
        }
      }
      await loadDetail({ quiet: true });
      await loadModUpdatesList({ force: true });
      if (done) toasts.success(`${done} mod(s) updated${failed ? `, ${failed} failed` : ""}`);
      else toasts.error("No mods could be updated");
    } finally {
      updateAllBusy = false;
    }
  }

  async function handleScanMods() {
    scanBusy = true;
    try {
      const res = await scanMods(id);
      await loadDetail({ quiet: true });
      await loadModUpdatesList({ force: true });
      toasts.success(`Scanned ${res?.scanned || 0} file(s): ${res?.found || 0} identified${res?.unknown?.length ? `, ${res.unknown.length} unknown` : ""}`);
    } catch (e) {
      toasts.error("Scan failed", e);
    } finally {
      scanBusy = false;
    }
  }

  function modUploadFolder() {
    return modFolderForLoader(server?.loader || "");
  }

  function onModDragOver(e) {
    e.preventDefault();
    modDropActive = true;
  }

  function onModDragLeave() {
    modDropActive = false;
  }

  function onModDrop(e) {
    e.preventDefault();
    modDropActive = false;
    uploadModFiles(e.dataTransfer?.files);
  }

  function onModFileInput(e) {
    uploadModFiles(e.target.files);
    e.target.value = "";
  }

  async function uploadModFiles(files) {
    if (!server) return;
    const list = Array.from(files || []).filter((f) => /\.jar$/i.test(f.name));
    if (!list.length) return toasts.error("Drop .jar files");
    const folder = modUploadFolder();
    modUploadBusy = true;
    let uploaded = 0;
    for (const file of list) {
      try {
        await uploadFile(id, folder, file);
        uploaded++;
      } catch (e) {
        toasts.error(`Upload failed: ${file.name}`, e);
      }
    }
    if (uploaded) {
      try {
        const res = await scanMods(id);
        await loadDetail({ quiet: true });
        await loadModUpdatesList({ force: true });
        toasts.success(`${uploaded} file(s) uploaded to ${folder}${res?.found ? `, ${res.found} identified` : ""}`);
      } catch {
        toasts.success(`${uploaded} file(s) uploaded to ${folder}`);
      }
    }
    modUploadBusy = false;
  }

  function openStore() {
    storeTarget = id;
    storeOpen = true;
  }

  function openStorePage(mod) {
    if (mod?.store_url) window.open(mod.store_url, "_blank", "noopener,noreferrer");
    else openStore();
  }

  function openMotdModal() { showMotdModal = true; }

  function formatDate(ms) { if (!ms) return "—"; try { return new Date(ms).toLocaleString(); } catch { return "—"; } }

  let tabItems = $derived([
    { value: "console", label: "Console", icon: "terminal" },
    { value: "files", label: "Files", icon: "folder" },
    { value: "backups", label: "Backups", icon: "archive" },
    { value: "mods", label: "Mods", icon: "puzzle", badge: server?.mods?.length || 0 },
    { value: "settings", label: "Settings", icon: "sliders" },
  ]);
</script>

{#if loading && !server}
  <div class="center"><Spinner size={24} label="Loading server…" /></div>
{:else if loadError && !server}
  <Alert tone="danger" title="Could not load this server">{loadError}</Alert>
{:else if server}
  <header class="server-header">
    <div class="server-heading">
      <a href="#/" class="back-link"><Icon name="arrow-left" size={13} /> Servers</a>
      <div class="server-identity">
        <div class="server-avatar" class:offline={server.online !== 1}>
          {#if !iconError}
            <img src={`/api/servers/${id}/icon?t=${iconNonce}`} alt="" onerror={() => (iconError = true)} />
          {:else}
            <Icon name="server" size={22} />
          {/if}
          <span class="avatar-status" class:offline={server.online !== 1}></span>
        </div>
        <div class="server-title">
          <h1>{server.name}</h1>
          <div class="subtitle">
            <Badge tone="accent">{loaderName}</Badge>
            <Badge tone={server.online === 1 ? "success" : "neutral"} dot>{server.online === 1 ? "Online" : "Offline"}</Badge>
            <span class="meta-pill" title="Minecraft version"><Icon name="layers" size={12} />{server.loader_version || "—"}{server.loader_build ? ` / ${server.loader_build}` : ""}</span>
            <span class="meta-pill" title="Port"><Icon name="network" size={12} />:{server.port}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="controls-row">
      {#if server.online === 1}
        <Button variant="danger" size="sm" loading={busy === "stop"} onclick={handleStop}><Icon name="square" size={13} /> Stop</Button>
        <Button variant="outline" size="sm" loading={busy === "restart"} onclick={handleRestart}><Icon name="rotate" size={13} /> Restart</Button>
        <Button variant="danger" size="sm" loading={forceStopBusy} onclick={() => (showForceStopModal = true)} title="Kill the process immediately without saving"><Icon name="zap" size={13} /> Force stop</Button>
      {:else}
        <Button variant="primary" size="sm" loading={busy === "start"} onclick={handleStart}><Icon name="play" size={13} /> Start</Button>
      {/if}
      <Button variant="outline" size="sm" onclick={openMotdModal}><Icon name="image" size={14} /> MOTD / Image</Button>
      <Button variant="outline" size="sm" disabled={!sftp} onclick={openSftp} title={sftpUri() || "Open SFTP"}><Icon name="plug" size={14} /> SFTP</Button>
    </div>
  </header>

  <Tabs items={tabItems} bind:value={activeTab} />

  <div class="detail-grid console-grid" class:tab-hidden={activeTab !== "console"}>
      <ConsolePanel serverId={id} online={server.online === 1} active={activeTab === "console"} />

      <div class="side-col">
        <ResourceGraph serverId={id} />
        <Panel title="Console & network" icon="network">
          <KeyValueList
            rows={[
              { key: "Status", value: server.online === 1 ? "Running" : "Stopped", mono: false },
              { key: "Loader", value: loaderName, mono: false },
              { key: "Version", value: server.loader_version || "—" },
              { key: "Jar", value: server.jar },
              { key: "Memory", value: server.memory_max },
              { key: "Port", value: server.port, mono: false },
              { key: "Java", value: server.java_version || "—", mono: false },
              { key: "SFTP", value: sftp?.enabled ? (sftp.hasPassword ? `${sftp.username}@${sftp.port}` : "enabled (no password)") : "disabled", mono: true },
            ]}
          />
          {#if sftpUri()}
            <div class="sftp-box">
              <TextField value={sftpUri()} label="SFTP address" readonly onfocus={(e) => e.currentTarget.select()} />
              <IconButton
                label={sftpCopied ? "Copied" : "Copy SFTP address"}
                icon={sftpCopied ? "check" : "copy"}
                variant={sftpCopied ? "primary" : "outline"}
                onclick={copySftpUri}
              />
            </div>
          {/if}
        </Panel>
        <Panel title="Connect" icon="plug">
          {#if connections.length}
            <div class="connect-list">
              {#each connections as c}
                <div class="connect-row">
                  <span class="connect-label">{c.label}</span>
                  <code class="connect-addr">{c.address}</code>
                  <span class="connect-proto">{c.protocol}</span>
                </div>
              {/each}
            </div>
            <div class="muted foot-note">Replace localhost with your public IP or domain when connecting from outside.</div>
          {:else}
            <div class="muted">No ports assigned yet.</div>
          {/if}
        </Panel>
        <Panel title="Quick actions" icon="zap">
          <div class="quick-grid">
            <Button size="sm" variant="outline" onclick={() => (activeTab = "backups")}><Icon name="archive" size={14} /> Backups</Button>
            <Button size="sm" variant="outline" onclick={() => (activeTab = "files")}><Icon name="folder" size={14} /> Files</Button>
            <Button size="sm" variant="outline" onclick={() => (activeTab = "mods")}><Icon name="puzzle" size={14} /> Mods</Button>
            <Button size="sm" variant="outline" onclick={openLoaderModal}><Icon name="layers" size={14} /> Loader</Button>
          </div>
        </Panel>
      </div>
    </div>

  {#if activeTab === "files"}
    <div class="panel fm-panel">
      <FileManager serverId={id} />
    </div>
  {:else if activeTab === "backups"}
    <BackupsTab {server} onChanged={() => loadDetail({ quiet: true })} />
  {:else if activeTab === "mods"}
    {#if isBedrock}
      <Panel title="Mods & plugins" icon="puzzle">
        <Alert tone="info">Bedrock servers do not support mods or plugins. Use an add-on or a Java server if you need mods.</Alert>
      </Panel>
    {:else if isEndstone}
      <Panel title="Plugins" icon="puzzle">
        <Alert tone="info">Endstone loads Python/C++ plugins from <code>bedrock_server/plugins</code>. Java .jar mods are not supported by this loader.</Alert>
      </Panel>
    {:else}
    <div class="detail-grid">
      <Panel title="Installed mods" id="installed-mods" icon="puzzle" subtitle={`${server.mods?.length || 0} file(s)`}>
        <div class="row-actions">
          <Button size="sm" variant="outline" loading={updatesLoading} onclick={() => loadModUpdatesList({ force: true })}><Icon name="refresh" size={13} /> Check updates</Button>
          {#if updateCount}
            <Button size="sm" variant="primary" loading={updateAllBusy} onclick={handleUpdateAll}><Icon name="arrow-up" size={13} /> Update all ({updateCount})</Button>
          {/if}
        </div>
        {#if server.mods && server.mods.length}
          <ul class="mod-list">
            {#each server.mods as m}
              {@const upd = updatesById[m.id]}
              <li class="mod-row">
                {#if m.icon_url}
                  <img class="mod-icon" src={m.icon_url} alt="" loading="lazy" onerror={(e) => e.currentTarget?.setAttribute("style", "display:none")} />
                {:else}
                  <div class="mod-icon placeholder">{(m.project_title || m.filename || "?").slice(0, 1)}</div>
                {/if}
                <div class="mod-main">
                  <div class="mod-name" title={m.filename || m.project_title}>{m.project_title || m.filename || m.version || "mod"}</div>
                  <div class="muted mod-sub">{[m.source, m.version, m.filename].filter(Boolean).join(" · ")}</div>
                  <div class="muted mod-extra">
                    {m.game_versions?.length ? m.game_versions.slice(0, 4).join(", ") : "any version"}
                    {m.sha1 ? ` · sha1 ${shortHash(m.sha1)}` : ""}
                  </div>
                </div>
                <div class="mod-actions">
                  <Button
                    size="xs"
                    variant={upd ? "primary" : "secondary"}
                    disabled={!upd}
                    title={upd ? `Update to ${upd.latest?.version_number || "latest"}` : "No update available"}
                    onclick={() => handleUpdateMod(m.id)}
                  ><Icon name="arrow-up" size={12} /> Update</Button>
                  <Button size="xs" variant="outline" onclick={() => openStorePage(m)}><Icon name="store" size={12} /> Store</Button>
                  <Button size="xs" variant="danger" onclick={() => handleRemoveMod(m.id)}><Icon name="trash" size={12} /> Remove</Button>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <EmptyState size="sm" icon="puzzle" title="No mods installed" description="Browse the store or scan the server folder to register mods by file hash." />
        {/if}
      </Panel>

      <div class="side-col">
        <Panel title="Add mods & plugins" icon="store" subtitle="All major stores">
          <div class="stack">
            <div
              class="dropzone"
              class:active={modDropActive}
              class:busy={modUploadBusy}
              role="button"
              tabindex="0"
              onclick={() => modFileInput?.click()}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); modFileInput?.click(); } }}
              ondragover={onModDragOver}
              ondragleave={onModDragLeave}
              ondrop={onModDrop}
            >
              <input bind:this={modFileInput} type="file" accept=".jar" multiple hidden onchange={onModFileInput} />
              <Icon name="upload" size={20} />
              <div class="dropzone-title">{modUploadBusy ? "Uploading…" : "Drop .jar files here"}</div>
              <div class="muted">or click to browse · saves to <code>{modUploadFolder()}</code></div>
            </div>
            <div class="row-actions">
              <Button size="sm" variant="primary" onclick={openStore}><Icon name="store" size={14} /> Browse store</Button>
              <Button size="sm" variant="outline" loading={scanBusy} onclick={handleScanMods}><Icon name="search" size={14} /> Scan installed folder</Button>
            </div>
            <div class="side-note">
              <div class="side-note-row"><span>Target folder</span><code>{modFolderForLoader(server.loader)}</code></div>
              <div class="side-note-row"><span>Runtime</span><b>{server.loader || "vanilla"} {server.loader_version || ""}</b></div>
            </div>
            <div class="muted hint-text">Scan identifies files through the Modrinth SHA-1 index, CurseForge fingerprints and Hangar SHA-256.</div>
          </div>
        </Panel>
      </div>
    </div>
    {/if}
  {:else if activeTab === "settings"}
    <div class="detail-grid">
      <div class="main-col">
        {#if !isCustomLoader}
        <Panel title="Updates" icon="refresh">
          <div class="update-list">
            <div class="update-row">
              <div class="update-info">
                <span class="update-label">Launcher</span>
                <div class="update-value"><b>{loaderName}</b> · {server.loader_version || "—"}{server.loader_build ? ` (${server.loader_build})` : ""}</div>
              </div>
              {#if server.update?.recommended}
                <Button size="sm" variant="primary" loading={updateBusy} disabled={server.online === 1} onclick={handleUpdateToLatest}><Icon name="download" size={13} /> Update to {server.update.recommended}</Button>
              {:else if server.update}
                <Badge tone="success">Up to date</Badge>
              {/if}
            </div>
            {#if server.modpack}
              <div class="update-row">
                <div class="update-info">
                  <span class="update-label">Modpack</span>
                  <div class="update-value"><b>{packName}</b> · {packVersion}</div>
                </div>
                {#if server.modpack.update?.recommended}
                  <Button size="sm" variant="primary" loading={updateBusy} disabled={server.online === 1} onclick={handleUpdateModpack}><Icon name="download" size={13} /> Update modpack to {server.modpack.update.latest_version}</Button>
                {:else if server.modpack.update}
                  <Badge tone="success">Up to date</Badge>
                {/if}
              </div>
            {/if}
          </div>
          {#if server.online === 1}<div class="muted foot-note">Stop the server to apply updates.</div>{/if}
          <div class="row-actions">
            <Button size="sm" variant="outline" loading={updatesBusy} onclick={checkForUpdates}><Icon name="refresh" size={13} /> Check for updates</Button>
          </div>
        </Panel>
        {/if}

        <Panel title="Loader & version" icon="layers">
          <KeyValueList
            rows={[
              { key: "Launcher", value: `${loaderName}${server.loader_build ? ` (${server.loader_build})` : ""}`, mono: false },
              { key: "Minecraft", value: `${server.loader_version || "—"}${server.loader_channel ? ` (${server.loader_channel})` : ""}` },
              { key: "Jar", value: server.jar },
            ]}
          />
          <div class="row-actions">
            <Button size="sm" variant="outline" disabled={server.online === 1} onclick={openLoaderModal}><Icon name="layers" size={13} /> Change loader / version</Button>
          </div>
          {#if server.online === 1}<div class="muted foot-note">Stop the server to change the loader or version.</div>{/if}
        </Panel>

        {#if isCustomLoader}
          <Panel title="Start command" icon="terminal" subtitle="Full command used to launch this server">
            <div class="jvm-fields" bind:this={customCommandEl}>
              <TextField
                bind:value={customCommand}
                label="Command"
                placeholder="java -Xmx2G -jar server.jar nogui"
                hint="Runs from the server folder, without a shell. Use quotes for paths with spaces."
              />
              <div class="row-actions">
                <Button size="sm" variant="primary" loading={customCommandBusy} disabled={!customCommandDirty} idle={!customCommandDirty} onclick={saveCustomCommand}><Icon name="save" size={13} /> Save command</Button>
              </div>
            </div>
          </Panel>
        {/if}

        <Panel title="Server & network" icon="server">
          <div class="jvm-fields" bind:this={portPanelEl}>
            {#if visiblePorts.length > 0}
              <div class="port-list">
                {#each visiblePorts as p}
                  <div class="port-row" class:conflict={!!p.conflict}>
                    <span class="port-role" title={portHelp[p.role] || ""}>{p.label}</span>
                    <span class="port-proto">{p.protocol.toUpperCase()}</span>
                    <input
                      class="input port-input"
                      type="number"
                      min="1"
                      max="65535"
                      aria-label={`${p.label} port`}
                      bind:value={portEdits[p.role]}
                      disabled={portBusy}
                    />
                    {#if p.conflict}
                      <Badge tone="danger" title={`Used by ${p.conflict.serverName || "another server"}`}>Collision</Badge>
                    {:else}
                      <Badge tone="neutral">Reserved</Badge>
                    {/if}
                    {#if p.custom}
                      <button class="port-remove" type="button" title="Release port" aria-label={`Release ${p.label}`} disabled={extraBusy} onclick={() => removeExtraPort(p)}>×</button>
                    {/if}
                  </div>
                {/each}
              </div>
              <div class="row-actions">
                <Button size="sm" variant="primary" loading={portBusy} disabled={!portDirty} idle={!portDirty} onclick={savePorts}><Icon name="save" size={13} /> Save all ports</Button>
                {#if !isCustomLoader}
                  <Button size="sm" variant="outline" loading={autoBusy} disabled={server.online === 1} onclick={autoFixPorts} title={server.online === 1 ? "Stop the server first" : "Move colliding or occupied ports to free ones"}><Icon name="refresh" size={13} /> Auto-assign free</Button>
                {/if}
              </div>
              <div class="muted foot-note">Ports are reserved per transport (TCP/UDP), so Java and Bedrock servers can share a number.</div>
              {#if !isCustomLoader}
                <div class="muted foot-note">Game: player connections · Query: server list / monitoring · RCON: remote console.</div>
              {/if}
            {/if}
            <div class="extra-ports">
              <div class="extra-ports-title">Plugin / extra ports</div>
              <div class="extra-grid">
                <TextField bind:value={extraLabel} label="Name" placeholder="Geyser, Dynmap…" disabled={extraBusy} />
                <TextField bind:value={extraPort} label="Port" type="number" min="1" max="65535" disabled={extraBusy} />
                <Select bind:value={extraProtocol} label="Protocol" disabled={extraBusy} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} />
              </div>
              <div class="row-actions">
                <Button size="sm" variant="outline" loading={extraBusy} disabled={!extraLabel.trim() || !extraPort} onclick={addExtraPort}><Icon name="plus" size={13} /> Reserve extra port</Button>
              </div>
              <div class="muted foot-note">Reserve plugin ports (Geyser UDP 19132, voice chat UDP 24454, Dynmap TCP 8123…) so another server cannot take them. Set the same port in the plugin config.</div>
            </div>
            <Switch
              checked={strictPorts}
              disabled={portBusy}
              label="Strict port mode"
              hint="Stops the server if it opens a port that is not reserved in this list. Applies from the next start."
              onchange={(e) => setStrictPorts(e.currentTarget.checked)}
            />
            {#if server.online === 1}<div class="muted foot-note">Restart the server to apply the new port.</div>{/if}
          </div>
        </Panel>

        <Panel title="Memory & JVM" icon="cpu">
          {#if canEditJvm}
            <div class="jvm-fields" bind:this={jvmPanelEl}>
              <Select
                bind:value={jvmEdit.javaVersion}
                label="Java runtime"
                disabled={jvmEdit.saving || server.online === 1}
                options={[
                  ...(!(javaRuntimes || []).some((j) => String(j.id) === String(jvmEdit.javaVersion)) && jvmEdit.javaVersion ? [{ value: jvmEdit.javaVersion, label: `${jvmEdit.javaVersion} (current)` }] : []),
                  ...(javaRuntimes || []).map((j) => ({ value: j.id, label: `${j.name}${j.source === "managed" ? " · managed" : (j.detected ? " · detected" : "")}` })),
                ]}
              />
              <div class="stack">
                <MemoryJvmInput
                  bind:valueMb={jvmEdit.memoryMb}
                  bind:jvmArgs={jvmEdit.jvmArgs}
                  maxMb={systemInfo?.memory?.maxMb || systemInfo?.totalRamMb || 8192}
                  minMb={256}
                  stepMb={512}
                  disabled={jvmEdit.saving}
                />
              </div>
              <div class="row-actions">
                <Button size="sm" variant="primary" loading={jvmEdit.saving} disabled={!jvmDirty || !!busy} idle={!jvmDirty} onclick={saveJvmSettings}><Icon name="save" size={13} /> Save Java / RAM / JVM</Button>
              </div>
            </div>
          {:else}
            <Alert tone="info">{isCustomLoader ? "This loader uses your custom start command. Set RAM and JVM flags there." : `This loader (${server.loader}) does not use managed Java / RAM settings.`}</Alert>
          {/if}
        </Panel>
      </div>

      <div class="side-col">
        <Panel title="Details" icon="info">
          <KeyValueList
            rows={[
              { key: "ID", value: server.id },
              { key: "Directory", value: server.dir || "—" },
              { key: "Memory", value: `${server.memory_min} – ${server.memory_max}` },
              { key: "JVM args", value: server.jvm_args || "—" },
              { key: "Auto start", value: server.auto_start ? "Yes" : "No", mono: false },
              { key: "Created", value: server.created_at ? formatDate(server.created_at * 1000) : "—" },
            ]}
          />
        </Panel>

        <Panel title="Danger zone" icon="alert">
          <Alert tone="danger">Deleting the server removes its database entry and <b>all files</b> in its directory (world, configs, mods, backups).</Alert>
          <div class="row-actions">
            <Button size="sm" variant="danger" disabled={server.online === 1 || !!busy} onclick={openDeleteModal}><Icon name="trash" size={13} /> Delete server</Button>
            <Button size="sm" variant="outline" disabled={!!busy} onclick={openRawModal}><Icon name="terminal" size={13} /> Raw config (JSON)</Button>
          </div>
          {#if server.online === 1}<div class="muted foot-note">Stop the server before deleting it.</div>{/if}
        </Panel>
      </div>
    </div>
  {/if}

  <MotdModal
    bind:open={showMotdModal}
    {server}
    onsaved={() => loadDetail({ quiet: true })}
    oniconchange={(e) => { iconError = !!e?.missing; iconNonce = Date.now(); }}
  />

  <LoaderModal
    bind:open={showLoaderModal}
    {server}
    {loaders}
    onsaved={() => loadDetail({ quiet: true, updates: true })}
  />

  <ConfirmDialog
    bind:open={showDeleteModal}
    title="Delete server"
    message={`This permanently deletes ${server?.name} and all of its files.`}
    confirmLabel="Delete permanently"
    confirmValue={server?.name || ""}
    busy={deleteBusy}
    onconfirm={handleDeleteServer}
    oncancel={() => { showDeleteModal = false; }}
  />

  <ConfirmDialog
    bind:open={showForceStopModal}
    title="Force stop server"
    message={`Kill "${server?.name || "this server"}" immediately? The process is terminated without saving the world. Unsaved chunks, player data and configuration changes can be lost or corrupted. Use the normal Stop button unless the server is stuck.`}
    confirmLabel="Force stop"
    busy={forceStopBusy}
    onconfirm={handleForceStop}
    oncancel={() => { showForceStopModal = false; }}
  />

  <Modal bind:open={storeOpen} title="Add mods & plugins" subtitle={server ? `${server.name} · ${server.loader || "vanilla"} ${server.loader_version || ""}` : ""} size="full" onclose={() => { storeOpen = false; }}>
    {#snippet children()}
      {#if server}
        <StoreBrowser
          servers={[{ id: server.id, name: server.name, loader: server.loader, loader_version: server.loader_version }]}
          {systemInfo}
          bind:targetServerId={storeTarget}
          onInstalled={() => { loadDetail({ quiet: true }); loadModUpdatesList({ force: true }); }}
        />
      {/if}
    {/snippet}
    {#snippet footer()}
      <Button size="sm" variant="outline" onclick={() => { storeOpen = false; }}>Close</Button>
    {/snippet}
  </Modal>

  <Modal
    bind:open={showRawModal}
    title="Raw server data (database row)"
    subtitle={server ? `${server.name} · ${server.id}` : ""}
    size="lg"
    dismissible={!rawBusy}
    closeOnBackdrop={!rawBusy}
    onclose={() => { showRawModal = false; }}
  >
    {#snippet children()}
      <div class="raw-stack">
        <Alert tone="danger" title="Advanced — this can break the server">
          <b>Do not edit these values unless you know exactly what you are doing.</b>
          This writes directly to the panel database row. A wrong value can stop the server from starting,
          break the panel, or make this server impossible to manage. There is no undo.
        </Alert>
        <Alert tone="warning">
          Stop the server before saving. Values such as <code>dir</code>, <code>loader</code>,
          <code>online</code>, <code>pid</code> and <code>exec</code> are especially dangerous.
          Only change a field if you understand what it does.
        </Alert>

        {#if rawError}<Alert tone="danger">{rawError}</Alert>{/if}

        <TextArea
          bind:value={rawText}
          label="servers row (JSON)"
          monospace
          rows={20}
          spellcheck="false"
          disabled={rawBusy}
          hint="Edit only the values you need. JSON must stay a valid object; the id column is read-only."
        />

        <div class="raw-actions">
          <Button size="xs" variant="outline" disabled={rawBusy || !rawText} onclick={formatRawJson}><Icon name="sparkles" size={12} /> Format JSON</Button>
          <Button size="xs" variant="outline" disabled={rawBusy || rawText === rawOriginal} onclick={resetRawText}><Icon name="rotate" size={12} /> Discard changes</Button>
          {#if server?.online === 1}<span class="muted raw-online">Server is running — stop it before saving.</span>{/if}
        </div>

        <label class="raw-ack">
          <input type="checkbox" bind:checked={rawAck} disabled={rawBusy} />
          <span>I understand that saving wrong values can damage this server and that there is no undo.</span>
        </label>
      </div>
    {/snippet}
    {#snippet footer()}
      <Button size="sm" variant="outline" disabled={rawBusy} onclick={() => { showRawModal = false; }}>Cancel</Button>
      <Button
        size="sm"
        variant="danger"
        loading={rawBusy}
        disabled={!rawAck || rawBusy || rawText === rawOriginal}
        idle={rawText === rawOriginal || !rawAck}
        onclick={saveRawConfig}
      ><Icon name="save" size={13} /> Save raw values</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .center { display: flex; align-items: center; justify-content: center; padding: 80px 0; }

  .raw-stack { display: flex; flex-direction: column; gap: 12px; }
  .raw-stack :global(code) { font-family: var(--font-mono); font-size: 0.85em; background: var(--panel-elevated); padding: 1px 4px; border-radius: 4px; }
  .raw-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .raw-online { font-size: 0.76rem; color: var(--warning); }
  .raw-ack { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; font-size: 0.8rem; color: var(--text-secondary); background: var(--input-bg); border: 1px solid var(--danger); border-radius: var(--radius); cursor: pointer; }
  .raw-ack input { margin-top: 2px; }

  /* ---------- Hero header ---------- */
  .server-header {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 18px;
    flex-wrap: wrap;
    padding: 20px 22px;
    margin-bottom: 18px;
    overflow: hidden;
    background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 86%, transparent), color-mix(in srgb, var(--panel) 97%, transparent));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03), var(--shadow);
  }
  .server-header::before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent-ring), transparent);
  }
  .server-heading { display: flex; flex-direction: column; gap: 13px; min-width: 0; }
  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    width: fit-content;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
    text-decoration: none;
    transition: color var(--t-fast), transform var(--t-fast);
  }
  .back-link:hover { color: var(--accent); transform: translateX(-2px); }
  .server-identity { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .server-avatar {
    position: relative;
    display: grid;
    place-items: center;
    width: 54px;
    height: 54px;
    flex: 0 0 auto;
    color: var(--accent);
    background: radial-gradient(circle at 30% 20%, var(--accent-soft), color-mix(in srgb, var(--panel-elevated) 92%, var(--accent) 8%));
    border: 1px solid var(--accent-ring);
    border-radius: 13px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), var(--shadow-xs);
  }
  .server-avatar.offline { color: var(--text-disabled); background: var(--panel-elevated); border-color: var(--border); }
  .server-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 12px; image-rendering: pixelated; }
  .avatar-status {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 12px;
    height: 12px;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 0 3px var(--panel);
  }
  .avatar-status.offline { background: var(--text-disabled); }
  .server-title { min-width: 0; }
  .server-title h1 {
    margin: 0;
    overflow: hidden;
    font-size: clamp(1.35rem, 2.2vw, 1.72rem);
    font-weight: 750;
    letter-spacing: -0.03em;
    line-height: 1.12;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subtitle { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 7px; }
  .meta-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    background: color-mix(in srgb, var(--panel-elevated) 65%, transparent);
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  .meta-pill :global(.icon) { color: var(--text-disabled); }
  .controls-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  /* ---------- Layout ---------- */
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; align-items: start; }
  .main-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .side-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .console-grid { min-height: 460px; }
  .console-grid.tab-hidden { display: none; }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .jvm-fields { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .foot-note { margin-top: 8px; font-size: 0.74rem; }
  .port-list { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .port-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-elevated); font-size: 0.78rem; }
  .port-row.conflict { border-color: var(--danger); }
  .port-role { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .port-proto { color: var(--text-secondary); font-size: 0.68rem; letter-spacing: 0.04em; }
  .port-input { width: 88px; font-family: var(--font-mono); text-align: right; padding: 4px 6px; }
  .connect-list { display: flex; flex-direction: column; gap: 6px; }
  .connect-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; font-size: 0.78rem; background: var(--panel-elevated); border: 1px solid var(--border); border-radius: 8px; }
  .connect-label { flex: 0 0 auto; color: var(--text-secondary); }
  .connect-addr { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); color: var(--text); }
  .connect-proto { flex: 0 0 auto; color: var(--text-secondary); font-size: 0.68rem; letter-spacing: 0.04em; }
  .port-remove { border: 0; background: transparent; color: var(--text-secondary); font-size: 1.05rem; line-height: 1; padding: 0 2px; cursor: pointer; }
  .port-remove:hover { color: var(--danger); }
  .extra-ports { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .extra-ports-title { font-size: 0.78rem; font-weight: 600; }
  .extra-grid { display: grid; grid-template-columns: minmax(0, 1fr) 110px 110px; gap: 8px; align-items: end; }
  @media (max-width: 560px) { .extra-grid { grid-template-columns: minmax(0, 1fr) 90px; } }
  .fm-panel { height: calc(100vh - 290px); min-height: 460px; padding: 0; overflow: hidden; }

  /* ---------- Side notes ---------- */
  .side-note {
    display: flex;
    flex-direction: column;
    padding: 4px 12px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .side-note-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 0;
    font-size: 0.76rem;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
  }
  .side-note-row:last-child { border-bottom: none; }
  .side-note-row code { color: var(--accent); font-family: var(--font-mono); font-size: 0.72rem; }
  .side-note-row b { color: var(--text); font-weight: 600; font-size: 0.76rem; }

  /* ---------- Mod drop zone ---------- */
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 18px 14px;
    color: var(--text-secondary);
    text-align: center;
    background: color-mix(in srgb, var(--input-bg) 70%, transparent);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast);
  }
  .dropzone:hover, .dropzone.active { color: var(--text); border-color: var(--accent); background: var(--accent-light); }
  .dropzone.busy { pointer-events: none; opacity: 0.7; }
  .dropzone :global(.icon) { color: var(--accent); }
  .dropzone-title { font-size: 0.82rem; font-weight: 650; }
  .dropzone code { color: var(--accent); font-family: var(--font-mono); font-size: 0.72rem; }
  .hint-text { font-size: 0.73rem; line-height: 1.55; }

  /* ---------- SFTP ---------- */
  .sftp-box { display: flex; align-items: flex-end; gap: 8px; padding: 0 16px 16px; }
  .sftp-box :global(.field) { flex: 1; min-width: 0; }
  .sftp-box :global(.input) { font-family: var(--font-mono); font-size: 0.78rem; }

  /* ---------- Quick actions ---------- */
  .quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .quick-grid :global(.btn) { justify-content: flex-start; }

  /* ---------- Updates ---------- */
  .update-list { display: flex; flex-direction: column; gap: 10px; }
  .update-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 11px 13px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .update-info { min-width: 0; }
  .update-label {
    display: block;
    margin-bottom: 3px;
    color: var(--text-disabled);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .update-value { font-size: 0.82rem; overflow-wrap: anywhere; }

  /* ---------- Mods ---------- */
  .mod-list { display: flex; flex-direction: column; list-style: none; }
  .mod-icon {
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    object-fit: cover;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .mod-icon.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-weight: 700;
    text-transform: uppercase;
  }
  .mod-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 8px;
    border-bottom: 1px solid var(--border);
    border-radius: 7px;
    transition: background var(--t-fast);
  }
  .mod-row:hover { background: color-mix(in srgb, var(--panel-elevated) 55%, transparent); }
  .mod-row:last-child { border-bottom: none; }
  .mod-main { min-width: 0; flex: 1; }
  .mod-name {
    display: block;
    max-width: 52ch;
    overflow: hidden;
    font-size: 0.86rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mod-sub { margin-top: 2px; font-size: 0.74rem; }
  .mod-extra {
    max-width: 58ch;
    margin-top: 1px;
    overflow: hidden;
    font-size: 0.7rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mod-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }

  @media (max-width: 1100px) {
    .detail-grid { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 640px) {
    .server-header { align-items: flex-start; padding: 16px; }
    .controls-row { width: 100%; }
    .quick-grid { grid-template-columns: minmax(0, 1fr); }
    .mod-row { flex-wrap: wrap; }
    .mod-actions { width: 100%; justify-content: flex-start; }
    .mod-name, .mod-extra { max-width: 100%; }
  }
</style>
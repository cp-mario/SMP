<script>
  import { onMount } from "svelte";
  import {
    loadServers, loadLoaders, loadJava, loadVersions, loadLoaderVersions, createServer,
    startServer, stopServer, forceStopServer, restartServer, loadSettings, acceptServerEula, loadSystemInfo, saveSettings,
    loadUpdateState,
  } from "./lib/stores.js";
  import { router } from "./lib/router.js";
  import { toasts } from "./lib/toast.js";
  import { versionId, pickLatest, pickLatestBuild, reconcileSelection } from "./lib/versionPicker.js";
  import { applyAccent as applyAccentTheme, DEFAULT_ACCENT, readStoredAccent } from "./lib/theme.js";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import Dashboard from "./lib/components/Dashboard.svelte";
  import CreateServer from "./lib/components/CreateServer.svelte";
  import ModpackCreate from "./lib/components/ModpackCreate.svelte";
  import ToastStack from "./lib/components/ui/ToastStack.svelte";
  import Modal from "./lib/components/ui/Modal.svelte";
  import ConfirmDialog from "./lib/components/ui/ConfirmDialog.svelte";
  import Alert from "./lib/components/ui/Alert.svelte";
  import Icon from "./lib/components/ui/Icon.svelte";

  const MC_EULA_URL = "https://www.minecraft.net/eula";

  let appState = $state({
    servers: [],
    loaders: [],
    loaderVersions: [],
    versionsMeta: { latest: null, channel: "all" },
    versionsLoading: false,
    versionsSearch: "",
    versionsError: null,
    selectedLoader: null,
    selectedVersion: null,
    selectedVersionChannel: "stable",
    selectedLoaderBuild: null,
    loaderBuilds: [],
    loaderBuildsLoading: false,
    loaderBuildsSupported: false,
    loaderBuildsError: null,
    loaderBuildChannel: "all",
    selectedJava: "21",
    createName: "",
    javaRuntimes: [],
    detectedJava: [],
    javaInfo: { available: [], installed: [], detected: [], runtimes: [], javaDir: "" },
    systemInfo: null,
    updateState: null,
    modsResults: [],
    modsSource: "modrinth",
    modsLoader: null,
    createLoading: false,
    accentColor: readStoredAccent() || DEFAULT_ACCENT,
    versionChannel: "all",
  });

  let showCreate = $state(false);
  let showModpack = $state(false);
  let eulaServerId = $state(null);
  let eulaOpen = $state(false);
  let eulaAction = $state("start");
  let eulaBusy = $state(false);
  let busyId = $state(null);
  let forceStopServerId = $state(null);
  let forceStopOpen = $state(false);
  let forceStopBusy = $state(false);
  let path = $state(router.path);
  let booting = $state(true);
  let accentTimer = null;

  // Route views are split into their own chunks, so the dashboard paints without
  // downloading the server detail, store browser or settings code.
  const lazyViews = {
    server: () => import("./lib/components/ServerDetail.svelte"),
    mods: () => import("./lib/components/ModsBrowser.svelte"),
    settings: () => import("./lib/components/Settings.svelte"),
  };
  let loadedViews = $state({ server: null, mods: null, settings: null });

  function ensureView(name) {
    if (loadedViews[name]) return;
    loadedViews[name] = "loading";
    lazyViews[name]()
      .then((mod) => { loadedViews[name] = mod.default; })
      .catch(() => { loadedViews[name] = null; });
  }

  const view = $derived(
    path === "/" ? "servers"
      : path.startsWith("/server/") ? "server"
      : path === "/mods" ? "mods"
      : path === "/settings" ? "settings"
      : "servers"
  );
  const serverId = $derived(path.startsWith("/server/") ? decodeURIComponent(path.split("/")[2] || "") : null);
  const forceStopTarget = $derived(appState.servers.find((s) => s.id === forceStopServerId) || null);

  $effect(() => {
    if (view === "server" || view === "mods" || view === "settings") ensureView(view);
  });

  function applyAccent(color, { persist = true } = {}) {
    const hex = applyAccentTheme(color, { persist: true });
    appState.accentColor = hex;
    if (!persist) return;
    // Debounce: the colour picker fires on every pixel, the database should not.
    if (accentTimer) clearTimeout(accentTimer);
    accentTimer = setTimeout(() => {
      accentTimer = null;
      saveSettings("accent_color", hex).catch(() => { /* non-blocking */ });
    }, 400);
  }

  async function refreshServers({ updates = true } = {}) {
    try {
      appState.servers = await loadServers({ updates });
    } catch (e) {
      toasts.error("Could not load servers", e);
    }
  }

  async function init() {
    try {
      const [servers, loaders, java, settings, systemInfo] = await Promise.all([
        // Update checks call external APIs: keep them off the first paint.
        loadServers({ updates: false }),
        loadLoaders(),
        loadJava(),
        loadSettings().catch(() => ({})),
        loadSystemInfo().catch(() => null),
      ]);
      appState.servers = servers;
      appState.loaders = loaders;
      appState.javaRuntimes = java.runtimes || [];
      appState.javaInfo = java;
      appState.detectedJava = java.detected || [];
      appState.systemInfo = systemInfo;
      applyAccent(settings.accent_color || appState.accentColor, { persist: false });
      // Version check runs in the background: the sidebar dot and Settings both read it.
      loadUpdateState().then((state) => { appState.updateState = state; }).catch(() => { /* placeholder: repo may not exist yet */ });
    } catch (e) {
      toasts.error("Panel init failed", e);
    } finally {
      booting = false;
      setTimeout(() => {
        if (document.visibilityState !== "hidden") refreshServers({ updates: true });
      }, 600);
    }
  }

  onMount(() => {
    const stopRouter = router.start();
    const unsubscribe = router.subscribe((p) => { path = p; });
    const onNewServer = () => { showCreate = true; };
    const onEula = (e) => {
      const detail = e?.detail || {};
      if (detail.id) eulaServerId = detail.id;
      if (detail.action === "restart") eulaAction = "restart";
      if (eulaServerId) eulaOpen = true;
    };
    window.addEventListener("smp:new-server", onNewServer);
    window.addEventListener("smp:eula", onEula);
    init();
    return () => {
      stopRouter();
      unsubscribe();
      window.removeEventListener("smp:new-server", onNewServer);
      window.removeEventListener("smp:eula", onEula);
    };
  });

  async function runServerAction(id, fn, okMessage, action = "start") {
    busyId = id;
    try {
      await fn();
      await refreshServers({ updates: true });
      if (okMessage) toasts.success(okMessage);
      return true;
    } catch (e) {
      if (e?.data?.eulaRequired) {
        eulaServerId = e?.data?.serverId || id;
        eulaAction = action;
        eulaOpen = true;
      } else {
        toasts.error("Action failed", e);
      }
      return false;
    } finally {
      busyId = null;
    }
  }

  const handleStart = (id) => runServerAction(id, () => startServer(id), "Server started", "start");
  const handleStop = (id) => runServerAction(id, () => stopServer(id), "Server stopped", "stop");
  const handleRestart = (id) => runServerAction(id, () => restartServer(id), "Server restarted", "restart");
  const handleRefresh = () => refreshServers({ updates: true });

  function requestForceStop(id) {
    if (!id) return;
    forceStopServerId = id;
    forceStopOpen = true;
  }

  async function confirmForceStop() {
    const id = forceStopServerId;
    if (!id) return;
    forceStopBusy = true;
    try {
      const res = await forceStopServer(id);
      forceStopOpen = false;
      forceStopServerId = null;
      await refreshServers({ updates: true });
      if (res?.stopped === false) toasts.warning(res?.message || "The server process was not running in this panel session.");
      else toasts.success("Server process killed");
    } catch (e) {
      toasts.error("Could not force stop the server", e);
    } finally {
      forceStopBusy = false;
    }
  }

  async function handleEulaAccept() {
    const id = eulaServerId;
    const action = eulaAction;
    if (!id) return;
    eulaBusy = true;
    try {
      await acceptServerEula(id, true);
      if (action === "restart") await restartServer(id);
      else await startServer(id);
      await refreshServers({ updates: false });
      toasts.success(action === "restart" ? "Server restarted" : "Server started");
      eulaOpen = false;
      eulaServerId = null;
    } catch (e) {
      toasts.error("Could not accept the EULA", e);
    } finally {
      eulaBusy = false;
    }
  }

  function closeEula() {
    if (eulaBusy) return;
    eulaOpen = false;
    eulaServerId = null;
    eulaAction = "start";
  }

  async function handleSelectLoader(id) {
    appState.selectedLoader = id;
    appState.selectedVersion = null;
    appState.selectedVersionChannel = "stable";
    appState.selectedLoaderBuild = null;
    appState.loaderBuilds = [];
    appState.loaderBuildsSupported = false;
    appState.loaderBuildsLoading = false;
    appState.loaderBuildsError = null;
    appState.versionsSearch = "";
    appState.versionsError = null;
    await fetchVersions(id);
  }

  /**
   * Loads the Minecraft version list for `loaderId`.
   *
   * The list is always fetched with `channel: "all"` (the "Todos" filter) and filtered in the
   * client, so "Latest stable/experimental" can select a version that the current filter would
   * hide, and switching All/Stable/Experimental never refetches (no UI jump / no reload flash).
   */
  async function fetchVersions(loaderId, { quiet = false } = {}) {
    if (!loaderId) { appState.loaderVersions = []; appState.versionsMeta = { latest: null, channel: "all" }; return; }
    if (!quiet) appState.versionsLoading = true;
    appState.versionsError = null;
    try {
      const res = await loadVersions(loaderId, "all");
      appState.loaderVersions = res.items || [];
      appState.versionsMeta = { latest: res.latest || null, channel: "all" };
      if (res.error) appState.versionsError = res.error;
      // Keep a previously selected version if it still exists, otherwise pick the newest stable.
      const ids = appState.loaderVersions.map((v) => versionId(v));
      if (!appState.selectedVersion || !ids.includes(appState.selectedVersion)) {
        const newest = res.latest?.stable || res.latest?.experimental || appState.loaderVersions[0]?.id || null;
        if (newest) {
          appState.selectedVersion = newest;
          appState.selectedVersionChannel = res.latest?.stable === newest ? "stable" : "experimental";
        }
      }
    } catch (e) {
      appState.loaderVersions = [];
      appState.versionsError = e?.message || String(e);
    } finally {
      if (!quiet) appState.versionsLoading = false;
    }
  }

  /** The All/Stable/Experimental pills only filter the already-loaded list. */
  function handleVersionChannel(channel) {
    appState.versionChannel = channel;
  }

  async function handleSelectVersion(v, ch) {
    appState.selectedVersion = v;
    if (ch) appState.selectedVersionChannel = ch;
    await loadLoaderBuilds(appState.selectedLoader, v);
  }

  /**
   * "Latest estable / experimental": reset the filter to "Todos" and select the requested build.
   *
   * The list is already loaded (channel "all"), so this only resolves and selects — no network
   * call and no loading flag, which means no modal repaint / flicker. The component scrolls the
   * newly selected entry into view.
   */
  async function handlePickLatest(channel = "stable") {
    const loaderId = appState.selectedLoader;
    if (!loaderId) return;
    const want = channel === "experimental" ? "experimental" : "stable";
    appState.versionChannel = "all";
    appState.versionsError = null;
    if (!(appState.loaderVersions || []).length) {
      await fetchVersions(loaderId);
    }
    const pick = pickLatest(appState.loaderVersions, appState.versionsMeta, want);
    if (pick) {
      appState.selectedVersion = pick;
      appState.selectedVersionChannel = want;
      await loadLoaderBuilds(loaderId, pick);
    } else {
      toasts.warning(`No hay versión ${want === "experimental" ? "experimental" : "estable"} para este loader`);
    }
  }

  async function loadLoaderBuilds(loaderId, mcVersion, channel = "all") {
    appState.loaderBuilds = [];
    appState.loaderBuildsSupported = false;
    appState.loaderBuildsError = null;
    if (!loaderId || !mcVersion) { appState.loaderBuildsLoading = false; appState.selectedLoaderBuild = null; return; }
    appState.loaderBuildsLoading = true;
    try {
      const res = await loadLoaderVersions(loaderId, mcVersion, channel);
      appState.loaderBuilds = res.items;
      appState.loaderBuildsSupported = !!res.supported && res.items.length > 0;
      appState.loaderBuildsError = res.error;
      const pick = (channel === "stable" ? res.latest?.stable : channel === "experimental" ? res.latest?.experimental : (res.latest?.default || res.latest?.stable || res.latest?.experimental)) || res.items[0]?.id || null;
      appState.selectedLoaderBuild = appState.loaderBuilds.some((b) => (typeof b === "string" ? b : b?.id) === pick) ? pick : (appState.loaderBuilds[0]?.id || null);
    } catch (e) {
      appState.loaderBuildsError = e?.message || String(e);
      appState.selectedLoaderBuild = null;
    } finally {
      appState.loaderBuildsLoading = false;
    }
  }

  /** Loader build pills only filter the already-loaded list; no refetch (keeps selection stable). */
  function handleLoaderBuildChannel(channel) {
    appState.loaderBuildChannel = channel;
    appState.selectedLoaderBuild = reconcileSelection(appState.loaderBuilds, channel, appState.selectedLoaderBuild);
  }

  /** "Latest estable / experimental" of a loader build: reset the filter to Todos and select it. */
  async function handlePickLatestLoaderBuild(channel = "stable") {
    const loaderId = appState.selectedLoader;
    const mcVersion = appState.selectedVersion;
    if (!loaderId || !mcVersion) return;
    const want = channel === "experimental" ? "experimental" : "stable";
    appState.loaderBuildChannel = "all";
    appState.loaderBuildsLoading = true;
    appState.loaderBuildsError = null;
    try {
      const res = await loadLoaderVersions(loaderId, mcVersion, "all");
      const items = res.items || [];
      const latest = res.latest || {};
      appState.loaderBuilds = items;
      appState.loaderBuildsSupported = !!res.supported && items.length > 0;
      appState.loaderBuildsError = res.error;
      if (!items.length) { toasts.warning("No loader builds for this version"); return; }
      const pick = pickLatestBuild(items, res, want);
      if (pick) appState.selectedLoaderBuild = pick;
    } catch (e) {
      appState.loaderBuildsError = e?.message || String(e);
    } finally {
      appState.loaderBuildsLoading = false;
    }
  }

  async function handleCreate({ memoryMax, jvmArgs, ports }) {
    appState.createLoading = true;
    const name = appState.createName.trim();
    try {
      const res = await createServer({
        name,
        loader: appState.selectedLoader,
        loader_version: appState.selectedVersion,
        loader_build: appState.selectedLoaderBuild || "",
        loader_channel: appState.selectedVersionChannel || (appState.versionChannel === "experimental" ? "experimental" : "stable"),
        java_version: appState.selectedJava,
        memory_max: memoryMax,
        jvm_args: jvmArgs ?? "",
        ...(ports ? { ports } : {}),
      });
      const id = typeof res === "string" ? res : res?.id;
      await refreshServers({ updates: true });
      showCreate = false;
      Object.assign(appState, {
        createName: "",
        selectedLoader: null,
        selectedVersion: null,
        selectedLoaderBuild: null,
        selectedVersionChannel: "stable",
        loaderBuildChannel: "all",
        loaderBuilds: [],
        loaderBuildsSupported: false,
        loaderBuildsLoading: false,
        loaderBuildsError: null,
        versionChannel: "all",
        versionsSearch: "",
        versionsError: null,
      });
      if (res?.installError) toasts.warning(`Server "${name}" created, but install failed: ${res.installError}`);
      else toasts.success(`Server "${name}" created`);
      if (id) router.navigate(`/server/${id}`);
    } catch (e) {
      toasts.error("Could not create the server", e);
    } finally {
      appState.createLoading = false;
    }
  }

  function handleJavaChanged(info) {
    appState.javaInfo = info;
    appState.javaRuntimes = info.runtimes || [];
    appState.detectedJava = info.detected || [];
  }
</script>

<div class="app">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <Sidebar servers={appState.servers} activeView={view} accentColor={appState.accentColor} currentPath={path} updateAvailable={!!appState.updateState?.updateAvailable} updateVersion={appState.updateState?.latest || null} />

  <main class="main-content" id="main-content">
    <div class="view">
      {#if booting && !appState.servers.length && view === "servers"}
        <div class="boot">
          <span class="boot-mark" aria-hidden="true">SMP</span>
          <div class="boot-copy">
            <strong>Preparing your workspace</strong>
            <span>Loading servers…</span>
          </div>
          <div class="spinner"></div>
        </div>
      {:else if view === "servers"}
        <Dashboard
          servers={appState.servers}
          busyId={busyId}
          onStart={handleStart}
          onStop={handleStop}
          onRestart={handleRestart}
          onForceStop={requestForceStop}
          onRefresh={handleRefresh}
          onCreateModpack={() => (showModpack = true)}
        />
      {:else if view === "server" && serverId}
        {#if loadedViews.server && loadedViews.server !== "loading"}
          {@const ServerDetail = loadedViews.server}
          {#key serverId}
            <ServerDetail id={serverId} />
          {/key}
        {:else}
          <div class="boot"><div class="spinner"></div><span>Loading server…</span></div>
        {/if}
      {:else if view === "mods"}
        {#if loadedViews.mods && loadedViews.mods !== "loading"}
          {@const ModsBrowser = loadedViews.mods}
          <ModsBrowser {appState} onServerCreated={refreshServers} />
        {:else}
          <div class="boot"><div class="spinner"></div><span>Loading store…</span></div>
        {/if}
      {:else if view === "settings"}
        {#if loadedViews.settings && loadedViews.settings !== "loading"}
          {@const Settings = loadedViews.settings}
          <Settings {appState} onJavaChanged={handleJavaChanged} onServersChanged={() => refreshServers({ updates: false })} onAccent={(color) => applyAccent(color)} onUpdateStateChanged={(next) => (appState.updateState = next)} />
        {:else}
          <div class="boot"><div class="spinner"></div><span>Loading settings…</span></div>
        {/if}
      {:else}
        <Dashboard servers={appState.servers} busyId={busyId} onStart={handleStart} onStop={handleStop} onRestart={handleRestart} onForceStop={requestForceStop} onRefresh={handleRefresh} onCreateModpack={() => (showModpack = true)} />
      {/if}
    </div>
  </main>

  <CreateServer
    bind:open={showCreate}
    loaders={appState.loaders}
    versions={appState.loaderVersions}
    versionsMeta={appState.versionsMeta}
    versionsLoading={appState.versionsLoading}
    versionsError={appState.versionsError}
    javaRuntimes={appState.javaRuntimes}
    versionsSearch={appState.versionsSearch}
    versionChannel={appState.versionChannel}
    selectedLoader={appState.selectedLoader}
    selectedVersion={appState.selectedVersion}
    selectedVersionChannel={appState.selectedVersionChannel}
    selectedJava={appState.selectedJava}
    createName={appState.createName}
    createLoading={appState.createLoading}
    systemInfo={appState.systemInfo}
    onSelectLoader={handleSelectLoader}
    onSelectVersion={handleSelectVersion}
    onSelectJava={(id) => { appState.selectedJava = id; }}
    onSearchVersions={(v) => { appState.versionsSearch = v; }}
    onVersionChannel={handleVersionChannel}
    onPickLatest={handlePickLatest}
    onLoaderBuildChannel={handleLoaderBuildChannel}
    onPickLatestLoaderBuild={handlePickLatestLoaderBuild}
    onCreateName={(v) => { appState.createName = v; }}
    onCreate={handleCreate}
    onClose={() => { showCreate = false; }}
    selectedLoaderBuild={appState.selectedLoaderBuild}
    loaderBuilds={appState.loaderBuilds}
    loaderBuildsLoading={appState.loaderBuildsLoading}
    loaderBuildsSupported={appState.loaderBuildsSupported}
    loaderBuildsError={appState.loaderBuildsError}
    loaderBuildChannel={appState.loaderBuildChannel}
    onSelectLoaderBuild={(v) => { appState.selectedLoaderBuild = v; }}
    onOpenModpack={() => { showCreate = false; showModpack = true; }}
  />

  {#if showModpack}
    <ModpackCreate
      bind:open={showModpack}
      onclose={() => { showModpack = false; }}
      onopenblank={() => { showModpack = false; showCreate = true; }}
      oncreated={(id) => { refreshServers(); router.navigate(`/server/${id}`); }}
    />
  {/if}

  <ToastStack />

  <nav class="mobile-nav" aria-label="Main navigation">
    <button type="button" class:active={view === "servers"} onclick={() => router.navigate("/")}>
      <Icon name="grid" size={18} />
      <span>Servers</span>
    </button>
    <button type="button" class:active={view === "mods"} onclick={() => router.navigate("/mods")}>
      <Icon name="puzzle" size={18} />
      <span>Mods</span>
    </button>
    <button type="button" class:active={view === "settings"} onclick={() => router.navigate("/settings")}>
      <Icon name="settings" size={18} />
      <span>Settings</span>
    </button>
    <button type="button" onclick={() => (showModpack = true)}>
      <Icon name="package" size={18} />
      <span>Pack</span>
    </button>
    <button type="button" class="mobile-new" onclick={() => (showCreate = true)}>
      <Icon name="plus" size={18} />
      <span>New</span>
    </button>
  </nav>

  <Modal bind:open={eulaOpen} title="Minecraft EULA" subtitle="Accept the license to start this instance" size="sm" dismissible={!eulaBusy} closeOnBackdrop={!eulaBusy} onclose={closeEula}>
    {#snippet children()}
      <div class="stack">
        <Alert tone="warning" title="EULA not accepted">
          This server has <code>eula=false</code> in its <code>eula.txt</code>. The Minecraft EULA must be accepted before it can start. Accepting only changes <code>eula.txt</code> for this server.
        </Alert>
        <p class="eula-copy">
          <a href={MC_EULA_URL} target="_blank" rel="noopener noreferrer">Read the Minecraft EULA <Icon name="external-link" size={12} /></a>
        </p>
        <p class="muted eula-note">If you do not accept it, the server will not start.</p>
      </div>
    {/snippet}
    {#snippet footer()}
      <button class="btn btn-outline btn-sm" type="button" disabled={eulaBusy} onclick={closeEula}>Do not accept</button>
      <button class="btn btn-primary btn-sm" type="button" disabled={eulaBusy} onclick={handleEulaAccept}>{eulaBusy ? "Working…" : (eulaAction === "restart" ? "Accept and restart" : "Accept and start")}</button>
    {/snippet}
  </Modal>

  <ConfirmDialog
    bind:open={forceStopOpen}
    title="Force stop server"
    message={forceStopTarget ? `Kill "${forceStopTarget.name}" immediately? The process is terminated without saving the world. Unsaved chunks, player data and configuration changes can be lost or corrupted. Use the normal Stop button unless the server is stuck.` : ""}
    confirmLabel="Force stop"
    busy={forceStopBusy}
    onconfirm={confirmForceStop}
    oncancel={() => { forceStopOpen = false; forceStopServerId = null; }}
  />
</div>

<style>
  .skip-link {
    position: fixed;
    top: 10px;
    left: 10px;
    z-index: 1000;
    padding: 8px 12px;
    color: #fff;
    font-size: 0.8rem;
    font-weight: 600;
    background: var(--accent);
    border-radius: var(--radius-sm);
    transform: translateY(-160%);
    transition: transform var(--t-fast);
  }
  .skip-link:focus { transform: none; }
  .boot { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 80px 0; color: var(--text-secondary); font-size: 0.9rem; }
  .boot-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    color: #fff;
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.03em;
    background: linear-gradient(135deg, var(--accent-hover), var(--accent-dark));
    border: 1px solid color-mix(in srgb, var(--accent) 60%, #fff);
    border-radius: 9px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.24), 0 8px 18px -10px var(--accent);
  }
  .boot-copy { display: flex; flex-direction: column; line-height: 1.3; }
  .boot-copy strong { color: var(--text); font-size: 0.86rem; font-weight: 650; }
  .boot-copy span { color: var(--text-disabled); font-size: 0.75rem; }
  .spinner { width: 18px; height: 18px; border: 2px solid var(--border-secondary); border-top-color: var(--accent); border-radius: 50%; animation: appspin 0.8s linear infinite; }
  @keyframes appspin { to { transform: rotate(360deg); } }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .eula-copy { margin: 0; font-size: 0.86rem; }
  .eula-copy a { display: inline-flex; align-items: center; gap: 4px; text-decoration: underline; text-underline-offset: 2px; }
  .eula-note { margin: 0; font-size: 0.8rem; }

  .mobile-nav { display: none; }

  @media (max-width: 900px) {
    .mobile-nav {
      display: flex;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: var(--z-mobile-nav);
      gap: 4px;
      padding: 7px 8px calc(7px + env(safe-area-inset-bottom));
      background: color-mix(in srgb, var(--sidebar) 92%, transparent);
      border-top: 1px solid var(--border);
      backdrop-filter: blur(14px);
    }
    .mobile-nav button {
      display: inline-flex;
      flex: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      min-height: 46px;
      color: var(--text-disabled);
      font-size: 0.64rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      border: 1px solid transparent;
      border-radius: var(--radius);
      transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
    }
    .mobile-nav button.active { color: var(--text); background: var(--panel-elevated); border-color: var(--border); }
    .mobile-nav button.active :global(.icon) { color: var(--accent); }
    .mobile-nav button.mobile-new { color: #fff; background: linear-gradient(180deg, var(--accent-hover), var(--accent)); border-color: var(--accent); }
  }
</style>
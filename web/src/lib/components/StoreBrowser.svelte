<script>
  import { untrack } from "svelte";
  import { searchStore, loadStoreProject, installMod, installModpack, loadModSources, loadMinecraftVersions, loadVersions } from "../stores.js";
  import { toasts } from "../toast.js";
  import { router } from "../router.js";
  import { renderDescription } from "../markdown.js";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import Alert from "./ui/Alert.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import Select from "./ui/Select.svelte";
  import Segmented from "./ui/Segmented.svelte";
  import Modal from "./ui/Modal.svelte";
  import Spinner from "./ui/Spinner.svelte";
  import TextField from "./ui/TextField.svelte";
  import Icon from "./ui/Icon.svelte";
  import {
    STORE_SOURCES, STORE_TYPES, typeFromLoader, formatDownloads, formatDate, channelTone, channelLabel,
    primaryFile, shortHash, sourceName, versionMatches, versionCompatibility, compatibilityFor,
    FALLBACK_MINECRAFT_VERSIONS, labelForLoader,
  } from "../storeBrowser.js";

  let {
    servers = [],
    targetServerId = $bindable(""),
    source = $bindable("modrinth"),
    type = $bindable("mod"),
    loader = $bindable(""),
    gameVersion = $bindable(""),
    systemInfo = null,
    allowInstall = true,
    compact = false,
    onInstalled = undefined,
    onCreated = undefined,
  } = $props();

  let query = $state("");
  let loading = $state(false);
  let error = $state("");
  let results = $state([]);
  let total = $state(0);
  let offset = $state(0);
  let sort = $state("relevance");
  const limit = 20;
  let sources = $state([]);
  let sourcesLoaded = $state(false);
  let minecraftVersions = $state([]);
  let velocityVersions = $state([]);
  let searchTimer = null;
  let lastQuery = "";

  const QUICK_SEARCHES = ["Create", "Fabric API", "Sodium", "JEI", "Terralith", "Aether"];

  let detailsOpen = $state(false);
  let detailsLoading = $state(false);
  let detailsError = $state("");
  let detailsProject = $state(null);
  let detailsVersions = $state([]);
  let detailsVersionId = $state(null);
  let detailsView = $state("preview");
  let onlyCompatible = $state(false);
  let installBusy = $state(false);

  let installOpen = $state(false);
  let installProject = $state(null);
  let installTargetId = $state("");
  let installServerQuery = $state("");

  let targetPickerOpen = $state(false);
  let targetMode = $state("server");
  let targetServerChoice = $state("");
  let targetServerQuery = $state("");
  let targetLoaderChoice = $state("");
  let targetVersionChoice = $state("");

  let packOpen = $state(false);
  let packName = $state("");
  let packMemory = $state(2048);
  let packBusy = $state(false);
  let packError = $state("");
  const maxRamMb = $derived(Math.max(1024, Math.floor(Number(systemInfo?.memory?.maxMb || systemInfo?.totalRamMb || 8192))));

  let targetServer = $derived((servers || []).find((s) => s.id === targetServerId) || null);
  // The destination server decides install compatibility; the toolbar loader/version only
  // scopes the store search, so a mod can still be inspected for an incompatible server.
  let compatLoader = $derived(targetServer ? (targetServer.loader || "") : loader);
  let compatGameVersion = $derived(targetServer ? (targetServer.loader_version || "") : gameVersion);
  let didInitTarget = false;
  let versionLabel = $derived(loader === "velocity" ? "Velocity version" : "Minecraft version");
  let versionOptions = $derived.by(() => {
    const sourceList = loader === "velocity" ? velocityVersions : (minecraftVersions.length ? minecraftVersions : FALLBACK_MINECRAFT_VERSIONS);
    const list = sourceList.map((v) => ({ value: v, label: v }));
    for (const v of [targetServer?.loader_version, gameVersion]) {
      if (!v || list.some((o) => o.value === v)) continue;
      list.unshift({ value: v, label: `${v} (current)` });
    }
    return [{ value: "", label: "Any version" }, ...list];
  });
  let selectedSource = $derived((sources || []).find((s) => s.id === source) || null);
  let effectiveType = $derived(source === "ftb" ? "modpack"
    : (source === "hangar" || source === "spigot") ? "plugin"
      : type);
  let filteredVersions = $derived.by(() => {
    const list = detailsVersions || [];
    if (!onlyCompatible) return list;
    return list.filter((v) => versionMatches(v, compatLoader, compatGameVersion));
  });
  let shownVersions = $derived(filteredVersions.slice(0, 100));
  let compatibleCount = $derived((detailsVersions || []).filter((v) => versionMatches(v, compatLoader, compatGameVersion)).length);

  // Filtering out the selected build must move the selection, otherwise the footer
  // would keep installing a version the user can no longer see.
  $effect(() => {
    if (!onlyCompatible || !detailsVersions.length) return;
    if (filteredVersions.some((v) => v.id === detailsVersionId)) return;
    detailsVersionId = filteredVersions[0]?.id || null;
  });
  let targetIsBedrock = $derived(targetServer?.loader === "bedrock");
  let targetIsEndstone = $derived(targetServer?.loader === "endstone");
  let canInstall = $derived(allowInstall && (servers || []).length > 0);
  let isModpackSource = $derived(source === "curseforge" || source === "modrinth" || source === "ftb" || source === "custom");
  let isPluginOnlySource = $derived(source === "hangar" || source === "spigot");
  let typeOptions = $derived(STORE_TYPES.filter((t) => {
    if (t.value === "modpack") return isModpackSource;
    if (t.value === "datapack") return source === "modrinth";
    if (t.value === "mod") return !isPluginOnlySource;
    return true;
  }).map((t) => t.value === "plugin" && source === "curseforge" ? { ...t, label: "Bukkit plugins" } : t));

  let installCandidate = $derived(installProject ? {
    loaders: installProject.loaders || [],
    gameVersions: installProject.game_versions || [],
    projectType: installProject.project_type || type,
  } : null);
  let installTargetServer = $derived((servers || []).find((s) => s.id === installTargetId) || null);
  let installTargetCompat = $derived(installTargetServer ? compatibilityFor(installTargetServer, installCandidate) : null);

  function serverMatchesQuery(server, query) {
    if (!query) return true;
    const haystack = `${server.name || ""} ${server.loader || ""} ${server.loader_version || ""}`.toLowerCase();
    return haystack.includes(query);
  }

  let installServers = $derived.by(() => {
    const query = installServerQuery.trim().toLowerCase();
    const list = (servers || []).filter((s) => serverMatchesQuery(s, query));
    // Compatible destinations first, then the incompatible (still selectable) ones.
    return list.sort((a, b) => {
      const aOk = compatibilityFor(a, installCandidate).compatible ? 0 : 1;
      const bOk = compatibilityFor(b, installCandidate).compatible ? 0 : 1;
      return aOk - bOk;
    });
  });
  let installCompatibleCount = $derived((servers || []).filter((s) => compatibilityFor(s, installCandidate).compatible).length);

  let targetServers = $derived.by(() => {
    const query = targetServerQuery.trim().toLowerCase();
    return (servers || []).filter((s) => serverMatchesQuery(s, query));
  });
  let selectedVersion = $derived((detailsVersions || []).find((v) => v.id === detailsVersionId) || null);
  let selectedVersionCompat = $derived(selectedVersion ? versionCompatibility(selectedVersion, compatLoader, compatGameVersion) : { compatible: true, reasons: [] });

  const LOADER_OPTIONS = [
    { value: "", label: "Any loader" },
    { value: "vanilla", label: "Vanilla / datapack" },
    { value: "fabric", label: "Fabric" },
    { value: "quilt", label: "Quilt" },
    { value: "forge", label: "Forge" },
    { value: "neoforge", label: "NeoForge" },
    { value: "paper", label: "Paper / Purpur / Spigot / Bukkit" },
    { value: "folia", label: "Folia" },
    { value: "pumpkinmc", label: "PumpkinMC" },
    { value: "velocity", label: "Velocity" },
    { value: "waterfall", label: "Waterfall" },
    { value: "bungeecord", label: "BungeeCord" },
  ];

  loadModSources().then((list) => { sources = list; sourcesLoaded = true; }).catch(() => { sources = STORE_SOURCES.map((s) => ({ id: s.value, name: s.label, configured: s.value !== "curseforge", needsKey: s.value === "curseforge" })); sourcesLoaded = true; });
  loadMinecraftVersions().then((list) => { if (list.length) minecraftVersions = list; }).catch(() => { minecraftVersions = FALLBACK_MINECRAFT_VERSIONS; });
  loadVersions("velocity").then((res) => { velocityVersions = (res.items || []).map((v) => v.id || v).filter(Boolean); }).catch(() => { velocityVersions = []; });

  function sourceDefaults(server) {
    const targetType = server ? typeFromLoader(server.loader) : "mod";
    if (source === "hangar" || source === "spigot") {
      return { loader: server?.loader === "velocity" ? "velocity" : "paper", gameVersion: server?.loader_version || "", type: "plugin" };
    }
    if (source === "ftb") {
      return { loader: "", gameVersion: server?.loader_version || "", type: "modpack" };
    }
    if (source === "curseforge" && targetType === "datapack") {
      return { loader: "", gameVersion: server?.loader_version || "", type: "mod" };
    }
    return { loader: server?.loader || "", gameVersion: server?.loader_version || "", type: targetType };
  }

  $effect(() => {
    if (didInitTarget || !(servers || []).length) return;
    didInitTarget = true;
    if (!targetServerId) targetServerId = servers[0].id;
  });

  function applyServerDefaults(server) {
    if (!server) return;
    const defaults = sourceDefaults(server);
    loader = defaults.loader;
    gameVersion = defaults.gameVersion;
    type = defaults.type;
  }

  function openInstall(project) {
    if (!(servers || []).length) return toasts.error("Create a server first");
    installProject = project;
    installTargetId = targetServerId || servers[0]?.id || "";
    installServerQuery = "";
    installOpen = true;
  }

  function confirmInstallTarget() {
    const server = (servers || []).find((s) => s.id === installTargetId);
    if (!server) return toasts.error("Select a destination server");
    if (installTargetCompat?.blocking) return toasts.error("This server cannot run mods or plugins");
    // Only the destination changes: the search keeps its loader / version so the
    // project's versions can still be listed and checked against this server.
    targetServerId = server.id;
    const project = installProject;
    installOpen = false;
    installProject = null;
    if (project) openDetails(project);
  }

  function openTargetPicker() {
    targetMode = "server";
    targetServerChoice = targetServerId || servers[0]?.id || "";
    targetServerQuery = "";
    targetLoaderChoice = loader;
    targetVersionChoice = gameVersion;
    targetPickerOpen = true;
  }

  function applyTargetServer() {
    const server = (servers || []).find((s) => s.id === targetServerChoice);
    if (!server) return toasts.error("Select a server");
    targetServerId = server.id;
    applyServerDefaults(server);
    targetPickerOpen = false;
    if (query.trim()) runSearch(true);
  }

  function applyManualTarget() {
    if (!targetLoaderChoice && !targetVersionChoice) return toasts.error("Select a loader or a version");
    changeLoader(targetLoaderChoice, false);
    gameVersion = targetVersionChoice;
    targetPickerOpen = false;
    if (query.trim()) runSearch(true);
  }

  function changeSource(value) {
    source = value;
    const targetType = targetServer ? typeFromLoader(targetServer.loader) : "mod";
    if (value === "ftb") {
      type = "modpack";
      loader = "";
    } else if (value === "hangar" || value === "spigot") {
      type = "plugin";
      loader = targetServer?.loader === "velocity" ? "velocity" : (typeFromLoader(loader) === "plugin" ? loader : "paper");
    } else if (value === "curseforge" && targetType === "datapack") {
      type = "mod";
      loader = "";
    } else if (targetType === "datapack") {
      type = "datapack";
      loader = "vanilla";
    } else if (targetType === "plugin") {
      type = "plugin";
      if (typeFromLoader(loader) !== "plugin") loader = "paper";
    } else {
      type = "mod";
      const targetLoader = targetServer?.loader || "";
      if (!loader || typeFromLoader(loader) === "plugin" || loader === "vanilla") loader = targetLoader;
    }
    results = [];
    error = "";
    offset = 0;
    if (query.trim()) runSearch(true);
  }

  function changeType(value) {
    type = value;
    if (source === "hangar" || source === "spigot") {
      type = "plugin";
      if (typeFromLoader(loader) !== "plugin") loader = "paper";
    } else if (value === "modpack") {
      loader = "";
    } else if (value === "mod") {
      if (loader === "vanilla") loader = "";
    } else if (value === "plugin") {
      if (!loader || typeFromLoader(loader) !== "plugin") loader = targetServer?.loader === "velocity" ? "velocity" : "paper";
      if (loader === "velocity") gameVersion = targetServer?.loader_version || gameVersion;
    } else if (value === "datapack") {
      if (loader !== "vanilla") loader = "vanilla";
    }
    results = [];
    error = "";
    offset = 0;
    if (query.trim()) runSearch(true);
  }

  function changeLoader(value, run = true) {
    const wasVelocity = loader === "velocity";
    loader = value;
    if (source === "ftb") {
      loader = "";
      type = "modpack";
    } else if (source === "hangar" || source === "spigot") {
      type = "plugin";
      if (typeFromLoader(value) !== "plugin") loader = targetServer?.loader === "velocity" ? "velocity" : "paper";
    } else if (source === "curseforge" && value === "vanilla") {
      loader = "";
      type = "mod";
    } else {
      const derived = value ? typeFromLoader(value) : "";
      if (value === "vanilla") type = "datapack";
      else if (derived === "plugin" && type !== "plugin" && type !== "modpack") type = "plugin";
      else if (derived === "mod" && (type === "plugin" || type === "datapack")) type = "mod";
    }
    if (value === "velocity") {
      type = "plugin";
      if (targetServer?.loader === "velocity" && targetServer.loader_version) gameVersion = targetServer.loader_version;
      else if (!velocityVersions.includes(gameVersion)) gameVersion = velocityVersions[0] || "";
    } else if (wasVelocity && targetServer?.loader !== "velocity") {
      gameVersion = targetServer?.loader_version || "";
    }
    results = [];
    error = "";
    offset = 0;
    if (run && query.trim()) runSearch(true);
  }

  async function runSearch(reset = true) {
    const q = query.trim();
    lastQuery = q;
    if (reset) offset = 0;
    if (!q && source !== "ftb") { results = []; total = 0; error = ""; return; }
    loading = true;
    error = "";
    try {
      const data = await searchStore({
        q, source, type: effectiveType, loader, gameVersion,
        limit, offset: reset ? 0 : offset, sort,
      });
      results = data.results || [];
      total = data.total || 0;
      if (!data.configured) error = `${sourceName(source)} needs an API key. Add it in Settings → CurseForge.`;
      else if (data.error) error = data.error;
    } catch (e) {
      error = e?.message || String(e);
      results = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  // Search while typing, so the grid reacts without requiring Enter or the Search button.
  $effect(() => {
    const q = query.trim();
    const src = untrack(() => source);
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) {
      lastQuery = "";
      if (src !== "ftb") { results = []; total = 0; }
      return;
    }
    searchTimer = setTimeout(() => { if (q !== lastQuery) runSearch(true); }, 380);
    return () => { if (searchTimer) clearTimeout(searchTimer); };
  });

  function quickSearch(value) {
    query = value;
    runSearch(true);
  }

  function nextPage() {
    if (offset + limit >= total) return;
    offset += limit;
    runSearch(false);
  }

  function prevPage() {
    if (offset <= 0) return;
    offset = Math.max(0, offset - limit);
    runSearch(false);
  }

  async function openDetails(project) {
    detailsProject = project;
    detailsOpen = true;
    detailsLoading = true;
    detailsError = "";
    detailsVersions = [];
    detailsVersionId = null;
    detailsView = "preview";
    try {
      let data = await loadStoreProject(source, project.id, {
        loader, gameVersion, includeVersions: true,
      });
      let versions = data.versions || [];
      // A loader/version mismatch can make the store return nothing. Refetch unfiltered so
      // incompatible builds can still be listed (greyed out) instead of showing "no versions".
      if (!versions.length && (loader || gameVersion)) {
        try {
          const relaxed = await loadStoreProject(source, project.id, { includeVersions: true });
          if (relaxed.versions?.length) {
            versions = relaxed.versions;
            data = { ...data, project: { ...data.project, ...relaxed.project } };
          }
        } catch { /* keep the filtered result */ }
      }
      const fetched = data.project || {};
      detailsProject = {
        ...project,
        ...fetched,
        body: fetched.body || project.body || "",
        description: fetched.description || project.description || "",
        description_format: fetched.description_format || project.description_format || "markdown",
      };
      detailsVersions = versions;
      const compatible = versions.filter((v) => versionMatches(v, compatLoader, compatGameVersion));
      detailsVersionId = (compatible[0] || versions[0])?.id || null;
    } catch (e) {
      detailsError = e?.message || String(e);
    } finally {
      detailsLoading = false;
    }
  }

  function closeDetails() {
    detailsOpen = false;
    detailsProject = null;
    detailsVersions = [];
    detailsVersionId = null;
    detailsError = "";
    detailsView = "preview";
  }

  function selectVersion(version) {
    detailsVersionId = version.id;
  }

  async function installSelected() {
    if (!targetServerId) return toasts.error("Select a destination server");
    const version = (detailsVersions || []).find((v) => v.id === detailsVersionId);
    const file = primaryFile(version);
    if (!version) return toasts.error("Select a version");
    if (!file?.url) return toasts.error("This version has no downloadable file");
    installBusy = true;
    try {
      await installMod(targetServerId, {
        source: detailsProject?.source || version.source || source,
        project_id: version.project_id || detailsProject?.id,
        version_id: version.id,
        version: version.version_number || version.name,
        filename: file.filename,
        download_url: file.url,
        sha1: file.hashes?.sha1 || "",
        sha256: file.hashes?.sha256 || "",
        sha512: file.hashes?.sha512 || "",
        file_size: file.size || null,
        project_title: detailsProject?.title || version.project_title || "",
        slug: detailsProject?.slug || version.project_slug || "",
        icon_url: detailsProject?.icon_url || version.icon_url || "",
        game_versions: version.game_versions || [],
        loaders: version.loaders || [],
        channel: version.channel || "",
        date_published: version.date_published || null,
        changelog: version.changelog || "",
        dependencies: version.dependencies || [],
        store_url: version.store_url || detailsProject?.store_url || "",
        project_type: detailsProject?.project_type || type,
      });
      toasts.success(`Installed ${detailsProject?.title || "project"}`);
      closeDetails();
      onInstalled?.();
    } catch (e) {
      toasts.error("Install failed", e);
    } finally {
      installBusy = false;
    }
  }

  function openPackCreate() {
    if (!detailsProject) return;
    packName = `${detailsProject.title || "Modpack"} SMP`;
    packMemory = Math.min(4096, maxRamMb);
    packError = "";
    packOpen = true;
  }

  async function createPackServer() {
    const version = (detailsVersions || []).find((v) => v.id === detailsVersionId);
    if (!version) return toasts.error("Select a modpack version");
    if (!packName.trim()) return toasts.error("Enter a server name");
    packBusy = true;
    packError = "";
    try {
      const res = await installModpack({
        name: packName.trim(),
        source,
        project_id: detailsProject.id,
        version_id: version.id,
        loader: loader || "",
        loader_version: gameVersion || "",
        memory_max: `${packMemory}M`,
        memory_min: "1G",
        jvm_args: "",
      });
      if (res?.ok && res?.id) {
        toasts.success(`Server "${packName.trim()}" created`);
        if (res.warnings?.length) toasts.warning(`${res.warnings.length} file(s) skipped`);
        packOpen = false;
        closeDetails();
        onInstalled?.(res.id);
        onCreated?.(res.id);
        if (!onCreated) router.navigate(`/server/${res.id}`);
      } else {
        packError = res?.error || "Could not create the server";
      }
    } catch (e) {
      packError = e?.message || String(e);
    } finally {
      packBusy = false;
    }
  }

  function openProjectPage() {
    const url = detailsProject?.store_url;
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }
</script>

<div class="store">
  {#if targetIsBedrock}
    <Alert tone="info">Bedrock servers do not support mods or plugins. Pick a Java server to install.</Alert>
  {:else if targetIsEndstone}
    <Alert tone="info">Endstone loads Python/C++ plugins from bedrock_server/plugins; the Java mod browser is not used for this loader.</Alert>
  {/if}
  <div class="toolbar">
    <form class="search-row" onsubmit={(e) => { e.preventDefault(); runSearch(true); }}>
      <SearchInput
        bind:value={query}
        placeholder={source === "ftb" ? "Search FTB modpacks…" : "Search mods, plugins, data packs…"}
        onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(true); } }}
      />
      <div class="search-actions">
        <Button variant="primary" type="submit" loading={loading}><Icon name="search" size={14} /> {loading ? "Searching…" : "Search"}</Button>
        {#if targetServer}
          <Button variant="outline" type="button" onclick={openTargetPicker} title="Choose a server or a loader / version"><Icon name="server" size={14} /> Use server target</Button>
        {/if}
      </div>
    </form>

    <div class="quick-row">
      <span class="muted quick-label">Try</span>
      {#each QUICK_SEARCHES as suggestion}
        <button class="chip" type="button" class:active={query === suggestion} onclick={() => quickSearch(suggestion)}>{suggestion}</button>
      {/each}
    </div>

    <div class="filters">
      <Select bind:value={source} label="Store" options={(sourcesLoaded ? sources : STORE_SOURCES.map((s) => ({ id: s.value, name: s.label }))).map((s) => ({ value: s.id, label: s.needsKey ? `${s.name} (API key)` : s.name }))} onchange={(e) => changeSource(e.currentTarget.value)} />
      <Select bind:value={loader} label="Loader" options={LOADER_OPTIONS} onchange={(e) => changeLoader(e.currentTarget.value)} />
      <Select
        bind:value={gameVersion}
        label={versionLabel}
        options={versionOptions}
        onchange={() => { if (query.trim()) runSearch(true); }}
      />
      <Select
        bind:value={sort}
        label="Sort"
        options={[
          { value: "relevance", label: "Relevance" },
          { value: "downloads", label: "Downloads" },
          { value: "updated", label: "Recently updated" },
          { value: "newest", label: "Newest" },
        ]}
        onchange={() => { if (query.trim()) runSearch(true); }}
      />
      <Select bind:value={targetServerId} label="Install to" options={(servers || []).map((s) => ({ value: s.id, label: s.name }))} />
    </div>

    <div class="type-row">
      <Segmented
        bind:value={type}
        size="sm"
        options={source === "ftb"
          ? [{ value: "modpack", label: "Modpacks" }]
          : typeOptions}
        onchange={(v) => changeType(v)}
      />
      <span class="muted auto-note">
        {#if targetServer}
          Target: <b>{targetServer.name}</b> · {targetServer.loader || "vanilla"} {targetServer.loader_version || ""}
        {:else}
          Select a server to install into.
        {/if}
      </span>
    </div>
  </div>

  {#if selectedSource?.needsKey && !selectedSource?.configured}
    <Alert tone="warning" title="API key required">
      {sourceName(source)} needs an API key. Add it in <a href="#/settings">Settings → CurseForge</a>.
    </Alert>
  {/if}

  {#if error}
    <Alert tone="danger">{error}</Alert>
  {:else if loading && results.length === 0}
    <div class="center"><Spinner label="Searching…" /></div>
  {:else if results.length === 0}
    <EmptyState
      icon="search"
      title={query ? "No results" : "Browse a store"}
      description={query ? `Nothing matched “${query}”. Try another name, store, loader or version.` : "Search by name or pick one of the suggestions above to load results."}
    />
  {:else}
    <div class="results-head">
      <span class="muted">{loading ? "Searching…" : total ? `${offset + 1}–${Math.min(offset + limit, total)} of ${total}` : `${results.length}`} result(s) · {sourceName(source)}</span>
      <span class="muted compact-note">{loader ? `${labelForLoader(loader)}${gameVersion ? ` ${gameVersion}` : ""}` : "Any loader"}{gameVersion && !loader ? ` · ${gameVersion}` : ""}</span>
    </div>
    <div class="grid" class:compact class:loading>
      {#each results as project}
        {@const categories = (project.categories || project.display_categories || []).filter((c) => !LOADER_OPTIONS.some((l) => l.value === c))}
        <article class="card">
          <div class="card-head">
            {#if project.icon_url}
              <img class="icon" src={project.icon_url} alt="" loading="lazy" onerror={(e) => e.currentTarget?.setAttribute("style", "display:none")} />
            {:else}
              <div class="icon placeholder">{(project.title || "?").slice(0, 1)}</div>
            {/if}
            <div class="card-title">
              <div class="name" title={project.title}>{project.title}</div>
              <div class="author muted">{project.author || sourceName(project.source || source)}</div>
            </div>
            {#if project.project_type === "modpack"}<Badge tone="accent">Modpack</Badge>{/if}
          </div>
          <p class="desc">{project.description || "No description"}</p>
          {#if categories.length}
            <div class="tag-row">
              {#each categories.slice(0, 3) as c}<Badge>{c}</Badge>{/each}
            </div>
          {/if}
          <div class="meta">
            <Badge>{sourceName(project.source || source)}</Badge>
            {#if project.downloads != null}<span class="stat"><b>{formatDownloads(project.downloads)}</b> downloads</span>{/if}
            {#if project.followers != null}<span class="stat"><b>{formatDownloads(project.followers)}</b> followers</span>{/if}
          </div>
          <div class="meta subtle-meta">
            {#if project.updated_at}<span>Updated {formatDate(project.updated_at)}</span>{/if}
            {#if project.published_at}<span>Published {formatDate(project.published_at)}</span>{/if}
          </div>
          {#if (project.game_versions || []).length}
            <div class="versions-line muted" title={project.game_versions.join(", ")}>{(project.game_versions || []).slice(0, 6).join(" · ")}{(project.game_versions || []).length > 6 ? " …" : ""}</div>
          {/if}
          <div class="card-actions">
            <Button size="sm" variant="outline" onclick={() => openDetails(project)}><Icon name="eye" size={13} /> Details</Button>
            {#if effectiveType === "modpack"}
              <Button size="sm" variant="primary" onclick={() => openDetails(project)}><Icon name="plus" size={13} /> Create server</Button>
            {:else if allowInstall}
              <Button size="sm" variant="primary" disabled={!canInstall} title={canInstall ? "" : "Create a server first"} onclick={() => openInstall(project)}><Icon name="download" size={13} /> Install</Button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
    {#if total > limit}
      <div class="pager">
        <Button size="sm" variant="outline" disabled={offset <= 0 || loading} onclick={prevPage}><Icon name="chevron-left" size={13} /> Previous</Button>
        <span class="muted">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
        <Button size="sm" variant="outline" disabled={offset + limit >= total || loading} onclick={nextPage}>Next <Icon name="chevron-right" size={13} /></Button>
      </div>
    {/if}
  {/if}
</div>

<Modal bind:open={detailsOpen} title={detailsProject?.title || "Details"} subtitle={detailsProject ? `${sourceName(detailsProject.source || source)}${detailsProject.author ? ` · ${detailsProject.author}` : ""}` : ""} size="xl" onclose={closeDetails}>
  <svelte:fragment>
    {#if detailsError}
      <Alert tone="danger">{detailsError}</Alert>
    {:else if detailsLoading}
      <div class="center"><Spinner label="Loading project…" /></div>
    {:else if detailsProject}
      <div class="details">
        <div class="details-head">
          {#if detailsProject.icon_url}
            <img class="icon lg" src={detailsProject.icon_url} alt="" onerror={(e) => e.currentTarget?.setAttribute("style", "display:none")} />
          {/if}
          <div class="details-title">
            <div class="name">{detailsProject.title}</div>
            <div class="meta">
              <Badge>{sourceName(detailsProject.source || source)}</Badge>
              {#if detailsProject.project_type}<Badge tone="accent">{detailsProject.project_type}</Badge>{/if}
              {#if detailsProject.downloads != null}<span class="muted">{formatDownloads(detailsProject.downloads)} downloads</span>{/if}
              {#if detailsProject.updated_at}<span class="muted">Updated {formatDate(detailsProject.updated_at)}</span>{/if}
            </div>
          </div>
        </div>

        {#if detailsProject.description || detailsProject.body}
          <div class="description-block">
            <div class="section-head">
              <span class="label">Description</span>
              <Segmented
                bind:value={detailsView}
                size="sm"
                options={[{ value: "preview", label: "Preview" }, { value: "source", label: "Source" }]}
              />
            </div>
            {#if detailsView === "preview"}
              <div class="description markdown">{@html renderDescription(detailsProject)}</div>
            {:else}
              <pre class="description source">{detailsProject.body || detailsProject.description}</pre>
            {/if}
          </div>
        {/if}

        {#if (detailsProject.categories || []).length}
          <div class="tag-row">
            {#each (detailsProject.categories || []).slice(0, 12) as c}<Badge>{c}</Badge>{/each}
          </div>
        {/if}

        <div class="details-actions">
          <Button size="sm" variant="outline" onclick={openProjectPage}><Icon name="external-link" size={13} /> Open in store</Button>
        </div>

        <div class="section-head">
          <span class="label">Versions</span>
          <label class="check">
            <input type="checkbox" bind:checked={onlyCompatible} />
            Only compatible{detailsVersions.length ? ` (${compatibleCount}/${detailsVersions.length})` : ""}
          </label>
        </div>

        {#if detailsVersions.length === 0}
          <EmptyState size="sm" icon="package" title="No versions" description="This store did not return versions for this project." />
        {:else if shownVersions.length === 0}
          <EmptyState size="sm" icon="package" title="No compatible versions" description="Disable the compatible filter or change the loader / version." />
        {:else}
          {#if selectedVersion && !selectedVersionCompat.compatible}
            <Alert tone="warning" title="Incompatible version selected">
              {selectedVersionCompat.reasons.join(" · ")}. You can still install it, but the server may fail to load it.
            </Alert>
          {/if}
          <div class="version-list">
            {#each shownVersions as v}
              {@const file = primaryFile(v)}
              {@const compat = versionCompatibility(v, compatLoader, compatGameVersion)}
              <button
                class="version-row"
                class:selected={detailsVersionId === v.id}
                class:incompatible={!compat.compatible}
                type="button"
                title={compat.compatible ? "" : `Not compatible: ${compat.reasons.join(", ")}`}
                onclick={() => selectVersion(v)}
              >
                <span class="version-main">
                  <span class="version-name">{v.version_number || v.name}</span>
                  <span class="muted version-meta">
                    {(v.game_versions || []).join(", ") || "any version"}{v.loaders?.length ? ` · ${v.loaders.join(", ")}` : ""}{v.date_published ? ` · ${formatDate(v.date_published)}` : ""}
                  </span>
                  {#if file}
                    <span class="muted file-meta">{file.filename}{file.size ? ` · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ""}{file.hashes?.sha1 ? ` · sha1 ${shortHash(file.hashes.sha1)}` : ""}</span>
                  {/if}
                </span>
                <span class="version-side">
                  {#if compat.compatible}
                    <Badge tone="success">Compatible</Badge>
                  {:else}
                    <Badge tone="warning">Not compatible</Badge>
                  {/if}
                  <Badge tone={channelTone(v.channel)}>{channelLabel(v.channel)}</Badge>
                  {#if v.downloads != null}<span class="muted">{formatDownloads(v.downloads)}</span>{/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    {#if effectiveType === "modpack"}
      <Button size="sm" variant="outline" disabled={installBusy} onclick={closeDetails}>Close</Button>
      <Button size="sm" variant="primary" loading={installBusy} disabled={!detailsVersionId || detailsLoading} onclick={openPackCreate}><Icon name="plus" size={13} /> Create server from this modpack</Button>
    {:else}
      <Button size="sm" variant="outline" disabled={installBusy} onclick={closeDetails}>Close</Button>
      <Button size="sm" variant="primary" loading={installBusy} disabled={!canInstall || !detailsVersionId || detailsLoading} onclick={installSelected}><Icon name="download" size={13} /> Install {targetServer ? `to ${targetServer.name}` : ""}</Button>
    {/if}
  </svelte:fragment>
</Modal>

<Modal bind:open={packOpen} title="Create server from modpack" subtitle={detailsProject?.title} size="md" onclose={() => (packOpen = false)} dismissible={!packBusy}>
  <svelte:fragment>
    <div class="stack">
      {#if packError}<Alert tone="danger">{packError}</Alert>{/if}
      <TextField bind:value={packName} label="Server name" placeholder="My modpack server" disabled={packBusy} autofocus />
      <div class="field-block">
        <span class="label">Memory</span>
        <input class="range" type="range" min="1024" max={maxRamMb} step="512" bind:value={packMemory} />
        <div class="muted">{(packMemory / 1024).toFixed(1)} GB of {(maxRamMb / 1024).toFixed(1)} GB</div>
      </div>
      <div class="muted pack-summary">
        Source: <b>{sourceName(source)}</b>{detailsProject?.game_versions?.length ? ` · ${detailsProject.game_versions.slice(0, 4).join(", ")}` : ""}
        {#if detailsVersions?.length}<br />Version: <b>{(detailsVersions.find((v) => v.id === detailsVersionId) || {}).version_number || "latest"}</b>{/if}
      </div>
      <Alert tone="info">The panel downloads the modpack, installs its loader, applies overrides and downloads every server-side file. This can take a while.</Alert>
    </div>
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <Button size="sm" variant="outline" disabled={packBusy} onclick={() => (packOpen = false)}>Cancel</Button>
    <Button size="sm" variant="primary" loading={packBusy} disabled={!packName.trim()} onclick={createPackServer}><Icon name="plus" size={13} /> Create server</Button>
  </svelte:fragment>
</Modal>

<Modal bind:open={installOpen} title="Install to server" subtitle={installProject?.title || ""} size="lg" dismissible={!installBusy} onclose={() => { installOpen = false; installProject = null; }}>
  <svelte:fragment>
    <div class="stack">
      <Alert tone="info">
        Pick the server that should receive this {effectiveType}. Incompatible servers are greyed out: you can still choose them, but the files may not load.
      </Alert>
      {#if !(servers || []).length}
        <EmptyState icon="server" title="No servers yet" description="Create a server before installing mods or plugins." />
      {:else}
        <TextField type="search" bind:value={installServerQuery} label="Find a server" placeholder="Filter by name, loader or version" />
        <div class="muted server-summary">{installCompatibleCount} compatible · {(servers || []).length - installCompatibleCount} not compatible</div>
        {#if !installServers.length}
          <EmptyState size="sm" icon="search" title="No servers match" description="Try another name, loader or version." />
        {:else}
          <div class="server-list" role="radiogroup" aria-label="Destination server">
            {#each installServers as s}
              {@const compat = compatibilityFor(s, installCandidate)}
              <button
                type="button"
                class="server-row"
                class:selected={installTargetId === s.id}
                class:incompatible={!compat.compatible}
                role="radio"
                aria-checked={installTargetId === s.id}
                disabled={compat.blocking}
                onclick={() => (installTargetId = s.id)}
              >
                <span class="server-radio" aria-hidden="true"></span>
                <span class="server-main">
                  <span class="server-name">{s.name}</span>
                  <span class="muted server-meta">{s.loader || "vanilla"} {s.loader_version || ""}</span>
                  {#if !compat.compatible && !compat.blocking}<span class="reason">{compat.reasons.join(" · ")}</span>{/if}
                </span>
                {#if compat.blocking}
                  <Badge tone="danger">Unsupported</Badge>
                {:else if compat.compatible}
                  <Badge tone="success">Compatible</Badge>
                {:else}
                  <Badge tone="warning">Not compatible</Badge>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <Button size="sm" variant="outline" disabled={installBusy} onclick={() => { installOpen = false; installProject = null; }}>Cancel</Button>
    <Button size="sm" variant="primary" disabled={!installTargetId || !!installTargetCompat?.blocking} onclick={confirmInstallTarget}><Icon name="arrow-right" size={13} /> Continue</Button>
  </svelte:fragment>
</Modal>

<Modal bind:open={targetPickerOpen} title="Use server target" subtitle="Choose a server or a loader / version for the search" size="lg" onclose={() => (targetPickerOpen = false)}>
  <svelte:fragment>
    <div class="stack">
      <Segmented
        bind:value={targetMode}
        options={[
          { value: "server", label: "A server" },
          { value: "manual", label: "Loader / version" },
        ]}
      />

      {#if targetMode === "server"}
        {#if !(servers || []).length}
          <EmptyState icon="server" title="No servers yet" description="Create a server first, then pick it as the target." />
        {:else}
          <TextField type="search" bind:value={targetServerQuery} label="Find a server" placeholder="Filter by name, loader or version" />
          {#if !targetServers.length}
            <EmptyState size="sm" icon="search" title="No servers match" description="Try another name, loader or version." />
          {:else}
            <div class="server-list" role="radiogroup" aria-label="Target server">
              {#each targetServers as s}
                <button
                  type="button"
                  class="server-row"
                  class:selected={targetServerChoice === s.id}
                  role="radio"
                  aria-checked={targetServerChoice === s.id}
                  onclick={() => (targetServerChoice = s.id)}
                >
                  <span class="server-radio" aria-hidden="true"></span>
                  <span class="server-main">
                    <span class="server-name">{s.name}</span>
                    <span class="muted server-meta">{s.loader || "vanilla"} {s.loader_version || ""}</span>
                  </span>
                  {#if targetServerId === s.id}<Badge tone="accent">Current</Badge>{/if}
                </button>
              {/each}
            </div>
          {/if}
          <div class="muted">Uses that server's loader and Minecraft version for the search, and selects it as the install destination.</div>
        {/if}
      {:else}
        <div class="manual-grid">
          <Select bind:value={targetLoaderChoice} label="Loader" options={LOADER_OPTIONS} />
          <Select bind:value={targetVersionChoice} label={versionLabel} options={versionOptions} />
        </div>
        <div class="muted">The destination server does not change; this loader / version is only used to search. Install compatibility still follows the destination server.</div>
      {/if}
    </div>
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <Button size="sm" variant="outline" onclick={() => (targetPickerOpen = false)}>Cancel</Button>
    {#if targetMode === "server"}
      <Button size="sm" variant="primary" disabled={!targetServerChoice} onclick={applyTargetServer}><Icon name="server" size={13} /> Use server</Button>
    {:else}
      <Button size="sm" variant="primary" disabled={!targetLoaderChoice && !targetVersionChoice} onclick={applyManualTarget}><Icon name="check" size={13} /> Use loader / version</Button>
    {/if}
  </svelte:fragment>
</Modal>

<style>
  .store { display: flex; flex-direction: column; gap: 16px; min-height: 100%; }
  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--panel-elevated) 45%, transparent), var(--panel));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03), var(--shadow);
  }
  .search-row { display: flex; gap: 10px; align-items: center; }
  .search-row :global(.field) { flex: 1; min-width: 0; }
  .search-row :global(.input) { height: 44px; font-size: 0.92rem; }
  .search-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .quick-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .quick-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 2px; }
  .chip {
    padding: 4px 10px;
    color: var(--text-secondary);
    font-size: 0.73rem;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  .chip:hover { color: var(--text); border-color: var(--border-strong); }
  .chip.active { color: var(--accent); background: var(--accent-light); border-color: var(--accent-ring); }
  .filters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  .type-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .auto-note { font-size: 0.76rem; }
  .center { display: flex; align-items: center; justify-content: center; padding: 42px 0; }
  .results-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 0.76rem; }
  .compact-note { font-family: var(--font-mono); font-size: 0.72rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; transition: opacity 0.15s ease; }
  .grid.loading { opacity: 0.5; pointer-events: none; }
  .grid.compact { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    background: linear-gradient(180deg, var(--panel-elevated) 0%, var(--panel) 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03), var(--shadow);
    transition: transform var(--t), border-color var(--t), box-shadow var(--t);
  }
  .card:hover { transform: translateY(-2px); border-color: var(--border-strong); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow-lg); }
  .card-head { display: flex; gap: 12px; align-items: center; min-width: 0; }
  .icon { width: 50px; height: 50px; border-radius: 10px; object-fit: cover; flex: 0 0 auto; background: var(--input-bg); border: 1px solid var(--border); }
  .icon.placeholder { display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.05rem; color: var(--text-secondary); text-transform: uppercase; }
  .icon.lg { width: 64px; height: 64px; border-radius: 14px; font-size: 1.3rem; }
  .card-title { min-width: 0; flex: 1; }
  .name { font-weight: 700; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .author { font-size: 0.74rem; margin-top: 2px; }
  .desc { margin: 0; font-size: 0.8rem; color: var(--text-secondary); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 3.6em; }
  .tag-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 0.74rem; }
  .meta .stat b { color: var(--text); font-weight: 600; }
  .subtle-meta { color: var(--text-disabled); font-size: 0.7rem; gap: 12px; }
  .versions-line { font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 2px; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 0 2px; }
  .details { display: flex; flex-direction: column; gap: 12px; }
  .details-head { display: flex; gap: 12px; align-items: center; }
  .details-title { min-width: 0; }
  .description-block { display: flex; flex-direction: column; gap: 8px; }
  .description { font-size: 0.82rem; line-height: 1.55; color: var(--text-secondary); max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--input-bg); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.18); }
  .description.source { white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.76rem; }
  .description.markdown :global(h1),
  .description.markdown :global(h2),
  .description.markdown :global(h3),
  .description.markdown :global(h4),
  .description.markdown :global(h5),
  .description.markdown :global(h6) { margin: 0.7em 0 0.35em; line-height: 1.25; color: var(--text); }
  .description.markdown :global(h1) { font-size: 1.3rem; }
  .description.markdown :global(h2) { font-size: 1.12rem; }
  .description.markdown :global(h3) { font-size: 1rem; }
  .description.markdown :global(h4),
  .description.markdown :global(h5),
  .description.markdown :global(h6) { font-size: 0.9rem; }
  .description.markdown :global(p) { margin: 0 0 0.75em; }
  .description.markdown :global(p:last-child) { margin-bottom: 0; }
  .description.markdown :global(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .description.markdown :global(img) { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 6px 0; }
  .description.markdown :global(ul),
  .description.markdown :global(ol) { margin: 0 0 0.75em; padding-left: 1.4em; }
  .description.markdown :global(li) { margin: 2px 0; }
  .description.markdown :global(code) { font-family: var(--font-mono); font-size: 0.85em; background: var(--panel-elevated); padding: 1px 4px; border-radius: 4px; }
  .description.markdown :global(pre) { background: var(--panel-elevated); padding: 10px; border-radius: 6px; overflow: auto; margin: 0 0 0.75em; }
  .description.markdown :global(pre code) { background: none; padding: 0; }
  .description.markdown :global(blockquote) { border-left: 3px solid var(--border); margin: 0 0 0.75em; padding: 2px 0 2px 10px; color: var(--text-secondary); }
  .description.markdown :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 0.8em 0; }
  .description.markdown :global(table) { border-collapse: collapse; width: 100%; margin: 0 0 0.75em; font-size: 0.8rem; }
  .description.markdown :global(th),
  .description.markdown :global(td) { border: 1px solid var(--border); padding: 5px 7px; text-align: left; vertical-align: top; }
  .description.markdown :global(th) { background: var(--panel-elevated); }
  .description.markdown :global(center) { display: block; }
  .description.markdown :global(details) { margin: 0.4em 0; }
  .description.markdown :global(summary) { cursor: pointer; }
  .tag-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .details-actions { display: flex; gap: 8px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .check { display: inline-flex; align-items: center; gap: 6px; font-size: 0.76rem; color: var(--text-secondary); }
  .version-list { display: flex; flex-direction: column; gap: 5px; max-height: 420px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; background: var(--input-bg); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.18); }
  .version-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; padding: 9px 10px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; cursor: pointer; transition: background var(--t-fast), border-color var(--t-fast); }
  .version-row:hover { background: var(--panel-elevated); border-color: var(--border); }
  .version-row.selected { border-color: var(--accent); background: var(--accent-light); box-shadow: inset 0 0 0 1px var(--accent-ring); }
  .version-row.incompatible { opacity: 0.55; }
  .version-row.incompatible:hover { opacity: 0.85; }
  .version-row.incompatible.selected { opacity: 1; }
  .server-list { display: flex; flex-direction: column; gap: 6px; max-height: 360px; overflow: auto; padding: 6px; background: var(--input-bg); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.18); }
  .server-summary { font-size: 0.76rem; margin-top: -4px; }
  .server-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 11px;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), opacity var(--t-fast);
  }
  .server-row:hover:not(:disabled) { background: var(--panel-elevated); border-color: var(--border); }
  .server-row.selected { border-color: var(--accent); background: var(--accent-light); box-shadow: inset 0 0 0 1px var(--accent-ring); }
  .server-row.incompatible { opacity: 0.55; }
  .server-row.incompatible:hover:not(:disabled) { opacity: 0.85; }
  .server-row:disabled { cursor: not-allowed; }
  .server-radio { width: 14px; height: 14px; flex: 0 0 auto; border: 1px solid var(--border-strong); border-radius: 50%; background: var(--panel); }
  .server-row.selected .server-radio { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--panel); }
  .server-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .server-name { font-weight: 600; font-size: 0.84rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .server-meta { font-size: 0.72rem; }
  .reason { font-size: 0.7rem; color: var(--warning); }
  .manual-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .version-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .version-name { font-weight: 600; font-size: 0.8rem; }
  .version-meta, .file-meta { font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-meta { font-family: var(--font-mono); }
  .version-side { display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 0.72rem; }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .field-block { display: flex; flex-direction: column; gap: 6px; }
  .range { width: 100%; }
  .pack-summary { font-size: 0.78rem; line-height: 1.5; }
  @media (max-width: 1100px) {
    .filters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 900px) {
    .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .search-row { flex-direction: column; align-items: stretch; }
    .search-actions { justify-content: flex-end; }
    .grid, .grid.compact { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  }
  @media (max-width: 560px) {
    .filters { grid-template-columns: minmax(0, 1fr); }
    .grid, .grid.compact { grid-template-columns: minmax(0, 1fr); }
  }
</style>
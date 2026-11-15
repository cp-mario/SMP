<script>
  import { searchStore, loadStoreVersions, installModpack, uploadModpack, loadStoreProject } from "../stores.js";
  import { toasts } from "../toast.js";
  import { router } from "../router.js";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import Alert from "./ui/Alert.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import Select from "./ui/Select.svelte";
  import Segmented from "./ui/Segmented.svelte";
  import TextField from "./ui/TextField.svelte";
  import Modal from "./ui/Modal.svelte";
  import Spinner from "./ui/Spinner.svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import Icon from "./ui/Icon.svelte";
  import MemoryJvmInput from "./MemoryJvmInput.svelte";
  import { formatDownloads, formatDate, sourceName } from "../storeBrowser.js";

  let {
    open = $bindable(false),
    systemInfo = null,
    onclose = undefined,
    oncreated = undefined,
    onopenblank = undefined,
  } = $props();

  const SOURCES = [
    { value: "modrinth", label: "Modrinth" },
    { value: "curseforge", label: "CurseForge" },
    { value: "ftb", label: "FTB" },
    { value: "custom", label: "Custom" },
  ];

  const CUSTOM_LOADERS = [
    { value: "", label: "No loader" },
    { value: "vanilla", label: "Vanilla" },
    { value: "fabric", label: "Fabric" },
    { value: "quilt", label: "Quilt" },
    { value: "forge", label: "Forge" },
    { value: "neoforge", label: "NeoForge" },
    { value: "paper", label: "Paper" },
    { value: "purpur", label: "Purpur" },
  ];

  let source = $state("modrinth");
  let query = $state("");
  let loading = $state(false);
  let error = $state("");
  let results = $state([]);
  let total = $state(0);
  let offset = $state(0);
  const limit = 15;

  let selectedPack = $state(null);
  let versions = $state([]);
  let versionId = $state("");
  let versionsLoading = $state(false);
  let versionsError = $state("");

  let uploadId = $state("");
  let uploadName = $state("");
  let uploadBusy = $state(false);
  let customLoader = $state("");
  let customLoaderVersion = $state("");

  let name = $state("");
  let memoryMb = $state(4096);
  let jvmArgs = $state("");
  let busy = $state(false);
  let formError = $state("");
  const maxRamMb = $derived(Math.max(256, Math.floor(Number(systemInfo?.memory?.maxMb || systemInfo?.totalRamMb || 8192))));

  let nameTouched = $state(false);

  function reset() {
    query = "";
    results = [];
    total = 0;
    offset = 0;
    error = "";
    selectedPack = null;
    versions = [];
    versionId = "";
    versionsError = "";
    uploadId = "";
    uploadName = "";
    formError = "";
    busy = false;
  }

  function changeSource(value) {
    source = value;
    reset();
    name = "";
    nameTouched = false;
    if (source === "custom") {
      name = "";
    }
  }

  async function runSearch(resetSearch = true) {
    if (source === "custom") return;
    const q = query.trim();
    if (resetSearch) offset = 0;
    loading = true;
    error = "";
    try {
      const data = await searchStore({ q, source, type: "modpack", limit, offset: resetSearch ? 0 : offset, sort: "relevance" });
      results = data.results || [];
      total = data.total || 0;
      if (!data.configured) error = `${sourceName(source)} needs an API key. Add it in Settings.`;
      else if (data.error) error = data.error;
    } catch (e) {
      error = e?.message || String(e);
      results = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  async function pickPack(project) {
    selectedPack = project;
    versions = [];
    versionId = "";
    versionsError = "";
    versionsLoading = true;
    if (!nameTouched) name = `${project.title || "Modpack"} SMP`;
    try {
      let projectData = project;
      try {
        const full = await loadStoreProject(source, project.id);
        if (full.project) projectData = full.project;
      } catch { /* keep search result */ }
      selectedPack = projectData;
      versions = await loadStoreVersions(source, project.id, {});
      versionId = versions[0]?.id || "";
    } catch (e) {
      versionsError = e?.message || String(e);
    } finally {
      versionsLoading = false;
    }
  }

  async function handleUpload(e) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    uploadBusy = true;
    error = "";
    try {
      const res = await uploadModpack(file);
      uploadId = res.uploadId;
      uploadName = res.name || file.name;
      if (!nameTouched) name = `${(res.name || file.name).replace(/\.(zip|mrpack)$/i, "")} SMP`;
      toasts.success(`Uploaded ${res.name || file.name}`);
    } catch (err) {
      error = err?.message || String(err);
    } finally {
      uploadBusy = false;
    }
  }

  async function createServer() {
    if (!name.trim()) return toasts.error("Enter a server name");
    if (source !== "custom" && !selectedPack) return toasts.error("Choose a modpack");
    if (source !== "custom" && !versionId) return toasts.error("Choose a modpack version");
    if (source === "custom" && !uploadId && !customLoader) return toasts.error("Upload an archive or choose a loader");
    busy = true;
    formError = "";
    try {
      const res = await installModpack({
        name: name.trim(),
        source,
        project_id: selectedPack?.id || "",
        version_id: source === "custom" ? "" : versionId,
        loader: source === "custom" ? customLoader : "",
        loader_version: source === "custom" ? customLoaderVersion : "",
        memory_max: `${memoryMb}M`,
        memory_min: "1G",
        jvm_args: jvmArgs,
        upload_id: uploadId || "",
      });
      if (res?.ok && res?.id) {
        toasts.success(`Server "${name.trim()}" created`);
        if (res.warnings?.length) toasts.warning(`${res.warnings.length} file(s) were skipped`);
        open = false;
        reset();
        oncreated?.(res.id);
        if (!oncreated) router.navigate(`/server/${res.id}`);
      } else {
        formError = res?.error || "Could not create the server";
      }
    } catch (e) {
      formError = e?.message || String(e);
    } finally {
      busy = false;
    }
  }

  function close() {
    if (busy) return;
    open = false;
    reset();
    onclose?.();
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
</script>

<Modal bind:open title="Create from a modpack" subtitle="CurseForge · Modrinth · FTB · Custom" size="lg" onclose={close} dismissible={!busy}>
  <div class="pack-create">
      {#if formError}<Alert tone="danger">{formError}</Alert>{/if}

      <Segmented bind:value={source} options={SOURCES} onchange={(v) => changeSource(v)} />

      {#if source !== "custom"}
        <form class="search-row" onsubmit={(e) => { e.preventDefault(); runSearch(true); }}>
          <SearchInput
            bind:value={query}
            placeholder={source === "ftb" ? "Search FTB modpacks…" : `Search ${sourceName(source)} modpacks…`}
            onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(true); } }}
          />
          <Button size="sm" variant="primary" type="submit" loading={loading}><Icon name="search" size={13} /> Search</Button>
        </form>
        {#if source === "curseforge" && error?.includes("API key")}
          <Alert tone="warning">CurseForge needs an API key. Add it in <a href="#/settings">Settings → CurseForge</a>.</Alert>
        {:else if error}
          <Alert tone="danger">{error}</Alert>
        {/if}

        <div class="pack-list">
          {#if loading}
            <div class="center"><Spinner label="Searching…" /></div>
          {:else if results.length === 0}
            <EmptyState size="sm" icon="package" title={query ? "No modpacks found" : "Search a modpack"} description="Type a name and press Enter." />
          {:else}
            {#each results as pack}
              <button class="pack-row" class:selected={selectedPack?.id === pack.id} type="button" onclick={() => pickPack(pack)}>
                {#if pack.icon_url}
                  <img class="pack-icon" src={pack.icon_url} alt="" loading="lazy" onerror={(e) => e.currentTarget?.setAttribute("style", "display:none")} />
                {:else}
                  <div class="pack-icon placeholder">{(pack.title || "?").slice(0, 1)}</div>
                {/if}
                <span class="pack-main">
                  <span class="pack-name">{pack.title}</span>
                  <span class="muted pack-meta">
                    {pack.description || "No description"}
                    {#if pack.downloads != null} · {formatDownloads(pack.downloads)} installs{/if}
                    {#if pack.updated_at} · {formatDate(pack.updated_at)}{/if}
                  </span>
                </span>
                <Badge>{sourceName(pack.source || source)}</Badge>
              </button>
            {/each}
          {/if}
        </div>
        {#if total > limit}
          <div class="pager">
            <Button size="sm" variant="outline" disabled={offset <= 0 || loading} onclick={prevPage}><Icon name="chevron-left" size={13} /> Previous</Button>
            <span class="muted">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            <Button size="sm" variant="outline" disabled={offset + limit >= total || loading} onclick={nextPage}>Next <Icon name="chevron-right" size={13} /></Button>
          </div>
        {/if}
      {:else}
        <div class="custom-upload">
          <div class="upload-box">
            <div class="upload-head"><Icon name="upload" size={16} /><span>Upload a .zip or .mrpack archive</span></div>
            <input type="file" accept=".zip,.mrpack" onchange={handleUpload} disabled={uploadBusy} />
            {#if uploadName}<div class="upload-ready"><Icon name="check-circle" size={13} /> Ready: <b>{uploadName}</b></div>{/if}
            {#if uploadBusy}<Spinner label="Uploading…" />{/if}
          </div>
          <div class="field-row">
            <Select bind:value={customLoader} label="Loader" options={CUSTOM_LOADERS} />
            <TextField bind:value={customLoaderVersion} label="Loader version" placeholder="e.g. 1.20.1" />
          </div>
          <div class="muted">The archive is extracted into the server. A manifest (Modrinth or CurseForge) is used to install the loader and files automatically.</div>
        </div>
      {/if}

      {#if selectedPack || source === "custom"}
        <div class="config">
          <div class="config-head"><Icon name="sliders" size={15} /> Server configuration</div>
          <div class="field-row">
            <TextField bind:value={name} label="Server name" placeholder="My modpack server" oninput={() => (nameTouched = true)} autofocus />
            {#if source !== "custom" && versions.length}
              <Select
                bind:value={versionId}
                label="Version"
                options={versions.map((v) => ({ value: v.id, label: `${v.version_number || v.name}${v.game_versions?.length ? ` · ${v.game_versions.slice(0, 2).join(", ")}` : ""}` }))}
              />
            {/if}
          </div>
          {#if versionsLoading}
            <Spinner label="Loading versions…" />
          {:else if versionsError}
            <Alert tone="warning">{versionsError}</Alert>
          {/if}
          <MemoryJvmInput
            bind:valueMb={memoryMb}
            bind:jvmArgs
            maxMb={maxRamMb}
          />
          <div class="summary muted">
            {#if selectedPack}
              {sourceName(selectedPack.source || source)} · {selectedPack.title}
              {#if selectedPack.game_versions?.length} · {selectedPack.game_versions.slice(0, 4).join(", ")}{/if}
              {#if versionId} · version <b>{(versions.find((v) => v.id === versionId) || {}).version_number || "latest"}</b>{/if}
            {:else}
              Custom archive or loader-only server
            {/if}
          </div>
          <Alert tone="info">The panel downloads the pack, installs its loader and every server-side file. Large packs can take several minutes.</Alert>
        </div>
      {/if}
  </div>
  {#snippet footer()}
    <div class="footer-left">
      {#if onopenblank}
        <Button size="sm" variant="outline" disabled={busy} onclick={() => { open = false; reset(); onopenblank(); }}><Icon name="plus" size={13} /> Blank server</Button>
      {/if}
    </div>
    <div class="footer-right">
      <Button size="sm" variant="outline" disabled={busy} onclick={close}>Cancel</Button>
      <Button size="sm" variant="primary" loading={busy} disabled={!name.trim() || (source !== "custom" && !selectedPack)} onclick={createServer}><Icon name="plus" size={13} /> Create server</Button>
    </div>
  {/snippet}
</Modal>

<style>
  .pack-create { display: flex; flex-direction: column; gap: 15px; }
  .search-row { display: flex; align-items: flex-end; gap: 8px; }
  .search-row :global(.field) { flex: 1; min-width: 0; }
  .center { display: flex; justify-content: center; padding: 24px; }

  .pack-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    max-height: 310px;
    padding: 6px;
    overflow: auto;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.2);
  }
  .pack-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .pack-row:hover { background: var(--panel-elevated); border-color: var(--border); }
  .pack-row.selected { background: var(--accent-light); border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-ring); }
  .pack-icon {
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    object-fit: cover;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .pack-icon.placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-weight: 700; text-transform: uppercase; }
  .pack-main { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
  .pack-name { font-size: 0.82rem; font-weight: 600; }
  .pack-meta { overflow: hidden; font-size: 0.72rem; text-overflow: ellipsis; white-space: nowrap; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 2px; }

  .custom-upload { display: flex; flex-direction: column; gap: 12px; }
  .upload-box {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 16px;
    background: var(--input-bg);
    border: 1px dashed var(--border-secondary);
    border-radius: var(--radius);
  }
  .upload-head { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 0.78rem; font-weight: 600; }
  .upload-head :global(.icon) { color: var(--accent); }
  .upload-box input[type="file"] { width: 100%; color: var(--text-secondary); font-size: 0.76rem; }
  .upload-box input[type="file"]::file-selector-button {
    margin-right: 10px;
    padding: 6px 10px;
    color: var(--text);
    font-family: var(--font);
    font-size: 0.74rem;
    font-weight: 600;
    background: var(--panel-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .upload-ready { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 0.76rem; }
  .upload-ready :global(.icon) { color: var(--success); }

  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .config {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 15px;
    background: color-mix(in srgb, var(--panel-elevated) 45%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .config-head {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--text-secondary);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .config-head :global(.icon) { color: var(--accent); }
  .summary { font-size: 0.77rem; line-height: 1.5; }
  .footer-left, .footer-right { display: flex; gap: 8px; }
  .footer-left { margin-right: auto; }

  @media (max-width: 640px) {
    .field-row { grid-template-columns: minmax(0, 1fr); }
  }
</style>
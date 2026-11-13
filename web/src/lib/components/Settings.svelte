<script>
  import { saveSettings, loadSettings, loadJava, installJavaVersion, uninstallJavaVersion, loadPanelPaths, wipePanelData } from "../stores.js";
  import { toasts } from "../toast.js";
  import Panel from "./ui/Panel.svelte";
  import Button from "./ui/Button.svelte";
  import TextField from "./ui/TextField.svelte";
  import Badge from "./ui/Badge.svelte";
  import Alert from "./ui/Alert.svelte";
  import Spinner from "./ui/Spinner.svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import KeyValueList from "./ui/KeyValueList.svelte";
  import ConfirmDialog from "./ui/ConfirmDialog.svelte";
  import Icon from "./ui/Icon.svelte";
  import UpdatesPanel from "./UpdatesPanel.svelte";

  let { appState, onJavaChanged, onServersChanged, onAccent, onUpdateStateChanged } = $props();

  let settings = $state(/** @type {Record<string, any>} */ ({}));
  let curseforgeKey = $state("");
  let curseforgeSaved = $state("");
  let saving = $state(false);
  let loadError = $state("");

  let javaInfo = $state({ available: [], installed: [], detected: [], runtimes: [], javaDir: "" });
  let javaLoading = $state(false);
  let javaBusy = $state("");
  let javaError = $state("");
  let removeTarget = $state(null);
  let showRemoveDialog = $state(false);

  // Danger zone: permanent deletion of server data and/or the panel install.
  const WIPE_OPTIONS = [
    {
      id: "servers",
      title: "All servers",
      description: "Every server, world, mod, backup and the panel database. The panel's Java runtimes are kept. Running servers are stopped first; the panel keeps running and recreates the empty servers folder.",
      pathKeys: ["serversDir"],
      phrase: "DELETE SERVERS",
      closes: false,
    },
    {
      id: "java",
      title: "Panel Java runtimes",
      description: "Only the Java versions downloaded by the panel. Running servers are stopped first; server files are kept.",
      pathKeys: ["javaDir"],
      phrase: "DELETE JAVA",
      closes: false,
    },
    {
      id: "panel",
      title: "The panel",
      description: "The SMP installation folder. Server data is kept.",
      pathKeys: ["installDir"],
      phrase: "DELETE PANEL",
      closes: true,
    },
    {
      id: "all",
      title: "Everything",
      description: "All servers, the panel's Java runtimes and the panel installation.",
      pathKeys: ["dataDir", "installDir"],
      phrase: "DELETE EVERYTHING",
      closes: true,
    },
  ];
  let panelPaths = $state({ dataDir: "", serversDir: "", javaDir: "", installDir: "" });
  let wipeScope = $state("servers");
  let wipeFirstOpen = $state(false);
  let wipeFinalOpen = $state(false);
  let wiping = $state(false);
  let wipeDone = $state("");
  let wipeInfo = $state("");
  let wipeError = $state("");

  const selectedWipe = $derived(WIPE_OPTIONS.find((o) => o.id === wipeScope) || WIPE_OPTIONS[0]);
  function optionPaths(option) {
    return (option.pathKeys || []).map((k) => panelPaths[k]).filter(Boolean);
  }
  const wipeTargetText = $derived(optionPaths(selectedWipe).join(" and "));

  function shortJavaVersion(v) {
    if (!v) return "";
    const m = String(v).match(/version\s+"([^"]+)"/);
    return m ? m[1] : String(v).split(/\r?\n/)[0];
  }

  function askRemove(id) { removeTarget = id; showRemoveDialog = true; }
  function closeRemoveDialog() { showRemoveDialog = false; }

  const accentChoices = ["#9255E8", "#3B82F6", "#22C55E", "#F59E0B", "#EF4444", "#EC4899", "#14B8A6"];
  const currentAccent = $derived(appState?.accentColor || "#9255E8");
  const curseforgeDirty = $derived(curseforgeKey !== curseforgeSaved);

  async function load() {
    loadError = "";
    try {
      settings = await loadSettings();
      curseforgeKey = settings.curseforge_api_key || "";
      curseforgeSaved = curseforgeKey;
    } catch (e) {
      loadError = e?.message || String(e);
    }
    loadPanelPaths().then((p) => { panelPaths = p; }).catch(() => { /* paths stay empty */ });
    await refreshJava();
  }

  async function refreshJava() {
    javaLoading = true;
    javaError = "";
    try {
      const info = await loadJava();
      javaInfo = info;
      if (appState) {
        appState.javaRuntimes = info.runtimes || [];
        appState.detectedJava = info.detected || [];
        appState.javaInfo = info;
      }
      onJavaChanged?.(info);
    } catch (e) {
      javaError = e?.message || String(e);
    } finally {
      javaLoading = false;
    }
  }

  async function handleInstall(version) {
    if (!version || javaBusy) return;
    javaBusy = `install:${version}`;
    javaError = "";
    try {
      await installJavaVersion(version);
      toasts.success(`Java ${version} installed`);
      await refreshJava();
    } catch (e) {
      javaError = e?.message || String(e);
      toasts.error("Install failed", e);
    } finally {
      javaBusy = "";
    }
  }

  async function handleUninstall(version) {
    if (!version || javaBusy) return;
    javaBusy = `uninstall:${version}`;
    javaError = "";
    try {
      await uninstallJavaVersion(version);
      toasts.success(`Java ${version} removed`);
      await refreshJava();
    } catch (e) {
      javaError = e?.message || String(e);
    } finally {
      javaBusy = "";
      removeTarget = null;
      // The uninstall removes the card, so leaving the dialog open would show it
      // empty and force a second click to dismiss it.
      showRemoveDialog = false;
    }
  }

  async function handleSave() {
    if (!curseforgeDirty || saving) return;
    const key = curseforgeKey;
    saving = true;
    try {
      await saveSettings("curseforge_api_key", key);
      curseforgeSaved = key;
      toasts.success("Settings saved");
    } catch (e) {
      toasts.error("Could not save settings", e);
    } finally {
      saving = false;
    }
  }

  function setAccent(color) {
    if (appState) appState.accentColor = color;
    // App applies the CSS variables, persists to localStorage and saves to the
    // backend (debounced), so this component only reports the intent.
    onAccent?.(color);
  }

  function openWipe() {
    if (wiping) return;
    wipeError = "";
    wipeInfo = "";
    wipeFirstOpen = true;
  }
  function continueWipe() {
    wipeFirstOpen = false;
    wipeFinalOpen = true;
  }
  function closeWipe() {
    if (wiping) return;
    wipeFirstOpen = false;
    wipeFinalOpen = false;
  }
  async function handleWipe() {
    if (wiping) return;
    wiping = true;
    wipeError = "";
    wipeInfo = "";
    try {
      const res = await wipePanelData(selectedWipe.id, selectedWipe.phrase);
      wipeFinalOpen = false;
      if (res?.closing === false) {
        wipeInfo = res.message || "Deleted. The panel is still running.";
        toasts.success("Deleted");
        if (selectedWipe.id === "servers") onServersChanged?.();
        await refreshJava();
      } else {
        wipeDone = selectedWipe.id;
        toasts.success("Deletion started");
      }
    } catch (e) {
      wipeError = e?.message || String(e);
      wipeFinalOpen = false;
      toasts.error("Could not delete", e);
    } finally {
      wiping = false;
    }
  }

  load();
</script>

<header class="page-header">
  <div>
    <h1>Settings</h1>
    <div class="subtitle">Panel appearance, integrations and managed Java runtimes.</div>
  </div>
  <Badge tone="accent">Workspace</Badge>
</header>

{#if loadError}
  <Alert tone="danger" title="Settings could not be loaded">{loadError}</Alert>
{/if}

<div class="layout">
  <div class="main-col">
    <Panel title="Appearance" icon="palette" subtitle="Accent color used across buttons and highlights">
      <div class="accent-preview" style={`--preview:${currentAccent}`}>
        <div class="preview-sheen"></div>
        <div class="preview-copy">
          <span class="preview-label">Current accent</span>
          <span class="preview-value">{currentAccent}</span>
        </div>
        <div class="preview-sample">
          <span class="sample-btn"><Icon name="sparkles" size={13} /> Primary</span>
          <span class="sample-chip">Badge</span>
        </div>
      </div>
      <div class="accent-row">
        <div class="swatches">
          {#each accentChoices as color}
            <button
              type="button"
              class="swatch"
              class:selected={(appState?.accentColor || "").toLowerCase() === color.toLowerCase()}
              style="background:{color}"
              title={color}
              aria-label={`Accent ${color}`}
              onclick={() => setAccent(color)}
            >
              {#if (appState?.accentColor || "").toLowerCase() === color.toLowerCase()}
                <Icon name="check" size={13} />
              {/if}
            </button>
          {/each}
        </div>
        <label class="custom-color">
          <span class="muted">Custom</span>
          <input
            type="color"
            class="color-input"
            value={currentAccent}
            oninput={(e) => setAccent(e.currentTarget.value)}
            aria-label="Custom accent color"
          />
        </label>
      </div>
    </Panel>

    <Panel title="CurseForge" icon="key" subtitle="Optional API key for CurseForge browsing">
      <TextField
        bind:value={curseforgeKey}
        type="password"
        label="API key"
        placeholder="sk-…"
        hint="Stored locally in the panel database."
      />
      <div class="key-hint">
        Get your API key here:
        <a href="https://console.curseforge.com/#/api-keys" target="_blank" rel="noopener noreferrer">https://console.curseforge.com/#/api-keys</a>
      </div>
      <div class="save-row">
        <Button variant="primary" size="sm" loading={saving} disabled={!curseforgeDirty} idle={!curseforgeDirty} onclick={handleSave}><Icon name="save" size={13} /> Save settings</Button>
      </div>
    </Panel>

    <Panel title="Managed Java" icon="coffee" subtitle="Downloaded into the panel data directory">
      <div class="panel-head-actions">
        <Button size="sm" variant="outline" loading={javaLoading} onclick={refreshJava}><Icon name="refresh" size={13} /> Rescan</Button>
      </div>
      {#if javaError}<Alert tone="danger">{javaError}</Alert>{/if}
      {#if javaLoading && !javaInfo.available.length}
        <Spinner label="Detecting Java…" />
      {:else}
        <div class="java-grid">
          {#each javaInfo.available as v}
            <div class="java-card" class:installed={v.installed}>
              <div class="java-icon"><Icon name="coffee" size={17} /></div>
              <div class="java-main">
                <div class="java-title">{v.name}{#if v.lts}<Badge tone="accent">LTS</Badge>{/if}</div>
                <div class="muted java-sub">{v.installed ? "Installed in the java folder" : "Available to install"}</div>
              </div>
              <div class="java-actions">
                {#if v.installed}
                  <Badge tone="success">Installed</Badge>
                  <Button size="xs" variant="outline" disabled={!!javaBusy} onclick={() => askRemove(v.id)}><Icon name="trash" size={12} /> Remove</Button>
                {:else}
                  <Button size="xs" variant="primary" loading={javaBusy === `install:${v.id}`} disabled={!!javaBusy} onclick={() => handleInstall(v.id)}><Icon name="download" size={12} /> Install</Button>
                {/if}
              </div>
            </div>
          {:else}
            <EmptyState icon="coffee" size="sm" title="No installable runtimes listed" description="The Java index could not be loaded." />
          {/each}
        </div>
      {/if}
    </Panel>
  </div>

<div class="java-row">
  <Panel title="Detected Java" icon="cpu" subtitle="System runtimes">
    {#if (javaInfo.detected || []).length}
      <div class="detected-list">
        {#each javaInfo.detected as j}
          <div class="detected-row" title={j.path || j.source || ""}>
            <span class="detected-name">{j.name || j.source || "Java"}</span>
            <span class="detected-ver">{shortJavaVersion(j.version) || j.path || "detected"}</span>
          </div>
        {/each}
      </div>
    {:else}
      <Alert tone="warning">No system Java detected. Install a managed runtime from the list.</Alert>
    {/if}
  </Panel>

  <Panel title="Environment" icon="info">
    <KeyValueList
      rows={[
        { key: "Managed runtimes", value: `${(javaInfo.available || []).filter((j) => j.installed).length}`, mono: false },
        { key: "Available", value: `${(javaInfo.available || []).length}`, mono: false },
        { key: "Java folder", value: javaInfo.javaDir || "—" },
      ]}
    />
  </Panel>
</div>

<UpdatesPanel updateState={appState?.updateState || null} {onUpdateStateChanged} />

<Panel title="Danger zone" icon="alert" subtitle="Permanently delete servers or the panel">
  {#if wipeDone}
    <Alert tone="success" title={wipeDone === "panel" ? "Panel deleted" : "Everything deleted"}>
      {wipeDone === "panel" ? "The panel has been deleted. See you soon!" : "The panel and all servers have been deleted. See you soon!"}
    </Alert>
  {:else}
    <div class="wipe-options" role="radiogroup" aria-label="What to delete">
      {#each WIPE_OPTIONS as option}
        <button
          type="button"
          role="radio"
          aria-checked={wipeScope === option.id}
          class="wipe-option"
          class:selected={wipeScope === option.id}
          onclick={() => (wipeScope = option.id)}
        >
          <span class="wipe-dot" aria-hidden="true"></span>
          <span class="wipe-copy">
            <span class="wipe-title">{option.title}</span>
            <span class="wipe-desc">{option.description}</span>
            <code class="wipe-path">{optionPaths(option).join(" · ") || "…"}</code>
          </span>
        </button>
      {/each}
    </div>
    {#if wipeInfo}<Alert tone="success">{wipeInfo}</Alert>{/if}
    {#if wipeError}<Alert tone="danger">{wipeError}</Alert>{/if}
    <div class="wipe-foot">
      <span class="wipe-hint">Asks twice and requires typing the confirmation phrase. It cannot be undone.</span>
      <Button variant="danger" size="sm" onclick={openWipe}><Icon name="trash" size={13} /> Delete…</Button>
    </div>
  {/if}
</Panel>
</div>

<ConfirmDialog
  bind:open={showRemoveDialog}
  title="Remove Java"
  message={removeTarget ? `Delete the managed Java ${removeTarget} runtime from the panel data directory? Servers using it will fall back to another runtime.` : ""}
  confirmLabel="Remove"
  tone="danger"
  busy={!!javaBusy}
  onconfirm={() => removeTarget && handleUninstall(removeTarget)}
  oncancel={closeRemoveDialog}
/>

<ConfirmDialog
  bind:open={wipeFirstOpen}
  title={`Delete ${selectedWipe.title.toLowerCase()}?`}
  message={`This permanently deletes ${selectedWipe.title.toLowerCase()}${wipeTargetText ? ` (${wipeTargetText})` : ""}.${selectedWipe.closes ? " The panel closes right after and does not restart by itself." : " The panel keeps running and recreates the empty folders."}`}
  confirmLabel="Continue"
  tone="danger"
  onconfirm={continueWipe}
  oncancel={closeWipe}
/>

<ConfirmDialog
  bind:open={wipeFinalOpen}
  title="Final confirmation"
  message={`Last chance: ${selectedWipe.title.toLowerCase()} will be erased from disk. Type ${selectedWipe.phrase} to continue.`}
  confirmLabel="Delete permanently"
  tone="danger"
  confirmValue={selectedWipe.phrase}
  placeholder={selectedWipe.phrase}
  busy={wiping}
  onconfirm={handleWipe}
  oncancel={closeWipe}
/>

<style>
  .layout { display: flex; flex-direction: column; gap: 18px; }
  .main-col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
  .java-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: stretch; }
  .java-row > :global(.panel) { height: 100%; }

  /* ---------- Detected Java ---------- */
  .detected-list { display: flex; flex-direction: column; }
  .detected-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .detected-row:last-child { border-bottom: none; }
  .detected-name { color: var(--text-secondary); font-size: 0.78rem; line-height: 1.35; overflow-wrap: anywhere; }
  .detected-ver { color: var(--text); font-family: var(--font-mono); font-size: 0.79rem; overflow-wrap: anywhere; }

  /* ---------- Accent preview ---------- */
  .accent-preview {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    padding: 18px;
    margin-bottom: 16px;
    overflow: hidden;
    background:
      radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--preview) 24%, transparent), transparent 62%),
      var(--input-bg);
    border: 1px solid color-mix(in srgb, var(--preview) 32%, var(--border));
    border-radius: var(--radius);
  }
  .preview-sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(115deg, transparent 28%, color-mix(in srgb, var(--preview) 12%, transparent) 50%, transparent 72%);
  }
  .preview-copy { position: relative; display: flex; flex-direction: column; gap: 4px; }
  .preview-label { color: var(--text-secondary); font-size: 0.64rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
  .preview-value { color: var(--text); font-family: var(--font-mono); font-size: 1.08rem; letter-spacing: 0.02em; }
  .preview-sample { position: relative; display: flex; align-items: center; gap: 8px; }
  .sample-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    color: #fff;
    font-size: 0.77rem;
    font-weight: 600;
    background: linear-gradient(180deg, color-mix(in srgb, var(--preview) 78%, #fff 22%), var(--preview));
    border: 1px solid color-mix(in srgb, var(--preview) 68%, #fff);
    border-radius: var(--radius-btn);
    box-shadow: 0 8px 20px -12px var(--preview);
  }
  .sample-chip {
    padding: 3px 8px;
    color: var(--preview);
    font-size: 0.63rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: color-mix(in srgb, var(--preview) 13%, transparent);
    border: 1px solid color-mix(in srgb, var(--preview) 36%, transparent);
    border-radius: 5px;
  }
  .accent-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .swatches { display: flex; gap: 8px; flex-wrap: wrap; }
  .swatch {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    color: #fff;
    border: 2px solid transparent;
    border-radius: 8px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), var(--shadow-xs);
    cursor: pointer;
    transition: transform var(--t-fast), border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .swatch:hover { transform: translateY(-2px); }
  .swatch.selected { border-color: var(--text); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3), 0 0 0 3px var(--panel-elevated); }
  .custom-color { display: inline-flex; align-items: center; gap: 8px; font-size: 0.78rem; }
  .color-input {
    width: 46px;
    height: 34px;
    padding: 0;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
  }

  /* ---------- CurseForge ---------- */
  .key-hint { margin-top: 7px; color: var(--text-secondary); font-size: 0.76rem; line-height: 1.4; }
  .key-hint a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
  .key-hint a:hover { text-decoration: underline; }
  .save-row { margin-top: 14px; }

  /* ---------- Java ---------- */
  .panel-head-actions { display: flex; justify-content: flex-end; margin-bottom: 10px; }
  .java-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .java-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 13px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .java-card:hover { border-color: var(--border-secondary); }
  .java-card.installed { border-color: var(--success-border); background: color-mix(in srgb, var(--input-bg) 90%, var(--success) 10%); }
  .java-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    color: var(--warning);
    background: var(--warning-soft);
    border: 1px solid var(--warning-border);
    border-radius: 8px;
  }
  .java-card.installed .java-icon { color: var(--success); background: var(--success-soft); border-color: var(--success-border); }
  .java-main { min-width: 0; flex: 1; }
  .java-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 0.87rem; font-weight: 600; }
  .java-sub { margin-top: 2px; font-size: 0.73rem; }
  .java-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }

  /* ---------- Danger zone ---------- */
  .wipe-options { display: flex; flex-direction: column; gap: 8px; }
  .wipe-option {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    width: 100%;
    padding: 11px 13px;
    text-align: left;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .wipe-option:hover { border-color: var(--border-secondary); }
  .wipe-option.selected {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--input-bg) 92%, var(--danger) 8%);
  }
  .wipe-dot {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    border: 1px solid var(--border-secondary);
    border-radius: 50%;
    box-shadow: inset 0 0 0 2px var(--input-bg);
  }
  .wipe-option.selected .wipe-dot { background: var(--danger); border-color: var(--danger); }
  .wipe-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .wipe-title { color: var(--text); font-size: 0.84rem; font-weight: 600; }
  .wipe-desc { color: var(--text-secondary); font-size: 0.75rem; line-height: 1.35; }
  .wipe-path { color: var(--text-disabled); font-family: var(--font-mono); font-size: 0.71rem; overflow-wrap: anywhere; }
  .wipe-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 14px;
    padding-top: 13px;
    border-top: 1px solid var(--border);
  }
  .wipe-hint { color: var(--text-secondary); font-size: 0.74rem; min-width: 0; }

  @media (max-width: 1100px) {
    .java-row { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 620px) {
    .java-grid { grid-template-columns: minmax(0, 1fr); }
    .accent-preview { flex-direction: column; align-items: flex-start; }
    .wipe-foot { align-items: flex-start; }
  }
</style>
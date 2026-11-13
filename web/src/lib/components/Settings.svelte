<script>
  import { saveSettings, loadSettings, loadJava, installJavaVersion, uninstallJavaVersion } from "../stores.js";
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

  let { appState, onJavaChanged, onAccent, onUpdateStateChanged } = $props();

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

  @media (max-width: 1100px) {
    .java-row { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 620px) {
    .java-grid { grid-template-columns: minmax(0, 1fr); }
    .accent-preview { flex-direction: column; align-items: flex-start; }
  }
</style>
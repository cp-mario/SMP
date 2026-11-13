<script>
  import { onMount } from "svelte";
  import {
    createBackup, loadBackups, deleteBackup, deleteAllBackups, deleteBackups, pruneBackups,
    renameBackup, protectBackup, restoreBackup, updateServer, backupDownloadUrl,
  } from "../../stores.js";
  import { toasts } from "../../toast.js";
  import Panel from "../ui/Panel.svelte";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Icon from "../ui/Icon.svelte";
  import Spinner from "../ui/Spinner.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import Alert from "../ui/Alert.svelte";
  import Modal from "../ui/Modal.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import TextField from "../ui/TextField.svelte";
  import Switch from "../ui/Switch.svelte";

  let { server = null, onChanged = undefined } = $props();

  let backups = $state([]);
  let loading = $state(true);
  let error = $state("");
  let busy = $state("");
  let nextNumber = $state(0);
  let overLimit = $state(0);

  let selectedIds = $state([]);

  let showCreate = $state(false);
  let createName = $state("");
  let createBusy = $state(false);

  let renameTarget = $state(null);
  let renameName = $state("");
  let renameOriginal = $state("");
  let renameBusy = $state(false);
  let showRename = $state(false);

  let downloadTarget = $state(null);
  let showDownload = $state(false);

  let deleteTarget = $state(null);
  let deleteBusy = $state(false);
  let showDelete = $state(false);

  let showBulkDelete = $state(false);
  let bulkBusy = $state(false);

  let showPrune = $state(false);
  let pruneBusy = $state(false);

  let showDeleteAll = $state(false);
  let deleteAllBusy = $state(false);

  let restoreTarget = $state(null);
  let restoreBusy = $state(false);
  let showRestore = $state(false);

  let settingsLimit = $state("0");
  let settingsAutoPrune = $state(false);
  let settingsOnStop = $state(false);
  let settingsOnUpdate = $state(true);
  let settingsOnLoader = $state(true);
  let settingsBusy = $state(false);
  let settingsSaved = $state(null);

  const settingsDirty = $derived(!!settingsSaved && (
    settingsLimit !== settingsSaved.limit ||
    settingsAutoPrune !== settingsSaved.autoPrune ||
    settingsOnStop !== settingsSaved.onStop ||
    settingsOnUpdate !== settingsSaved.onUpdate ||
    settingsOnLoader !== settingsSaved.onLoader
  ));
  const renameDirty = $derived(renameName.trim() !== "" && renameName.trim() !== renameOriginal.trim());

  const totalSize = $derived(backups.reduce((sum, b) => sum + (Number(b.size) || 0), 0));
  const protectedCount = $derived(backups.filter((b) => b.protected).length);
  const unprotectedCount = $derived(backups.length - protectedCount);
  const selectedSet = $derived(new Set(selectedIds));
  const selectedCount = $derived(selectedIds.length);
  const allSelected = $derived(unprotectedCount > 0 && selectedCount === unprotectedCount);
  const nextLabel = $derived(nextNumber ? `Backup #${nextNumber}` : "Backup #");

  function syncSettingsFromServer() {
    settingsLimit = String(Number(server?.backup_limit) || 0);
    settingsAutoPrune = !!server?.backup_auto_prune;
    settingsOnStop = !!server?.backup_on_stop;
    settingsOnUpdate = server?.backup_on_update !== 0;
    settingsOnLoader = server?.backup_on_loader !== 0;
    settingsSaved = {
      limit: settingsLimit,
      autoPrune: settingsAutoPrune,
      onStop: settingsOnStop,
      onUpdate: settingsOnUpdate,
      onLoader: settingsOnLoader,
    };
  }

  async function load({ quiet = false } = {}) {
    if (!server?.id) return;
    if (!quiet) loading = true;
    try {
      const data = await loadBackups(server.id);
      backups = data?.backups || [];
      nextNumber = Number(data?.next_number) || 0;
      overLimit = Number(data?.over_limit) || 0;
      selectedIds = selectedIds.filter((id) => backups.some((b) => b.id === id && !b.protected));
      error = "";
    } catch (e) {
      error = e?.message || String(e);
      if (!quiet) backups = [];
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    syncSettingsFromServer();
    load();
  });

  function backupName(b) {
    return b?.name || `Backup #${b?.number ?? ""}`.trim();
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function formatDate(seconds) {
    if (!seconds) return "—";
    try {
      return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return "—";
    }
  }

  function openCreate() {
    createName = "";
    showCreate = true;
  }

  async function handleCreate() {
    if (!server?.id) return;
    createBusy = true;
    try {
      const res = await createBackup(server.id, { name: createName.trim() });
      showCreate = false;
      await load({ quiet: true });
      toasts.success(`Backup "${res?.backup?.name || createName || "created"}" created`);
    } catch (e) {
      toasts.error("Could not create the backup", e);
    } finally {
      createBusy = false;
    }
  }

  function openRename(b) {
    renameTarget = b;
    renameName = backupName(b);
    renameOriginal = renameName;
    showRename = true;
  }

  async function handleRename() {
    if (!server?.id || !renameTarget || !renameDirty) return;
    renameBusy = true;
    try {
      await renameBackup(server.id, renameTarget.id, { name: renameName });
      showRename = false;
      renameTarget = null;
      await load({ quiet: true });
      toasts.success("Backup renamed");
    } catch (e) {
      toasts.error("Could not rename the backup", e);
    } finally {
      renameBusy = false;
    }
  }

  async function toggleProtection(b) {
    if (!server?.id || !b) return;
    busy = `protect:${b.id}`;
    try {
      await protectBackup(server.id, b.id, !b.protected);
      await load({ quiet: true });
      toasts.success(b.protected ? "Backup unprotected" : "Backup protected");
    } catch (e) {
      toasts.error("Could not update protection", e);
    } finally {
      busy = "";
    }
  }

  function openDownload(b) {
    downloadTarget = b;
    showDownload = true;
  }

  function downloadBackup(format) {
    if (!server?.id || !downloadTarget) return;
    const target = downloadTarget;
    showDownload = false;
    downloadTarget = null;
    const a = document.createElement("a");
    a.href = backupDownloadUrl(server.id, target.id, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function toggleSelect(b) {
    if (!b || b.protected) return;
    selectedIds = selectedSet.has(b.id)
      ? selectedIds.filter((id) => id !== b.id)
      : [...selectedIds, b.id];
  }

  function toggleSelectAll() {
    if (allSelected) selectedIds = [];
    else selectedIds = backups.filter((b) => !b.protected).map((b) => b.id);
  }

  function openBulkDelete() {
    if (!selectedCount) return;
    showBulkDelete = true;
  }

  async function handleBulkDelete() {
    if (!server?.id || !selectedIds.length) return;
    bulkBusy = true;
    try {
      const res = await deleteBackups(server.id, selectedIds);
      showBulkDelete = false;
      selectedIds = [];
      await load({ quiet: true });
      toasts.success(`Deleted ${res?.deleted || 0} selected backup(s)`);
    } catch (e) {
      toasts.error("Could not delete the selected backups", e);
    } finally {
      bulkBusy = false;
    }
  }

  function openPrune() {
    if (!overLimit) return;
    showPrune = true;
  }

  async function handlePrune() {
    if (!server?.id) return;
    pruneBusy = true;
    try {
      const res = await pruneBackups(server.id);
      showPrune = false;
      await load({ quiet: true });
      toasts.success(`Deleted ${res?.deleted || 0} backup(s) over the limit`);
    } catch (e) {
      toasts.error("Could not delete the over-limit backups", e);
    } finally {
      pruneBusy = false;
    }
  }

  function openDelete(b) {
    if (b?.protected) return toasts.warning("Unprotect this backup before deleting it.");
    deleteTarget = b;
    showDelete = true;
  }

  async function handleDelete() {
    if (!server?.id || !deleteTarget) return;
    deleteBusy = true;
    try {
      await deleteBackup(server.id, deleteTarget.id);
      showDelete = false;
      deleteTarget = null;
      await load({ quiet: true });
      toasts.success("Backup deleted");
    } catch (e) {
      toasts.error("Could not delete the backup", e);
    } finally {
      deleteBusy = false;
    }
  }

  async function handleDeleteAll() {
    if (!server?.id) return;
    deleteAllBusy = true;
    try {
      const res = await deleteAllBackups(server.id);
      showDeleteAll = false;
      await load({ quiet: true });
      const kept = Number(res?.kept) || 0;
      toasts.success(`Deleted ${res?.deleted || 0} backup(s)${kept ? ` · kept ${kept} protected` : ""}`);
    } catch (e) {
      toasts.error("Could not delete the backups", e);
    } finally {
      deleteAllBusy = false;
    }
  }

  function openRestore(b) {
    restoreTarget = b;
    showRestore = true;
  }

  async function handleRestore() {
    if (!server?.id || !restoreTarget) return;
    restoreBusy = true;
    try {
      await restoreBackup(server.id, restoreTarget.id);
      showRestore = false;
      restoreTarget = null;
      await load({ quiet: true });
      toasts.success("Backup restored. Start the server when you are ready.");
      onChanged?.();
    } catch (e) {
      toasts.error("Could not restore the backup", e);
    } finally {
      restoreBusy = false;
    }
  }

  async function saveSettings() {
    if (!server?.id || !settingsDirty || settingsBusy) return;
    const limit = Math.max(0, Math.min(9999, Math.floor(Number(settingsLimit) || 0)));
    settingsLimit = String(limit);
    settingsBusy = true;
    try {
      await updateServer(server.id, {
        backup_limit: limit,
        backup_auto_prune: settingsAutoPrune ? 1 : 0,
        backup_on_stop: settingsOnStop ? 1 : 0,
        backup_on_update: settingsOnUpdate ? 1 : 0,
        backup_on_loader: settingsOnLoader ? 1 : 0,
      });
      settingsSaved = {
        limit: settingsLimit,
        autoPrune: settingsAutoPrune,
        onStop: settingsOnStop,
        onUpdate: settingsOnUpdate,
        onLoader: settingsOnLoader,
      };
      await load({ quiet: true });
      toasts.success("Backup settings saved");
      onChanged?.();
    } catch (e) {
      toasts.error("Could not save backup settings", e);
    } finally {
      settingsBusy = false;
    }
  }
</script>

<div class="backup-layout">
  <Panel title="Backups" icon="archive" subtitle={`${backups.length} backup(s) · ${formatSize(totalSize)}`} class="backup-list-panel">
    <div class="backup-toolbar">
      <Button size="sm" variant="primary" onclick={openCreate}><Icon name="plus" size={13} /> New backup</Button>
      <Button size="sm" variant="outline" loading={loading} onclick={() => load()}><Icon name="refresh" size={13} /> Refresh</Button>
      {#if overLimit > 0}
        <Button size="sm" variant="danger" disabled={!!busy} onclick={openPrune}>
          <Icon name="trash" size={13} /> Delete over limit ({overLimit})
        </Button>
      {/if}
      <div class="toolbar-spacer"></div>
      <Button size="sm" variant="danger" disabled={!unprotectedCount || !!busy} onclick={() => (showDeleteAll = true)}>
        <Icon name="trash" size={13} /> Delete all
      </Button>
    </div>

    {#if error}
      <div class="backup-error"><Alert tone="danger">{error}</Alert></div>
    {/if}

    <div class="backup-scroll">
      {#if loading && !backups.length}
        <div class="backup-loading"><Spinner size={20} label="Loading backups…" /></div>
      {:else if backups.length}
        <div class="select-bar">
          <label class="select-all">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={!unprotectedCount}
              onchange={toggleSelectAll}
            />
            <span>Select all</span>
          </label>
          <span class="select-summary">{selectedCount ? `${selectedCount} selected` : `${unprotectedCount} unprotected`}</span>
          {#if selectedCount}
            <Button size="xs" variant="danger" onclick={openBulkDelete}>
              <Icon name="trash" size={12} /> Delete selected ({selectedCount})
            </Button>
          {/if}
        </div>

        <ul class="backup-list">
          {#each backups as b (b.id)}
            <li class="backup-row" class:protected={b.protected}>
              <input
                type="checkbox"
                class="backup-check"
                checked={selectedSet.has(b.id)}
                disabled={b.protected}
                aria-label={`Select ${backupName(b)}`}
                onchange={() => toggleSelect(b)}
              />
              <div class="backup-main">
                <div class="backup-title-line">
                  <span class="backup-name" title={backupName(b)}>{backupName(b)}</span>
                  <span class="backup-date">{formatDate(b.created_at)}</span>
                  {#if b.protected}
                    <span class="backup-pill protected-pill"><Icon name="shield" size={11} /> Protected</span>
                  {/if}
                  {#if b.reason_label}
                    <span class="backup-pill reason-pill">{b.reason_label}</span>
                  {/if}
                </div>
                <div class="backup-meta">
                  <span>{formatSize(b.size)}</span>
                  <span aria-hidden="true">·</span>
                  <span class="backup-format">.{b.format}</span>
                </div>
              </div>
              <div class="backup-actions">
                <IconButton
                  label="Download backup"
                  icon="download"
                  variant="outline"
                  onclick={() => openDownload(b)}
                />
                <IconButton
                  label="Rename backup"
                  icon="edit"
                  variant="outline"
                  onclick={() => openRename(b)}
                />
                <IconButton
                  label={b.protected ? "Unprotect backup" : "Protect backup"}
                  icon="shield"
                  variant={b.protected ? "primary" : "outline"}
                  disabled={busy === `protect:${b.id}`}
                  onclick={() => toggleProtection(b)}
                />
                <IconButton
                  label="Restore backup"
                  icon="rotate"
                  variant="outline"
                  disabled={!!busy || restoreBusy}
                  onclick={() => openRestore(b)}
                />
                <IconButton
                  label={b.protected ? "Protected backup" : "Delete backup"}
                  icon="trash"
                  variant="danger"
                  disabled={b.protected || !!busy}
                  onclick={() => openDelete(b)}
                />
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <EmptyState
          size="sm"
          icon="archive"
          title="No backups yet"
          description="Backups are stored as compressed .tar.zst archives. Create one before risky changes, or enable automatic backups in the panel on the right."
        />
      {/if}
    </div>
  </Panel>

  <div class="backup-side">
    <Panel title="Backup settings" icon="settings">
      <div class="settings-stack">
        <TextField
          bind:value={settingsLimit}
          label="Retention limit"
          type="number"
          min="0"
          max="9999"
          hint="Maximum number of unprotected backups to keep. 0 means unlimited. Protected backups do not count and are never removed."
          disabled={settingsBusy}
        />
        <Switch
          bind:checked={settingsAutoPrune}
          label="Delete over-limit backups automatically"
          hint="Off by default. When off, creating backups or lowering the limit never deletes existing backups; a Delete over limit button appears instead. Turning this on deletes the oldest unprotected backups."
          disabled={settingsBusy}
        />
        <Switch
          bind:checked={settingsOnStop}
          label="Back up when the server stops"
          hint="Runs after a manual stop finishes. Disabled by default."
          disabled={settingsBusy}
        />
        <Switch
          bind:checked={settingsOnUpdate}
          label="Back up before server updates"
          hint="Creates a snapshot before changing the Minecraft/loader version or updating a modpack."
          disabled={settingsBusy}
        />
        <Switch
          bind:checked={settingsOnLoader}
          label="Back up before loader changes"
          hint="Creates a snapshot before switching the loader."
          disabled={settingsBusy}
        />
        <div class="row-actions">
          <Button size="sm" variant="primary" loading={settingsBusy} disabled={!settingsDirty} idle={!settingsDirty} onclick={saveSettings}>
            <Icon name="save" size={13} /> Save settings
          </Button>
        </div>
      </div>
    </Panel>

    <Panel title="Storage" icon="hard-drive">
      <div class="storage-list">
        <div class="storage-row"><span>Format on disk</span><b>.tar.zst</b></div>
        <div class="storage-row"><span>Total size</span><b>{formatSize(totalSize)}</b></div>
        <div class="storage-row"><span>Protected (not counted)</span><b>{protectedCount}</b></div>
        <div class="storage-row"><span>Unprotected</span><b>{unprotectedCount}</b></div>
        <div class="storage-row" class:over={overLimit > 0}><span>Over the limit</span><b>{overLimit}</b></div>
      </div>
      <p class="storage-note">
        Retention applies only to unprotected backups. ZIP downloads are converted on the fly; the server never keeps a second copy.
      </p>
    </Panel>
  </div>
</div>

<Modal bind:open={showCreate} title="New backup" subtitle={server?.name || ""} size="sm" dismissible={!createBusy} closeOnBackdrop={!createBusy} onclose={() => { showCreate = false; }}>
  {#snippet children()}
    <div class="modal-stack">
      {#if server?.online === 1}
        <Alert tone="warning">The server is running. For a fully consistent world, stop it before creating the backup.</Alert>
      {/if}
      <TextField
        bind:value={createName}
        label="Name"
        placeholder={nextLabel}
        maxlength="120"
        hint={`Optional. Leave empty to use "${nextLabel}".`}
        disabled={createBusy}
        autofocus
      />
    </div>
  {/snippet}
  {#snippet footer()}
    <Button size="sm" variant="outline" disabled={createBusy} onclick={() => (showCreate = false)}>Cancel</Button>
    <Button size="sm" variant="primary" loading={createBusy} onclick={handleCreate}>
      <Icon name="archive" size={13} /> Create backup
    </Button>
  {/snippet}
</Modal>

<Modal bind:open={showDownload} title="Download backup" subtitle={downloadTarget ? backupName(downloadTarget) : ""} size="md" onclose={() => { showDownload = false; downloadTarget = null; }}>
  {#snippet children()}
    <div class="download-options">
      <button type="button" class="download-option" onclick={() => downloadBackup("tar.zst")}>
        <span class="download-option-icon"><Icon name="archive" size={22} /></span>
        <span class="download-option-body">
          <span class="download-option-title">
            .tar.zst
            <span class="download-option-badge">Smaller · faster</span>
          </span>
          <span class="download-option-desc">
            Smaller file and the fastest download: it is already compressed, so the server sends it directly without extra work.
            Requires 7-Zip, Zstandard or another program that supports .tar.zst.
          </span>
        </span>
      </button>
      <button type="button" class="download-option" onclick={() => downloadBackup("zip")}>
        <span class="download-option-icon"><Icon name="file" size={22} /></span>
        <span class="download-option-body">
          <span class="download-option-title">
            ZIP
            <span class="download-option-badge compat">Compatible with almost everything</span>
          </span>
          <span class="download-option-desc">
            Opens almost anywhere, but the file is larger and must be converted on the fly, so it takes longer to download.
          </span>
        </span>
      </button>
    </div>
  {/snippet}
</Modal>

<Modal bind:open={showRename} title="Rename backup" size="sm" dismissible={!renameBusy} closeOnBackdrop={!renameBusy} onclose={() => { showRename = false; }}>
  {#snippet children()}
    <TextField
      bind:value={renameName}
      label="Backup name"
      maxlength="120"
      hint="The date and time are kept and added to the download filename automatically."
      disabled={renameBusy}
      autofocus
    />
  {/snippet}
  {#snippet footer()}
    <Button size="sm" variant="outline" disabled={renameBusy} onclick={() => (showRename = false)}>Cancel</Button>
    <Button size="sm" variant="primary" loading={renameBusy} disabled={!renameDirty} idle={!renameDirty} onclick={handleRename}><Icon name="save" size={13} /> Save name</Button>
  {/snippet}
</Modal>

<ConfirmDialog
  bind:open={showDelete}
  title="Delete backup"
  message={`Permanently delete "${backupName(deleteTarget)}"? This cannot be undone.`}
  confirmLabel="Delete backup"
  busy={deleteBusy}
  onconfirm={handleDelete}
  oncancel={() => { showDelete = false; deleteTarget = null; }}
/>

<ConfirmDialog
  bind:open={showBulkDelete}
  title="Delete selected backups"
  message={`Permanently delete ${selectedCount} selected backup(s)? This cannot be undone.`}
  confirmLabel={`Delete ${selectedCount} backup(s)`}
  busy={bulkBusy}
  onconfirm={handleBulkDelete}
  oncancel={() => { showBulkDelete = false; }}
/>

<ConfirmDialog
  bind:open={showPrune}
  title="Delete backups over the limit"
  message={`This permanently deletes the ${overLimit} oldest unprotected backup(s) that are over the retention limit. Protected backups do not count toward the limit and will be kept.`}
  confirmLabel={`Delete ${overLimit} backup(s)`}
  tone="warning"
  busy={pruneBusy}
  onconfirm={handlePrune}
  oncancel={() => { showPrune = false; }}
/>

<ConfirmDialog
  bind:open={showDeleteAll}
  title="Delete all backups"
  message={`This permanently deletes ${unprotectedCount} unprotected backup(s)${protectedCount ? ` and keeps ${protectedCount} protected backup(s)` : ""}. This cannot be undone.`}
  confirmLabel="Delete all backups"
  confirmValue="delete all"
  placeholder="delete all"
  busy={deleteAllBusy}
  onconfirm={handleDeleteAll}
  oncancel={() => { showDeleteAll = false; }}
/>

<ConfirmDialog
  bind:open={showRestore}
  title="Restore backup"
  message={`Restore "${backupName(restoreTarget)}"? The server will be stopped if needed, its current files will be replaced with this snapshot, and it will stay stopped afterwards. This cannot be undone.`}
  confirmLabel="Restore backup"
  tone="warning"
  busy={restoreBusy}
  onconfirm={handleRestore}
  oncancel={() => { showRestore = false; restoreTarget = null; }}
/>

<style>
  .backup-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 18px;
    align-items: start;
  }
  :global(.backup-list-panel) {
    height: calc(100vh - 290px);
    height: calc(100dvh - 290px);
    min-height: 460px;
  }
  :global(.backup-list-panel .panel-body) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .backup-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .backup-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; flex: 0 0 auto; }
  .toolbar-spacer { flex: 1; }
  .backup-error { margin-bottom: 10px; }
  .backup-loading { display: flex; justify-content: center; align-items: center; padding: 40px 0; flex: 1; }
  .backup-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 2px;
  }
  .select-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 0 8px 9px;
    border-bottom: 1px solid var(--border);
  }
  .select-all {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-secondary);
    font-size: 0.76rem;
    cursor: pointer;
    user-select: none;
  }
  .select-all input,
  .backup-check {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .backup-check:disabled { cursor: not-allowed; opacity: 0.35; }
  .select-summary { color: var(--text-disabled); font-size: 0.73rem; }

  .backup-list { display: flex; flex-direction: column; list-style: none; }
  .backup-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 8px;
    border-bottom: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: background var(--t-fast);
  }
  .backup-row:hover { background: color-mix(in srgb, var(--panel-elevated) 55%, transparent); }
  .backup-row:last-child { border-bottom: none; }
  .backup-row.protected { background: color-mix(in srgb, var(--accent-soft) 45%, transparent); }
  .backup-main { min-width: 0; flex: 1; }
  .backup-title-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
  .backup-name {
    max-width: 44ch;
    overflow: hidden;
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .backup-date {
    color: var(--text-disabled);
    font-size: 0.71rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .backup-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    font-size: 0.64rem;
    font-weight: 650;
    letter-spacing: 0.02em;
    border-radius: 5px;
  }
  .protected-pill { color: var(--accent); background: var(--accent-light); border: 1px solid var(--accent-ring); }
  .reason-pill { color: var(--text-secondary); background: var(--panel-elevated); border: 1px solid var(--border); }
  .backup-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
    color: var(--text-disabled);
    font-size: 0.71rem;
    font-variant-numeric: tabular-nums;
  }
  .backup-format { font-family: var(--font-mono); font-size: 0.67rem; }
  .backup-actions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; flex-shrink: 0; flex-wrap: wrap; }

  .settings-stack { display: flex; flex-direction: column; gap: 14px; }
  .row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .storage-list { display: flex; flex-direction: column; }
  .storage-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 0;
    color: var(--text-secondary);
    font-size: 0.78rem;
    border-bottom: 1px solid var(--border);
  }
  .storage-row:last-child { border-bottom: none; }
  .storage-row b { color: var(--text); font-family: var(--font-mono); font-size: 0.75rem; font-weight: 600; }
  .storage-row.over b { color: var(--danger); }
  .storage-note { margin: 8px 0 0; color: var(--text-disabled); font-size: 0.72rem; line-height: 1.5; }
  .modal-stack { display: flex; flex-direction: column; gap: 14px; }

  .download-options { display: flex; flex-direction: column; gap: 10px; }
  .download-option {
    display: flex;
    align-items: flex-start;
    gap: 13px;
    width: 100%;
    padding: 14px;
    color: var(--text);
    text-align: left;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color var(--t-fast), background var(--t-fast), transform var(--t-fast);
  }
  .download-option:hover {
    background: color-mix(in srgb, var(--panel-elevated) 70%, transparent);
    border-color: var(--accent-ring);
  }
  .download-option:active { transform: translateY(1px); }
  .download-option-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    color: var(--accent);
    background: var(--accent-light);
    border: 1px solid var(--accent-ring);
    border-radius: var(--radius);
  }
  .download-option-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .download-option-title {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 0.9rem;
    font-weight: 700;
  }
  .download-option-badge {
    padding: 1px 6px;
    color: var(--accent);
    font-size: 0.63rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    background: var(--accent-light);
    border: 1px solid var(--accent-ring);
    border-radius: 5px;
  }
  .download-option-badge.compat { color: var(--text-secondary); background: var(--panel-elevated); border-color: var(--border); }
  .download-option-desc { color: var(--text-secondary); font-size: 0.76rem; line-height: 1.5; }

  @media (max-width: 1100px) {
    .backup-layout { grid-template-columns: minmax(0, 1fr); }
    .backup-side { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  }

  @media (max-width: 720px) {
    :global(.backup-list-panel) { height: calc(100vh - 230px); height: calc(100dvh - 230px); }
    .backup-row { align-items: flex-start; flex-wrap: wrap; }
    .backup-actions { width: 100%; justify-content: flex-start; }
  }
</style>

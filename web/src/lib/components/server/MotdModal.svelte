<script>
  import { onDestroy } from "svelte";
  import { api, saveMotd } from "../../stores.js";
  import { toasts } from "../../toast.js";
  import Modal from "../ui/Modal.svelte";
  import Button from "../ui/Button.svelte";
  import TextField from "../ui/TextField.svelte";
  import Icon from "../ui/Icon.svelte";

  /**
   * MOTD + server icon editor. Owns the image preview and upload lifecycle so
   * ServerDetail only needs to know when the visible icon changed.
   */
  let {
    open = $bindable(false),
    server = null,
    onsaved = undefined,
    oniconchange = undefined,
  } = $props();

  let motdValue = $state("");
  let motdSaved = $state("");
  let iconFile = $state(null);
  let iconPreview = $state("");
  let iconBusy = $state(false);
  let iconNonce = $state(Date.now());
  let iconMissing = $state(true);
  let iconChecked = $state(false);
  let wasOpen = false;
  const motdDirty = $derived(motdValue !== motdSaved || !!iconFile);

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      motdValue = server?.motd || "";
      motdSaved = motdValue;
      iconFile = null;
      iconMissing = server?.has_icon === false;
      iconChecked = false;
      revokePreview();
      iconNonce = Date.now();
      if (server?.has_icon === false) iconChecked = true;
      else checkIcon();
    } else if (!open) {
      wasOpen = false;
    }
  });

  onDestroy(revokePreview);

  function revokePreview() {
    if (iconPreview) {
      try { URL.revokeObjectURL(iconPreview); } catch { /* noop */ }
    }
    iconPreview = "";
  }

  async function checkIcon() {
    if (!server?.id) return;
    iconChecked = false;
    try {
      const res = await fetch(`/api/servers/${server.id}/icon?t=${Date.now()}`);
      iconMissing = !res.ok;
    } catch {
      iconMissing = true;
    } finally {
      iconChecked = true;
    }
  }

  function onIconPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    iconFile = file;
    revokePreview();
    iconPreview = URL.createObjectURL(file);
  }

  async function uploadIcon() {
    if (!iconFile || !server?.id) return;
    const form = new FormData();
    form.append("file", iconFile);
    const res = await fetch(`/api/servers/${server.id}/icon`, { method: "POST", body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = `Upload failed (${res.status})`;
      try { msg = JSON.parse(text)?.error || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    iconFile = null;
    iconMissing = false;
    iconNonce = Date.now();
    revokePreview();
    oniconchange?.({ missing: false });
    toasts.success("Server image updated");
  }

  async function removeIcon() {
    if (!server?.id) return;
    iconBusy = true;
    try {
      await api(`/servers/${server.id}/icon`, { method: "DELETE" });
      iconMissing = true;
      iconNonce = Date.now();
      oniconchange?.({ missing: true });
      toasts.success("Server image removed");
    } catch (e) {
      toasts.error("Could not remove the image", e);
    } finally {
      iconBusy = false;
    }
  }

  async function handleSave() {
    if (!server?.id || iconBusy || !motdDirty) return;
    const motd = motdValue;
    iconBusy = true;
    try {
      if (iconFile) await uploadIcon();
      await saveMotd(server.id, motd);
      motdSaved = motd;
      iconFile = null;
      open = false;
      onsaved?.();
    } catch (e) {
      toasts.error("Could not save MOTD", e);
    } finally {
      iconBusy = false;
    }
  }
</script>

<Modal
  bind:open
  title="MOTD & server image"
  size="md"
  dismissible={!iconBusy}
  closeOnBackdrop={!iconBusy}
  onclose={() => (open = false)}
>
  {#snippet children()}
    <div class="stack">
      <TextField
        bind:value={motdValue}
        label="Server MOTD"
        placeholder="A SMP Server"
        hint="Use § for colors, e.g. §a green."
        maxlength={256}
      />
      <div class="icon-row">
        <div class="icon-preview">
          {#if iconPreview}
            <img src={iconPreview} alt="server icon preview" />
          {:else if iconChecked && !iconMissing}
            <img
              src={`/api/servers/${server?.id}/icon?t=${iconNonce}`}
              alt="server icon"
              onerror={() => (iconMissing = true)}
            />
          {:else if iconChecked}
            <span class="icon-empty"><Icon name="image" size={18} /> No icon</span>
          {/if}
        </div>
        <div class="icon-controls">
          <TextField
            type="file"
            label="Image file"
            accept="image/*"
            onchange={onIconPick}
            hint="Minecraft uses server-icon.png (ideally 64×64). PNG, JPEG or BMP; resized automatically."
          />
          <div class="row-actions">
            <Button size="sm" variant="outline" disabled={iconBusy || !iconFile} onclick={uploadIcon}>
              <Icon name="upload" size={13} /> Upload
            </Button>
            <Button size="sm" variant="danger" disabled={iconBusy} onclick={removeIcon}>
              <Icon name="trash" size={13} /> Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <Button size="sm" variant="outline" disabled={iconBusy} onclick={() => (open = false)}>Cancel</Button>
    <Button size="sm" variant="primary" loading={iconBusy} disabled={!motdDirty} idle={!motdDirty} onclick={handleSave}>Save</Button>
  {/snippet}
</Modal>

<style>
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .icon-row { display: flex; align-items: flex-start; gap: 14px; }
  .icon-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 78px;
    height: 78px;
    flex: 0 0 auto;
    padding: 4px;
    overflow: hidden;
    font-size: 0.68rem;
    text-align: center;
    background: var(--input-bg);
    border: 1px dashed var(--border-secondary);
    border-radius: var(--radius);
  }
  .icon-preview img { width: 78px; height: 78px; object-fit: cover; image-rendering: pixelated; }
  .icon-empty { display: flex; flex-direction: column; align-items: center; gap: 5px; color: var(--text-disabled); }
  .icon-controls { display: flex; flex: 1; flex-direction: column; gap: 8px; min-width: 0; }
  .row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  @media (max-width: 640px) {
    .icon-row { flex-direction: column; }
  }
</style>

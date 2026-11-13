<script>
  import Modal from "./Modal.svelte";
  import Button from "./Button.svelte";
  import Alert from "./Alert.svelte";

  /**
   * Confirmation dialog for destructive actions.
   * `confirmValue` (optional) requires typing an exact phrase before the confirm button enables.
   */
  let {
    open = $bindable(false),
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "danger",
    busy = false,
    confirmValue = "",
    placeholder = "",
    disabled = false,
    onconfirm = undefined,
    oncancel = undefined,
  } = $props();

  let typed = $state("");

  $effect(() => {
    if (open) typed = "";
  });

  const needsValue = $derived(!!confirmValue);
  const canConfirm = $derived(!disabled && !busy && (!needsValue || typed.trim().toLowerCase() === String(confirmValue).trim().toLowerCase()));

  function cancel() {
    if (busy) return;
    open = false;
    oncancel?.();
  }
  function confirm() {
    if (!canConfirm) return;
    onconfirm?.();
  }
</script>

<Modal bind:open size="sm" title={title} dismissible={!busy} closeOnBackdrop={!busy} onclose={cancel}>
  {#snippet children()}
    <div class="confirm-body">
      <Alert tone={tone === "danger" ? "danger" : "warning"}>{message}</Alert>
      {#if needsValue}
        <div class="confirm-field">
          <div class="confirm-hint">Type <code>{confirmValue}</code> to confirm.</div>
          <input class="input" bind:value={typed} placeholder={placeholder || confirmValue} disabled={busy} data-autofocus />
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="outline" size="sm" disabled={busy} onclick={cancel}>{cancelLabel}</Button>
    <Button variant={tone === "danger" ? "danger" : "primary"} size="sm" loading={busy} disabled={!canConfirm} onclick={confirm}>{confirmLabel}</Button>
  {/snippet}
</Modal>

<style>
  .confirm-body { display: flex; flex-direction: column; gap: 12px; }
  .confirm-hint { font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 6px; }
  .confirm-hint code { font-size: 0.9em; color: var(--text); }
</style>
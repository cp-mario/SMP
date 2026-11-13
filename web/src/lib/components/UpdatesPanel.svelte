<script>
  import { checkForUpdate, applyUpdate, shutdownPanel } from "../stores.js";
  import { toasts } from "../toast.js";
  import Panel from "./ui/Panel.svelte";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import Alert from "./ui/Alert.svelte";
  import KeyValueList from "./ui/KeyValueList.svelte";
  import ConfirmDialog from "./ui/ConfirmDialog.svelte";
  import Icon from "./ui/Icon.svelte";

  /**
   * Self-update panel: reads the running version from the server (root
   * package.json) and compares it with the latest GitHub release. "Update"
   * closes every running server first, then hands the install to the updater.
   */
  let { updateState = null, onUpdateStateChanged = undefined } = $props();

  let checking = $state(false);
  let busy = $state("");
  let error = $state("");
  let updateOpen = $state(false);
  let shutdownOpen = $state(false);
  let shuttingDown = $state(false);

  const state = $derived(updateState || {});
  const current = $derived(state.current || "0.0.0");
  const latest = $derived(state.latest || null);
  const configured = $derived(state.configured !== false && state.code !== "NOT_CONFIGURED");
  const updateAvailable = $derived(!!state.updateAvailable && !!latest);
  const checkedAt = $derived(state.checkedAt ? new Date(state.checkedAt) : null);

  function publish(next) {
    onUpdateStateChanged?.(next);
  }

  function describe() {
    if (checking || state.checking) return { tone: "info", text: "Checking GitHub releases…" };
    if (!configured) return { tone: "warning", text: "Release feed not configured yet. Once the repository is on GitHub this panel will offer the latest release." };
    if (state.error) return { tone: "danger", text: state.error };
    if (updateAvailable) return { tone: "accent", text: `Version ${latest} is available. You are on ${current}.` };
    if (!state.checkedAt) return { tone: "info", text: "Not checked yet." };
    return { tone: "success", text: `You are up to date (${current}).` };
  }

  const status = $derived(describe());

  async function handleCheck() {
    if (checking) return;
    checking = true;
    error = "";
    try {
      const next = await checkForUpdate();
      publish(next);
      if (next.updateAvailable) toasts.success(`Update available: ${next.latest}`);
      else if (next.code === "NOT_CONFIGURED") toasts.info("Release feed is still a placeholder");
      else if (next.error) toasts.error("Update check failed", next.error);
      else toasts.success("You are up to date");
    } catch (e) {
      error = e?.message || String(e);
      toasts.error("Update check failed", e);
    } finally {
      checking = false;
    }
  }

  async function handleUpdate() {
    if (!latest || busy) return;
    busy = "update";
    error = "";
    try {
      const res = await applyUpdate(latest);
      if (res?.ok) {
        toasts.success(`Updated to ${latest}. The panel is restarting…`);
      } else if (res?.code === "NOT_CONFIGURED") {
        toasts.warning("Self-update is not wired up yet");
      } else {
        toasts.error("Update failed", res?.message || res?.code);
      }
    } catch (e) {
      error = e?.message || String(e);
      toasts.error("Update failed", e);
    } finally {
      busy = "";
      updateOpen = false;
    }
  }

  async function handleShutdown() {
    if (busy) return;
    busy = "shutdown";
    error = "";
    try {
      await shutdownPanel("Shutdown requested from Settings");
      shuttingDown = true;
    } catch (e) {
      // The process exits mid-request, so a network error here usually means it worked.
      shuttingDown = true;
      if (!/fetch|network|abort/i.test(String(e?.message || ""))) {
        error = e?.message || String(e);
        toasts.error("Could not shut down the panel", e);
      }
    } finally {
      busy = "";
      shutdownOpen = false;
    }
  }

  const formatDate = (d) => (d ? d.toLocaleString() : "—");
</script>

<Panel title="Updates" icon="refresh" subtitle="Panel version and GitHub releases">
  <div class="update-head">
    <div class="version-block">
      <span class="version-label">Current version</span>
      <div class="version-line">
        <span class="version-value">v{current}</span>
        {#if updateAvailable}
          <Badge tone="accent" dot>Update available</Badge>
        {:else if configured && state.checkedAt && !state.error}
          <Badge tone="success" dot>Up to date</Badge>
        {/if}
      </div>
      {#if latest}
        <span class="version-latest">Latest release: v{latest}{#if state.isPrerelease} (pre-release){/if}</span>
      {/if}
    </div>
    <div class="head-actions">
      <Button variant="outline" size="sm" loading={checking || state.checking} onclick={handleCheck}>
        <Icon name="refresh" size={13} /> Check for updates
      </Button>
      <Button variant="primary" size="sm" disabled={!updateAvailable || !!busy} title={updateAvailable ? `Update to v${latest}` : "No update available"} onclick={() => (updateOpen = true)}>
        <Icon name="download" size={13} /> {latest ? `Update to v${latest}` : "Update"}
      </Button>
    </div>
  </div>

  {#if error}
    <Alert tone="danger">{error}</Alert>
  {:else if shuttingDown}
    <Alert tone="success" title="Panel stopped">All servers were closed. Start the panel again to keep working.</Alert>
  {:else}
    <Alert tone={status.tone}>{status.text}</Alert>
  {/if}

  <KeyValueList
    rows={[
      { key: "Current version", value: `v${current}` },
      { key: "Latest release", value: latest ? `v${latest}` : "—", mono: false },
      { key: "Release feed", value: configured ? state.feedUrl || "GitHub releases" : "Not configured", mono: false },
      { key: "Last checked", value: checkedAt ? formatDate(checkedAt) : "Never", mono: false },
    ]}
  />

  <div class="update-foot">
    <div class="foot-copy">
      <span class="foot-title">Shut down the panel</span>
      <span class="muted">Closes every running server and stops the panel process.</span>
    </div>
    <Button variant="danger" size="sm" loading={busy === "shutdown"} onclick={() => (shutdownOpen = true)}>
      <Icon name="power" size={13} /> Shut down
    </Button>
  </div>
</Panel>

<ConfirmDialog
  bind:open={updateOpen}
  title={`Update to v${latest || ""}`}
  message={`This closes every running server and installs version ${latest || "the latest release"}. Running instances are stopped with the graceful stop command; start them again once the update finishes.`}
  confirmLabel={busy === "update" ? "Updating…" : "Update and restart"}
  tone="warning"
  busy={busy === "update"}
  onconfirm={handleUpdate}
  oncancel={() => (updateOpen = false)}
/>

<ConfirmDialog
  bind:open={shutdownOpen}
  title="Shut down the panel"
  message="Every running server is closed and the panel process stops. You will need to start SMP again from the terminal."
  confirmLabel={busy === "shutdown" ? "Stopping…" : "Shut down"}
  tone="danger"
  busy={busy === "shutdown"}
  onconfirm={handleShutdown}
  oncancel={() => (shutdownOpen = false)}
/>

<style>
  .update-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
  .version-block { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .version-label { color: var(--text-secondary); font-size: 0.64rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
  .version-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .version-value { color: var(--text); font-family: var(--font-mono); font-size: 1.08rem; letter-spacing: 0.02em; }
  .version-latest { color: var(--text-disabled); font-size: 0.74rem; }
  .head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .update-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .foot-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .foot-title { color: var(--text); font-size: 0.82rem; font-weight: 600; }
  .foot-copy .muted { color: var(--text-secondary); font-size: 0.74rem; }

  @media (max-width: 620px) {
    .head-actions { width: 100%; }
    .update-foot { align-items: flex-start; }
  }
</style>
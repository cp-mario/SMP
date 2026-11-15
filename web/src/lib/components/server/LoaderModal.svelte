<script>
  import { loadVersions, loadLoaderVersions, updateServer, installServerJar } from "../../stores.js";
  import { toasts } from "../../toast.js";
  import Modal from "../ui/Modal.svelte";
  import Button from "../ui/Button.svelte";
  import Alert from "../ui/Alert.svelte";
  import Select from "../ui/Select.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Spinner from "../ui/Spinner.svelte";
  import Switch from "../ui/Switch.svelte";
  import TextField from "../ui/TextField.svelte";

  /**
   * Loader / Minecraft version switcher.
   *
   * The modal owns its temporary form and remote version lists, so the detail
   * page never has to track half-filled loader state. `onsaved` runs after the
   * server row and jar were updated.
   */
  let {
    open = $bindable(false),
    server = null,
    loaders = [],
    onsaved = undefined,
  } = $props();

  let loaderVersions = $state([]);
  let loaderLatest = $state(null);
  let versionsLoading = $state(false);
  let versionsError = $state(null);
  let loaderBuilds = $state([]);
  let loaderBuildsLoading = $state(false);
  let loaderBuildsSupported = $state(false);
  let loaderBuildChannel = $state("all");
  let loaderBuildLatest = $state({ stable: null, experimental: null, default: null });
  let loaderForm = $state({
    loader: "",
    version: "",
    channel: "all",
    loaderBuild: "",
    downloadJar: true,
    confirmText: "",
  });
  let loaderBusy = $state(false);
  let wasOpen = false;

  const loaderDirty = $derived(!!server && (
    (loaderForm.loader || "") !== (server.loader || "") ||
    (loaderForm.version || "") !== (server.loader_version || "") ||
    (loaderForm.loaderBuild || "") !== (server.loader_build || "")
  ));

  const vId = (v) => (typeof v === "string" ? v : (v?.id || ""));
  const vCh = (v) => ((typeof v === "object" && v?.channel === "experimental") ? "experimental" : "stable");

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      init();
    } else if (!open) {
      wasOpen = false;
    }
  });

  // Lists are filtered locally: the channel pills never refetch, so the select
  // does not flicker. The installed value stays visible even when the active
  // channel would hide it, otherwise the select could silently lose its value.
  const filteredModalVersions = $derived.by(() => {
    const list = (loaderVersions || []).filter((v) =>
      loaderForm.channel === "all" ? true : vCh(v) === loaderForm.channel);
    const current = loaderForm.version;
    if (current && !list.some((v) => vId(v) === current)) {
      const installed = (loaderVersions || []).find((v) => vId(v) === current);
      list.unshift(installed || { id: current, stable: loaderForm.channel !== "experimental", channel: loaderForm.channel });
    }
    return list;
  });

  const filteredModalBuilds = $derived.by(() => {
    const list = (loaderBuilds || []).filter((b) =>
      loaderBuildChannel === "all" ? true : (b?.channel || (b?.stable !== false ? "stable" : "experimental")) === loaderBuildChannel);
    const current = loaderForm.loaderBuild;
    if (current && !list.some((b) => vId(b) === current)) {
      const installed = (loaderBuilds || []).find((b) => vId(b) === current);
      list.unshift(installed || { id: current, stable: loaderBuildChannel !== "experimental", channel: loaderBuildChannel });
    }
    return list;
  });

  async function init() {
    loaderForm = {
      loader: server?.loader || "",
      version: server?.loader_version || "",
      channel: server?.loader_channel || server?.update?.channel || "all",
      loaderBuild: server?.loader_build || "",
      downloadJar: true,
      confirmText: "",
    };
    loaderVersions = [];
    loaderLatest = null;
    loaderBuilds = [];
    loaderBuildsSupported = false;
    loaderBuildLatest = { stable: null, experimental: null, default: null };

    if (loaderForm.loader) await fetchLoaderVersions(loaderForm.loader);
    if (loaderForm.loader && loaderForm.version) {
      await loadLoaderVersionsFor(loaderForm.loader, loaderForm.version, "all");
      if (!loaderBuildLatest.stable && !loaderBuildLatest.experimental) {
        loaderBuildLatest = {
          stable: loaderForm.loaderBuild || null,
          experimental: null,
          default: loaderForm.loaderBuild || null,
        };
      }
    }
  }

  async function loadLoaderVersionsFor(loader, version, channel = "all") {
    if (!loader || !version) { loaderBuilds = []; loaderBuildsLoading = false; return; }
    const current = loaderForm.loaderBuild;
    loaderBuildsLoading = true;
    try {
      const res = await loadLoaderVersions(loader, version, channel);
      loaderBuilds = res.items;
      loaderBuildsSupported = !!res.supported && res.items.length > 0;
      loaderBuildLatest = res.latest || { stable: null, experimental: null, default: null };
      const pick = (channel === "stable" ? res.latest?.stable : channel === "experimental" ? res.latest?.experimental : (res.latest?.default || res.latest?.stable || res.latest?.experimental)) || res.items[0]?.id || null;
      const keep = current && loaderBuilds.some((b) => vId(b) === current);
      if (!keep) loaderForm.loaderBuild = pick || (loaderBuilds[0]?.id || "");
    } catch (e) {
      toasts.error("Could not load loader builds", e);
    } finally {
      loaderBuildsLoading = false;
    }
  }

  async function fetchLoaderVersions(loader) {
    if (!loader) { loaderVersions = []; loaderLatest = null; versionsError = null; return; }

    versionsLoading = true;
    versionsError = null;
    try {
      const res = await loadVersions(loader, "all");
      loaderVersions = res.items;
      loaderLatest = res.latest;
      versionsError = res.error || null;
    } catch (e) {
      loaderVersions = [];
      loaderLatest = null;
      versionsError = e?.message || String(e);
      toasts.error("Could not load versions", e);
    } finally {
      versionsLoading = false;
    }
  }

  function onLoaderBuildChannelChange(channel) {
    loaderBuildChannel = channel;
    const visible = loaderBuilds.filter((b) => channel === "all" ? true : (b?.channel || (b?.stable !== false ? "stable" : "experimental")) === channel);
    if (!visible.length) return;
    if (!visible.some((b) => vId(b) === loaderForm.loaderBuild)) loaderForm.loaderBuild = vId(visible[0]) || "";
  }

  async function pickLatestLoaderBuild(channel = "stable") {
    if (!loaderForm.loader || !loaderForm.version) return;
    const want = channel === "experimental" ? "experimental" : "stable";
    loaderBuildChannel = "all";
    if (!loaderBuilds.length) await loadLoaderVersionsFor(loaderForm.loader, loaderForm.version, "all");
    const latest = /** @type {{ stable?: string, experimental?: string, default?: string }} */ (loaderBuildLatest || {});
    loaderForm.loaderBuild = latest[want] || latest.default || vId(loaderBuilds[0]) || "";
  }

  async function onLoaderOrChannelChange() {
    loaderForm.version = "";
    loaderForm.loaderBuild = "";
    loaderBuilds = [];
    loaderBuildsSupported = false;
    loaderBuildLatest = { stable: null, experimental: null, default: null };
    await fetchLoaderVersions(loaderForm.loader);
  }

  async function onLoaderVersionChange() {
    loaderForm.loaderBuild = loaderForm.loader === server?.loader && loaderForm.version === server?.loader_version
      ? (server?.loader_build || "")
      : "";
    loaderBuildLatest = { stable: null, experimental: null, default: null };
    await loadLoaderVersionsFor(loaderForm.loader, loaderForm.version, "all");
  }

  function pickLatestChannel(channel = "stable") {
    const want = channel === "experimental" ? "experimental" : "stable";
    const id = loaderLatest?.[want] || (loaderVersions || []).find((v) => vCh(v) === want)?.id || vId((loaderVersions || [])[0]);
    if (!id) return;
    loaderForm.version = id;
    loaderForm.channel = want;
    loadLoaderVersionsFor(loaderForm.loader, id);
  }

  async function handleChangeLoader() {
    if (!server || !loaderDirty || loaderBusy) return;
    if (server.online === 1) return toasts.warning("Stop the server before changing its loader.");
    const expected = `change ${server.name}`;
    if (loaderForm.confirmText.trim().toLowerCase() !== expected.toLowerCase()) return toasts.warning(`Type "${expected}" to confirm.`);
    if (!loaderForm.loader) return toasts.warning("Select a loader.");
    if (loaderBuildsSupported && !loaderForm.loaderBuild) return toasts.warning("Select a loader build.");
    loaderBusy = true;
    try {
      const vobj = (loaderVersions || []).find((v) => vId(v) === loaderForm.version);
      const channel = vobj ? vCh(vobj) : (loaderForm.channel === "experimental" ? "experimental" : "stable");
      await updateServer(server.id, {
        loader: loaderForm.loader,
        loader_version: loaderForm.version || "",
        loader_build: loaderForm.loaderBuild || "",
        loader_channel: channel,
      });
      if (loaderForm.downloadJar) {
        await installServerJar(loaderForm.loader, loaderForm.version || "", server.id, channel, loaderForm.loaderBuild || "");
      }
      open = false;
      await onsaved?.();
      toasts.success("Loader / version updated");
    } catch (e) {
      toasts.error("Could not apply changes", e);
    } finally {
      loaderBusy = false;
    }
  }

  const confirmPhrase = $derived(`change ${server?.name || ""}`);
</script>

<Modal
  bind:open
  title="Change loader / version"
  size="lg"
  dismissible={!loaderBusy}
  closeOnBackdrop={!loaderBusy}
  onclose={() => (open = false)}
>
  <div class="stack">
    <Alert tone="warning">Changing the loader or Minecraft version can break worlds and mods. A backup is created automatically before applying the change (you can disable this in the Backups tab). The server must be stopped.</Alert>

    <Select bind:value={loaderForm.loader} label="Loader" disabled={loaderBusy} onchange={onLoaderOrChannelChange}>
      <option value="">Select a loader…</option>
      {#each loaders as l}
        <option value={l.id}>{l.name}</option>
      {/each}
    </Select>

    <div class="field-block">
      <span class="label">Release channel</span>
      <Segmented
        bind:value={loaderForm.channel}
        size="sm"
        options={[
          { value: "all", label: "All" },
          { value: "stable", label: "Stable" },
          { value: "experimental", label: "Experimental" },
        ]}
      />
      <div class="row-actions">
        <Button size="xs" variant="outline" disabled={!loaderForm.loader || versionsLoading} onclick={() => pickLatestChannel("stable")}>Latest stable{loaderLatest?.stable ? ` (${loaderLatest.stable})` : ""}</Button>
        <Button size="xs" variant="outline" disabled={!loaderForm.loader || versionsLoading || !loaderLatest?.experimental} onclick={() => pickLatestChannel("experimental")}>Latest experimental{loaderLatest?.experimental ? ` (${loaderLatest.experimental})` : ""}</Button>
      </div>
    </div>

    <div class="field-block">
      <span class="label">Minecraft version</span>
      {#if versionsLoading}
        <Spinner label="Loading versions…" />
      {:else}
        <Select bind:value={loaderForm.version} disabled={loaderBusy || !loaderForm.loader} onchange={onLoaderVersionChange}>
          <option value="">Select a version…</option>
          {#each filteredModalVersions as v}
            <option value={vId(v)}>{vId(v)}{vCh(v) !== "stable" ? " (experimental)" : ""}</option>
          {/each}
        </Select>
        {#if versionsError}
          <Alert tone="danger">{versionsError}</Alert>
        {/if}
      {/if}
    </div>

    {#if loaderBuildsSupported || loaderBuildsLoading}
      <div class="field-block">
        <span class="label">{loaders.find((l) => l.id === loaderForm.loader)?.name || "Loader"} build</span>
        <Segmented
          bind:value={loaderBuildChannel}
          size="sm"
          options={[
            { value: "all", label: "All" },
            { value: "stable", label: "Stable" },
            { value: "experimental", label: "Experimental" },
          ]}
          onchange={(v) => onLoaderBuildChannelChange(v)}
        />
        <div class="row-actions">
          <Button size="xs" variant="outline" disabled={!loaderForm.version || loaderBuildsLoading} onclick={() => pickLatestLoaderBuild("stable")}>Latest stable{loaderBuildLatest?.stable ? ` (${loaderBuildLatest.stable})` : ""}</Button>
          <Button size="xs" variant="outline" disabled={!loaderForm.version || loaderBuildsLoading || !loaderBuildLatest?.experimental} onclick={() => pickLatestLoaderBuild("experimental")}>Latest experimental{loaderBuildLatest?.experimental ? ` (${loaderBuildLatest.experimental})` : ""}</Button>
        </div>
        {#if loaderBuildsLoading}
          <Spinner label="Loading builds…" />
        {:else}
          <Select bind:value={loaderForm.loaderBuild} disabled={loaderBusy || !loaderForm.version}>
            <option value="">Select a build…</option>
            {#each filteredModalBuilds as b}
              <option value={vId(b)}>{vId(b)}{(b?.stable === false || b?.channel === "experimental") ? " (experimental)" : ""}</option>
            {/each}
          </Select>
        {/if}
      </div>
    {/if}

    <Switch bind:checked={loaderForm.downloadJar} label="Download the loader jar when saving" hint="Recommended. It may take a while." disabled={loaderBusy} />

    <TextField
      bind:value={loaderForm.confirmText}
      label="Extra confirmation"
      placeholder={confirmPhrase}
      hint={`Type "${confirmPhrase}" to confirm.`}
      disabled={loaderBusy}
    />
  </div>

  {#snippet footer()}
    <Button size="sm" variant="outline" disabled={loaderBusy} onclick={() => (open = false)}>Cancel</Button>
    <Button
      size="sm"
      variant="primary"
      loading={loaderBusy}
      disabled={!loaderDirty || !loaderForm.loader || (loaderBuildsSupported && !loaderForm.loaderBuild) || loaderForm.confirmText.trim().toLowerCase() !== confirmPhrase.toLowerCase()}
      idle={!loaderDirty}
      onclick={handleChangeLoader}
    >
      Apply changes
    </Button>
  {/snippet}
</Modal>

<style>
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .field-block { display: flex; flex-direction: column; gap: 8px; }
  .row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .label { color: var(--text-secondary); font-size: 0.78rem; font-weight: 600; }
</style>

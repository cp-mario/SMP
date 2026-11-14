<script>
  import MemoryJvmInput from "./MemoryJvmInput.svelte";
  import Modal from "./ui/Modal.svelte";
  import Button from "./ui/Button.svelte";
  import TextField from "./ui/TextField.svelte";
  import Alert from "./ui/Alert.svelte";
  import Segmented from "./ui/Segmented.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import Spinner from "./ui/Spinner.svelte";
  import Icon from "./ui/Icon.svelte";
  import { versionId, isStable, versionChannel as channelOfVersion, filterByChannel as filterVersions, filterBuilds } from "../versionPicker.js";
  import { scrollToId } from "../scrollIntoView.js";
  import { allocatePorts, checkPort } from "../stores.js";
  import { toasts } from "../toast.js";

  let {
    open = $bindable(false),
    loaders = [],
    versions = [],
    versionsMeta = { latest: null, channel: "all" },
    versionsLoading = false,
    versionsError = null,
    javaRuntimes = [],
    versionsSearch = "",
    versionChannel = "all",
    selectedLoader = null,
    selectedVersion = null,
    selectedVersionChannel = "stable",
    selectedLoaderBuild = null,
    loaderBuilds = [],
    loaderBuildsLoading = false,
    loaderBuildsSupported = false,
    loaderBuildsError = null,
    loaderBuildChannel = "all",
    selectedJava,
    createName = $bindable(""),
    createLoading = false,
    systemInfo = null,
    onSelectLoader,
    onSelectVersion,
    onSelectJava,
    onSearchVersions,
    onVersionChannel,
    onPickLatest,
    onLoaderBuildChannel,
    onPickLatestLoaderBuild,
    onCreateName,
    onCreate,
    onClose,
    onSelectLoaderBuild,
    onOpenModpack,
  } = $props();

  let memoryMb = $state(2048);
  let jvmArgs = $state("");
  let portValues = $state({});
  let portErrors = $state({});
  let portsBusy = $state(false);
  let portsChecking = $state(false);
  let portsChecked = $state(false);
  let portsLoaderKey = null;
  let portCheckKey = null;
  let portCheckSeq = 0;
  let versionListEl = $state(null);
  let buildListEl = $state(null);

  const vId = (v) => versionId(v);
  const vStable = (v) => isStable(v);
  const vChannel = (v) => channelOfVersion(v);

  let filteredVersions = $derived(filterVersions(versions, versionChannel, versionsSearch));

  let latestStable = $derived(versionsMeta?.latest?.stable || (versions || []).find((v) => vStable(v))?.id || null);
  let latestExp = $derived(versionsMeta?.latest?.experimental || (versions || []).find((v) => !vStable(v))?.id || null);
  let loaderBuildLatestStable = $derived((loaderBuilds || []).find((b) => (b?.channel || (b?.stable !== false ? "stable" : "experimental")) === "stable")?.id || null);
  let loaderBuildLatestExp = $derived((loaderBuilds || []).find((b) => (b?.channel || (b?.stable !== false ? "stable" : "experimental")) === "experimental")?.id || null);

  let filteredLoaderBuilds = $derived(filterBuilds(loaderBuilds, loaderBuildChannel));

  let loaderMeta = $derived((loaders || []).find((l) => l.id === selectedLoader) || null);
  let supportsJvm = $derived(loaderMeta?.java === true);
  let showJvmPanel = $derived(!!loaderMeta && loaderMeta.type !== "bedrock" && loaderMeta.type !== "native" && !loaderMeta.custom);
  let isCustomLoader = $derived(loaderMeta?.custom === true);
  let needsVersion = $derived(loaderMeta?.custom !== true);
  let needsPorts = $derived(!isCustomLoader);
  let portRoles = $derived(loaderMeta?.ports || []);
  let portsInRange = $derived(portRoles.every((p) => {
    const n = Number(portValues[p.role]);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  }));
  let portsValid = $derived(isCustomLoader || (portsInRange && portsChecked && !portsChecking && !portsBusy && !Object.values(portErrors).some(Boolean)));
  let canCreate = $derived(!!selectedLoader && !!createName?.trim() && !createLoading && (!needsVersion || !!selectedVersion) && (!loaderBuildsSupported || !!selectedLoaderBuild || loaderBuildsLoading) && portsValid);
  let maxRamMb = $derived(Number(systemInfo?.memory?.maxMb || systemInfo?.totalRamMb || 8192));
  let selectedJavaName = $derived((javaRuntimes || []).find((j) => j.id === selectedJava)?.name || (selectedJava ? String(selectedJava) : "Auto"));

  $effect(() => {
    if (!needsPorts) return;
    const key = `${selectedLoader || ""}:${(loaderMeta?.ports || []).map((p) => p.role).join(",")}`;
    if (key === portsLoaderKey) return;
    portsLoaderKey = key;
    const next = {};
    for (const p of loaderMeta?.ports || []) next[p.role] = p.defaultPort != null ? String(p.defaultPort) : "";
    portValues = next;
  });

  // Check every displayed port against both the panel's reservations and the OS.
  // A port is only accepted once the API confirms it can be bound right now.
  $effect(() => {
    if (!needsPorts || !selectedLoader || !portRoles.length) {
      portCheckSeq++;
      portCheckKey = null;
      portErrors = {};
      portsChecked = false;
      portsChecking = false;
      return;
    }

    const entries = portRoles.map((p) => ({
      role: p.role,
      protocol: String(p.protocol || "tcp").toLowerCase() === "udp" ? "udp" : "tcp",
      family: p.family === 6 ? 6 : 4,
      raw: String(portValues[p.role] ?? "").trim(),
    }));
    const key = `${selectedLoader}:${entries.map((e) => `${e.role}=${e.raw}`).join("|")}`;
    if (key === portCheckKey) return;
    portCheckKey = key;
    const seq = ++portCheckSeq;
    portsChecked = false;
    portsChecking = true;
    portErrors = {};

    const localErrors = {};
    for (const e of entries) {
      const n = Number(e.raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) localErrors[e.role] = "Enter a port between 1 and 65535.";
    }
    const byPort = new Map();
    for (const e of entries) {
      if (localErrors[e.role]) continue;
      const k = `${e.protocol}:${Number(e.raw)}`;
      const roles = byPort.get(k) || [];
      roles.push(e.role);
      byPort.set(k, roles);
    }
    for (const roles of byPort.values()) {
      if (roles.length < 2) continue;
      for (const role of roles) localErrors[role] = "That port is already used by another field.";
    }
    if (Object.keys(localErrors).length) {
      portErrors = localErrors;
      portsChecked = true;
      portsChecking = false;
      return;
    }

    const timer = setTimeout(async () => {
      const results = await Promise.all(entries.map(async (e) => {
        try {
          return { role: e.role, res: await checkPort(Number(e.raw), e.protocol, { family: e.family }) };
        } catch (error) {
          return { role: e.role, error };
        }
      }));
      if (seq !== portCheckSeq) return;
      const next = {};
      for (const r of results) {
        if (r.error) {
          next[r.role] = "Could not check availability. Please try again.";
          continue;
        }
        if (r.res?.available) continue;
        const proto = String(r.res?.protocol || "").toUpperCase();
        const ownerName = r.res?.server?.name;
        const reason = ownerName
          ? `in use by "${ownerName}"`
          : r.res?.reason === "system"
            ? "in use by another process"
            : r.res?.reason === "server"
              ? "already reserved by another server"
              : "unavailable";
        next[r.role] = `Port ${r.res?.port ?? ""}/${proto} ${reason}.`;
      }
      portErrors = next;
      portsChecked = true;
      portsChecking = false;
    }, 300);
    return () => clearTimeout(timer);
  });

  async function autoPorts() {
    if (!selectedLoader || portsBusy) return;
    portsBusy = true;
    try {
      const res = await allocatePorts(selectedLoader);
      const next = { ...portValues };
      for (const p of res?.ports || []) next[p.role] = String(p.port);
      portValues = next;
    } catch (e) {
      toasts.error("Could not find free ports", e);
    } finally {
      portsBusy = false;
    }
  }

  function requestedPorts() {
    // Custom loaders do not ask for ports: the backend allocates a free set.
    if (isCustomLoader) return {};
    // Send every chosen port explicitly: the backend must reject a conflict
    // instead of silently moving a port after the UI has validated it.
    const out = {};
    for (const p of portRoles) {
      const n = Number(portValues[p.role]);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) out[p.role] = n;
    }
    return out;
  }

  function close() { onClose?.(); }

  function onName(e) { onCreateName?.(e.currentTarget.value); }

  function changeVersionChannel(channel) {
    onVersionChannel?.(channel);
    const list = filterVersions(versions, channel, versionsSearch);
    if (list.length && !list.some((v) => vId(v) === selectedVersion)) {
      const first = list[0];
      onSelectVersion?.(vId(first), vChannel(first));
    }
  }

  // Scroll the selected entry into view after the list changes (loader pick, "Latest", filter).
  // `scrollToId` only scrolls when the entry is not already visible, so nothing jumps.
  $effect(() => {
    const id = selectedVersion;
    const channel = versionChannel;
    const search = versionsSearch;
    const loading = versionsLoading;
    const count = filteredVersions.length;
    if (loading || !id || !count || !versionListEl) return;
    const list = versionListEl;
    requestAnimationFrame(() => scrollToId(list, id));
  });

  $effect(() => {
    const id = selectedLoaderBuild;
    const channel = loaderBuildChannel;
    const loading = loaderBuildsLoading;
    const count = filteredLoaderBuilds.length;
    if (loading || !id || !count || !buildListEl) return;
    const list = buildListEl;
    requestAnimationFrame(() => scrollToId(list, id));
  });
</script>

<Modal bind:open={open} title="New server" size="lg" onclose={close} dismissible={!createLoading}>
  <div class="create-layout">
    <div class="create-body">
        <section class="form-section">
          <div class="section-head">
            <span class="step-badge">1</span>
            <div>
              <div class="section-title">Server name</div>
              <div class="section-sub">This is how it will appear in the panel and the instances list.</div>
            </div>
          </div>
          <TextField
            bind:value={createName}
            label="Server name"
            placeholder="e.g. Survival"
            oninput={onName}
            autofocus
          />
        </section>

        <section class="form-section">
          <div class="section-head">
            <span class="step-badge">2</span>
            <div>
              <div class="section-title">Loader</div>
              <div class="section-sub">Choose the engine that will run your server.</div>
            </div>
          </div>
          <div class="pill-list">
            {#each loaders as l}
              <button
                class="pill"
                class:selected={selectedLoader === l.id}
                type="button"
                title={l.custom ? "Custom loader" : (l.java ? "Java / JVM configurable" : "No RAM / JVM settings")}
                onclick={() => onSelectLoader?.(l.id)}
              >{l.name}{#if l.custom}<span class="muted"> (custom)</span>{/if}</button>
            {/each}
          </div>
          {#if loaderMeta}
            <div class="muted loader-note">
              {#if loaderMeta.eula === false}<span>Does not require accepting the Minecraft EULA.</span>{/if}
              {#if loaderMeta.custom}<span>Custom loader: upload or place the server files and configure the start command.</span>{/if}
              {#if loaderMeta.type === "bedrock"}<span>Bedrock: the dedicated binary is downloaded and extracted automatically.</span>{/if}
              {#if loaderMeta.id === "endstone"}<span>Endstone: official bundle with a Python launcher; BDS is downloaded on first startup.</span>{/if}
              {#if loaderMeta.type === "native" && loaderMeta.id !== "endstone"}<span>Native binary: the executable for your platform is downloaded.</span>{/if}
              {#if loaderMeta.java === false && !loaderMeta.custom && loaderMeta.type !== "bedrock" && loaderMeta.type !== "native"}<span>This loader does not expose RAM/JVM settings.</span>{/if}
            </div>
          {/if}
        </section>

        {#if selectedLoader && !loaderMeta?.custom}
          <section class="form-section">
            <div class="section-head">
              <span class="step-badge">P</span>
              <div>
                <div class="section-title">Ports</div>
                <div class="section-sub">You can leave them as they are or find a free slot for all of them.</div>
              </div>
            </div>
            <div class="port-create-grid">
              {#each portRoles as p}
                <TextField
                  value={portValues[p.role] ?? ""}
                  label={`${p.label} · ${p.protocol.toUpperCase()}`}
                  type="number"
                  min="1"
                  max="65535"
                  disabled={portsBusy || createLoading}
                  error={portErrors[p.role] || ""}
                  hint={portsChecking ? "Checking availability…" : p.role === "game" ? "Primary connection" : ""}
                  oninput={(e) => { portValues[p.role] = e.currentTarget.value; }}
                />
              {/each}
            </div>
            <div class="row-actions">
              <Button size="xs" variant="outline" loading={portsBusy} disabled={!selectedLoader || createLoading} onclick={autoPorts}><Icon name="refresh" size={12} /> Find free ports</Button>
            </div>
            <div class="muted port-note">
              {#if portsChecking}
                Checking port availability…
              {:else}
                Occupied ports are marked in red. Use "Find free ports" or enter an available one to be able to create the server.
              {/if}
            </div>
          </section>
        {/if}

        {#if !loaderMeta?.custom && selectedLoader}
          <section class="form-section">
            <div class="section-head">
              <span class="step-badge">3</span>
              <div>
                <div class="section-title">Minecraft version</div>
                <div class="section-sub">Filter by channel and choose the exact version.</div>
              </div>
            </div>
            <Segmented
              bind:value={versionChannel}
              size="sm"
              options={[
                { value: "all", label: "All" },
                { value: "stable", label: "Stable" },
                { value: "experimental", label: "Experimental" },
              ]}
              onchange={(v) => changeVersionChannel(v)}
            />
            <div class="row-actions">
              <Button size="xs" variant="outline" disabled={!selectedLoader || versionsLoading} onclick={() => onPickLatest?.("stable")}>Latest stable{latestStable ? ` (${latestStable})` : ""}</Button>
              <Button size="xs" variant="outline" disabled={!selectedLoader || versionsLoading || !latestExp} onclick={() => onPickLatest?.("experimental")}>Latest experimental{latestExp ? ` (${latestExp})` : ""}</Button>
            </div>
          </section>
        {/if}

        {#if !loaderMeta?.custom}
          {#if !selectedLoader}
            <Alert tone="info">Select a loader first.</Alert>
          {:else}
            <div class="version-panel">
              <div class="version-head">
                <span class="muted version-count">
                  {filteredVersions.length} version(s){versionChannel !== "all" ? ` · ${versionChannel}` : ""}
                </span>
                {#if versionsLoading}<Spinner size={13} label="" />{/if}
              </div>
              <SearchInput
                value={versionsSearch}
                placeholder="Search version…"
                oninput={(e) => onSearchVersions?.(e.currentTarget.value)}
              />
              <div class="pill-list scrollable" bind:this={versionListEl}>
                {#each filteredVersions as v}
                  {@const id = vId(v)}
                  {@const ch = vChannel(v)}
                  <button
                    class="pill"
                    class:selected={selectedVersion === id}
                    data-version={id}
                    data-selected={selectedVersion === id ? "true" : "false"}
                    type="button"
                    onclick={() => onSelectVersion?.(id, ch)}
                  >{id}{#if ch !== "stable"}<span class="muted"> (experimental)</span>{/if}</button>
                {:else}
                  <div class="pill muted">
                    {#if versionsLoading}
                      Loading versions…
                    {:else if versionsError}
                      Error: {versionsError}
                    {:else}
                      No versions found
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {:else}
          <Alert tone="info" title="Custom loader">
            No need to choose a version or ports. Create the server and then upload your files, adjust the start command and add the ports, mods and settings you want from the server page.
          </Alert>
        {/if}

        {#if !loaderMeta?.custom && (loaderBuildsSupported || loaderBuildsLoading)}
          <section class="form-section">
            <div class="section-head">
              <span class="step-badge">4</span>
              <div>
                <div class="section-title">{loaderMeta?.name || "Loader"} build</div>
                <div class="section-sub">Loader build for {selectedVersion || "this version"}. The most recent is selected by default.</div>
              </div>
            </div>
            <Segmented
              bind:value={loaderBuildChannel}
              size="sm"
              options={[
                { value: "all", label: "All" },
                { value: "stable", label: "Stable" },
                { value: "experimental", label: "Experimental" },
              ]}
              onchange={(v) => onLoaderBuildChannel?.(v)}
            />
            <div class="row-actions">
              <Button size="xs" variant="outline" disabled={!selectedVersion || loaderBuildsLoading} onclick={() => onPickLatestLoaderBuild?.("stable")}>Latest stable{loaderBuildLatestStable ? ` (${loaderBuildLatestStable})` : ""}</Button>
              <Button size="xs" variant="outline" disabled={!selectedVersion || loaderBuildsLoading || !loaderBuildLatestExp} onclick={() => onPickLatestLoaderBuild?.("experimental")}>Latest experimental{loaderBuildLatestExp ? ` (${loaderBuildLatestExp})` : ""}</Button>
            </div>
            {#if loaderBuildsLoading}
              <div class="loading-box"><span class="spinner"></span><span class="muted">Loading builds…</span></div>
            {:else}
              <div class="pill-list scrollable" bind:this={buildListEl}>
                {#each filteredLoaderBuilds as b}
                  {@const bid = typeof b === "string" ? b : (b?.id || b?.name || "")}
                  {@const bch = b?.channel || (b?.stable !== false ? "stable" : "experimental")}
                  <button
                    class="pill"
                    class:selected={selectedLoaderBuild === bid}
                    data-version={bid}
                    data-selected={selectedLoaderBuild === bid ? "true" : "false"}
                    type="button"
                    title={bid}
                    onclick={() => onSelectLoaderBuild?.(bid)}
                  >{bid}{#if bch !== "stable"}<span class="muted"> (experimental)</span>{/if}</button>
                {:else}
                  <div class="pill muted">{loaderBuildsError ? `Error: ${loaderBuildsError}` : "No loader builds"}</div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}

        {#if showJvmPanel}
          <section class="form-section">
            <div class="section-head">
              <span class="step-badge">5</span>
              <div>
                <div class="section-title">Java runtime</div>
                <div class="section-sub">Runtimes detected or installed by the panel. Install more in <b>Settings → Java</b>.</div>
              </div>
            </div>
            <div class="pill-list">
              {#each (javaRuntimes || []) as j}
                <button
                  class="pill"
                  class:selected={selectedJava === j.id}
                  type="button"
                  title={j.path || j.source || ""}
                  onclick={() => onSelectJava?.(j.id)}
                >{j.name}{#if j.source === "managed"}<span class="muted"> · managed</span>{:else if j.detected || j.source === "system"}<span class="muted"> · detected</span>{/if}</button>
              {:else}
                <div class="pill muted">No Java detected. Install one in Settings → Java.</div>
              {/each}
            </div>
          </section>
        {/if}

        {#if supportsJvm}
          <section class="form-section">
            <div class="section-head">
              <span class="step-badge">6</span>
              <div>
                <div class="section-title">Memoria y JVM</div>
                <div class="section-sub">Adjust the RAM and startup arguments.</div>
              </div>
            </div>
            <MemoryJvmInput bind:valueMb={memoryMb} bind:jvmArgs={jvmArgs} maxMb={maxRamMb} minMb={256} stepMb={512} />
          </section>
        {:else if showJvmPanel}
          <Alert tone="info">RAM / JVM are not configurable for this loader.</Alert>
        {/if}
      </div>

      <aside class="create-summary">
        <div class="summary-head"><Icon name="sparkles" size={15} /> Summary</div>
        <div class="summary-list">
          <div class="summary-row"><span>Name</span><b>{createName?.trim() || "—"}</b></div>
          <div class="summary-row"><span>Loader</span><b>{loaderMeta?.name || "—"}</b></div>
          {#if !isCustomLoader}
            <div class="summary-row"><span>Version</span><b>{selectedVersion || "—"}</b></div>
          {/if}
          {#if loaderBuildsSupported}
            <div class="summary-row"><span>Build</span><b>{selectedLoaderBuild || "—"}</b></div>
          {/if}
          {#if showJvmPanel}
            <div class="summary-row"><span>Java</span><b>{selectedJavaName}</b></div>
          {/if}
          {#if supportsJvm}
            <div class="summary-row"><span>RAM</span><b>{memoryMb} MB</b></div>
          {/if}
        </div>
        <div class="summary-note"><Icon name="info" size={13} /> You can change these settings later.</div>
      </aside>
    </div>

    <div class="footer">
      <div class="footer-left">
        <Button size="sm" variant="outline" disabled={createLoading} onclick={() => onOpenModpack?.()}><Icon name="package" size={13} /> From modpack</Button>
      </div>

      <div class="footer-right">
        <Button size="sm" variant="outline" disabled={createLoading} onclick={close}>Cancel</Button>
        <Button
          size="sm"
          variant="primary"
          loading={createLoading}
          disabled={!canCreate}
          onclick={() => onCreate?.({ ...(supportsJvm ? { memoryMax: `${memoryMb}M`, jvmArgs } : {}), ports: requestedPorts() })}
        ><Icon name="plus" size={13} /> Create server</Button>
      </div>
    </div>
</Modal>

<style>
  .create-layout { display: grid; grid-template-columns: minmax(0, 1fr) 232px; gap: 22px; align-items: start; }
  .create-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .form-section { display: flex; flex-direction: column; gap: 9px; }
  .port-create-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .port-note { font-size: 0.72rem; line-height: 1.4; }
  .form-section + .form-section { padding-top: 16px; border-top: 1px solid var(--border); }
  .section-head { display: flex; align-items: flex-start; gap: 10px; }
  .step-badge {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    color: var(--accent);
    font-size: 0.66rem;
    font-weight: 700;
    background: var(--accent-light);
    border: 1px solid var(--accent-ring);
    border-radius: 6px;
  }
  .section-title { color: var(--text); font-size: 0.88rem; font-weight: 650; letter-spacing: -0.01em; }
  .section-sub { margin-top: 1px; color: var(--text-secondary); font-size: 0.73rem; line-height: 1.45; }

  .pill-list { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill-list.scrollable {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 5px;
    min-height: 96px;
    max-height: 196px;
    padding: 8px;
    overflow-y: auto;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.2);
  }
  .pill-list.scrollable .pill { overflow: hidden; text-align: center; text-overflow: ellipsis; }
  .pill {
    padding: 6px 11px;
    color: var(--text-secondary);
    font-family: var(--font);
    font-size: 0.77rem;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast), box-shadow var(--t-fast);
  }
  .pill:hover { color: var(--text); border-color: var(--border-strong); background: var(--panel-elevated); }
  .pill.selected {
    color: var(--accent);
    background: var(--accent-light);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent-ring);
  }
  .pill.muted { color: var(--text-disabled); white-space: normal; cursor: default; }
  .pill-list.scrollable .pill { font-family: var(--font-mono); font-size: 0.71rem; }
  .pill-list.scrollable .pill.muted { font-family: var(--font); font-size: 0.76rem; }
  .loader-note { display: flex; flex-direction: column; gap: 2px; font-size: 0.76rem; line-height: 1.45; }
  .row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .version-panel { display: flex; flex-direction: column; gap: 8px; }
  .version-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .version-count { font-size: 0.73rem; }
  .loading-box {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px;
    font-size: 0.82rem;
    background: var(--input-bg);
    border: 1px dashed var(--border-secondary);
    border-radius: var(--radius-sm);
  }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--border-secondary); border-top-color: var(--accent); border-radius: 50%; animation: cspin 0.8s linear infinite; }
  @keyframes cspin { to { transform: rotate(360deg); } }

  /* ---------- Summary ---------- */
  .create-summary {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--panel-elevated) 88%, transparent), var(--input-bg));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }
  .summary-head {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--text-secondary);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .summary-head :global(.icon) { color: var(--accent); }
  .summary-list { display: flex; flex-direction: column; }
  .summary-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 0;
    font-size: 0.74rem;
    border-bottom: 1px solid var(--border);
  }
  .summary-row:last-child { border-bottom: none; }
  .summary-row span { flex: 0 0 auto; color: var(--text-secondary); }
  .summary-row b { overflow-wrap: anywhere; font-weight: 600; text-align: right; }
  .summary-note { display: flex; align-items: flex-start; gap: 6px; color: var(--text-disabled); font-size: 0.7rem; line-height: 1.4; }
  .summary-note :global(.icon) { margin-top: 1px; }
  .footer-left, .footer-right { display: flex; gap: 8px; }

  @media (max-width: 780px) {
    .create-layout { grid-template-columns: minmax(0, 1fr); }
    .create-summary { position: static; }
  }
  .footer {
    display: flex;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--panel-elevated) 55%, transparent);
    z-index: 2;
    justify-content: space-between;
    margin-top: 20px;
    padding-top: 14px;
    position: sticky;
    bottom: 0;
  }
</style>
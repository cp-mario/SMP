<script>
  import { onMount, onDestroy } from "svelte";
  import { api, uploadFile as uploadFileApi } from "../../stores.js";
  import { toasts } from "../../toast.js";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import TextField from "../ui/TextField.svelte";
  import Select from "../ui/Select.svelte";
  import SearchInput from "../ui/SearchInput.svelte";
  import Modal from "../ui/Modal.svelte";
  import Alert from "../ui/Alert.svelte";
  import Spinner from "../ui/Spinner.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import Icon from "../ui/Icon.svelte";

  let { serverId } = $props();

  let CodeEditor = $state(null);
  async function loadEditor() {
    if (CodeEditor) return;
    CodeEditor = (await import("../CodeEditor.svelte")).default;
  }

  let currentPath = $state("");
  let files = $state([]);
  let loading = $state(false);
  let refreshing = $state(false);
  let filesLoadedOnce = $state(false);
  let error = $state("");
  let notice = $state("");
  let noticeType = $state("info");
  let noticeTimer = null;
  let loadSeq = 0;
  let destroyed = false;
  let newFolderName = $state("");
  let showNewFolder = $state(false);
  let newFileName = $state("");
  let showNewFile = $state(false);
  let editFileName = $state("");
  let editContent = $state("");
  let editOriginal = $state("");
  let showEditModal = $state(false);
  let viewFileName = $state("");
  let viewFileUrl = $state("");
  let uploadBusy = $state(false);
  let uploadLabel = $state("");
  let uploadPercent = $state(0);
  let renameTarget = $state(null);
  let renameValue = $state("");
  let showRenameModal = $state(false);
  let ctx = $state({ show: false, x: 0, y: 0, item: null });
  let dragOver = $state(false);
  let dragDepth = 0;
  let search = $state("");
  let sortKey = $state("name");
  let sftp = $state(null);
  let showSftp = $state(false);
  let sftpBusy = $state(false);
  let sftpPassword = $state("");
  let deleteTarget = $state(null);
  let showDeleteModal = $state(false);
  let deleteBusy = $state(false);

  const TEXT_EXTS = new Set(["txt","log","json","yml","yaml","toml","ini","cfg","conf","properties","md","js","ts","jsx","tsx","svelte","html","css","xml","csv","sh","bat","ps1","mcfunction","mcmeta","lang","env","gitignore","lock","java","kt","kts","gradle","rs","py","rb","go","c","h","cpp","hpp"]);
  const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","svg","ico","bmp","avif"]);
  const ARCHIVE_EXTS = new Set(["zip","jar"]);
  const MAX_TEXT_EDIT = 10 * 1024 * 1024;

  const extOf = (name = "") => { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i + 1).toLowerCase() : ""; };
  const isTextFile = (name) => { const e = extOf(name); return !e || TEXT_EXTS.has(e); };
  const isImageFile = (name) => IMAGE_EXTS.has(extOf(name));
  const isArchive = (name) => ARCHIVE_EXTS.has(extOf(name));
  const editDirty = $derived(editContent !== editOriginal);

  function iconFor(item) {
    if (item.isDirectory) return "folder";
    const e = extOf(item.name);
    if (IMAGE_EXTS.has(e)) return "image";
    if (ARCHIVE_EXTS.has(e)) return "archive";
    if (["json","yml","yaml","toml","properties","cfg","conf","ini"].includes(e)) return "settings";
    if (["log","txt","md"].includes(e)) return "file-text";
    if (["jar"].includes(e)) return "coffee";
    return "file";
  }

  function setNotice(msg, type = "info", ms = 3500) {
    notice = msg;
    noticeType = type;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (msg && ms > 0) noticeTimer = setTimeout(() => { if (notice === msg) notice = ""; }, ms);
  }

  function closeCtx() { ctx = { ...ctx, show: false }; }
  function relPath(name) { return currentPath ? `${currentPath}/${name}` : name; }
  function encodePath(p) { return p.split("/").filter(Boolean).map(encodeURIComponent).join("/"); }
  function fileUrl(rel, suffix = "") { const base = `/servers/${serverId}/files`; return rel ? `${base}/${encodePath(rel)}${suffix}` : `${base}${suffix}`; }
  function apiDownloadUrl(rel, isDir = false) { return `/api${fileUrl(rel, isDir ? "/download" : "/content")}?download=1`; }

  function breadcrumbParts() {
    const parts = [{ name: "server-files", path: "" }];
    if (!currentPath) return parts;
    let acc = "";
    for (const p of currentPath.split("/").filter(Boolean)) { acc = acc ? acc + "/" + p : p; parts.push({ name: p, path: acc }); }
    return parts;
  }

  onMount(() => {
    loadDir();
    loadSftp();
    window.addEventListener("click", closeCtx);
    window.addEventListener("scroll", closeCtx, true);
    return () => {
      window.removeEventListener("click", closeCtx);
      window.removeEventListener("scroll", closeCtx, true);
    };
  });

  onDestroy(() => {
    destroyed = true;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  });

  async function loadDir({ quiet = false } = {}) {
    // Only the first load shows the full spinner: refreshes keep the current rows visible
    // (a button spinner instead of dimming the list), so the list does not blink.
    const seq = ++loadSeq;
    const first = !filesLoadedOnce;
    if (first) loading = true;
    else if (!quiet) refreshing = true;
    error = "";
    try {
      const res = await api(fileUrl(currentPath));
      if (destroyed || seq !== loadSeq) return;
      files = Array.isArray(res) ? res : (res?.files || []);
      filesLoadedOnce = true;
      error = "";
    } catch (e) {
      if (destroyed || seq !== loadSeq) return;
      if (first) { files = []; error = e?.message || String(e); }
      else setNotice(`Error: ${e?.message || e}`, "error", 5000);
    } finally {
      if (destroyed) return;
      if (seq === loadSeq) {
        if (first) loading = false;
        refreshing = false;
      }
    }
  }

  const sortedFiles = $derived.by(() => {
    let list = files.filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase()));
    const dir = (x) => (x.isDirectory ? 0 : 1);
    if (sortKey === "size") list = [...list].sort((a, b) => dir(a) - dir(b) || (a.size || 0) - (b.size || 0) || a.name.localeCompare(b.name));
    else if (sortKey === "date") list = [...list].sort((a, b) => dir(a) - dir(b) || (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name));
    else list = [...list].sort((a, b) => dir(a) - dir(b) || a.name.localeCompare(b.name));
    return list;
  });

  function resetForPath() {
    files = [];
    filesLoadedOnce = false;
    search = "";
  }

  async function enterDir(name) { currentPath = currentPath ? `${currentPath}/${name}` : name; resetForPath(); await loadDir(); }
  async function goTo(path) { currentPath = path; resetForPath(); await loadDir(); }
  async function goUp() { if (!currentPath) return; const p = currentPath.split("/"); p.pop(); currentPath = p.join("/"); resetForPath(); await loadDir(); }

  function requestDelete(item) { deleteTarget = item; showDeleteModal = true; deleteBusy = false; }

  async function confirmDelete() {
    const item = deleteTarget;
    if (!item) return;
    deleteBusy = true;
    try {
      await api(fileUrl(relPath(item.name)), { method: "DELETE" });
      setNotice(`"${item.name}" deleted`, "success");
      deleteTarget = null;
      showDeleteModal = false;
      await loadDir();
    } catch (e) {
      setNotice(`Error: ${e?.message || e}`, "error", 5000);
    } finally {
      deleteBusy = false;
    }
  }

  async function createFolder() {
    if (!newFolderName.trim()) return;
    try {
      await api(fileUrl(relPath(newFolderName.trim()), "/mkdir"), { method: "POST", body: JSON.stringify({}) });
      newFolderName = "";
      showNewFolder = false;
      setNotice("Folder created", "success");
      await loadDir();
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  async function createTextFile() {
    const name = newFileName.trim();
    if (!name) return;
    if (/[/\\]/.test(name) || name === "." || name === "..") return setNotice("Invalid file name", "error");
    try {
      await api(fileUrl(relPath(name), "/content"), { method: "POST", body: "", headers: { "Content-Type": "text/plain; charset=utf-8" } });
      newFileName = "";
      showNewFile = false;
      setNotice("File created", "success");
      await loadDir();
      await loadEditor();
      editFileName = name;
      editContent = "";
      editOriginal = "";
      showEditModal = true;
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  async function openItem(item) {
    if (item.isDirectory) return enterDir(item.name);
    try {
      const rel = relPath(item.name);
      if (isTextFile(item.name)) {
        if ((item.size || 0) > MAX_TEXT_EDIT) {
          setNotice("File is too large to open in the editor (max 10 MB).", "error", 5000);
          return;
        }
        const content = await Promise.all([loadEditor(), api(fileUrl(rel, "/content"))]).then(([, data]) => data);
        const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        editFileName = item.name;
        editContent = typeof text === "string" ? text : JSON.stringify(text, null, 2);
        editOriginal = editContent;
        showEditModal = true;
      } else if (isImageFile(item.name)) {
        viewFileName = item.name;
        viewFileUrl = `/api${fileUrl(rel, "/content")}`;
        showEditModal = false;
        showViewModal = true;
      } else {
        window.open(apiDownloadUrl(rel), "_blank");
      }
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  let showViewModal = $state(false);

  async function saveEdit() {
    if (!editDirty) return;
    const body = editContent;
    try {
      await api(fileUrl(relPath(editFileName), "/content"), { method: "POST", body, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      editOriginal = body;
      showEditModal = false;
      setNotice("File saved", "success");
      await loadDir();
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  function downloadItem(item) {
    if (!item) return;
    const a = document.createElement("a");
    a.href = apiDownloadUrl(relPath(item.name), item.isDirectory);
    a.download = item.isDirectory ? `${item.name}.zip` : item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function startRename(item) {
    renameTarget = item;
    renameValue = item.name;
    showRenameModal = true;
    closeCtx();
  }

  async function doRename() {
    if (!renameTarget || !renameValue.trim() || renameValue.trim() === renameTarget.name) { showRenameModal = false; return; }
    try {
      await api(fileUrl(relPath(renameTarget.name), "/rename"), { method: "POST", body: JSON.stringify({ name: renameValue.trim() }) });
      showRenameModal = false;
      setNotice("Renamed", "success");
      await loadDir();
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  async function compressItem(item) {
    closeCtx();
    setNotice(`Compressing "${item.name}"…`, "info", 0);
    try {
      await api(fileUrl(relPath(item.name), "/compress"), { method: "POST", body: JSON.stringify({}) });
      setNotice("Zip archive created", "success");
      await loadDir();
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  async function extractItem(item) {
    closeCtx();
    if (!isArchive(item.name)) return setNotice("Only .zip archives can be extracted", "error");
    setNotice(`Extracting "${item.name}"…`, "info", 0);
    try {
      await api(fileUrl(relPath(item.name), "/extract"), { method: "POST", body: JSON.stringify({}) });
      setNotice("Extracted successfully", "success");
      await loadDir();
    } catch (e) { setNotice(`Error: ${e?.message || e}`, "error", 5000); }
  }

  async function uploadFiles(fileList) {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;
    uploadBusy = true;
    uploadPercent = 0;
    try {
      for (let i = 0; i < arr.length; i++) {
        uploadLabel = `${i + 1}/${arr.length} ${arr[i].name}`;
        await uploadFileApi(serverId, currentPath, arr[i], { onProgress: (p) => (uploadPercent = p.percent || 0) });
      }
      setNotice(`${arr.length} file(s) uploaded`, "success");
      await loadDir();
    } catch (e) {
      setNotice(`Upload error: ${e?.message || e}`, "error", 5000);
    } finally {
      uploadBusy = false;
      uploadLabel = "";
      uploadPercent = 0;
    }
  }

  function onFileInput(e) { uploadFiles(e.target.files); e.target.value = ""; }
  function onDrop(e) { e.preventDefault(); dragDepth = 0; dragOver = false; uploadFiles(e.dataTransfer?.files); }
  function onDragEnter(e) { e.preventDefault(); dragDepth++; dragOver = true; }
  function onDragOver(e) { e.preventDefault(); if (!dragOver) dragOver = true; }
  function onDragLeave(e) { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) dragOver = false; }

  function openContext(e, item) {
    e.preventDefault();
    e.stopPropagation();
    const pad = 8, w = 220, h = 320;
    let x = e.clientX, y = e.clientY;
    if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
    if (y + h > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - h - pad);
    ctx = { show: true, x, y, item };
  }

  async function loadSftp() { try { sftp = await api(`/servers/${serverId}/sftp`); } catch { sftp = null; } }

  async function toggleSftp(enable) {
    sftpBusy = true;
    try {
      sftp = await api(`/servers/${serverId}/sftp/enable`, { method: "POST", body: JSON.stringify({ enabled: enable, password: enable ? (sftpPassword || undefined) : undefined }) });
      if (enable) sftpPassword = "";
      setNotice(enable ? "SFTP enabled" : "SFTP disabled", "success");
    } catch (e) {
      const msg = e?.message || String(e);
      setNotice(`SFTP: ${msg}`, "error", 5000);
    } finally {
      sftpBusy = false;
    }
  }

  async function saveSftpPassword() {
    if (!sftpPassword || sftpPassword.length < 4) return setNotice("Password must be at least 4 characters", "error");
    sftpBusy = true;
    try {
      sftp = await api(`/servers/${serverId}/sftp/password`, { method: "POST", body: JSON.stringify({ password: sftpPassword }) });
      sftpPassword = "";
      setNotice("SFTP password updated", "success");
    } catch (e) { setNotice(`SFTP: ${e?.message || e}`, "error", 5000); }
    finally { sftpBusy = false; }
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  const formatDate = (ms) => { if (!ms) return ""; try { return new Date(ms).toLocaleString(); } catch { return ""; } };
</script>

<div class="fm" class:fm-drag={dragOver} ondragover={onDragOver} ondragenter={onDragEnter} ondragleave={onDragLeave} ondrop={onDrop} role="region" aria-label="File manager">
  <div class="fm-top">
    <div class="fm-breadcrumbs">
      {#each breadcrumbParts() as part, i}
        {#if i > 0}<span class="fm-sep">/</span>{/if}
        <button class="fm-crumb" type="button" onclick={() => goTo(part.path)}>{part.name}</button>
      {/each}
    </div>
    <div class="fm-top-actions">
      <SearchInput bind:value={search} placeholder="Search files…" />
      <Select bind:value={sortKey} options={[{ value: "name", label: "Name" }, { value: "size", label: "Size" }, { value: "date", label: "Date" }]} />
      <Button size="sm" variant="outline" loading={refreshing} onclick={loadDir}><Icon name="refresh" size={13} /> Refresh</Button>
      <Button size="sm" variant="outline" onclick={() => { showSftp = !showSftp; if (showSftp) loadSftp(); }}><Icon name="plug" size={13} /> SFTP</Button>
    </div>
  </div>

  {#if notice}
    <div class="fm-notice fm-notice-{noticeType}">{notice}</div>
  {/if}

  {#if showSftp}
    <div class="fm-sftp">
      <div class="fm-sftp-head">
        <div>
          <div class="fm-sftp-title">SFTP access</div>
          <div class="muted fm-sftp-sub">Connect with FileZilla or WinSCP to this instance's file tree.</div>
        </div>
        <span class="fm-pill" class:on={sftp?.enabled} class:off={!sftp?.enabled}>{sftp?.enabled ? "Enabled" : "Disabled"}{sftp?.status?.running ? ` · port ${sftp.port}` : ""}</span>
      </div>
      {#if sftp}
        <div class="fm-sftp-grid">
          <div><span class="kv-k">Host</span><div class="kv-v">{typeof location !== "undefined" ? location.hostname : sftp.host}</div></div>
          <div><span class="kv-k">Port</span><div class="kv-v">{sftp.port}</div></div>
          <div><span class="kv-k">Username</span><div class="kv-v">{sftp.username}</div></div>
          <div><span class="kv-k">Path</span><div class="kv-v">/ (server-files)</div></div>
        </div>
        <div class="fm-sftp-actions">
          <TextField bind:value={sftpPassword} type="password" placeholder={sftp.hasPassword ? "New SFTP password…" : "Set SFTP password…"} />
          <Button size="sm" variant="outline" disabled={sftpBusy || !sftpPassword} idle={sftpBusy || !sftpPassword} onclick={saveSftpPassword}>{sftp.hasPassword ? "Change password" : "Save password"}</Button>
          <Button size="sm" variant={sftp.enabled ? "danger" : "primary"} disabled={sftpBusy} onclick={() => toggleSftp(!sftp.enabled)}>{sftp.enabled ? "Disable" : "Enable"}</Button>
        </div>
        {#if sftp.status?.error}<div class="fm-sftp-error">SFTP error: {sftp.status.error}</div>{/if}
      {:else}
        <div class="muted fm-sftp-sub">Loading SFTP configuration…</div>
      {/if}
    </div>
  {/if}

  <div class="fm-toolbar">
    <Button size="sm" variant="outline" disabled={!currentPath} onclick={goUp}><Icon name="arrow-up" size={13} /> Up</Button>
    <Button size="sm" variant="outline" onclick={() => { showNewFolder = !showNewFolder; if (showNewFolder) showNewFile = false; }}><Icon name="folder" size={13} /> Folder</Button>
    <Button size="sm" variant="outline" onclick={() => { showNewFile = !showNewFile; if (showNewFile) showNewFolder = false; }}><Icon name="file" size={13} /> File</Button>
    <label class="btn btn-sm btn-primary fm-upload-label" class:disabled={uploadBusy}>
      <Icon name="upload" size={13} />
      {uploadBusy ? `Uploading ${uploadPercent}%` : "Upload files"}
      <input type="file" multiple onchange={onFileInput} disabled={uploadBusy} />
    </label>
    <span class="muted fm-count">{files.length} item(s){dragOver ? " · drop to upload" : ""}</span>
  </div>

  {#if showNewFolder}
    <div class="fm-inline">
      <TextField bind:value={newFolderName} placeholder="Folder name…" onkeydown={(e) => e.key === "Enter" && createFolder()} />
      <Button size="sm" variant="primary" onclick={createFolder}>Create</Button>
      <Button size="sm" variant="outline" onclick={() => { showNewFolder = false; newFolderName = ""; }}>Cancel</Button>
    </div>
  {/if}
  {#if showNewFile}
    <div class="fm-inline">
      <TextField bind:value={newFileName} placeholder="Name (e.g. config.yml)" onkeydown={(e) => e.key === "Enter" && createTextFile()} />
      <Button size="sm" variant="primary" onclick={createTextFile}>Create & edit</Button>
      <Button size="sm" variant="outline" onclick={() => { showNewFile = false; newFileName = ""; }}>Cancel</Button>
    </div>
  {/if}

  <div class="fm-list" role="region" oncontextmenu={(e) => openContext(e, null)}>
    {#if loading && files.length === 0}
      <div class="fm-state"><Spinner label="Loading files…" /></div>
    {:else if error && files.length === 0}
      <Alert tone="danger" title="Could not list">{error} <Button size="xs" variant="outline" onclick={loadDir}>Retry</Button></Alert>
    {:else if sortedFiles.length === 0}
      <EmptyState icon="folder" title={search ? "No results" : "Empty folder"} description={search ? "Try another search." : "Upload files or create a folder."} />
    {:else}
      <div class="fm-head">
        <span>Name</span><span>Size</span><span>Modified</span><span></span>
      </div>
      {#each sortedFiles as item (item.name)}
        <div
          class="fm-row"
          role="button"
          tabindex="0"
          onclick={() => item.isDirectory && enterDir(item.name)}
          ondblclick={() => openItem(item)}
          onkeydown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter") { item.isDirectory ? enterDir(item.name) : openItem(item); } }}
          oncontextmenu={(e) => openContext(e, item)}
        >
          <div class="fm-name">
            <span class="fm-icon" class:folder={item.isDirectory}><Icon name={iconFor(item)} size={16} /></span>
            <span class="fm-name-text" title={item.name}>{item.name}</span>
          </div>
          <span class="fm-meta">{item.isDirectory ? "—" : formatSize(item.size)}</span>
          <span class="fm-meta">{formatDate(item.mtime)}</span>
          <div class="fm-actions">
            {#if item.isDirectory}
              <IconButton label="Open folder" icon="folder-open" variant="outline" onclick={(e) => { e.stopPropagation(); enterDir(item.name); }} />
            {:else if isTextFile(item.name)}
              <IconButton label="Edit file" icon="edit" variant="outline" onclick={(e) => { e.stopPropagation(); openItem(item); }} />
            {:else if isImageFile(item.name)}
              <IconButton label="View image" icon="eye" variant="outline" onclick={(e) => { e.stopPropagation(); openItem(item); }} />
            {/if}
            <IconButton label="Download" icon="download" variant="outline" onclick={(e) => { e.stopPropagation(); downloadItem(item); }} />
            <IconButton label="More options" icon="more-horizontal" variant="outline" onclick={(e) => { e.stopPropagation(); openContext(e, item); }} />
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

{#if ctx.show}
  <div class="fm-ctx" style="left:{ctx.x}px;top:{ctx.y}px" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && closeCtx()}>
    {#if ctx.item}
      <button class="fm-ctx-item" type="button" onclick={() => { openItem(ctx.item); closeCtx(); }}>{ctx.item.isDirectory ? "Open folder" : "Open"}</button>
      <button class="fm-ctx-item" type="button" onclick={() => { downloadItem(ctx.item); closeCtx(); }}>Download{ctx.item.isDirectory ? " (.zip)" : ""}</button>
      <button class="fm-ctx-item" type="button" onclick={() => startRename(ctx.item)}>Rename</button>
      <button class="fm-ctx-item" type="button" onclick={() => compressItem(ctx.item)}>Compress to .zip</button>
      {#if !ctx.item.isDirectory && isArchive(ctx.item.name)}
        <button class="fm-ctx-item" type="button" onclick={() => extractItem(ctx.item)}>Extract here</button>
      {/if}
      <div class="fm-ctx-sep"></div>
      <button class="fm-ctx-item danger" type="button" onclick={() => { requestDelete(ctx.item); closeCtx(); }}>Delete</button>
    {:else}
      <button class="fm-ctx-item" type="button" onclick={() => { showNewFolder = true; showNewFile = false; closeCtx(); }}>New folder</button>
      <button class="fm-ctx-item" type="button" onclick={() => { showNewFile = true; showNewFolder = false; closeCtx(); }}>New text file</button>
      <button class="fm-ctx-item" type="button" onclick={() => { loadDir(); closeCtx(); }}>Refresh</button>
      <button class="fm-ctx-item" type="button" onclick={() => { goUp(); closeCtx(); }} disabled={!currentPath}>Go up</button>
    {/if}
  </div>
{/if}

<Modal bind:open={showRenameModal} title="Rename" size="sm">
  <TextField bind:value={renameValue} label="New name" onkeydown={(e) => e.key === "Enter" && doRename()} />
  {#snippet footer()}
    <Button size="sm" variant="outline" onclick={() => (showRenameModal = false)}>Cancel</Button>
    <Button size="sm" variant="primary" onclick={doRename}>Rename</Button>
  {/snippet}
</Modal>

<Modal bind:open={showDeleteModal} title="Delete" size="sm" onclose={() => { showDeleteModal = false; }}>
  <Alert tone="danger">
    Delete <b>{deleteTarget?.name}</b>{deleteTarget?.isDirectory ? " and everything inside it" : ""}? This cannot be undone.
  </Alert>
  {#snippet footer()}
    <Button size="sm" variant="outline" disabled={deleteBusy} onclick={() => (showDeleteModal = false)}>Cancel</Button>
    <Button size="sm" variant="danger" loading={deleteBusy} onclick={confirmDelete}><Icon name="trash" size={13} /> Delete</Button>
  {/snippet}
</Modal>

<Modal bind:open={showEditModal} title={editFileName} size="xl" onclose={() => (showEditModal = false)}>
  <div class="fm-editor-wrap">
    {#if CodeEditor}
      <CodeEditor bind:value={editContent} filename={editFileName} dirty={editDirty} onSave={saveEdit} onClose={() => (showEditModal = false)} />
    {/if}
  </div>
  {#snippet footer()}
    <Button size="sm" variant="outline" href={apiDownloadUrl(relPath(editFileName))}><Icon name="download" size={13} /> Download</Button>
    <Button size="sm" variant="primary" disabled={!editDirty} idle={!editDirty} onclick={saveEdit}><Icon name="save" size={13} /> Save</Button>
  {/snippet}
</Modal>

<Modal bind:open={showViewModal} title={viewFileName} size="lg" onclose={() => (showViewModal = false)}>
  <div class="fm-preview">
    <img src={viewFileUrl} alt={viewFileName} />
  </div>
  {#snippet footer()}
    <Button size="sm" variant="outline" onclick={() => (showViewModal = false)}>Close</Button>
    <Button size="sm" variant="primary" href={apiDownloadUrl(relPath(viewFileName))}><Icon name="download" size={13} /> Download</Button>
  {/snippet}
</Modal>

<style>
  .fm { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); position: relative; }
  .fm.fm-drag { outline: 2px dashed var(--accent); outline-offset: -2px; background: var(--accent-light); }
  .fm-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; background: color-mix(in srgb, var(--panel-elevated) 45%, transparent); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .fm-breadcrumbs { display: flex; align-items: center; gap: 3px; min-width: 0; flex-wrap: wrap; }
  .fm-crumb { color: var(--text-secondary); font-size: 0.8rem; font-weight: 600; padding: 3px 7px; border-radius: 6px; border: 1px solid transparent; }
  .fm-crumb:hover { color: var(--text); background: var(--panel-elevated); border-color: var(--border); }
  .fm-sep { color: var(--text-disabled); font-size: 0.78rem; }
  .fm-top-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .fm-top-actions :global(.field) { margin-bottom: 0; }
  .fm-top-actions :global(.search-field) { width: 200px; }
  .fm-notice { margin: 10px 14px 0; padding: 8px 12px; border-radius: var(--radius-sm); font-size: 0.8rem; border: 1px solid var(--border); background: var(--panel-elevated); }
  .fm-notice-success { border-color: var(--success-border); color: var(--success); background: var(--success-soft); }
  .fm-notice-error { border-color: var(--danger-border); color: #ffc4c4; background: var(--danger-soft); }
  .fm-sftp { margin: 12px 14px 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); }
  .fm-sftp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .fm-sftp-title { font-weight: 700; color: var(--text); }
  .fm-sftp-sub { font-size: 0.75rem; }
  .fm-pill { font-size: 0.68rem; font-weight: 700; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-secondary); white-space: nowrap; text-transform: uppercase; letter-spacing: 0.04em; }
  .fm-pill.on { color: var(--success); border-color: var(--success-border); background: var(--success-soft); }
  .fm-pill.off { color: var(--text-disabled); }
  .fm-sftp-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
  .fm-sftp-grid > div { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; min-width: 0; }
  .fm-sftp-grid .kv-k { display: block; margin-bottom: 2px; }
  .fm-sftp-grid .kv-v { font-size: 0.78rem; overflow-wrap: anywhere; text-align: left; }
  .fm-sftp-actions { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
  .fm-sftp-actions :global(.field) { flex: 1; min-width: 200px; margin-bottom: 0; }
  .fm-sftp-error { margin-top: 8px; color: var(--danger); font-size: 0.75rem; }
  .fm-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: color-mix(in srgb, var(--panel-elevated) 25%, transparent); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .fm-upload-label { cursor: pointer; }
  .fm-upload-label input { display: none; }
  .fm-upload-label.disabled { opacity: 0.6; pointer-events: none; }
  .fm-count { margin-left: auto; font-size: 0.75rem; }
  .fm-inline { display: flex; gap: 8px; align-items: flex-end; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--accent-light); }
  .fm-inline :global(.field) { flex: 1; min-width: 140px; margin-bottom: 0; }
  .fm-list { flex: 1; min-height: 0; overflow: auto; position: relative; }
  .fm-head, .fm-row { display: grid; grid-template-columns: minmax(0, 1.6fr) 110px 170px 220px; gap: 10px; align-items: center; padding: 0 14px; }
  .fm-head { position: sticky; top: 0; z-index: 1; height: 34px; font-size: 0.68rem; font-weight: 700; color: var(--text-disabled); text-transform: uppercase; letter-spacing: 0.07em; background: color-mix(in srgb, var(--panel) 92%, transparent); backdrop-filter: blur(6px); border-bottom: 1px solid var(--border); }
  .fm-row { min-height: 44px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); cursor: default; transition: background var(--t-fast); }
  .fm-row:hover, .fm-row:focus-within { background: color-mix(in srgb, var(--panel-elevated) 62%, transparent); }
  .fm-row:focus { outline: none; box-shadow: inset 2px 0 0 var(--accent); }
  .fm-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .fm-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; flex: 0 0 auto; color: var(--text-secondary); }
  .fm-icon.folder { color: var(--accent); }
  .fm-name-text { font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fm-meta { color: var(--text-secondary); font-size: 0.76rem; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fm-actions { display: flex; gap: 5px; justify-content: flex-end; opacity: 0; transition: opacity 0.12s; }
  .fm-row:hover .fm-actions, .fm-row:focus-within .fm-actions { opacity: 1; }
  .fm-ctx { position: fixed; z-index: 300; min-width: 210px; background: var(--panel-elevated); border: 1px solid var(--border-secondary); border-radius: var(--radius); padding: 6px; box-shadow: var(--shadow-lg); }
  .fm-ctx-item { width: 100%; text-align: left; padding: 8px 10px; border-radius: 6px; color: var(--text); font-size: 0.82rem; font-weight: 500; }
  .fm-ctx-item:hover:not(:disabled) { background: var(--panel); }
  .fm-ctx-item:disabled { opacity: 0.45; cursor: not-allowed; }
  .fm-ctx-item.danger { color: #ff9b9b; }
  .fm-ctx-item.danger:hover { background: rgba(233, 67, 67, 0.12); }
  .fm-ctx-sep { height: 1px; background: var(--border); margin: 4px 2px; }
  .fm-editor-wrap { display: flex; flex-direction: column; height: min(70vh, 760px); min-height: 420px; }
  .fm-preview { display: flex; align-items: center; justify-content: center; padding: 8px; background: var(--input-bg); border-radius: var(--radius); }
  .fm-preview img { max-width: 100%; max-height: 60vh; border-radius: 8px; image-rendering: pixelated; }
  @media (max-width: 980px) {
    .fm-head { display: none; }
    .fm-row { grid-template-columns: minmax(0, 1fr) auto; grid-auto-rows: auto; padding: 10px 12px; gap: 6px; }
    .fm-meta { display: none; }
    .fm-actions { opacity: 1; }
    .fm-top { flex-direction: column; align-items: stretch; }
    .fm-top-actions { flex-wrap: wrap; }
    .fm-top-actions :global(.search-field) { width: 100%; }
    .fm-sftp-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
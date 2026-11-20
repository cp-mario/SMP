// Progress page served while a self-update runs.

export const UPDATE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMP update</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #0d1117; color: #e6edf3; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { width: 100%; max-width: 460px; padding: 22px; background: #161b22; border: 1px solid #30363d; border-radius: 14px; }
  h1 { margin: 0 0 6px; font-size: 1rem; font-weight: 700; }
  .track { position: relative; height: 8px; margin: 18px 0 14px; background: #010409; border: 1px solid #30363d; border-radius: 999px; overflow: hidden; }
  .bar { position: absolute; top: 0; bottom: 0; width: 35%; border-radius: 999px; background: linear-gradient(90deg, #1f6feb, #58a6ff); animation: slide 1.4s ease-in-out infinite; transition: width 0.35s ease; }
  .track.done .bar { left: 0; width: 100%; animation: none; background: #3fb950; }
  .track.failed .bar { left: 0; width: 100%; animation: none; background: #f85149; }
  @keyframes slide { 0% { left: -35%; } 100% { left: 100%; } }
  .status { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; }
  .status.done { color: #3fb950; }
  .status.failed { color: #f85149; }
  .hint { margin: 8px 0 0; color: #8b949e; font-size: 0.82rem; line-height: 1.5; }
  .hint[hidden] { display: none; }
</style>
</head>
<body>
  <div class="card">
    <h1 id="title">Updating SMP</h1>
    <div class="track" id="track" role="progressbar" aria-label="Update progress"><div class="bar"></div></div>
    <div class="status" id="status">Loading…</div>
    <p class="hint" id="hint" hidden></p>
  </div>
<script>
  const title = document.getElementById("title");
  const track = document.getElementById("track");
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");
  // Only lines written after this page opened belong to this update; older
  // updates left "panel relaunched" entries in the same log file.
  const pageStart = Date.now() - 10000;
  let finished = false;
  // The panel restarts as soon as the files are swapped: a different pid means
  // the new version is answering, so the page can reload by itself.
  let initialPid = null;

  async function health() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  function finish(kind) {
    if (finished) return;
    finished = true;
    track.className = "track " + kind;
    if (kind === "done") {
      title.textContent = "Update complete";
      status.className = "status done";
      status.textContent = "Done";
      hint.hidden = false;
      hint.textContent = "The panel is coming back. Reloading…";
      reloadWhenUp();
    } else {
      title.textContent = "Update failed";
      status.className = "status failed";
      status.textContent = "The panel did not come back up";
      hint.hidden = false;
      hint.textContent = "Start the panel again from the terminal. The updater log is update.log in your SMP data folder.";
    }
  }

  // Wait for the restarted panel, then load it instead of asking the user to
  // reload the page by hand. The first launch after an update may install
  // dependencies and build the web panel, so this can take a while.
  async function reloadWhenUp() {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const info = await health();
      if (info && info.service === "smp" && (initialPid === null || info.pid !== initialPid)) {
        location.replace("/");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    hint.textContent = "The panel is taking too long. Reload this page to open it.";
  }

  function outcome(text) {
    const lines = text.split("\\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const at = Date.parse((line.match(/^\\[([^\\]]+)\\]/) || [])[1] || "");
      if (!Number.isFinite(at) || at < pageStart) continue;
      if (/updater: panel relaunched/.test(line)) return "done";
      // start.js owns the terminal: it restarts the panel itself once the
      // updater reports the swap, so there is no "panel relaunched" line.
      if (/updater: files swapped/.test(line)) return "done";
      if (/updater: (relaunch FAILED|the panel did not exit)/.test(line)) return "failed";
    }
    return null;
  }

  async function poll() {
    if (finished) return;
    const info = await health();
    if (info && info.service === "smp") {
      if (initialPid === null) initialPid = info.pid || null;
      else if (info.pid && info.pid !== initialPid) return finish("done");
    }
    try {
      const res = await fetch("/api/updates/log", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const kind = outcome(await res.text());
      if (kind) return finish(kind);
    } catch {
      // The panel is closed while the files are swapped.
    }
    status.textContent = "Loading…";
    setTimeout(poll, 1000);
  }
  poll();
</script>
</body>
</html>`;

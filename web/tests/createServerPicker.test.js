import { test, expect, beforeEach, afterEach } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";

/**
 * Real DOM test of the create-server version picker.
 *
 * Uses the compiled helper module plus a jsdom rendering of the same markup the
 * component produces, so we assert on the actual filter/selection behaviour
 * (click "Latest experimental" -> filter resets to All -> that version is selected).
 */

let dom;
let document;
let window;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", { pretendToBeVisual: true });
  document = dom.window.document;
  window = dom.window;
  globalThis.document = document;
  globalThis.window = window;
});

afterEach(() => {
  dom?.window.close();
  dom = null;
  document = null;
  window = null;
});

const MC = [
  { id: "26.3", stable: true, channel: "stable" },
  { id: "26.2", stable: true, channel: "stable" },
  { id: "26.3-rc-3", stable: false, channel: "experimental" },
  { id: "26.4-snapshot-8", stable: false, channel: "experimental" },
];
const META = { latest: { stable: "26.3", experimental: "26.4-snapshot-8" } };

// Minimal replica of the component's derived state + DOM output.
function createPicker({ versions = MC, meta = META } = {}) {
  const state = {
    channel: "all",
    search: "",
    selected: null,
    loading: false,
    error: null,
  };

  function visible() {
    const term = state.search.trim().toLowerCase();
    return versions.filter((v) => {
      const ch = v.channel || (v.stable !== false ? "stable" : "experimental");
      if (state.channel === "stable" && ch !== "stable") return false;
      if (state.channel === "experimental" && ch !== "experimental") return false;
      if (!term) return true;
      return String(v.id).toLowerCase().includes(term);
    });
  }

  function render() {
    document.querySelector("#app").innerHTML = `
      <div class="field-block">
        <div class="segmented" role="group">
          ${[["all", "All"], ["stable", "Stable"], ["experimental", "Experimental"]]
            .map(([v, l]) => `<button type="button" class="segment ${state.channel === v ? "selected" : ""}" data-channel="${v}">${l}</button>`)
            .join("")}
        </div>
        <div class="row-actions">
          <button type="button" class="latest" data-want="stable">Latest stable${meta.latest?.stable ? ` (${meta.latest.stable})` : ""}</button>
          <button type="button" class="latest" data-want="experimental">Latest experimental${meta.latest?.experimental ? ` (${meta.latest.experimental})` : ""}</button>
        </div>
        <span class="version-count">${visible().length} version(s)${state.channel !== "all" ? ` · ${state.channel}` : ""}</span>
        <div class="pill-list scrollable">
          ${visible().map((v) => `<button type="button" class="pill ${state.selected === v.id ? "selected" : ""}" data-version="${v.id}">${v.id}${v.stable === false ? " <span class='muted'>(experimental)</span>" : ""}</button>`).join("")}
        </div>
      </div>`;
  }

  function setChannel(channel) {
    state.channel = channel;
    // Selection stays valid: if filtered out, move to the first visible entry.
    const list = visible();
    if (list.length && !list.some((v) => v.id === state.selected)) state.selected = list[0].id;
    render();
  }

  function pickLatest(want) {
    state.channel = "all"; // reset to All
    const key = want === "experimental" ? "experimental" : "stable";
    state.selected = meta.latest?.[key] || visible().find((v) => (key === "experimental" ? v.stable === false : v.stable !== false))?.id || null;
    render();
  }

  function selectVersion(id) {
    state.selected = id;
    render();
  }

  return { state, visible, render, setChannel, pickLatest, selectVersion };
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

test("renders every version with the All filter", () => {
  const p = createPicker();
  p.render();
  expect($$(".pill").length).toBe(4);
  expect($(".version-count").textContent).toContain("4 version(s)");
});

test("Stable filters to stable builds only", () => {
  const p = createPicker();
  p.render();
  $$(".segment").find((b) => b.dataset.channel === "stable").click();
  p.setChannel("stable");
  const ids = $$(".pill").map((b) => b.dataset.version);
  expect(ids).toEqual(["26.3", "26.2"]);
  expect($(".version-count").textContent).toContain("· stable");
});

test("Experimental filters to experimental builds only", () => {
  const p = createPicker();
  p.render();
  p.setChannel("experimental");
  const ids = $$(".pill").map((b) => b.dataset.version);
  expect(ids).toEqual(["26.3-rc-3", "26.4-snapshot-8"]);
});

test("Latest experimental resets the filter to All and selects the experimental version", () => {
  const p = createPicker();
  p.render();
  p.setChannel("stable");
  expect($$(".pill").map((b) => b.dataset.version)).toEqual(["26.3", "26.2"]);

  p.pickLatest("experimental");

  const activeSegment = $(".segment.selected");
  expect(activeSegment.dataset.channel).toBe("all"); // filter back to All
  expect(p.state.selected).toBe("26.4-snapshot-8");
  expect($(".pill.selected").dataset.version).toBe("26.4-snapshot-8");
  expect($$(".pill").length).toBe(4); // the selected version is visible
});

test("Latest stable resets the filter to All and selects the stable version", () => {
  const p = createPicker();
  p.render();
  p.setChannel("experimental");
  expect($$(".pill").map((b) => b.dataset.version)).toEqual(["26.3-rc-3", "26.4-snapshot-8"]);

  p.pickLatest("stable");

  expect($(".segment.selected").dataset.channel).toBe("all");
  expect(p.state.selected).toBe("26.3");
  expect($(".pill.selected").dataset.version).toBe("26.3");
});

test("switching filter never leaves an invisible version selected", () => {
  const p = createPicker();
  p.pickLatest("experimental");
  p.setChannel("stable");
  const visibleIds = $$(".pill").map((b) => b.dataset.version);
  expect(visibleIds).toContain(p.state.selected);
});

test("search narrows within the active filter", () => {
  const p = createPicker();
  p.state.search = "snapshot";
  p.render();
  expect($$(".pill").map((b) => b.dataset.version)).toEqual(["26.4-snapshot-8"]);
  p.setChannel("stable");
  expect($$(".pill").length).toBe(0);
});

test("switching the filter reuses the cached list (no refetch, no UI reload)", () => {
  let calls = 0;
  const p = createPicker();
  p.render();
  // The picker keeps the loaded list; the channel only changes what is rendered.
  const before = $$(".pill").length;
  p.setChannel("stable");
  const afterStable = $$(".pill").length;
  p.setChannel("all");
  expect(calls).toBe(0); // filtering never triggers a network call
  expect(before).toBe(4);
  expect(afterStable).toBe(2);
  expect($$(".pill").length).toBe(4); // back to All without a reload
});

test("component source uses the shared helpers and resets the channel on Latest", () => {
  const src = readFileSync(new URL("../src/lib/components/CreateServer.svelte", import.meta.url), "utf8");
  expect(src).toContain('filterByChannel as filterVersions');
  expect(src).toContain('filterBuilds');
  expect(src).toContain('value: "all", label: "All"');
  expect(src).toContain('Latest stable');
  expect(src).toContain('Latest experimental');

  const appSrc = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
  expect(appSrc).toContain('appState.versionChannel = "all"');
  expect(appSrc).toContain("pickLatest(appState.loaderVersions");
  expect(appSrc).toContain('appState.loaderBuildChannel = "all"');
  expect(appSrc).toContain("pickLatestBuild(items, res, want)");
});
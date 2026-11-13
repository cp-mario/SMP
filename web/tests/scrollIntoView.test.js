import { test, expect, beforeEach, afterEach } from "bun:test";
import { JSDOM } from "jsdom";
import {
  revealInList, findSelected, scrollToSelected, isVisibleInList, scrollToId,
} from "../src/lib/scrollIntoView.js";

let dom;
let document;
let calls;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  document = dom.window.document;
  globalThis.document = document;
  globalThis.window = dom.window;

  // jsdom has no layout engine: stub scrollIntoView and record the calls.
  calls = [];
  dom.window.Element.prototype.scrollIntoView = function (opts) {
    calls.push({ el: this, opts });
  };
});

afterEach(() => {
  dom?.window.close();
  dom = null;
  document = null;
  calls = [];
});

function buildList(count = 40, selectedIndex = 30) {
  const list = document.createElement("div");
  list.className = "pill-list scrollable";
  for (let i = 0; i < count; i++) {
    const b = document.createElement("button");
    b.className = "pill";
    b.dataset.version = `1.21.${i}`;
    b.setAttribute("data-selected", i === selectedIndex ? "true" : "false");
    b.className += i === selectedIndex ? " selected" : "";
    list.appendChild(b);
  }
  document.body.appendChild(list);
  return list;
}

test("findSelected locates the selected entry", () => {
  const list = buildList(10, 7);
  const found = findSelected(list);
  expect(found).toBeTruthy();
  expect(found.dataset.version).toBe("1.21.7");
});

test("findSelected returns null when nothing is selected", () => {
  const list = buildList(5, -1);
  expect(findSelected(list)).toBeNull();
});

test("findSelected returns null for a missing container", () => {
  expect(findSelected(null)).toBeNull();
  expect(findSelected(undefined)).toBeNull();
});

test("revealInList calls scrollIntoView with nearest block by default", () => {
  const list = buildList(10, 3);
  const target = findSelected(list);
  const ok = revealInList(list, target);
  expect(ok).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0].opts.block).toBe("nearest");
  expect(calls[0].opts.inline).toBe("nearest");
});

test("revealInList honours a custom behavior", () => {
  const list = buildList(10, 3);
  const ok = revealInList(list, findSelected(list), { behavior: "smooth", block: "center" });
  expect(ok).toBe(true);
  expect(calls[0].opts.behavior).toBe("smooth");
  expect(calls[0].opts.block).toBe("center");
});

test("revealInList is a no-op without a target", () => {
  const list = buildList(5, 0);
  expect(revealInList(list, null)).toBe(false);
  expect(revealInList(null, null)).toBe(false);
  expect(calls.length).toBe(0);
});

test("scrollToSelected scrolls the selected entry", () => {
  const list = buildList(40, 35);
  expect(scrollToSelected(list)).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0].el.dataset.version).toBe("1.21.35");
});

test("scrollToSelected does nothing when the list has no selection", () => {
  const list = buildList(5, -1);
  expect(scrollToSelected(list)).toBe(false);
  expect(calls.length).toBe(0);
});

test("scrollToId scrolls the matching entry (Latest stable / experimental flow)", () => {
  const list = buildList(40, 0);
  expect(scrollToId(list, "1.21.39")).toBe(true);
  expect(calls[0].el.dataset.version).toBe("1.21.39");
});

test("scrollToId escapes ids so lookups cannot break", () => {
  const list = document.createElement("div");
  const b = document.createElement("button");
  b.dataset.version = 'weird"id';
  list.appendChild(b);
  document.body.appendChild(list);
  expect(scrollToId(list, 'weird"id')).toBe(true);
});

test("scrollToId ignores unknown ids", () => {
  const list = buildList(5, 0);
  expect(scrollToId(list, "does-not-exist")).toBe(false);
});

test("isVisibleInList is false without layout (jsdom)", () => {
  const list = buildList(5, 0);
  // jsdom returns zero-size rects, so the helper must not claim visibility it cannot prove.
  expect(isVisibleInList(list, findSelected(list))).toBe(false);
});

test("component markup marks the selected entry so it can be scrolled to", async () => {
  const { readFileSync } = await import("fs");
  const src = readFileSync(new URL("../src/lib/components/CreateServer.svelte", import.meta.url), "utf8");
  expect(src).toContain('data-selected={selectedVersion === id ? "true" : "false"}');
  expect(src).toContain('data-selected={selectedLoaderBuild === bid ? "true" : "false"}');
  expect(src).toContain("scrollToId(list, id)");
  expect(src).toContain("bind:this={versionListEl}");
  expect(src).toContain("bind:this={buildListEl}");
});

test("scrollToId skips scrolling when the target is already visible", () => {
  const list = buildList(5, 1);
  const target = findSelected(list);
  // Pretend the element is fully inside the viewport (jsdom has no layout).
  const rect = { top: 0, bottom: 10, height: 10, left: 0, right: 10, width: 10 };
  list.getBoundingClientRect = () => ({ ...rect, height: 100 });
  target.getBoundingClientRect = () => rect;
  calls.length = 0;
  expect(scrollToId(list, target.dataset.version)).toBe(false);
  expect(calls.length).toBe(0);
});

test("scrollToId scrolls when the target is out of view", () => {
  const list = buildList(5, 4);
  const target = findSelected(list);
  list.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 10, width: 10 });
  target.getBoundingClientRect = () => ({ top: 200, bottom: 220, height: 20, left: 0, right: 10, width: 10 });
  calls.length = 0;
  expect(scrollToId(list, target.dataset.version)).toBe(true);
  expect(calls.length).toBe(1);
});
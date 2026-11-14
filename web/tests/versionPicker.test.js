import { describe, it, expect } from "bun:test";
import {
  versionId, isStable, versionChannel, filterByChannel, pickLatest,
  pickLatestBuild, containsVersion, reconcileSelection,
} from "../src/lib/versionPicker.js";

const MC = [
  { id: "26.3", stable: true, channel: "stable" },
  { id: "26.2", stable: true, channel: "stable" },
  { id: "26.3-rc-3", stable: false, channel: "experimental" },
  { id: "26.4-snapshot-8", stable: false, channel: "experimental" },
];

const BUILDS = [
  { id: "0.19.0", stable: true, channel: "stable" },
  { id: "0.20.1", stable: true, channel: "stable" },
  { id: "0.21.0-exp", stable: false, channel: "experimental" },
];

describe("version picker helpers", () => {
  it("reads ids from strings and objects", () => {
    expect(versionId("1.21.1")).toBe("1.21.1");
    expect(versionId({ id: "1.21.1" })).toBe("1.21.1");
    expect(versionId(null)).toBe("");
  });

  it("classifies stable vs experimental", () => {
    expect(isStable("1.21.1")).toBe(true);
    expect(isStable(MC[0])).toBe(true);
    expect(isStable(MC[2])).toBe(false);
    expect(versionChannel(MC[2])).toBe("experimental");
    expect(versionChannel(MC[0])).toBe("stable");
  });

  it("filters by channel", () => {
    expect(filterByChannel(MC, "all").map(versionId)).toEqual(["26.3", "26.2", "26.3-rc-3", "26.4-snapshot-8"]);
    expect(filterByChannel(MC, "stable").map(versionId)).toEqual(["26.3", "26.2"]);
    expect(filterByChannel(MC, "experimental").map(versionId)).toEqual(["26.3-rc-3", "26.4-snapshot-8"]);
  });

  it("filters by channel and search term together", () => {
    expect(filterByChannel(MC, "experimental", "rc").map(versionId)).toEqual(["26.3-rc-3"]);
    expect(filterByChannel(MC, "stable", "snapshot").map(versionId)).toEqual([]);
  });

  it("prefers the server latest metadata", () => {
    const meta = { latest: { stable: "26.3", experimental: "26.4-snapshot-8" } };
    expect(pickLatest(MC, meta, "stable")).toBe("26.3");
    expect(pickLatest(MC, meta, "experimental")).toBe("26.4-snapshot-8");
  });

  it("falls back to scanning the list when metadata is missing", () => {
    expect(pickLatest(MC, { latest: {} }, "stable")).toBe("26.3");
    expect(pickLatest(MC, { latest: {} }, "experimental")).toBe("26.3-rc-3");
    expect(pickLatest(MC, null, "stable")).toBe("26.3");
  });

  it("returns null for an empty list", () => {
    expect(pickLatest([], { latest: {} }, "stable")).toBeNull();
  });

  it("picks loader builds with stable/experimental preference", () => {
    expect(pickLatestBuild(BUILDS, { latest: { stable: "0.20.1", experimental: "0.21.0-exp" } }, "stable")).toBe("0.20.1");
    expect(pickLatestBuild(BUILDS, { latest: { stable: "0.20.1", experimental: "0.21.0-exp" } }, "experimental")).toBe("0.21.0-exp");
  });

  it("falls back to default then first build", () => {
    expect(pickLatestBuild(BUILDS, { latest: { default: "0.20.1" } }, "stable")).toBe("0.20.1");
    expect(pickLatestBuild(BUILDS, { latest: {} }, "experimental")).toBe("0.21.0-exp");
  });

  it("keeps a valid selection when the filter changes", () => {
    expect(reconcileSelection(MC, "experimental", "26.3-rc-3")).toBe("26.3-rc-3");
  });

  it("moves the selection to the first visible entry when filtered out", () => {
    // "Latest experimental" resets to All and selects 26.4-snapshot-8.
    expect(reconcileSelection(MC, "all", "26.4-snapshot-8")).toBe("26.4-snapshot-8");
    // Switching to Stable must not leave an experimental build selected.
    const next = reconcileSelection(MC, "stable", "26.4-snapshot-8");
    expect(next).toBe("26.3");
    expect(filterByChannel(MC, "stable").some((v) => versionId(v) === next)).toBe(true);
  });

  it("detects presence of a version", () => {
    expect(containsVersion(MC, "26.3")).toBe(true);
    expect(containsVersion(MC, "1.0.0")).toBe(false);
    expect(containsVersion([], "1.0.0")).toBe(false);
    expect(containsVersion(MC, "")).toBe(false);
  });
});

describe("latest flow end to end (App logic)", () => {
  // Mirrors App.handlePickLatest: reset the filter to "All", then select the requested build.
  function pickLatestFlow(list, meta, want) {
    const channel = "all";
    const versions = filterByChannel(list, channel);
    const pick = pickLatest(list, meta, want);
    return { channel, versions, pick, visible: versions.some((v) => versionId(v) === pick) };
  }

  it("experimental: filter becomes All and the experimental build is selected", () => {
    const meta = { latest: { stable: "26.3", experimental: "26.4-snapshot-8" } };
    const out = pickLatestFlow(MC, meta, "experimental");
    expect(out.channel).toBe("all");
    expect(out.pick).toBe("26.4-snapshot-8");
    expect(out.visible).toBe(true);
    expect(out.versions.map(versionId)).toContain("26.4-snapshot-8");
  });

  it("stable: filter becomes All and the stable build is selected", () => {
    const meta = { latest: { stable: "26.3", experimental: "26.4-snapshot-8" } };
    const out = pickLatestFlow(MC, meta, "stable");
    expect(out.channel).toBe("all");
    expect(out.pick).toBe("26.3");
    expect(out.visible).toBe(true);
  });

  it("works when the loader exposes no latest metadata", () => {
    const out = pickLatestFlow(MC, { latest: {} }, "experimental");
    expect(out.pick).toBe("26.3-rc-3");
    expect(out.visible).toBe(true);
  });

  it("reports nothing selected when the list is empty", () => {
    const out = pickLatestFlow([], { latest: {} }, "stable");
    expect(out.pick).toBeNull();
    expect(out.visible).toBe(false);
  });
});
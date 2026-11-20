import { describe, test, expect } from "bun:test";
import { createTtlCache } from "../src/core/cache.js";

describe("createTtlCache", () => {
  test("stores and retrieves values", () => {
    const cache = createTtlCache({ name: "test" });
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  test("returns undefined for missing keys", () => {
    const cache = createTtlCache({ name: "test" });
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts expired entries", async () => {
    const cache = createTtlCache({ name: "test", ttlMs: 50 });
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
    await new Promise(r => setTimeout(r, 60));
    expect(cache.get("key1")).toBeUndefined();
  });

  test("invalidates a specific key", () => {
    const cache = createTtlCache({ name: "test" });
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.invalidate("key1");
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBe("value2");
  });

  test("invalidates all keys", () => {
    const cache = createTtlCache({ name: "test" });
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.invalidate();
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBeUndefined();
  });

  test("respects maxEntries limit", () => {
    const cache = createTtlCache({ name: "test", maxEntries: 2 });
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.set("key3", "value3"); // should evict key1
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBe("value2");
    expect(cache.get("key3")).toBe("value3");
  });

  test("wrap dedupes in-flight calls", async () => {
    const cache = createTtlCache({ name: "test" });
    let callCount = 0;
    const loader = async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 50));
      return "loaded";
    };

    // Fire two concurrent requests
    const [a, b] = await Promise.all([
      cache.wrap("key1", loader),
      cache.wrap("key1", loader),
    ]);
    expect(a).toBe("loaded");
    expect(b).toBe("loaded");
    expect(callCount).toBe(1); // loader called only once
  });

  test("deleteMatching removes keys by prefix", () => {
    const cache = createTtlCache({ name: "test" });
    cache.set("loader:v1", "a");
    cache.set("loader:v2", "b");
    cache.set("other:v1", "c");
    cache.deleteMatching("loader:");
    expect(cache.get("loader:v1")).toBeUndefined();
    expect(cache.get("loader:v2")).toBeUndefined();
    expect(cache.get("other:v1")).toBe("c");
  });
});

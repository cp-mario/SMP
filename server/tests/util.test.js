import { describe, test, expect } from "bun:test";
import { parseMemoryMb, formatMemoryMb, clampMemoryMb, normalizeJvmArgs, parseJsonField, parseExec, flagValue, formatBytes } from "../src/core/util.js";

describe("parseMemoryMb", () => {
  test("parses MB suffix", () => {
    expect(parseMemoryMb("512M")).toBe(512);
    expect(parseMemoryMb("1024MB")).toBe(1024);
  });

  test("parses GB suffix", () => {
    expect(parseMemoryMb("2G")).toBe(2048);
    expect(parseMemoryMb("4GB")).toBe(4096);
  });

  test("parses plain number as MB", () => {
    expect(parseMemoryMb("256")).toBe(256);
  });

  test("returns fallback for invalid input", () => {
    expect(parseMemoryMb("", 1024)).toBe(1024);
    expect(parseMemoryMb(null, 512)).toBe(512);
    expect(parseMemoryMb("abc", 2048)).toBe(2048);
  });
});

describe("formatMemoryMb", () => {
  test("formats GB when divisible by 1024", () => {
    expect(formatMemoryMb(2048)).toBe("2G");
    expect(formatMemoryMb(4096)).toBe("4G");
  });

  test("formats MB when not divisible by 1024", () => {
    expect(formatMemoryMb(512)).toBe("512M");
    expect(formatMemoryMb(1536)).toBe("1536M");
  });

  test("clamps to minimum 256", () => {
    expect(formatMemoryMb(64)).toBe("256M");
  });
});

describe("normalizeJvmArgs", () => {
  test("removes newlines", () => {
    expect(normalizeJvmArgs("-Xmx2G\n-Xms1G")).toBe("-Xmx2G -Xms1G");
  });

  test("trims whitespace", () => {
    expect(normalizeJvmArgs("  -Xmx2G  ")).toBe("-Xmx2G");
  });

  test("handles null", () => {
    expect(normalizeJvmArgs(null)).toBe("");
  });
});

describe("parseJsonField", () => {
  test("parses valid JSON string", () => {
    expect(parseJsonField('["a","b"]')).toEqual(["a", "b"]);
  });

  test("returns fallback for invalid JSON", () => {
    expect(parseJsonField("not json", [])).toEqual([]);
  });

  test("returns fallback for null", () => {
    expect(parseJsonField(null, [])).toEqual([]);
  });

  test("returns value if already parsed", () => {
    const arr = [1, 2];
    expect(parseJsonField(arr)).toBe(arr);
  });
});

describe("parseExec", () => {
  test("parses valid JSON object", () => {
    expect(parseExec('{"command":"java","args":["-Xmx2G"]}')).toEqual({ command: "java", args: ["-Xmx2G"] });
  });

  test("returns null for array", () => {
    expect(parseExec('[1,2]')).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseExec("not json")).toBeNull();
  });
});

describe("flagValue", () => {
  test("converts truthy values to 1", () => {
    expect(flagValue(true)).toBe(1);
    expect(flagValue(1)).toBe(1);
    expect(flagValue("1")).toBe(1);
    expect(flagValue("true")).toBe(1);
  });

  test("converts falsy values to 0", () => {
    expect(flagValue(false)).toBe(0);
    expect(flagValue(0)).toBe(0);
    expect(flagValue("")).toBe(0);
  });
});

describe("formatBytes", () => {
  test("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  test("formats KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test("formats MB", () => {
    expect(formatBytes(1572864)).toBe("1.5 MB");
  });

  test("formats GB", () => {
    expect(formatBytes(1610612736)).toBe("1.50 GB");
  });
});

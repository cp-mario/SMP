import { test, expect } from "bun:test";
import { classifyLogLevel } from "../src/lib/logLevel.js";

test("classifies Minecraft INFO lines", () => {
  expect(classifyLogLevel("[12:00:00] [Server thread/INFO]: Preparing spawn area"))
    .toBe("info");
});

test("classifies Minecraft WARN lines", () => {
  expect(classifyLogLevel("[12:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded?"))
    .toBe("warn");
});

test("classifies Minecraft ERROR/FATAL lines", () => {
  expect(classifyLogLevel("[12:00:00] [Server thread/ERROR]: Failed to start")).toBe("error");
  expect(classifyLogLevel("[12:00:00] [Server thread/FATAL]: Boom")).toBe("error");
});

test("classifies the server-ready line as success", () => {
  expect(classifyLogLevel('[12:00:00] [Server thread/INFO]: Done (1.234s)! For help, type "help"'))
    .toBe("success");
});

test("classifies panel process lifecycle messages", () => {
  expect(classifyLogLevel("Error: Port 25565 is already in use.")).toBe("error");
  expect(classifyLogLevel("Process error: spawn failed")).toBe("error");
  expect(classifyLogLevel("Process exited (code=0)")).toBe("success");
  expect(classifyLogLevel("Process exited (code=1)")).toBe("error");
  expect(classifyLogLevel("Starting Paper (paper 1.21) pid=1234")).toBe("info");
  expect(classifyLogLevel("Exec: java -jar server.jar nogui")).toBe("debug");
  expect(classifyLogLevel("[SCHEDULE] say hi")).toBe("info");
  expect(classifyLogLevel("[SCHEDULE ERROR] boom")).toBe("error");
});

test("classifies Java stack traces as errors", () => {
  expect(classifyLogLevel("java.lang.NullPointerException: bad")).toBe("error");
  expect(classifyLogLevel("    at net.minecraft.server.MinecraftServer.run(MinecraftServer.java:1)")).toBe("error");
});

test("returns null for unclassified lines", () => {
  expect(classifyLogLevel("hello world")).toBeNull();
  expect(classifyLogLevel("")).toBeNull();
  expect(classifyLogLevel(null)).toBeNull();
});

test("ignores the stored ISO timestamp prefix", () => {
  expect(classifyLogLevel("[2026-11-12T10:24:25.000Z] Error: Port 25565 is already in use.")).toBe("error");
  expect(classifyLogLevel("[2026-11-12T10:24:25.000Z] Exec: java -jar server.jar")).toBe("debug");
  expect(classifyLogLevel("[2026-11-12T10:24:25.000Z] Starting Paper (paper) pid=1")).toBe("info");
  expect(classifyLogLevel("[2026-11-12T10:24:25.000Z] [Server thread/WARN]: slow")).toBe("warn");
});
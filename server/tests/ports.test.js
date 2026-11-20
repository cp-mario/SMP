import { describe, test, expect } from "bun:test";
import { portProfile, isPortNumber, PortConflictError } from "../src/runtime/ports.js";

describe("portProfile", () => {
  test("returns Java roles for vanilla", () => {
    const roles = portProfile("vanilla");
    expect(roles.length).toBeGreaterThan(0);
    const game = roles.find(r => r.role === "game");
    expect(game).toBeDefined();
    expect(game.protocol).toBe("tcp");
    expect(game.defaultPort).toBe(25565);
  });

  test("returns Bedrock roles for endstone", () => {
    const roles = portProfile("endstone");
    const game = roles.find(r => r.role === "game");
    expect(game.protocol).toBe("udp");
    expect(game.defaultPort).toBe(19132);
  });

  test("returns Pumpkin roles for pumpkinmc", () => {
    const roles = portProfile("pumpkinmc");
    expect(roles.length).toBe(2);
    const java = roles.find(r => r.role === "game");
    const bedrock = roles.find(r => r.role === "bedrock");
    expect(java.protocol).toBe("tcp");
    expect(bedrock.protocol).toBe("udp");
  });

  test("returns Velocity roles for velocity", () => {
    const roles = portProfile("velocity");
    const game = roles.find(r => r.role === "game");
    expect(game.label).toBe("Proxy");
  });
});

describe("isPortNumber", () => {
  test("accepts valid port numbers", () => {
    expect(isPortNumber(80)).toBe(true);
    expect(isPortNumber(25565)).toBe(true);
    expect(isPortNumber(65535)).toBe(true);
    expect(isPortNumber(1)).toBe(true);
  });

  test("rejects invalid port numbers", () => {
    expect(isPortNumber(0)).toBe(false);
    expect(isPortNumber(65536)).toBe(false);
    expect(isPortNumber(-1)).toBe(false);
    expect(isPortNumber("abc")).toBe(false);
    expect(isPortNumber(null)).toBe(false);
  });
});

describe("PortConflictError", () => {
  test("sets correct name and status", () => {
    const err = new PortConflictError("Port taken", []);
    expect(err.name).toBe("PortConflictError");
    expect(err.status).toBe(409);
    expect(err.message).toBe("Port taken");
  });

  test("stores conflicts array", () => {
    const conflicts = [{ role: "game", port: 25565 }];
    const err = new PortConflictError("Port taken", conflicts);
    expect(err.conflicts).toEqual(conflicts);
  });
});

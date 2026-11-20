import { describe, test, expect, beforeEach } from "bun:test";
import { db, query, queryOne, run, resetDatabase, initDb, genId } from "../src/core/db.js";

describe("Server CRUD integration", () => {
  beforeEach(() => {
    resetDatabase();
  });

  test("creates and reads a server", () => {
    const id = genId();
    run("INSERT INTO servers(id,name,dir,loader,jar,memory_max,memory_min,port,motd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id, "Test Server", "/tmp/test", "vanilla", "server.jar", "2G", "512M", 25565, "A SMP Server", Math.floor(Date.now() / 1000));

    const row = queryOne("SELECT id, name, loader, port FROM servers WHERE id = ?", id);
    expect(row).toBeDefined();
    expect(row.name).toBe("Test Server");
    expect(row.loader).toBe("vanilla");
    expect(row.port).toBe(25565);
  });

  test("updates a server", () => {
    const id = genId();
    run("INSERT INTO servers(id,name,dir,loader,jar,memory_max,memory_min,port,motd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id, "Old Name", "/tmp/test", "vanilla", "server.jar", "2G", "512M", 25565, "A SMP Server", Math.floor(Date.now() / 1000));

    run("UPDATE servers SET name = ?, memory_max = ? WHERE id = ?", "New Name", "4G", id);

    const row = queryOne("SELECT name, memory_max FROM servers WHERE id = ?", id);
    expect(row.name).toBe("New Name");
    expect(row.memory_max).toBe("4G");
  });

  test("deletes a server and cascades to mods and backups", () => {
    const serverId = genId();
    const modId = genId();
    const backupId = genId();

    run("INSERT INTO servers(id,name,dir,loader,jar,memory_max,memory_min,port,motd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      serverId, "Test Server", "/tmp/test", "vanilla", "server.jar", "2G", "512M", 25565, "A SMP Server", Math.floor(Date.now() / 1000));

    run("INSERT INTO mods(id,server_id,source,version,filename,installed_at) VALUES(?,?,?,?,?,?)",
      modId, serverId, "curseforge", "1.0", "mod.jar", Math.floor(Date.now() / 1000));

    run("INSERT INTO backups(id,server_id,path,size,created_at) VALUES(?,?,?,?,?)",
      backupId, serverId, "/tmp/backup.zip", 1024, Math.floor(Date.now() / 1000));

    // Verify data exists
    expect(queryOne("SELECT id FROM servers WHERE id = ?", serverId)).toBeDefined();
    expect(queryOne("SELECT id FROM mods WHERE id = ?", modId)).toBeDefined();
    expect(queryOne("SELECT id FROM backups WHERE id = ?", backupId)).toBeDefined();

    // Delete server — ON DELETE CASCADE should remove mods and backups
    run("DELETE FROM servers WHERE id = ?", serverId);

    expect(queryOne("SELECT id FROM servers WHERE id = ?", serverId)).toBeNull();
    expect(queryOne("SELECT id FROM mods WHERE id = ?", modId)).toBeNull();
    expect(queryOne("SELECT id FROM backups WHERE id = ?", backupId)).toBeNull();
  });

  test("settings CRUD works correctly", () => {
    run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      "test_key", "test_value");

    const row = queryOne("SELECT value FROM settings WHERE key = ?", "test_key");
    expect(row.value).toBe("test_value");

    run("DELETE FROM settings WHERE key = ?", "test_key");
    expect(queryOne("SELECT value FROM settings WHERE key = ?", "test_key")).toBeNull();
  });

  test("lists servers ordered by name", () => {
    const id1 = genId();
    const id2 = genId();
    const id3 = genId();

    run("INSERT INTO servers(id,name,dir,loader,jar,memory_max,memory_min,port,motd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id1, "Charlie", "/tmp/c", "vanilla", "server.jar", "2G", "512M", 25565, "A SMP Server", Math.floor(Date.now() / 1000));
    run("INSERT INTO servers(id,name,dir,loader,jar,memory_max,memory_min,port,motd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id2, "Alice", "/tmp/a", "vanilla", "server.jar", "2G", "512M", 25565, "A SMP Server", Math.floor(Date.now() / 1000));
    run("INSERT INTO servers(id,name,dir,loader,jar,memory_max,memory_min,port,motd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id3, "Bob", "/tmp/b", "vanilla", "server.jar", "2G", "512M", 25565, "A SMP Server", Math.floor(Date.now() / 1000));

    const rows = query("SELECT name FROM servers ORDER BY name ASC");
    expect(rows.map(r => r.name)).toEqual(["Alice", "Bob", "Charlie"]);
  });
});

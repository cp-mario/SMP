import { BaseLoader } from "./BaseLoader.js";

/**
 * Custom loader: user supplies `server.jar` (or a configured executable) and run behavior.
 * No EULA enforcement by the panel, no managed download.
 */
export class CustomLoader extends BaseLoader {
  static id = "custom";
  static name = "Custom";
  static type = "custom";
  static java = false;
  static eula = false;
  static custom = true;

  async getVersions() {
    return [{ id: "custom", stable: true, channel: "stable" }];
  }

  async resolveDownload(version) {
    return {
      manual: true,
      custom: true,
      fileName: "server.jar",
      exec: { type: "custom", command: null, args: [], jar: "server.jar", manual: true },
    };
  }

  getExecution({ jar = "server.jar", row = null } = {}) {
    // Default: try Java if a jar is present; callers/UI can extend with explicit command config.
    const defaultArgs = [`-Xmx${row?.memory_max || "2G"}`, `-Xms${row?.memory_min || "512M"}`, "-jar", jar, "nogui"];
    const extra = row?.jvm_args ? String(row.jvm_args).split(/\s+/).filter(Boolean) : [];
    return {
      type: "custom",
      command: "java",
      args: extra.length ? [...extra, "-jar", jar, "nogui"] : defaultArgs,
      jar,
      custom: true,
    };
  }
}

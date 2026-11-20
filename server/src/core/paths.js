import { join } from "path";
import { homedir } from "os";

/**
 * Central path configuration.
 *
 * `DATA_DIR` was duplicated in both `config.js` and `db.js`, causing a circular
 * dependency and the risk of drift. Every module that needs a path constant
 * imports it from here instead.
 */

const DATA_DIR = process.env.SMP_DATA_DIR || join(homedir(), ".smp");

export { DATA_DIR };

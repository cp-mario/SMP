/**
 * Shared constants used by both the launcher (start.js) and the server core.
 * Keeping them in one file prevents silent mismatches when a value changes.
 */

/** Exit code the panel uses to signal the launcher to restart after an update. */
export const UPDATE_RESTART_EXIT = 86;

/** Maximum number of log lines kept in memory per server. */
export const LOG_LINES_MAX = 4000;

/** Maximum log file size before rotation (10 MB). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Log flush interval to disk (ms). */
export const LOG_FLUSH_MS = 250;

/** SSE log event coalescing interval (ms). */
export const LOG_EVENT_FLUSH_MS = 32;

/** Default server port. */
export const DEFAULT_SERVER_PORT = 3001;

/** Minimum port number. */
export const MIN_PORT = 1;

/** Maximum port number. */
export const MAX_PORT = 65535;

/** First unprivileged port. */
export const FIRST_UNPRIVILEGED_PORT = 1024;

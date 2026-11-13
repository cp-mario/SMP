// Classify a console/log line into a severity level so the console can color it.
// Returns one of: "error" | "warn" | "success" | "info" | "debug" | null.
// null means "no recognizable level" (left at the default console color).

const ERROR_RE = /\b(?:ERROR|FATAL|SEVERE|CRITICAL)\b/;
const WARN_RE = /\b(?:WARN|WARNING)\b/;
const INFO_RE = /\b(?:INFO|CONFIG|NOTICE)\b/;
const DEBUG_RE = /\b(?:DEBUG|FINER|FINEST|TRACE)\b/;

export function classifyLogLevel(text) {
  // Server lines are stored as "[2026-...Z] <raw>"; drop that prefix so the
  // leading-token checks below work on the original message.
  const s = String(text ?? "").replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\]\s*/, "");
  if (!s) return null;

  // Panel-generated process lifecycle messages.
  const exit = s.match(/Process exited \(code=(-?\d+)/);
  if (exit) return Number(exit[1]) === 0 ? "success" : "error";
  if (/^Error(?:\s*:|\b)/.test(s)) return "error";
  if (/\bProcess error\b|\bStream error\b/.test(s)) return "error";
  if (/\[SCHEDULE ERROR\]/.test(s)) return "error";
  if (/\[SCHEDULE\]/.test(s)) return "info";
  if (/^Exec:/.test(s)) return "debug";
  if (/^Starting /.test(s)) return "info";

  // Minecraft / log4j level tokens: "[Server thread/ERROR]:", "[WARN]:", "/FATAL]".
  if (ERROR_RE.test(s)) return "error";
  if (WARN_RE.test(s)) return "warn";
  if (DEBUG_RE.test(s)) return "debug";

  // Java stack traces and exception class names (e.g. NullPointerException).
  if (/^\s*at [\w.$]+\(/.test(s) || /^\s*Caused by:/.test(s) || /\b[\w.$]*(?:Exception|Throwable)\b/.test(s)) return "error";

  // Success markers such as 'Done (1.234s)! For help, type "help"'.
  if (/\bDone \(/.test(s)) return "success";

  if (INFO_RE.test(s)) return "info";

  return null;
}
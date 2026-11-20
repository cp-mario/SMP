import { query } from "../core/db.js";
import { runningServers } from "./process.js";
import { logLine } from "../core/logs.js";

function parseCron(cronStr) {
  const parts = String(cronStr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const field = /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)+)$/;
  if (![minute, hour, dayOfMonth, month, dayOfWeek].every((f) => field.test(f))) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function matchesCron(cron, date) {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay(); // 0 = Sunday

  function match(field, value) {
    if (field === "*") return true;
    if (field.includes(",")) return field.split(",").map(Number).includes(value);
    if (field.includes("/")) {
      const [range, stepRaw] = field.split("/");
      const step = parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step <= 0) return false;
      const [fromRaw, toRaw] = range.split("-");
      const from = fromRaw === "*" ? 0 : Number(fromRaw);
      const to = toRaw == null ? value : Number(toRaw);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      if (fromRaw === "*") return value % step === 0;
      return value >= from && value <= to && (value - from) % step === 0;
    }
    if (field.includes("-")) {
      const [from, to] = field.split("-").map(Number);
      return Number.isFinite(from) && Number.isFinite(to) && value >= from && value <= to;
    }
    const n = parseInt(field, 10);
    return Number.isFinite(n) && n === value;
  }

  return match(cron.minute, minute) &&
         match(cron.hour, hour) &&
         match(cron.dayOfMonth, dayOfMonth) &&
         match(cron.month, month) &&
         match(cron.dayOfWeek, dayOfWeek);
}

async function runSchedules() {
  const now = new Date();
  let schedules = [];
  try { schedules = query("SELECT * FROM schedules WHERE enabled = 1"); } catch { return; }

  for (const sched of schedules) {
    const cron = parseCron(sched.cron);
    if (!cron || !matchesCron(cron, now)) continue;
    const r = runningServers.get(sched.server_id);
    const proc = r?.proc;
    if (!proc || proc.exitCode != null || !proc.stdin?.writable) continue;
    try {
      proc.stdin.write(sched.command + "\n");
      logLine(sched.server_id, `[SCHEDULE] ${sched.command}`);
    } catch (e) {
      logLine(sched.server_id, `[SCHEDULE ERROR] ${e.message}`);
    }
  }
}

export function startScheduleRunner() {
  setInterval(runSchedules, 60 * 1000);
  runSchedules();
}

export { parseCron };

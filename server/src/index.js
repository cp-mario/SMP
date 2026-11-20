import app from "./app.js";
import { startScheduleRunner } from "./instances/schedules.js";
import { autoStartSftp } from "./runtime/sftp.js";

startScheduleRunner();
try { autoStartSftp(); } catch {}

const __SMP_PORT = Number(process.env.SMP_PORT || process.env.PORT || 3001);
console.log(`SMP server running at http://localhost:${app.server?.port ?? __SMP_PORT}`);

export default app;
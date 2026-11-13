/**
 * Shared class-name helper for the ui/* primitives.
 * Accepts strings, arrays, or `{ class: boolean }` maps and returns a stable string.
 */
export function cx(...parts) {
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string" || typeof part === "number") {
      out.push(String(part));
      continue;
    }
    if (Array.isArray(part)) {
      const nested = cx(...part);
      if (nested) out.push(nested);
      continue;
    }
    if (typeof part === "object") {
      for (const [key, value] of Object.entries(part)) if (value) out.push(key);
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}
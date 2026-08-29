/**
 * Timestamp helpers for persisted memory records.
 *
 * Historical memory rows use a mix of Unix seconds and ISO timestamps. Keep the
 * parsing rules in one place so retention, prompt ordering, and vector metadata
 * do not each invent slightly different behavior.
 */

export function parseMemoryTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
      }
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function memoryTimestampSeconds(value: unknown, fallbackSeconds = Math.floor(Date.now() / 1000)): number {
  const ms = parseMemoryTimestampMs(value);
  return ms === null ? fallbackSeconds : Math.floor(ms / 1000);
}

export function memorySortTimeMs(record: { created_at?: unknown; date?: unknown }): number {
  return parseMemoryTimestampMs(record.created_at) ??
    parseMemoryTimestampMs(record.date) ??
    0;
}

export function memoryMonth(record: { created_at?: unknown; date?: unknown }): string {
  if (typeof record.date === "string" && /^\d{4}-\d{2}/.test(record.date)) {
    return record.date.slice(0, 7);
  }
  const ms = parseMemoryTimestampMs(record.created_at);
  return ms === null ? "unknown" : new Date(ms).toISOString().slice(0, 7);
}

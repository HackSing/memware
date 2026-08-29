import { createHash } from "node:crypto";

export function shaHex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${shaHex(parts.join("\0")).slice(0, 32)}`;
}

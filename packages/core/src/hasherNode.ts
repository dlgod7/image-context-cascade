import { createHash } from "node:crypto";

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

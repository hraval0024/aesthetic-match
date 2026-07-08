import { createHash } from "node:crypto";

export function hashImage(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

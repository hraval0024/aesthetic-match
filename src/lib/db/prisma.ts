import { PrismaClient } from "@/generated/prisma";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import fs from "node:fs";
import path from "node:path";

// Global singleton so Next.js dev-mode hot reload doesn't open a new
// connection per file change. Catalog data is read-mostly at runtime
// (see prisma/schema.prisma comments) -- this client is only ever
// pointed at the bundled snapshot db in production.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// One-time seed: if nothing exists yet at `targetPath`, copy the read-only
// bundled snapshot (prisma/prod.db, built by scripts/ingest-catalog.ts +
// scripts/tag-catalog.ts) there. Idempotent and safe to call on every boot --
// once the target exists, this is a no-op forever, so a persistent volume
// (Railway, etc.) only gets seeded on its very first deploy and every write
// after that (e.g. TagCache upserts from live requests) survives restarts
// and redeploys untouched.
function seedIfMissing(targetPath: string): void {
  const bundled = path.join(process.cwd(), "prisma", "prod.db");
  try {
    if (!fs.existsSync(targetPath) && fs.existsSync(bundled)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(bundled, targetPath);
    }
  } catch {
    // Target directory unwritable -- fall through and let Prisma's own
    // connection error surface the real problem; nothing more to do here.
  }
}

// Local dev sets DATABASE_URL explicitly (file:./prisma/dev.db, writable,
// gitignored) and always wins here -- dev.db already exists in a normal
// checkout, so seedIfMissing is a no-op there.
//
// In production, DATABASE_URL should point at a path on persistent storage
// (a Railway Volume, for example: file:/data/prod.db). On first boot
// against a fresh, empty volume this seeds it once from the bundled
// snapshot; from then on the volume file is the durable source of truth.
// This replaced an earlier /tmp-per-cold-start approach built for
// serverless hosts with a read-only deployment filesystem (e.g. Vercel) --
// that copy had to re-run on every cold start since /tmp itself doesn't
// persist, which meant TagCache writes from live requests never actually
// survived past the instance that made them. A mounted volume fixes that
// for good: seed once, persist forever. The /tmp fallback below is kept
// only for a host with no DATABASE_URL and no volume at all.
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    if (url.startsWith("file:")) seedIfMissing(url.slice("file:".length));
    return url;
  }

  const writable = path.join("/tmp", "prod.db");
  seedIfMissing(writable);
  if (fs.existsSync(writable)) return `file:${writable}`;
  return `file:${path.join(process.cwd(), "prisma", "prod.db")}`;
}

const adapter = new PrismaLibSql({ url: resolveDatabaseUrl() });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

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

// Local dev sets DATABASE_URL explicitly (file:./prisma/dev.db, writable,
// gitignored) and always wins here. With no override -- i.e. production --
// the deployment bundle ships prisma/prod.db (built by
// scripts/ingest-catalog.ts + scripts/tag-catalog.ts) as a read-only file,
// but TagCache still needs to be writable: a user's uploaded photo that
// isn't already cached gets tagged and upserted at request time. Most
// serverless hosts (e.g. Vercel) make the deployment filesystem read-only
// everywhere except /tmp, so we copy the bundled snapshot into /tmp once
// per cold start and open that instead. Consequence: TagCache doesn't
// persist across cold starts or share across concurrent instances in
// production -- disclosed in INSTRUCTIONS.md as a known limitation, not a
// correctness issue (a cache miss just re-tags via Claude and produces an
// identical result, just without the latency win).
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const bundled = path.join(process.cwd(), "prisma", "prod.db");
  const writable = path.join("/tmp", "prod.db");
  try {
    if (!fs.existsSync(writable) && fs.existsSync(bundled)) {
      fs.copyFileSync(bundled, writable);
    }
    if (fs.existsSync(writable)) return `file:${writable}`;
  } catch {
    // /tmp unavailable -- fall through to the bundled path directly. Reads
    // still work; TagCache writes will fail (caught, non-fatal -- see
    // api/profile/route.ts).
  }
  return `file:${bundled}`;
}

const adapter = new PrismaLibSql({ url: resolveDatabaseUrl() });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

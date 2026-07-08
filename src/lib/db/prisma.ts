import { PrismaClient } from "@/generated/prisma";
import { PrismaLibSql } from "@prisma/adapter-libsql";

// Global singleton so Next.js dev-mode hot reload doesn't open a new
// connection per file change. Catalog data is read-mostly at runtime
// (see prisma/schema.prisma comments) -- this client is only ever
// pointed at the bundled snapshot db in production.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaLibSql({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

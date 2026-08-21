import { PrismaClient } from "@prisma/client";

// Singleton PrismaClient. In dev with `node --watch`, module state is reset on
// each restart anyway, so a simple module-scoped instance is sufficient here
// (no need for the globalThis caching trick used with hot-reloading frameworks).
export const prisma = new PrismaClient();

export default prisma;

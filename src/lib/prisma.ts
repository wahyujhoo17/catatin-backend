import { PrismaClient } from "@prisma/client";

// Connection pooling — sesuaikan pool_connections dgn jumlah concurrent user
// Format: DATABASE_URL?connection_limit=20&pool_timeout=30
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export default prisma;

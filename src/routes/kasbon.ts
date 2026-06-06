import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";

/*
 * Kasbon feature is not yet implemented.
 * Prisma schema does not have a Kasbon model yet.
 * This stub exists so the route import in index.ts does not fail.
 * TODO: Add Kasbon model to schema, then implement this route.
 */

const kasbon = new Hono();
kasbon.use("*", authMiddleware);

kasbon.get("/", async (c) => {
  return c.json({ kasbon: [], message: "Kasbon feature coming soon" });
});

export default kasbon;

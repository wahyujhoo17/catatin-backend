import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

/*
 * Budget feature is not yet implemented.
 * Prisma schema does not have a Budget model yet.
 * This stub exists so the route import in index.ts does not fail.
 * TODO: Add Budget model to schema, then implement this route.
 */

const budgets = new Hono();
budgets.use("*", authMiddleware);

budgets.get("/", async (c) => {
  return c.json({ budgets: [], message: "Budget feature coming soon" });
});

export default budgets;

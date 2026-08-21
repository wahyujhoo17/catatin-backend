import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";

const kasbon = new Hono();
kasbon.use("*", authMiddleware);

kasbon.get("/", async (c) => {
  const { userId } = c.get("user");
  const customers = await prisma.customer.findMany({
    where: { userId, isActive: true, debt: { gt: 0 } },
    orderBy: { debt: "desc" },
    include: {
      receivables: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  return c.json({
    kasbon: customers.map((customer) => ({
      ...customer,
      debt: Number(customer.debt),
      maxDebt: customer.maxDebt == null ? null : Number(customer.maxDebt),
      receivables: customer.receivables.map((entry) => ({ ...entry, amount: Number(entry.amount) })),
    })),
    total: customers.reduce((sum, customer) => sum + Number(customer.debt), 0),
  });
});

export default kasbon;

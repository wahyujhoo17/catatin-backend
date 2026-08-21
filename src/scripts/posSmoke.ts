import "dotenv/config";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import prisma from "../lib/prisma";
import { signAccessToken } from "../lib/jwt";

const baseUrl = process.env.POS_SMOKE_BASE_URL || "http://127.0.0.1:4000";
const email = `pos-smoke-${randomUUID()}@example.invalid`;
let userId = "";

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-timezone": "Asia/Jakarta",
      ...init?.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${response.status} ${path}: ${body.error || "unknown error"}`);
  return body;
}

async function run() {
  const user = await prisma.user.create({ data: { email, name: "POS Smoke Test", mode: "POS" } });
  userId = user.id;
  const token = signAccessToken({ userId, email });

  await request("/api/pos/profile", token, {
    method: "PUT",
    body: JSON.stringify({ businessName: "Warung Uji", taxPercent: 0 }),
  });
  const productResult = await request<{ product: { id: string } }>("/api/products", token, {
    method: "POST",
    body: JSON.stringify({ name: "Produk Uji", sku: `SKU-${randomUUID()}`, price: 10_000, costPrice: 6_000, unit: "pcs", stock: 10, minStock: 9 }),
  });
  const customerResult = await request<{ customer: { id: string } }>("/api/customers", token, {
    method: "POST",
    body: JSON.stringify({ name: "Pelanggan Uji", maxDebt: 50_000 }),
  });
  await request("/api/pos/session/open", token, { method: "POST", body: JSON.stringify({ openingCash: 100_000 }) });

  const idempotencyKey = randomUUID();
  const checkout = await request<{ sale: { id: string; total: number; creditAmount: number } }>("/api/pos/checkout", token, {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey,
      customerId: customerResult.customer.id,
      items: [{ productId: productResult.product.id, quantity: 1 }],
      payments: [{ method: "CASH", amount: 6_000 }, { method: "CREDIT", amount: 4_000 }],
      discount: 0,
      taxPercent: 0,
    }),
  });
  assert.equal(checkout.sale.total, 10_000);
  assert.equal(checkout.sale.creditAmount, 4_000);

  const duplicate = await request<{ duplicate: boolean; sale: { id: string } }>("/api/pos/checkout", token, {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey,
      customerId: customerResult.customer.id,
      items: [{ productId: productResult.product.id, quantity: 1 }],
      payments: [{ method: "CASH", amount: 6_000 }, { method: "CREDIT", amount: 4_000 }],
      discount: 0,
      taxPercent: 0,
    }),
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sale.id, checkout.sale.id);

  const product = await request<{ product: { stock: number; stockMovements: unknown[] } }>(`/api/products/${productResult.product.id}`, token);
  assert.equal(product.product.stock, 9);
  assert.ok(product.product.stockMovements.length >= 2);

  const customerBefore = await request<{ customer: { debt: number; receivables: unknown[] } }>(`/api/customers/${customerResult.customer.id}`, token);
  assert.equal(customerBefore.customer.debt, 4_000);
  assert.equal(customerBefore.customer.receivables.length, 1);

  const report = await request<{ metrics: { revenue: number; transactionCount: number; grossProfit: number } }>("/api/pos/report?period=day", token);
  assert.equal(report.metrics.revenue, 10_000);
  assert.equal(report.metrics.transactionCount, 1);
  assert.equal(report.metrics.grossProfit, 4_000);

  const assistant = await request<{ intent: string }>("/api/pos/assistant", token, {
    method: "POST",
    body: JSON.stringify({ message: "siapa aja yang masih kasbon" }),
  });
  assert.equal(assistant.intent, "DEBT_QUERY");

  await request(`/api/customers/${customerResult.customer.id}/payments`, token, {
    method: "POST",
    body: JSON.stringify({ amount: 4_000, method: "CASH", note: "Pelunasan uji" }),
  });
  const customerAfter = await request<{ customer: { debt: number; receivables: unknown[] } }>(`/api/customers/${customerResult.customer.id}`, token);
  assert.equal(customerAfter.customer.debt, 0);
  assert.equal(customerAfter.customer.receivables.length, 2);

  await request("/api/pos/session/close", token, { method: "POST", body: JSON.stringify({ closingCash: 110_000 }) });
  console.log("POS smoke test passed: profile, product, customer, shift, checkout, idempotency, stock, kasbon, report, assistant, and payment.");
}

run()
  .finally(async () => {
    if (userId) {
      await prisma.$transaction([
        prisma.product.deleteMany({ where: { userId } }),
        prisma.customer.deleteMany({ where: { userId } }),
        prisma.user.deleteMany({ where: { id: userId, email } }),
      ]).catch((error) => console.error("POS smoke cleanup failed:", error));
    }
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

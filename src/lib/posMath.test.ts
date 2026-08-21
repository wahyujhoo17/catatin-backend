import test from "node:test";
import assert from "node:assert/strict";
import { allocateDebtPayment, calculatePaymentSummary } from "./posMath";

test("cash checkout returns change without inflating paid revenue", () => {
  assert.deepEqual(calculatePaymentSummary(18_500, [{ method: "CASH", amount: 20_000 }]), {
    credit: 0,
    tendered: 20_000,
    requiredPaid: 18_500,
    change: 1_500,
  });
});

test("mixed checkout separates cash received and customer credit", () => {
  assert.deepEqual(
    calculatePaymentSummary(50_000, [
      { method: "E_WALLET", amount: 30_000 },
      { method: "CREDIT", amount: 20_000 },
    ]),
    { credit: 20_000, tendered: 30_000, requiredPaid: 30_000, change: 0 },
  );
});

test("debt payments are allocated oldest sale first", () => {
  assert.deepEqual(
    allocateDebtPayment(35_000, [
      { id: "old", outstanding: 20_000 },
      { id: "new", outstanding: 30_000 },
    ]),
    {
      allocations: [
        { saleId: "old", amount: 20_000 },
        { saleId: "new", amount: 15_000 },
      ],
      remaining: 0,
    },
  );
});

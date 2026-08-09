import test from "node:test";
import assert from "node:assert/strict";
import { getFinancialMonthlyRange } from "./financialCycle";

test("getFinancialMonthlyRange with default startDay (1)", () => {
  const ref = new Date(2026, 7, 9); // Aug 9, 2026
  const { start, end } = getFinancialMonthlyRange(ref, 1);

  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 7); // Aug
  assert.equal(start.getDate(), 1);

  assert.equal(end.getFullYear(), 2026);
  assert.equal(end.getMonth(), 7); // Aug
  assert.equal(end.getDate(), 31);
});

test("getFinancialMonthlyRange with payday startDay (25) before 25th", () => {
  const ref = new Date(2026, 7, 9); // Aug 9, 2026 (before Aug 25)
  const { start, end } = getFinancialMonthlyRange(ref, 25);

  // Cycle should be July 25 to Aug 24
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 6); // July
  assert.equal(start.getDate(), 25);

  assert.equal(end.getFullYear(), 2026);
  assert.equal(end.getMonth(), 7); // Aug
  assert.equal(end.getDate(), 24);
});

test("getFinancialMonthlyRange with payday startDay (25) on/after 25th", () => {
  const ref = new Date(2026, 7, 26); // Aug 26, 2026 (after Aug 25)
  const { start, end } = getFinancialMonthlyRange(ref, 25);

  // Cycle should be Aug 25 to Sept 24
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 7); // Aug
  assert.equal(start.getDate(), 25);

  assert.equal(end.getFullYear(), 2026);
  assert.equal(end.getMonth(), 8); // Sept
  assert.equal(end.getDate(), 24);
});

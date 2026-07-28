import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyRecapExpenseWhere } from "./dailyRecap";

test("daily expense recap excludes internal account transfers", () => {
  const where = buildDailyRecapExpenseWhere({
    userId: "user-1",
    start: new Date("2026-07-28T00:00:00.000+07:00"),
    end: new Date("2026-07-28T23:59:59.999+07:00"),
  });

  assert.equal(where.isTransfer, false);
});

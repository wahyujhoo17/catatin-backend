import assert from "node:assert/strict";
import test from "node:test";
import { shouldPersistNotification } from "./notificationPersistence";

test("a queued notification is persisted exactly once across its pipeline", () => {
  const persistenceCount = (["enqueue", "delivery"] as const).filter((phase) =>
    shouldPersistNotification(phase),
  ).length;

  assert.equal(persistenceCount, 1);
});

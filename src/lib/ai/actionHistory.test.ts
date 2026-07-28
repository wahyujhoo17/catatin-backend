import assert from "node:assert/strict";
import test from "node:test";
import { formatAiHistoryMessage } from "./actionHistory";

test("history hydrates an executed AI action on its original assistant message", () => {
  const createdAt = new Date("2026-07-28T05:48:00.626Z");
  const expiresAt = new Date("2026-07-28T05:58:00.626Z");

  const message = formatAiHistoryMessage({
    id: "message-1",
    role: "assistant",
    content:
      "Saya sudah menyiapkan aksi berikut. Periksa rinciannya sebelum dikonfirmasi.",
    createdAt,
    proposedActions: [
      {
        id: "action-1",
        actionType: "transfer_balance",
        title: "Transfer antar dompet",
        summary: "Rp100.000 dari BCA ke BRI",
        expiresAt,
        status: "EXECUTED",
        error: null,
      },
    ],
  });

  assert.equal(message.type, "bot");
  assert.deepEqual(message.pendingActions, [
    {
      id: "action-1",
      actionType: "transfer_balance",
      title: "Transfer antar dompet",
      summary: "Rp100.000 dari BCA ke BRI",
      expiresAt: expiresAt.toISOString(),
      status: "executed",
      error: undefined,
    },
  ]);
});

test("history maps cancelled and failed action statuses for the confirmation card", () => {
  const message = formatAiHistoryMessage({
    id: "message-2",
    role: "assistant",
    content: "Periksa aksi berikut.",
    createdAt: new Date("2026-07-28T05:48:00.626Z"),
    proposedActions: [
      {
        id: "action-cancelled",
        actionType: "transfer_balance",
        title: "Transfer",
        summary: "Rp10.000",
        expiresAt: new Date("2026-07-28T05:58:00.626Z"),
        status: "CANCELLED",
        error: null,
      },
      {
        id: "action-failed",
        actionType: "transfer_balance",
        title: "Transfer",
        summary: "Rp20.000",
        expiresAt: new Date("2026-07-28T05:58:00.626Z"),
        status: "FAILED",
        error: "Saldo tidak cukup",
      },
    ],
  });

  assert.deepEqual(
    message.pendingActions?.map((action) => ({
      status: action.status,
      error: action.error,
    })),
    [
      { status: "cancelled", error: undefined },
      { status: "failed", error: "Saldo tidak cukup" },
    ],
  );
});

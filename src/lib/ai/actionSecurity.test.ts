import assert from "node:assert/strict";
import test from "node:test";
import {
  requiresConfirmation,
  validateAiToolCall,
} from "./actionRequests";
import { decryptAiSecret, encryptAiSecret } from "./secrets";
import { assertSafeAiBaseUrl } from "./safeUrl";

function toolCall(name: string, args: unknown) {
  return {
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

test("transaction writes require an explicit confirmation", () => {
  assert.equal(requiresConfirmation("record_transaction"), true);
  assert.equal(requiresConfirmation("delete_transaction"), true);
  assert.equal(requiresConfirmation("adjust_balance"), true);
  assert.equal(requiresConfirmation("draft_transaction"), false);
});

test("record_transaction rejects missing accounts and invalid amounts", () => {
  assert.throws(() =>
    validateAiToolCall(
      toolCall("record_transaction", {
        type: "EXPENSE",
        amount: 50_000,
        description: "Makan siang",
        category: "Makanan",
      }),
    ),
  );
  assert.throws(() =>
    validateAiToolCall(
      toolCall("record_transaction", {
        type: "EXPENSE",
        amount: -50_000,
        description: "Makan siang",
        category: "Makanan",
        accountId: "cash",
      }),
    ),
  );
});

test("transfer rejects identical source and destination accounts", () => {
  assert.throws(() =>
    validateAiToolCall(
      toolCall("transfer_balance", {
        fromAccountId: "bca",
        toAccountId: "bca",
        amount: 100_000,
      }),
    ),
  );
});

test("split bill rejects allocations above the paid total", () => {
  assert.throws(() =>
    validateAiToolCall(
      toolCall("split_bill", {
        totalAmount: 100_000,
        description: "Makan bersama",
        category: "Makanan",
        accountId: "cash",
        splits: [
          { targetName: "Budi", amount: 70_000 },
          { targetName: "Ani", amount: 50_000 },
        ],
      }),
    ),
  );
});

test("AI secrets use authenticated encryption", () => {
  const previousKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
  process.env.AI_CONFIG_ENCRYPTION_KEY =
    "test-only-key-with-at-least-thirty-two-characters";
  try {
    const encrypted = encryptAiSecret("sk-secret-value");
    assert.notEqual(encrypted, "sk-secret-value");
    assert.match(encrypted, /^v1:/);
    assert.equal(decryptAiSecret(encrypted), "sk-secret-value");
    assert.throws(() => decryptAiSecret(`${encrypted}tampered`));
  } finally {
    if (previousKey === undefined) {
      delete process.env.AI_CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.AI_CONFIG_ENCRYPTION_KEY = previousKey;
    }
  }
});

test("custom AI URLs reject credentials and insecure production HTTP", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(() =>
      assertSafeAiBaseUrl("https://user:pass@example.com/v1"),
    );
    await assert.rejects(() =>
      assertSafeAiBaseUrl("http://localhost:11434/v1"),
    );
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

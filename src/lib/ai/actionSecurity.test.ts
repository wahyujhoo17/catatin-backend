import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAiToolCallAccounts,
  resolveAiToolCallTargets,
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

test("account references copied from prompt brackets are normalized", () => {
  const validated = validateAiToolCall(
    toolCall("adjust_balance", {
      accountId: "[cmq2xit7j000lqh6set3920za]",
      newBalance: 1_000_000,
    }),
  );
  const args = JSON.parse(validated.function.arguments);

  assert.equal(args.accountId, "cmq2xit7j000lqh6set3920za");
});

test("every account-bearing action resolves bracketed IDs", () => {
  const accounts = [
    { id: "account-bca", name: "BCA" },
    { id: "account-bri", name: "BRI" },
  ];
  const cases = [
    {
      name: "record_transaction",
      args: {
        type: "EXPENSE",
        amount: 50_000,
        description: "Makan",
        category: "Makanan",
        accountId: "[account-bca]",
      },
      expected: { accountId: "account-bca" },
    },
    {
      name: "draft_transaction",
      args: {
        type: "EXPENSE",
        amount: 50_000,
        description: "Makan",
        category: "Makanan",
        accountId: "[account-bca]",
      },
      expected: { accountId: "account-bca" },
    },
    {
      name: "transfer_balance",
      args: {
        fromAccountId: "[account-bca]",
        toAccountId: "[account-bri]",
        amount: 50_000,
      },
      expected: {
        fromAccountId: "account-bca",
        toAccountId: "account-bri",
      },
    },
    {
      name: "adjust_balance",
      args: { accountId: "[account-bca]", newBalance: 1_000_000 },
      expected: { accountId: "account-bca" },
    },
    {
      name: "split_bill",
      args: {
        totalAmount: 100_000,
        description: "Makan bersama",
        category: "Makanan",
        accountId: "[account-bca]",
        splits: [{ targetName: "Budi", amount: 50_000 }],
      },
      expected: { accountId: "account-bca" },
    },
  ];

  for (const item of cases) {
    const validated = validateAiToolCall(toolCall(item.name, item.args));
    const resolved = resolveAiToolCallAccounts(validated, accounts);
    const args = JSON.parse(resolved.function.arguments);
    for (const [field, expected] of Object.entries(item.expected)) {
      assert.equal(args[field], expected, `${item.name}.${field}`);
    }
  }
});

test("all internal entity references copied from AI context are normalized", () => {
  const cases = [
    {
      name: "update_transaction",
      args: {
        id: "[transaction-1]",
        amount: 75_000,
        description: "Makan malam",
      },
      field: "id",
      expected: "transaction-1",
    },
    {
      name: "delete_transaction",
      args: { id: "[transaction-1]" },
      field: "id",
      expected: "transaction-1",
    },
    {
      name: "delete_subscription",
      args: { id: "[ID:subscription-1]" },
      field: "id",
      expected: "subscription-1",
    },
    {
      name: "allocate_saving_goal",
      args: { goalId: "[ID:goal-1]", amount: 100_000 },
      field: "goalId",
      expected: "goal-1",
    },
  ];

  for (const item of cases) {
    const validated = validateAiToolCall(toolCall(item.name, item.args));
    assert.equal(
      JSON.parse(validated.function.arguments)[item.field],
      item.expected,
      item.name,
    );
  }
});

test("account references are resolved to a canonical account ID", () => {
  const call = validateAiToolCall(
    toolCall("adjust_balance", {
      accountId: "bca",
      newBalance: 1_000_000,
    }),
  );
  const resolved = resolveAiToolCallAccounts(call, [
    { id: "account-bca", name: "BCA" },
  ]);

  assert.equal(
    JSON.parse(resolved.function.arguments).accountId,
    "account-bca",
  );
});

test("unknown account references are rejected before creating a proposal", () => {
  const call = validateAiToolCall(
    toolCall("adjust_balance", {
      accountId: "rekening-tidak-ada",
      newBalance: 1_000_000,
    }),
  );

  assert.throws(
    () =>
      resolveAiToolCallAccounts(call, [
        { id: "account-bca", name: "BCA" },
      ]),
    /tidak ditemukan/,
  );
});

test("transfer aliases cannot resolve to the same account", () => {
  const call = validateAiToolCall(
    toolCall("transfer_balance", {
      fromAccountId: "BCA",
      toAccountId: "account-bca",
      amount: 100_000,
    }),
  );

  assert.throws(
    () =>
      resolveAiToolCallAccounts(call, [
        { id: "account-bca", name: "BCA" },
      ]),
    /harus berbeda/,
  );
});

test("transaction targets are verified before proposal creation", async () => {
  const call = validateAiToolCall(
    toolCall("delete_transaction", { id: "[transaction-1]" }),
  );
  const resolved = await resolveAiToolCallTargets("user-1", call, {
    findTransaction: async () => ({ id: "transaction-1" }),
  });

  assert.equal(
    JSON.parse(resolved.function.arguments).id,
    "transaction-1",
  );
});

test("subscription targets are resolved to canonical IDs and names", async () => {
  const call = validateAiToolCall(
    toolCall("delete_subscription", { id: "[ID:subscription-1]" }),
  );
  const resolved = await resolveAiToolCallTargets("user-1", call, {
    findSubscriptions: async () => [
      { id: "subscription-1", name: "Netflix" },
    ],
  });
  const args = JSON.parse(resolved.function.arguments);

  assert.equal(args.id, "subscription-1");
  assert.equal(args.name, "Netflix");
});

test("saving goal targets are resolved before proposal creation", async () => {
  const call = validateAiToolCall(
    toolCall("allocate_saving_goal", {
      goalId: "[ID:goal-1]",
      amount: 100_000,
    }),
  );
  const resolved = await resolveAiToolCallTargets("user-1", call, {
    findSavingGoals: async () => [{ id: "goal-1", name: "Laptop" }],
  });

  assert.equal(JSON.parse(resolved.function.arguments).goalId, "goal-1");
});

test("missing or ambiguous named targets are rejected before confirmation", async () => {
  const call = validateAiToolCall(
    toolCall("allocate_saving_goal", {
      goalId: "Laptop",
      amount: 100_000,
    }),
  );

  await assert.rejects(
    () =>
      resolveAiToolCallTargets("user-1", call, {
        findSavingGoals: async () => [
          { id: "goal-1", name: "Laptop kerja" },
          { id: "goal-2", name: "Laptop gaming" },
        ],
      }),
    /ambigu/,
  );
});

test("budget deletion validates category and period targets", async () => {
  const call = validateAiToolCall(
    toolCall("delete_budget", {
      category: "makanan",
      period: "MONTHLY",
    }),
  );
  const resolved = await resolveAiToolCallTargets("user-1", call, {
    findCategory: async () => ({
      id: "category-food",
      name: "Makanan",
    }),
    findBudget: async () => ({ id: "budget-1" }),
  });

  assert.equal(
    JSON.parse(resolved.function.arguments).category,
    "Makanan",
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

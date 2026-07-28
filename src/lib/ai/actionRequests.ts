import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../prisma";

const MAX_IDR_AMOUNT = 1_000_000_000_000_000;
const text = (max: number) => z.string().trim().min(1).max(max);
const normalizeInternalReference = (value: string) => {
  const trimmed = value.trim();
  const wrapped = trimmed.match(/^\[([^\[\]]+)\]$/);
  return (wrapped?.[1] || trimmed).replace(/^ID\s*:\s*/i, "").trim();
};
const idOrName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .transform(normalizeInternalReference)
  .pipe(z.string().min(1).max(160));
const optionalIdOrName = z
  .string()
  .trim()
  .max(160)
  .transform((value) => {
    const normalized = normalizeInternalReference(value);
    return normalized === "" ? undefined : normalized;
  })
  .optional();
const internalId = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform(normalizeInternalReference)
    .pipe(z.string().min(1).max(max));
const optionalInternalId = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => {
      const normalized = normalizeInternalReference(value);
      return normalized === "" ? undefined : normalized;
    })
    .optional();
const amount = z.number().finite().int().positive().max(MAX_IDR_AMOUNT);
const nonNegativeAmount = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .max(MAX_IDR_AMOUNT);
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
    "Tanggal tidak valid",
  );

const actionSchemas = {
  record_transaction: z
    .object({
      type: z.enum(["EXPENSE", "INCOME"]),
      amount,
      description: text(240),
      category: text(100),
      accountId: idOrName,
    })
    .strict(),
  draft_transaction: z
    .object({
      summary: z.string().max(2_000).optional(),
      type: z.enum(["EXPENSE", "INCOME"]),
      amount,
      description: text(240),
      category: text(100),
      accountId: optionalIdOrName,
    })
    .strict(),
  transfer_balance: z
    .object({
      fromAccountId: idOrName,
      toAccountId: idOrName,
      amount,
      description: z.string().trim().max(240).optional(),
    })
    .strict()
    .refine((value) => value.fromAccountId !== value.toAccountId, {
      message: "Akun asal dan tujuan harus berbeda",
    }),
  add_subscription: z
    .object({
      name: text(120),
      amount,
      cycle: z.enum([
        "MONTHLY",
        "YEARLY",
        "WEEKLY",
        "QUARTERLY",
        "SEMI_ANNUALLY",
      ]),
      nextDueDate: dateOnly,
    })
    .strict(),
  delete_subscription: z
    .object({
      id: optionalInternalId(128),
      name: text(120).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.id || value.name), {
      message: "ID atau nama pengingat wajib diisi",
    }),
  update_transaction: z
    .object({
      id: internalId(128),
      amount,
      description: text(240),
    })
    .strict(),
  delete_transaction: z.object({ id: internalId(128) }).strict(),
  set_alert_threshold: z.object({ threshold: nonNegativeAmount }).strict(),
  adjust_balance: z
    .object({
      accountId: idOrName,
      newBalance: nonNegativeAmount,
    })
    .strict(),
  set_budget: z
    .object({
      category: z.string().trim().max(100).optional(),
      amount,
      period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    })
    .strict(),
  delete_budget: z
    .object({
      category: z.string().trim().max(100).optional(),
      period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    })
    .strict(),
  split_bill: z
    .object({
      totalAmount: amount,
      description: text(240),
      category: text(100),
      accountId: idOrName,
      splits: z
        .array(
          z
            .object({
              targetName: text(120),
              amount,
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict()
    .refine(
      (value) =>
        value.splits.reduce((sum, item) => sum + item.amount, 0) <=
        value.totalAmount,
      { message: "Total pembagian tidak boleh melebihi total transaksi" },
    ),
  create_saving_goal: z
    .object({
      name: text(120),
      targetAmount: amount,
      currentAmount: nonNegativeAmount.optional(),
      targetDate: dateOnly.optional(),
    })
    .strict(),
  allocate_saving_goal: z
    .object({
      goalId: idOrName,
      amount,
    })
    .strict(),
} satisfies Record<string, z.ZodType>;

export type AiActionName = keyof typeof actionSchemas;
export type AiToolCall = {
  function: {
    name: AiActionName;
    arguments: string;
  };
};

export interface AiActionProposal {
  id: string;
  actionType: AiActionName;
  title: string;
  summary: string;
  expiresAt: string;
}

export function isAiActionName(value: string): value is AiActionName {
  return Object.prototype.hasOwnProperty.call(actionSchemas, value);
}

export function requiresConfirmation(actionType: AiActionName): boolean {
  return actionType !== "draft_transaction";
}

export function validateAiToolCall(toolCall: unknown): AiToolCall {
  const raw = z
    .object({
      function: z.object({
        name: z.string(),
        arguments: z.string().max(20_000),
      }),
    })
    .passthrough()
    .parse(toolCall);

  if (!isAiActionName(raw.function.name)) {
    throw new Error("Aksi AI tidak dikenal");
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(raw.function.arguments);
  } catch {
    throw new Error("Format parameter aksi AI tidak valid");
  }

  const normalized = actionSchemas[raw.function.name].parse(parsedArguments);
  return {
    function: {
      name: raw.function.name,
      arguments: JSON.stringify(normalized),
    },
  };
}

const accountArgumentNames: Partial<
  Record<AiActionName, readonly string[]>
> = {
  record_transaction: ["accountId"],
  draft_transaction: ["accountId"],
  transfer_balance: ["fromAccountId", "toAccountId"],
  adjust_balance: ["accountId"],
  split_bill: ["accountId"],
};

export function resolveAiToolCallAccounts(
  call: AiToolCall,
  accounts: { id: string; name: string }[],
): AiToolCall {
  const argumentNames = accountArgumentNames[call.function.name];
  if (!argumentNames) return call;

  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  for (const argumentName of argumentNames) {
    const value = args[argumentName];
    if (
      call.function.name === "draft_transaction" &&
      (value === undefined || value === "")
    ) {
      continue;
    }

    const reference = String(value ?? "").trim();
    const account = accounts.find(
      (item) =>
        item.id === reference ||
        item.name.toLocaleLowerCase("id-ID") ===
          reference.toLocaleLowerCase("id-ID"),
    );
    if (!account) {
      throw new Error(`Akun "${reference || "tidak diketahui"}" tidak ditemukan`);
    }
    args[argumentName] = account.id;
  }

  if (
    call.function.name === "transfer_balance" &&
    args.fromAccountId === args.toAccountId
  ) {
    throw new Error("Akun asal dan tujuan harus berbeda");
  }

  return {
    function: {
      name: call.function.name,
      arguments: JSON.stringify(args),
    },
  };
}

function selectNamedEntity<T extends { id: string; name: string }>(
  reference: string,
  entities: T[],
  label: string,
): T {
  const normalized = reference.toLocaleLowerCase("id-ID");
  const exactId = entities.find((item) => item.id === reference);
  if (exactId) return exactId;

  const exactNames = entities.filter(
    (item) => item.name.toLocaleLowerCase("id-ID") === normalized,
  );
  if (exactNames.length === 1) return exactNames[0];
  if (exactNames.length > 1 || entities.length > 1) {
    throw new Error(`${label} "${reference}" ambigu`);
  }
  if (entities.length === 1) return entities[0];
  throw new Error(`${label} "${reference}" tidak ditemukan`);
}

export interface AiActionTargetStore {
  findTransaction(
    userId: string,
    id: string,
  ): Promise<{ id: string } | null>;
  findSubscriptions(
    userId: string,
    id: string,
    name: string,
  ): Promise<{ id: string; name: string }[]>;
  findSavingGoals(
    userId: string,
    reference: string,
  ): Promise<{ id: string; name: string }[]>;
  findCategory(
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string } | null>;
  findBudget(
    userId: string,
    categoryId: string | null,
    period: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY",
  ): Promise<{ id: string } | null>;
}

const defaultAiActionTargetStore: AiActionTargetStore = {
  findTransaction: (userId, id) =>
    prisma.transaction.findFirst({
      where: { id, userId },
      select: { id: true },
    }),
  findSubscriptions: (userId, id, name) =>
    prisma.subscription.findMany({
      where: {
        userId,
        OR: [
          id ? { id } : undefined,
          name
            ? { name: { contains: name, mode: "insensitive" as const } }
            : undefined,
        ].filter(Boolean) as any[],
      },
      select: { id: true, name: true },
      take: 3,
    }),
  findSavingGoals: (userId, reference) =>
    prisma.savingGoal.findMany({
      where: {
        userId,
        OR: [
          { id: reference },
          { name: { contains: reference, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true },
      take: 3,
    }),
  findCategory: (userId, name) =>
    prisma.category.findFirst({
      where: {
        userId,
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true, name: true },
    }),
  findBudget: (userId, categoryId, period) =>
    prisma.budget.findFirst({
      where: { userId, categoryId, period },
      select: { id: true },
    }),
};

export async function resolveAiToolCallTargets(
  userId: string,
  call: AiToolCall,
  store: Partial<AiActionTargetStore> = defaultAiActionTargetStore,
): Promise<AiToolCall> {
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

  switch (call.function.name) {
    case "update_transaction":
    case "delete_transaction": {
      const id = String(args.id);
      const transaction = await store.findTransaction!(userId, id);
      if (!transaction) throw new Error("Transaksi tidak ditemukan");
      args.id = transaction.id;
      break;
    }
    case "delete_subscription": {
      const id = args.id ? String(args.id) : "";
      const name = args.name ? String(args.name).trim() : "";
      const subscriptions = await store.findSubscriptions!(userId, id, name);
      const subscription = selectNamedEntity(
        id || name,
        subscriptions,
        "Pengingat",
      );
      args.id = subscription.id;
      args.name = subscription.name;
      break;
    }
    case "allocate_saving_goal": {
      const reference = String(args.goalId);
      const goals = await store.findSavingGoals!(userId, reference);
      const goal = selectNamedEntity(reference, goals, "Target tabungan");
      args.goalId = goal.id;
      break;
    }
    case "delete_budget": {
      const globalCategoryNames = new Set([
        "",
        "keseluruhan",
        "semua",
        "total",
        "global",
        "all",
      ]);
      const categoryReference = String(args.category || "").trim();
      let categoryId: string | null = null;
      if (
        !globalCategoryNames.has(
          categoryReference.toLocaleLowerCase("id-ID"),
        )
      ) {
        const category = await store.findCategory!(
          userId,
          categoryReference,
        );
        if (!category) {
          throw new Error(`Kategori budget "${categoryReference}" tidak ditemukan`);
        }
        categoryId = category.id;
        args.category = category.name;
      } else {
        delete args.category;
      }

      const period = String(args.period) as
        | "DAILY"
        | "WEEKLY"
        | "MONTHLY"
        | "YEARLY";
      const budget = await store.findBudget!(userId, categoryId, period);
      if (!budget) throw new Error("Budget tidak ditemukan");
      break;
    }
  }

  return {
    function: {
      name: call.function.name,
      arguments: JSON.stringify(args),
    },
  };
}

function accountName(
  value: string,
  accounts: { id: string; name: string }[],
): string {
  return (
    accounts.find(
      (account) =>
        account.id === value ||
        account.name.toLocaleLowerCase("id-ID") ===
          value.toLocaleLowerCase("id-ID"),
    )?.name || "akun tidak dikenal"
  );
}

async function buildPreview(
  userId: string,
  call: AiToolCall,
  accounts: { id: string; name: string }[],
): Promise<{ title: string; summary: string }> {
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  const rupiah = (value: unknown) =>
    `Rp${Number(value || 0).toLocaleString("id-ID")}`;

  switch (call.function.name) {
    case "record_transaction":
      return {
        title:
          args.type === "INCOME" ? "Catat pemasukan" : "Catat pengeluaran",
        summary: `${String(args.description)} • ${rupiah(args.amount)} • ${accountName(String(args.accountId), accounts)}`,
      };
    case "transfer_balance":
      return {
        title: "Transfer antar dompet",
        summary: `${rupiah(args.amount)} dari ${accountName(String(args.fromAccountId), accounts)} ke ${accountName(String(args.toAccountId), accounts)}`,
      };
    case "update_transaction": {
      const transaction = await prisma.transaction.findFirst({
        where: { id: String(args.id), userId },
        select: { description: true },
      });
      if (!transaction) throw new Error("Transaksi tidak ditemukan");
      return {
        title: "Ubah transaksi",
        summary: `${transaction.description || "Transaksi"} menjadi ${rupiah(args.amount)}`,
      };
    }
    case "delete_transaction": {
      const transaction = await prisma.transaction.findFirst({
        where: { id: String(args.id), userId },
        select: { description: true, amount: true },
      });
      if (!transaction) throw new Error("Transaksi tidak ditemukan");
      return {
        title: "Hapus transaksi",
        summary: `${transaction.description || "Transaksi"} • ${rupiah(transaction.amount)}`,
      };
    }
    case "adjust_balance":
      return {
        title: "Sesuaikan saldo",
        summary: `${accountName(String(args.accountId), accounts)} menjadi ${rupiah(args.newBalance)}`,
      };
    case "add_subscription":
      return {
        title: "Buat pengingat rutin",
        summary: `${String(args.name)} • ${rupiah(args.amount)} • ${String(args.cycle)}`,
      };
    case "delete_subscription":
      return {
        title: "Hapus pengingat rutin",
        summary: String(args.name || "Pengingat yang dipilih"),
      };
    case "set_alert_threshold":
      return {
        title: "Ubah batas peringatan",
        summary: `Batas baru ${rupiah(args.threshold)}`,
      };
    case "set_budget":
      return {
        title: "Buat atau ubah budget",
        summary: `${String(args.category || "Semua kategori")} • ${rupiah(args.amount)} • ${String(args.period)}`,
      };
    case "delete_budget":
      return {
        title: "Hapus budget",
        summary: `${String(args.category || "Semua kategori")} • ${String(args.period)}`,
      };
    case "split_bill":
      return {
        title: "Catat split bill",
        summary: `${String(args.description)} • ${rupiah(args.totalAmount)} • ${accountName(String(args.accountId), accounts)}`,
      };
    case "create_saving_goal":
      return {
        title: "Buat target tabungan",
        summary: `${String(args.name)} • target ${rupiah(args.targetAmount)}`,
      };
    case "allocate_saving_goal":
      const goal = await prisma.savingGoal.findFirst({
        where: { id: String(args.goalId), userId },
        select: { name: true },
      });
      if (!goal) throw new Error("Target tabungan tidak ditemukan");
      return {
        title: "Alokasikan target tabungan",
        summary: `${rupiah(args.amount)} ke ${goal.name}`,
      };
    case "draft_transaction":
      return {
        title: "Draf transaksi",
        summary: `${String(args.description)} • ${rupiah(args.amount)}`,
      };
  }
}

export async function createPendingAiActions(input: {
  userId: string;
  requestId?: string;
  toolCalls: unknown[];
  accounts: { id: string; name: string }[];
}): Promise<AiActionProposal[]> {
  const stableRequestId =
    input.requestId && input.requestId.length <= 128
      ? input.requestId
      : randomUUID();
  const proposals: AiActionProposal[] = [];

  for (let index = 0; index < input.toolCalls.length; index += 1) {
    const validatedCall = validateAiToolCall(input.toolCalls[index]);
    if (!requiresConfirmation(validatedCall.function.name)) continue;
    const accountResolvedCall = resolveAiToolCallAccounts(
      validatedCall,
      input.accounts,
    );
    const call = await resolveAiToolCallTargets(
      input.userId,
      accountResolvedCall,
    );

    const preview = await buildPreview(input.userId, call, input.accounts);
    const idempotencyKey = createHash("sha256")
      .update(
        `${input.userId}:${stableRequestId}:${index}:${call.function.name}:${call.function.arguments}`,
      )
      .digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000);
    const args = JSON.parse(call.function.arguments);

    const request = await prisma.aiActionRequest.upsert({
      where: { idempotencyKey },
      update: {},
      create: {
        userId: input.userId,
        actionType: call.function.name,
        arguments: args,
        title: preview.title,
        summary: preview.summary,
        idempotencyKey,
        expiresAt,
      },
    });

    proposals.push({
      id: request.id,
      actionType: call.function.name,
      title: preview.title,
      summary: preview.summary,
      expiresAt: request.expiresAt.toISOString(),
    });
  }

  return proposals;
}

export function toolCallFromActionRequest(request: {
  actionType: string;
  arguments: unknown;
}): AiToolCall {
  if (!isAiActionName(request.actionType)) {
    throw new Error("Aksi AI tidak dikenal");
  }
  return validateAiToolCall({
    function: {
      name: request.actionType,
      arguments: JSON.stringify(request.arguments),
    },
  });
}

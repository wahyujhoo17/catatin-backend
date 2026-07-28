import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../prisma";

const MAX_IDR_AMOUNT = 1_000_000_000_000_000;
const text = (max: number) => z.string().trim().min(1).max(max);
const idOrName = text(160);
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
      accountId: idOrName.optional(),
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
      id: text(128).optional(),
      name: text(120).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.id || value.name), {
      message: "ID atau nama pengingat wajib diisi",
    }),
  update_transaction: z
    .object({
      id: text(128),
      amount,
      description: text(240),
    })
    .strict(),
  delete_transaction: z.object({ id: text(128) }).strict(),
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
      return {
        title: "Alokasikan target tabungan",
        summary: `${rupiah(args.amount)} ke target yang dipilih`,
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
    const call = validateAiToolCall(input.toolCalls[index]);
    if (!requiresConfirmation(call.function.name)) continue;

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

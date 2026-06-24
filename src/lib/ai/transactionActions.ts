import prisma from "../prisma";
import { clearUserAiCache } from "../redis";
import { cronQueue } from "../queue";

export const processTransactionActions = async (toolCalls: any[], userId: string, accounts: any[]) => {
  const processedEvents: any[] = [];

  for (const toolCall of toolCalls) {
    if (!toolCall.function || !toolCall.function.name) continue;

    try {
      const actionType = toolCall.function.name;
      const parsed = JSON.parse(toolCall.function.arguments);
      
      if (actionType === "delete_transaction") {
        const txId = parsed.id;
        if (!txId) continue;
        const existingTx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (!existingTx || existingTx.userId !== userId) continue;
        
        await prisma.$transaction(async (tx) => {
          // Revert balance
          if (existingTx.accountId) {
            const delta = existingTx.type === "INCOME" || existingTx.type === "DEBT" ? -existingTx.amount : existingTx.amount;
            await tx.account.update({
              where: { id: existingTx.accountId },
              data: { balance: { increment: delta } },
            });
          }
          await tx.transaction.delete({ where: { id: txId } });
        });
        
        processedEvents.push({ action: "delete", transaction: existingTx });
        continue;
      }

      if (actionType === "update_transaction") {
        const txId = parsed.id;
        const newAmount = parsed.amount;
        const newDesc = parsed.description;
        if (!txId || typeof newAmount !== "number") continue;
        
        const existingTx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (!existingTx || existingTx.userId !== userId) continue;
        
        const updatedTx = await prisma.$transaction(async (tx) => {
          // Revert old balance
          if (existingTx.accountId) {
            const oldDelta = existingTx.type === "INCOME" || existingTx.type === "DEBT" ? -existingTx.amount : existingTx.amount;
            await tx.account.update({
              where: { id: existingTx.accountId },
              data: { balance: { increment: oldDelta } },
            });
          }
          // Add new balance
          if (existingTx.accountId) {
            const newDelta = existingTx.type === "INCOME" || existingTx.type === "DEBT" ? newAmount : -newAmount;
            await tx.account.update({
              where: { id: existingTx.accountId },
              data: { balance: { increment: newDelta } },
            });
          }
          return await tx.transaction.update({
            where: { id: txId },
            data: { amount: newAmount, description: newDesc || existingTx.description },
          });
        });
        
        processedEvents.push({ action: "update", transaction: updatedTx });
        continue;
      }

      // --- transfer_balance ---
      if (actionType === "transfer_balance") {
        const { fromAccountId, toAccountId, amount, description } = parsed;
        if (!fromAccountId || !toAccountId || !amount || amount <= 0) continue;

        const fromAcc = accounts.find((a) => a.id === fromAccountId || a.name.toLowerCase() === fromAccountId.toLowerCase());
        const toAcc = accounts.find((a) => a.id === toAccountId || a.name.toLowerCase() === toAccountId.toLowerCase());
        if (!fromAcc || !toAcc) {
          console.warn(`[AI] Invalid transfer accounts: ${fromAccountId} -> ${toAccountId}`);
          continue;
        }

        // Cari atau buat kategori transfer
        let catOutId: string | null = null;
        let catInId: string | null = null;

        const catOut = await prisma.category.findFirst({ where: { userId, name: "Transfer Keluar" } });
        if (catOut) catOutId = catOut.id;
        else {
          const newCat = await prisma.category.create({ data: { userId, name: "Transfer Keluar", type: "EXPENSE" } });
          catOutId = newCat.id;
        }

        const catIn = await prisma.category.findFirst({ where: { userId, name: "Transfer Masuk" } });
        if (catIn) catInId = catIn.id;
        else {
          const newCat = await prisma.category.create({ data: { userId, name: "Transfer Masuk", type: "INCOME" } });
          catInId = newCat.id;
        }

        const transferTx = await prisma.$transaction(async (tx) => {
          const expenseTx = await tx.transaction.create({
            data: {
              userId,
              type: "EXPENSE",
              amount,
              description: description || `Transfer ke ${toAcc.name}`,
              categoryId: catOutId,
              accountId: fromAccountId,
              source: "CHAT",
              isTransfer: true,
              date: new Date(),
            }
          });
          await tx.account.update({
            where: { id: fromAccountId },
            data: { balance: { decrement: amount } }
          });

          const incomeTx = await tx.transaction.create({
            data: {
              userId,
              type: "INCOME",
              amount,
              description: description || `Transfer dari ${fromAcc.name}`,
              categoryId: catInId,
              accountId: toAccountId,
              source: "CHAT",
              isTransfer: true,
              date: new Date(),
            }
          });
          await tx.account.update({
            where: { id: toAccountId },
            data: { balance: { increment: amount } }
          });

          return { expenseTx, incomeTx };
        });

        // Event for frontend
        processedEvents.push({
          action: "record",
          transaction: {
            ...transferTx.expenseTx,
            category: "Transfer Keluar",
            account: fromAcc.name,
          }
        });
        processedEvents.push({
          action: "record",
          transaction: {
            ...transferTx.incomeTx,
            category: "Transfer Masuk",
            account: toAcc.name,
          }
        });
        continue;
      }

      // --- add_subscription ---
      if (actionType === "add_subscription") {
        const { name, amount, cycle, nextDueDate } = parsed;
        if (!name || typeof amount !== "number" || !cycle || !nextDueDate) continue;

        const newSub = await prisma.subscription.create({
          data: {
            userId,
            name,
            amount,
            cycle,
            nextDueDate: new Date(nextDueDate),
          }
        });

        processedEvents.push({
          action: "add_subscription",
          subscription: newSub
        });
        continue;
      }

      // --- set_alert_threshold ---
      if (actionType === "set_alert_threshold") {
        let { threshold } = parsed;
        if (typeof threshold === "string") {
          threshold = Number(threshold.replace(/\D/g, ""));
        }
        if (typeof threshold !== "number" || isNaN(threshold)) continue;

        const userObj = await prisma.user.findUnique({ where: { id: userId }, select: { customAiConfig: true } });
        const config = (userObj?.customAiConfig as any) || { enabled: false, provider: "openai", baseUrl: "", apiKey: "", model: "" };
        
        await prisma.user.update({
          where: { id: userId },
          data: { customAiConfig: { ...config, alertThreshold: threshold } }
        });

        processedEvents.push({
          action: "set_alert_threshold",
          threshold
        });
        continue;
      }

      // --- adjust_balance ---
      if (actionType === "adjust_balance") {
        const { accountId, newBalance } = parsed;
        if (!accountId || typeof newBalance !== "number" || isNaN(newBalance)) continue;

        const acc = accounts.find(
          (a) => a.id === accountId || a.name.toLowerCase() === accountId.toLowerCase()
        );
        if (!acc) {
          console.warn(`[AI] adjust_balance: account not found: ${accountId}`);
          continue;
        }

        const oldBalance = Number(acc.balance);
        const updated = await prisma.account.update({
          where: { id: acc.id },
          data: { balance: newBalance },
        });

        console.log(`[AI] Balance adjusted: ${acc.name} from ${oldBalance} to ${newBalance}`);

        processedEvents.push({
          action: "adjust_balance",
          account: {
            id: updated.id,
            name: updated.name,
            balance: Number(updated.balance),
            oldBalance,
          }
        });
        continue;
      }

      // --- record_transaction & draft_transaction ---
      if (actionType === "record_transaction" || actionType === "draft_transaction") {
        const {
          type,
          description,
          category: catName,
          accountId,
        } = parsed;

        let { amount } = parsed;
        if (typeof amount === "string") {
          amount = Number(amount.replace(/\D/g, ""));
        }

        if (!type || !amount || !description) continue;
        if (!["INCOME", "EXPENSE"].includes(type)) continue;
        if (typeof amount !== "number" || isNaN(amount) || amount <= 0) continue;

        // Validasi accountId jika diberikan
        let finalAccountId: string | null = null;
        if (accountId && typeof accountId === "string") {
          const acc = accounts.find(
            (a) => a.id === accountId || a.name.toLowerCase() === accountId.toLowerCase()
          );
          if (acc) {
            finalAccountId = acc.id;
          } else {
            console.warn(`[AI] accountId ${accountId} tidak valid, abaikan`);
          }
        }
        // Auto-assign ke akun pertama (utama) jika AI tidak menyebutkan dompet
        if (!finalAccountId && accounts.length > 0) {
          finalAccountId = accounts[0].id;
        }

        // Cari atau buat kategori
        let categoryId: string | null = null;
        if (catName) {
          const existingCat = await prisma.category.findFirst({
            where: { userId: userId, name: catName },
          });
          if (existingCat) {
            categoryId = existingCat.id;
          } else {
            // Hanya buat kategori di DB jika bukan DRAFT
            if (actionType === "record_transaction") {
               const newCat = await prisma.category.create({
                 data: {
                   userId: userId,
                   name: catName,
                   type: type as any,
                 },
               });
               categoryId = newCat.id;
            }
          }
        }

        const accName = accounts.find((a) => a.id === finalAccountId)?.name || "Umum";

        if (actionType === "draft_transaction") {
          processedEvents.push({
            action: "draft",
            transaction: {
              id: "draft-" + Date.now() + Math.floor(Math.random() * 1000),
              type,
              amount,
              description,
              categoryId,
              category: catName || "Umum",
              accountId: finalAccountId,
              account: accName,
              date: new Date().toISOString()
            }
          });
          continue;
        }

        // Buat transaksi
        const newTx = await prisma.$transaction(async (tx) => {
          const created = await tx.transaction.create({
            data: {
              userId: userId,
              type: type as any,
              amount,
              description,
              categoryId,
              accountId: finalAccountId,
              source: "CHAT",
              date: new Date(),
            },
          });
          
          if (finalAccountId) {
            const delta = type === "INCOME" || type === "DEBT" ? amount : -amount;
            await tx.account.update({
              where: { id: finalAccountId },
              data: { balance: { increment: delta } },
            });
          }
          return created;
        });

        // Trigger real-time alert jika pengeluaran > threshold
        if (String(type).toUpperCase() === "EXPENSE") {
          const userObj = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, customAiConfig: true } });
          const config = userObj?.customAiConfig as any;
          const threshold = config?.alertThreshold ?? 500000;

          if (amount >= threshold) {
            await cronQueue.add("realtime-ai-alert", {
              userId,
              userName: userObj?.name || "User",
              amount,
              description
            });
          }
        }

        processedEvents.push({
          action: "record",
          transaction: {
            ...newTx,
            category: catName || "Umum",
            account: accName,
          }
        });
      }
    } catch (parseErr) {
      console.warn("[AI] Gagal parse action JSON:", parseErr);
    }
  }

  const hasDbChanges = processedEvents.some(
    (e) => e.action === "delete" || e.action === "update" || e.action === "record" || e.action === "transfer" || e.action === "adjust_balance",
  );
  if (hasDbChanges) {
    try {
      await clearUserAiCache(userId);
    } catch (err) {
      console.error("[Cache] Failed to clear user AI cache in transactionActions:", err);
    }
  }

  return processedEvents;
};

// ─── Strip [ACTION] blocks from response ────────────────────
export type TransactionActionType =
  | "record_transaction"
  | "update_transaction"
  | "delete_transaction"
  | "draft_transaction"
  | "transfer_balance"
  | "add_subscription"
  | "set_alert_threshold"
  | "adjust_balance";

export function stripActions(content: string): string {
  // Since we use native function calling now, the content usually won't have [ACTION] blocks.
  // But we keep this for backward compatibility with old chat history just in case.
  return content
    .replace(/\[ACTION:(record_transaction|update_transaction|delete_transaction|draft_transaction|transfer_balance|add_subscription|set_alert_threshold|adjust_balance)\][\s\S]*?\[\/ACTION\]/g, "")
    .trim();
}

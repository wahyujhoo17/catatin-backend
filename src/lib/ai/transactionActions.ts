import prisma from "../prisma";
import { clearUserAiCache } from "../redis";
import { cronQueue } from "../queue";
import { checkAndTriggerBudgetAlerts } from "../../services/budgetAlert";
import { validateAiToolCall } from "./actionRequests";
import { decryptAiSecret, encryptAiSecret } from "./secrets";

export const processTransactionActions = async (toolCalls: any[], userId: string, accounts: any[]) => {
  const processedEvents: any[] = [];

  for (const toolCall of toolCalls) {
    if (!toolCall.function || !toolCall.function.name) continue;

    try {
      const normalizedCall = validateAiToolCall(toolCall);
      const actionType = normalizedCall.function.name;
      const parsed = JSON.parse(normalizedCall.function.arguments);
      
      if (actionType === "delete_transaction") {
        if (accounts.length === 0) continue;
        const txId = parsed.id;
        if (!txId) continue;
        const existingTx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (!existingTx || existingTx.userId !== userId) continue;

        // Cari semua transaksi terkait (linkedTransactionId, splitGroupId, atau linkedFrom)
        const whereConditions: any[] = [
          { id: txId },
          { linkedTransactionId: txId }
        ];
        if (existingTx.linkedTransactionId) {
          whereConditions.push({ id: existingTx.linkedTransactionId });
        }
        if (existingTx.splitGroupId) {
          whereConditions.push({ splitGroupId: existingTx.splitGroupId });
        }

        // Robust Peer Transfer matching fallback
        if (existingTx.isTransfer) {
          const peerTx = await prisma.transaction.findFirst({
            where: {
              userId,
              amount: existingTx.amount,
              isTransfer: true,
              type: existingTx.type === "EXPENSE" ? "INCOME" : "EXPENSE",
              id: { not: existingTx.id },
              createdAt: {
                gte: new Date(existingTx.createdAt.getTime() - 15000),
                lte: new Date(existingTx.createdAt.getTime() + 15000),
              }
            }
          });
          if (peerTx) {
            whereConditions.push({ id: peerTx.id });
          }
        }

        const relatedTxs = await prisma.transaction.findMany({
          where: {
            userId,
            OR: whereConditions
          },
          include: {
            account: { select: { name: true } },
            category: { select: { name: true } }
          }
        });

        await prisma.$transaction(async (tx) => {
          const balanceDeltas = new Map<string, number>();
          for (const item of relatedTxs) {
            if (!item.accountId) continue;
            const delta =
              item.type === "INCOME" || item.type === "DEBT"
                ? -item.amount
                : item.amount;
            balanceDeltas.set(
              item.accountId,
              (balanceDeltas.get(item.accountId) || 0) + delta,
            );
          }
          const affectedAccounts = await tx.account.findMany({
            where: {
              userId,
              id: { in: [...balanceDeltas.keys()] },
            },
            select: { id: true, balance: true },
          });
          for (const [accountId, delta] of balanceDeltas) {
            const account = affectedAccounts.find(
              (item) => item.id === accountId,
            );
            if (!account || account.balance + delta < 0) {
              throw new Error(
                "Transaksi tidak dapat dihapus karena akan membuat saldo negatif",
              );
            }
          }

          for (const item of relatedTxs) {
            // Revert account balance
            if (item.accountId) {
              const delta = item.type === "INCOME" || item.type === "DEBT" ? -item.amount : item.amount;
              await tx.account.update({
                where: { id: item.accountId },
                data: { balance: { increment: delta } },
              });
            }
            // Revert customer debt if applicable
            if (item.customerId && item.type === "DEBT") {
              await tx.customer.update({
                where: { id: item.customerId },
                data: { debt: { decrement: item.amount } }
              });
            }
            const flatItem = {
              ...item,
              account: item.account?.name || "Umum",
              category: item.category?.name || "Umum"
            };
            await tx.transaction.delete({ where: { id: item.id } });
            processedEvents.push({ action: "delete", transaction: flatItem });
          }
        });

        continue;
      }

      if (actionType === "update_transaction") {
        if (accounts.length === 0) continue;
        const txId = parsed.id;
        const newAmount = parsed.amount;
        const newDesc = parsed.description;
        if (!txId || typeof newAmount !== "number") continue;

        const existingTx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (!existingTx || existingTx.userId !== userId) continue;

        // Find linked transaction if this is a transfer
        let peerTx = null;
        const wherePeer: any[] = [{ linkedTransactionId: existingTx.id }];
        if (existingTx.linkedTransactionId) {
          wherePeer.push({ id: existingTx.linkedTransactionId });
        }

        if (wherePeer.length > 0) {
          peerTx = await prisma.transaction.findFirst({
            where: { userId, OR: wherePeer }
          });
        }

        const updatedTx = await prisma.$transaction(async (tx) => {
          const effect = (type: string, value: number) =>
            type === "INCOME" || type === "DEBT" ? value : -value;
          const balanceDeltas = new Map<string, number>();
          if (existingTx.accountId) {
            balanceDeltas.set(
              existingTx.accountId,
              effect(existingTx.type, newAmount) -
                effect(existingTx.type, existingTx.amount),
            );
          }
          if (peerTx?.accountId) {
            balanceDeltas.set(
              peerTx.accountId,
              (balanceDeltas.get(peerTx.accountId) || 0) +
                effect(peerTx.type, newAmount) -
                effect(peerTx.type, peerTx.amount),
            );
          }
          const affectedAccounts = await tx.account.findMany({
            where: {
              userId,
              id: { in: [...balanceDeltas.keys()] },
            },
            select: { id: true, balance: true },
          });
          for (const [accountId, delta] of balanceDeltas) {
            const account = affectedAccounts.find(
              (item) => item.id === accountId,
            );
            if (!account || account.balance + delta < 0) {
              throw new Error(
                "Perubahan transaksi akan membuat saldo negatif",
              );
            }
            if (delta !== 0) {
              await tx.account.update({
                where: { id: accountId },
                data: { balance: { increment: delta } },
              });
            }
          }
          if (existingTx.customerId && existingTx.type === "DEBT") {
            await tx.customer.update({
              where: { id: existingTx.customerId },
              data: {
                debt: { increment: newAmount - existingTx.amount },
              },
            });
          }

          // Update peer transaction
          if (peerTx) {
            const updatedPeer = await tx.transaction.update({
              where: { id: peerTx.id },
              data: {
                amount: newAmount,
                description: newDesc || peerTx.description
              }
            });
            processedEvents.push({ action: "update", transaction: updatedPeer });
          }

          // Update target transaction
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
        if (accounts.length === 0) continue;
        let { fromAccountId, toAccountId, amount, description } = parsed;
        if (!fromAccountId || !toAccountId || !amount || amount <= 0) continue;

        // Strip out brackets if AI accidentally includes them
        fromAccountId = fromAccountId.replace(/[\[\]]/g, "");
        toAccountId = toAccountId.replace(/[\[\]]/g, "");

        const fromAcc = accounts.find((a) => a.id === fromAccountId || a.name.toLowerCase() === fromAccountId.toLowerCase());
        const toAcc = accounts.find((a) => a.id === toAccountId || a.name.toLowerCase() === toAccountId.toLowerCase());
        if (!fromAcc || !toAcc) {
          console.warn(`[AI] Invalid transfer accounts: ${fromAccountId} -> ${toAccountId}`);
          continue;
        }
        if (fromAcc.id === toAcc.id) {
          processedEvents.push({
            action: "error",
            message: "Akun asal dan tujuan transfer harus berbeda",
          });
          continue;
        }

        const transferTx = await prisma.$transaction(async (tx) => {
          const catOut = await tx.category.upsert({
            where: { userId_name: { userId, name: "Transfer Keluar" } },
            update: {},
            create: { userId, name: "Transfer Keluar", type: "EXPENSE" },
          });
          const catIn = await tx.category.upsert({
            where: { userId_name: { userId, name: "Transfer Masuk" } },
            update: {},
            create: { userId, name: "Transfer Masuk", type: "INCOME" },
          });
          const expenseTx = await tx.transaction.create({
            data: {
              userId,
              type: "EXPENSE",
              amount,
              description: description || `Transfer ke ${toAcc.name}`,
              categoryId: catOut.id,
              accountId: fromAcc.id,
              source: "CHAT",
              isTransfer: true,
              date: new Date(),
            }
          });
          const debited = await tx.account.updateMany({
            where: {
              id: fromAcc.id,
              userId,
              balance: { gte: amount },
            },
            data: { balance: { decrement: amount } }
          });
          if (debited.count !== 1) {
            throw new Error("Saldo akun asal tidak mencukupi");
          }

          const incomeTx = await tx.transaction.create({
            data: {
              userId,
              type: "INCOME",
              amount,
              description: description || `Transfer dari ${fromAcc.name}`,
              categoryId: catIn.id,
              accountId: toAcc.id,
              source: "CHAT",
              isTransfer: true,
              date: new Date(),
              linkedTransactionId: expenseTx.id
            }
          });

          // Link back from expense to income
          await tx.transaction.update({
            where: { id: expenseTx.id },
            data: { linkedTransactionId: incomeTx.id }
          });

          await tx.account.update({
            where: { id: toAcc.id },
            data: { balance: { increment: amount } }
          });

          return { expenseTx, incomeTx };
        });

        // Event for frontend (consolidated for better UX message)
        processedEvents.push({
          action: "transfer",
          transaction: {
            ...transferTx.expenseTx,
            category: "Transfer",
            fromAccount: fromAcc.name,
            toAccount: toAcc.name
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

      // --- delete_subscription ---
      if (actionType === "delete_subscription") {
        const { id, name } = parsed;
        let sub = await prisma.subscription.findFirst({
          where: {
            userId,
            OR: [
              id ? { id } : undefined,
              name ? { name: { contains: name, mode: "insensitive" } } : undefined
            ].filter(Boolean) as any[]
          }
        });

        // Fallback: search all subscriptions for fuzzy keyword matching
        if (!sub) {
          const allSubs = await prisma.subscription.findMany({ where: { userId } });
          const searchKeyword = (name || "").toLowerCase().trim();
          sub = allSubs.find((s) => {
            const subName = s.name.toLowerCase();
            return (
              subName.includes(searchKeyword) ||
              searchKeyword.includes(subName) ||
              (searchKeyword.includes("menabung") && subName.includes("tabung")) ||
              (searchKeyword.includes("tabung") && subName.includes("menabung"))
            );
          }) || null;
        }

        if (!sub) {
          console.warn(`[AI] Subscription not found for delete: ${id || name}`);
          continue;
        }

        await prisma.subscription.delete({ where: { id: sub.id } });
        processedEvents.push({
          action: "delete_subscription",
          subscription: sub
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
        const {
          apiKey,
          elevenLabsApiKey,
          ...configWithoutPlaintextSecrets
        } = config;
        const secureConfig = {
          ...configWithoutPlaintextSecrets,
          ...(config.apiKeyEncrypted || apiKey
            ? {
                apiKeyEncrypted:
                  config.apiKeyEncrypted ||
                  encryptAiSecret(decryptAiSecret(apiKey)),
              }
            : {}),
          ...(config.elevenLabsApiKeyEncrypted || elevenLabsApiKey
            ? {
                elevenLabsApiKeyEncrypted:
                  config.elevenLabsApiKeyEncrypted ||
                  encryptAiSecret(decryptAiSecret(elevenLabsApiKey)),
              }
            : {}),
        };
        
        await prisma.user.update({
          where: { id: userId },
          data: {
            customAiConfig: { ...secureConfig, alertThreshold: threshold },
          },
        });

        processedEvents.push({
          action: "set_alert_threshold",
          threshold
        });
        continue;
      }

      // --- set_budget ---
      if (actionType === "set_budget") {
        const { category: catName, amount, period } = parsed;
        if (typeof amount !== "number" || amount <= 0) continue;

        let categoryId: string | null = null;
        if (catName && typeof catName === "string" && !["keseluruhan", "semua", "total", "global", "all"].includes(catName.trim().toLowerCase())) {
          const existingCat = await prisma.category.findFirst({
            where: { userId, name: catName }
          });
          if (existingCat) {
            categoryId = existingCat.id;
          }
        }

        const validPeriod = period || "MONTHLY";

        // Cek apakah budget untuk kategori & periode ini sudah ada
        const existingBudget = await prisma.budget.findFirst({
          where: {
            userId,
            categoryId,
            period: validPeriod,
          },
        });

        let budgetObj;
        if (existingBudget) {
          budgetObj = await prisma.budget.update({
            where: { id: existingBudget.id },
            data: { amount },
            include: { category: true },
          });
        } else {
          budgetObj = await prisma.budget.create({
            data: {
              userId,
              categoryId,
              amount,
              period: validPeriod,
            },
            include: { category: true },
          });
        }

        processedEvents.push({
          action: "set_budget",
          budget: budgetObj
        });
        continue;
      }

      // --- delete_budget ---
      if (actionType === "delete_budget") {
        const { category: catName, period } = parsed;
        const validPeriod = period || "MONTHLY";

        let categoryId: string | null = null;
        if (catName && typeof catName === "string" && !["keseluruhan", "semua", "total", "global", "all"].includes(catName.trim().toLowerCase())) {
          const existingCat = await prisma.category.findFirst({
            where: { userId, name: catName }
          });
          if (!existingCat) {
            processedEvents.push({
              action: "error",
              message: `Kategori budget "${catName}" tidak ditemukan`,
            });
            continue;
          }
          categoryId = existingCat.id;
        }

        const existingBudget = await prisma.budget.findFirst({
          where: {
            userId,
            categoryId,
            period: validPeriod,
          },
          include: { category: true }
        });

        if (existingBudget) {
          await prisma.budget.delete({ where: { id: existingBudget.id } });
          processedEvents.push({
            action: "delete_budget",
            budget: existingBudget
          });
        }
        continue;
      }

      // --- split_bill ---
      if (actionType === "split_bill") {
        if (accounts.length === 0) continue;
        const { totalAmount, description, category: catName, accountId, splits } = parsed;
        if (typeof totalAmount !== "number" || totalAmount <= 0 || !description || !Array.isArray(splits)) continue;

        let finalAccountId: string | null = null;
        if (accountId) {
          const acc = accounts.find((a) => a.id === accountId || a.name.toLowerCase() === accountId.toLowerCase());
          if (acc) finalAccountId = acc.id;
        }
        if (!finalAccountId) {
          processedEvents.push({
            action: "error",
            message: "Akun pembayaran split bill wajib dipilih",
          });
          continue;
        }

        let categoryId: string | null = null;
        if (catName) {
          const existingCat = await prisma.category.findFirst({
            where: { userId, name: catName }
          });
          if (existingCat) {
            categoryId = existingCat.id;
          } else {
            const newCat = await prisma.category.create({
              data: { userId, name: catName, type: "EXPENSE" }
            });
            categoryId = newCat.id;
          }
        }

        const splitGroupId = "split-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);

        const createdSplitTxs = await prisma.$transaction(async (tx) => {
          let resolvedCategoryId = categoryId;
          if (!resolvedCategoryId && catName) {
            const category = await tx.category.upsert({
              where: { userId_name: { userId, name: catName } },
              update: {},
              create: { userId, name: catName, type: "EXPENSE" },
            });
            resolvedCategoryId = category.id;
          }
          // 1. Create base Expense transaction
          const mainTx = await tx.transaction.create({
            data: {
              userId,
              type: "EXPENSE",
              amount: totalAmount,
              description,
              categoryId: resolvedCategoryId,
              accountId: finalAccountId,
              source: "CHAT",
              splitGroupId,
              date: new Date(),
            }
          });

          const debited = await tx.account.updateMany({
            where: {
              id: finalAccountId,
              userId,
              balance: { gte: totalAmount },
            },
            data: { balance: { decrement: totalAmount } },
          });
          if (debited.count !== 1) {
            throw new Error("Saldo akun pembayaran tidak mencukupi");
          }

          // 2. Create DEBT transactions per target person
          for (const s of splits) {
            if (!s.targetName || typeof s.amount !== "number" || s.amount <= 0) continue;

            let customer = await tx.customer.findFirst({
              where: { userId, name: s.targetName }
            });
            if (!customer) {
              customer = await tx.customer.create({
                data: { userId, name: s.targetName, debt: 0 }
              });
            }

            const debtTx = await tx.transaction.create({
              data: {
                userId,
                type: "DEBT",
                amount: s.amount,
                description: `Piutang Split Bill: ${description} (${s.targetName})`,
                customerId: customer.id,
                source: "CHAT",
                splitGroupId,
                date: new Date(),
                linkedTransactionId: mainTx.id
              }
            });

            await tx.customer.update({
              where: { id: customer.id },
              data: { debt: { increment: s.amount } }
            });
          }

          return mainTx;
        });

        processedEvents.push({
          action: "record",
          transaction: {
            ...createdSplitTxs,
            category: catName || "Umum",
            account: accounts.find((a) => a.id === finalAccountId)?.name || "Umum"
          }
        });
        continue;
      }

      // --- adjust_balance ---
      if (actionType === "adjust_balance") {
        if (accounts.length === 0) continue;
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

      // --- create_saving_goal ---
      if (actionType === "create_saving_goal") {
        const { name, targetAmount, currentAmount, targetDate } = parsed;
        if (!name || typeof targetAmount !== "number" || targetAmount <= 0) continue;

        const newGoal = await prisma.savingGoal.create({
          data: {
            userId,
            name,
            targetAmount,
            currentAmount: typeof currentAmount === "number" ? currentAmount : 0,
            targetDate: targetDate ? new Date(targetDate) : null,
            isCompleted: (typeof currentAmount === "number" ? currentAmount : 0) >= targetAmount,
          }
        });

        processedEvents.push({
          action: "create_saving_goal",
          goal: newGoal
        });
        continue;
      }

      // --- allocate_saving_goal ---
      if (actionType === "allocate_saving_goal") {
        const { goalId, amount } = parsed;
        if (!goalId || typeof amount !== "number" || amount <= 0) continue;

        // Find goal by ID or name
        const matchingGoals = await prisma.savingGoal.findMany({
          where: {
            userId,
            OR: [
              { id: goalId },
              { name: { contains: goalId, mode: "insensitive" } }
            ]
          },
          take: 3,
        });
        const exactGoal = matchingGoals.find(
          (goal) =>
            goal.id === goalId ||
            goal.name.toLowerCase() === String(goalId).toLowerCase(),
        );
        const existingGoal =
          exactGoal || (matchingGoals.length === 1 ? matchingGoals[0] : null);

        if (!existingGoal) {
          processedEvents.push({
            action: "error",
            message:
              matchingGoals.length > 1
                ? "Nama target tabungan ambigu"
                : "Target tabungan tidak ditemukan",
          });
          continue;
        }

        const newCurrentAmount = existingGoal.currentAmount + amount;
        const isCompleted = newCurrentAmount >= existingGoal.targetAmount;

        const updatedGoal = await prisma.savingGoal.update({
          where: { id: existingGoal.id },
          data: {
            currentAmount: newCurrentAmount,
            isCompleted
          }
        });

        processedEvents.push({
          action: "allocate_saving_goal",
          goal: updatedGoal,
          depositedAmount: amount
        });
        continue;
      }

      // --- record_transaction & draft_transaction ---
      if (actionType === "record_transaction" || actionType === "draft_transaction") {
        if (accounts.length === 0) continue;
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
          const cleanAccountId = accountId.replace(/[\[\]]/g, "");
          const acc = accounts.find(
            (a) => a.id === cleanAccountId || a.name.toLowerCase() === cleanAccountId.toLowerCase()
          );
          if (acc) {
            finalAccountId = acc.id;
          } else {
            console.warn(`[AI] accountId ${cleanAccountId} tidak valid, abaikan`);
          }
        }
        // Cegah auto-assign akun! Jika AI tidak menyebutkan dompet (kecuali draft_transaction), paksa gagal agar AI bertanya.
        if (!finalAccountId && actionType !== "draft_transaction") {
          console.warn(`[AI] record_transaction gagal karena accountId kosong. Harap tanya user.`);
          // Tambahkan ke output agar LLM tahu bahwa dia harus bertanya
          processedEvents.push({
            action: "error",
            message: `Gagal mencatat transaksi "${description}": accountId kosong. Kamu WAJIB bertanya kepada user dompet mana yang digunakan beserta [ASK_ACCOUNT:...]`
          });
          continue;
        }

        // Cari atau buat kategori
        let categoryId: string | null = null;
        if (catName) {
          const existingCat = await prisma.category.findFirst({
            where: { userId: userId, name: catName },
          });
          if (existingCat) {
            categoryId = existingCat.id;
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
        const transactionResult = await prisma.$transaction(async (tx) => {
          let resolvedCategoryId = categoryId;
          if (!resolvedCategoryId && catName) {
            const category = await tx.category.upsert({
              where: { userId_name: { userId, name: catName } },
              update: {},
              create: { userId, name: catName, type: type as any },
            });
            resolvedCategoryId = category.id;
          }
          const created = await tx.transaction.create({
            data: {
              userId: userId,
              type: type as any,
              amount,
              description,
              categoryId: resolvedCategoryId,
              accountId: finalAccountId,
              source: "CHAT",
              date: new Date(),
            },
          });
          
          if (finalAccountId) {
            const isExpense = type === "EXPENSE";
            const updated = await tx.account.updateMany({
              where: {
                id: finalAccountId,
                userId,
                ...(isExpense ? { balance: { gte: amount } } : {}),
              },
              data: {
                balance: { increment: isExpense ? -amount : amount },
              },
            });
            if (updated.count !== 1) {
              throw new Error(
                isExpense
                  ? "Saldo akun tidak mencukupi"
                  : "Akun transaksi tidak ditemukan",
              );
            }
          }
          return { created, resolvedCategoryId };
        });
        const newTx = transactionResult.created;
        categoryId = transactionResult.resolvedCategoryId;

        // Trigger real-time & cumulative budget alerts
        if (String(type).toUpperCase() === "EXPENSE") {
          checkAndTriggerBudgetAlerts(userId, amount, description || "Pengeluaran", categoryId).catch((err) => {
            console.error("[BudgetAlert] Error in async AI alert trigger:", err.message);
          });
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
      const errorName =
        parseErr instanceof Error ? parseErr.constructor.name : "";
      const message =
        errorName === "ZodError"
          ? "Parameter aksi AI tidak valid"
          : errorName.startsWith("Prisma")
            ? "Data berubah saat aksi diproses. Silakan coba lagi."
            : parseErr instanceof Error
              ? parseErr.message
              : "Parameter aksi AI tidak valid";
      console.warn("[AI] Gagal memproses aksi:", message);
      processedEvents.push({ action: "error", message });
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
  | "delete_subscription"
  | "set_alert_threshold"
  | "adjust_balance"
  | "set_budget"
  | "delete_budget"
  | "split_bill"
  | "create_saving_goal"
  | "allocate_saving_goal";

export function stripActions(content: string): string {
  // Since we use native function calling now, the content usually won't have [ACTION] blocks.
  // But we keep this for backward compatibility with old chat history just in case.
  return content
    .replace(/\[ACTION:(record_transaction|update_transaction|delete_transaction|draft_transaction|transfer_balance|add_subscription|delete_subscription|set_alert_threshold|adjust_balance|set_budget|delete_budget|split_bill|create_saving_goal|allocate_saving_goal)\][\s\S]*?\[\/ACTION\]/g, "")
    .trim();
}

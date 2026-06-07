import prisma from "../prisma";

export const processTransactionActions = async (content: string, userId: string, accounts: any[]) => {
  const actionRegex = /\[ACTION:\s*(record_transaction|update_transaction|delete_transaction|draft_transaction)\s*\]([\s\S]*?)\[\/ACTION\]/g;
  let match;
  const processedEvents: any[] = [];

  while ((match = actionRegex.exec(content)) !== null) {
    try {
      const actionType = match[1];
      const parsed = JSON.parse(match[2].trim());
      
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

      // --- record_transaction & draft_transaction ---
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
          // Hanya buat kategori di DB jika bukan DRAFT, 
          // tapi untuk DRAFT kita bisa buat saja kategori barunya supaya tidak error saat post
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

      processedEvents.push({
        action: "record",
        transaction: {
          ...newTx,
          category: catName || "Umum",
          account: accName,
        }
      });
    } catch (parseErr) {
      console.warn("[AI] Gagal parse action:", parseErr);
    }
  }

  return processedEvents;
};

// ─── Strip [ACTION] blocks from response ────────────────────
export function stripActions(content: string): string {
  return content
    .replace(/\[ACTION:(record_transaction|update_transaction|delete_transaction)\][\s\S]*?\[\/ACTION\]/g, "")
    .trim();
}

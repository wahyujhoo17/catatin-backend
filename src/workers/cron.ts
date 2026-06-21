import prisma from "../lib/prisma";
import { cronQueue } from "../lib/queue";
import { sendPushNotification } from "../services/notification";
import { aiManager } from "../lib/ai/providerManager";

export function startCronWorker(): void {
  cronQueue.process("daily-ai-alert", async (job) => {
    console.log(`[Worker:Cron] Memproses daily-ai-alert #${job.id}`);

    // Ambil semua user yang memiliki device token (berarti bisa dikirimi notifikasi)
    const usersWithTokens = await prisma.user.findMany({
      where: {
        deviceTokens: { some: {} },
      },
      select: { id: true, name: true },
    });

    console.log(`[Worker:Cron] Ditemukan ${usersWithTokens.length} user dengan device token.`);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    for (const user of usersWithTokens) {
      // Hitung total pengeluaran hari ini
      const expensesToday = await prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          userId: user.id,
          type: "EXPENSE",
          date: { gte: todayStart, lte: todayEnd },
        },
      });

      const totalSpent = expensesToday._sum.amount || 0;

      // Jika pengeluaran hari ini 0, skip notifikasi agar tidak mengganggu
      if (totalSpent === 0) continue;

      // Ambil budget bulan ini untuk perbandingan (opsional)
      const startOfMonth = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
      const endOfMonth = new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 0, 23, 59, 59, 999);
      
      const budgets = await prisma.budget.findMany({
        where: { userId: user.id }
      });
      const totalBudget = budgets.reduce((acc, b) => acc + b.amount, 0);

      let budgetContext = "";
      if (totalBudget > 0) {
        const expensesMonth = await prisma.transaction.aggregate({
          _sum: { amount: true },
          where: {
            userId: user.id,
            type: "EXPENSE",
            date: { gte: startOfMonth, lte: endOfMonth },
          },
        });
        const spentMonth = expensesMonth._sum.amount || 0;
        const remaining = totalBudget - spentMonth;
        budgetContext = `Sisa budget bulan ini: Rp ${remaining.toLocaleString("id-ID")} dari total budget Rp ${totalBudget.toLocaleString("id-ID")}.`;
      }

      // Prompt AI
      const prompt = `Kamu adalah Catatin AI, asisten keuangan pribadi yang ramah dan cerewet. 
Tugasmu: Evaluasi pengeluaran hari ini untuk user bernama ${user.name || "User"}.
Total pengeluaran hari ini: Rp ${totalSpent.toLocaleString("id-ID")}.
${budgetContext}

Instruksi:
- Buatkan pesan pendek (maksimal 150 huruf) bergaya asisten pribadi untuk Push Notification.
- Jika boros (misal > 100rb sehari), berikan teguran ringan/lucu.
- Jika sedikit, puji hemat.
- JANGAN pakai salam bertele-tele, langsung to the point.
- Hanya balas teks notifikasinya saja, jangan ada teks lain.`;

      try {
        const aiResponse = await aiManager.chat([{ role: "user", content: prompt }]);
        const messageText = aiResponse.content?.trim() || "";

        if (messageText) {
          console.log(`[Worker:Cron] Mengirim notifikasi ke ${user.name}: ${messageText}`);
          await sendPushNotification({
            userIds: [user.id],
            title: "Rekap Pengeluaran Hari Ini 💸",
            body: messageText,
            clickAction: "/dashboard",
          });
        }
      } catch (err: any) {
        console.error(`[Worker:Cron] Gagal AI alert untuk user ${user.id}:`, err.message);
      }
    }
  });

  // Processor untuk Real-time Alert (jika ada pengeluaran besar mendadak)
  cronQueue.process("realtime-ai-alert", async (job) => {
    const { userId, userName, amount, description } = job.data;
    console.log(`[Worker:Cron] Memproses realtime-ai-alert #${job.id} untuk user ${userId}`);

    const prompt = `Kamu adalah Catatin AI, asisten keuangan pribadi yang ramah dan proaktif. 
Tugasmu: Berikan teguran atau peringatan instan kepada ${userName || "User"} karena dia baru saja mencatat pengeluaran yang CUKUP BESAR.
Detail transaksi barusan: Rp ${Number(amount).toLocaleString("id-ID")} untuk "${description}".

Instruksi:
- Buatkan pesan pendek (maksimal 150 huruf) bergaya asisten untuk Push Notification.
- Pesan harus terdengar kaget/menegur (misal: "Waduh, baru aja keluar 500rb buat X. Hati-hati ya!").
- JANGAN pakai salam bertele-tele.
- Hanya balas teks notifikasinya saja, jangan ada teks lain.`;

    try {
      const aiResponse = await aiManager.chat([{ role: "user", content: prompt }]);
      const messageText = aiResponse.content?.trim() || "";

      if (messageText) {
        console.log(`[Worker:Cron] Mengirim peringatan real-time ke ${userName}: ${messageText}`);
        await sendPushNotification({
          userIds: [userId],
          title: "Peringatan Pengeluaran Besar 🚨",
          body: messageText,
          clickAction: "/dashboard",
        });
      }
    } catch (err: any) {
      console.error(`[Worker:Cron] Gagal real-time alert untuk user ${userId}:`, err.message);
    }
  });

  console.log("[Worker] Cron worker started");
}

export async function registerCronJobs(): Promise<void> {
  // Jadwalkan pekerjaan berulang (cron)
  // Berjalan setiap hari pada jam 20:00 server time
  await cronQueue.add(
    "daily-ai-alert",
    {},
    {
      repeat: { cron: "0 20 * * *" },
      jobId: "daily-ai-alert-job", // fixed job ID prevents duplicates
    }
  );
  console.log("[Worker] Cron jobs registered");
}

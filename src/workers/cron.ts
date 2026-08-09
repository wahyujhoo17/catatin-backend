import prisma from "../lib/prisma";
import { cronQueue } from "../lib/queue";
import { sendPushNotification } from "../services/notification";
import { aiManager } from "../lib/ai/providerManager";
import { buildDailyRecapExpenseWhere } from "../lib/dailyRecap";

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
        where: buildDailyRecapExpenseWhere({
          userId: user.id,
          start: todayStart,
          end: todayEnd,
        }),
      });

      const totalSpent = expensesToday._sum.amount || 0;

      // Jika pengeluaran hari ini 0, skip notifikasi agar tidak mengganggu
      if (totalSpent === 0) continue;

      // Ambil budget bulan ini untuk perbandingan (opsional) - belum diimplementasi di schema
      let budgetContext = "";


      // Prompt AI
      const prompt = `Kamu adalah Catatin AI, asisten keuangan pribadi yang peka, ekspresif, gaul, dan penuh apresiasi.
Tugasmu: Evaluasi total pengeluaran hari ini untuk ${user.name || "User"}.
Total pengeluaran hari ini: Rp ${totalSpent.toLocaleString("id-ID")}.

Instruksi PENTING:
- Buatkan Push Notification (maksimal 120 huruf).
- Bikin kata-katanya BERVARIASI tiap hari! JANGAN kaku!
- ATURAN TONALITAS & JENIS PENGELUARAN:
  * Jika pengeluaran didominasi KEGIATAN KEBAIKAN (infaq, amal, sedekah, donasi, zakat) atau BAKTI ORANG TUA/KELUARGA atau KEWAJIBAN POKOK (bayar kos, kontrakan, SPP/pendidikan): BERIKAN PUJIAN DAN APRESIASI HANGAT! DILARANG KERAS menyindir, mengomeli, atau bertindak "nyolot"!
  * Jika pengeluaran boros untuk hal-hal konsumtif/hedonisme: omeli dengan lucu/sarkas (misal: "Wahyu, duit itu dicari susah lho, masa hari ini ludes buat yang konsumtif?!").
  * Jika hemat: puji selangit (misal: "Cieee puasa jajan ya hari ini? Pinter banget dompetnya dijaga!").
- DILARANG keras pakai format template yang sama terus-menerus.
- Langsung to the point, tanpa basa-basi "Halo Wahyu".
- Hanya balas teks notifikasinya saja!`;

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
            type: "DAILY_RECAP",
          });
        }
      } catch (err: any) {
        console.error(`[Worker:Cron] Gagal AI alert untuk user ${user.id}:`, err.message);
      }
    }
  });

  // Processor untuk Real-time Alert (jika ada pengeluaran besar mendadak)
  cronQueue.process("realtime-ai-alert", async (job) => {
    const { userId, userName, amount, description, categoryName } = job.data;
    console.log(`[Worker:Cron] Memproses realtime-ai-alert #${job.id} untuk user ${userId}`);

    const prompt = `Kamu adalah Catatin AI, asisten keuangan pribadi yang peka, cerdas, dan ekspresif.
Tugasmu: Buatkan Push Notification (maksimal 120 huruf) untuk transaksi pengeluaran besar berikut:
- Pengguna: ${userName || "User"}
- Nominal: Rp ${Number(amount).toLocaleString("id-ID")}
- Deskripsi: "${description}"
${categoryName ? `- Kategori: "${categoryName}"` : ""}

ATURAN UTAMA SESUAI KLASIFIKASI TRANSAKSI:
1. PENGELUARAN KEBAIKAN & BERBAGI (Infaq, Amal, Sedekah, Zakat, Donasi, Wakaf, Qurban, Panti Asuhan, Bantuan, dsb):
   - WAJIB berikan pujian tulus, doa keberkahan, atau rasa bangga atas kedermawanan pengguna!
   - DILARANG KERAS menyindir, mengomeli, bertindak "nyolot", atau menganggapnya menghamburkan uang!
   - Contoh nada: "MasyaAllah! Berbagi dan beramal tak pernah bikin rugi. Semoga makin berkah & melimpah rezekinya! 🤲✨"

2. BAKTI ORANG TUA & KELUARGA (Kasih/Kirim Uang ke Orang Tua, Uang Saku Ortu, Belanja Ibu/Ayah/Mama/Papa, Nafkah, dsb):
   - WAJIB berikan apresiasi tinggi atas bakti anak kepada orang tua / kehangatan keluarga!
   - DILARANG KERAS menyindir, omeli, atau bersikap sarkas!
   - Contoh nada: "Mantap! Berbakti ke orang tua itu pelancar rezeki terbesar. Anak hebat, semoga rezekinya ngalir terus! ❤️🙏"

3. KEWAJIBAN POKOK & TAGIHAN UTAMA (Bayar Kos, Kontrakan, KPR, SPP/Pendidikan/UKT, PLN/Listrik, PAM/Air, dsb):
   - Berikan apresiasi atas kedisiplinan dan kelegaan menunaikan kewajiban tempat tinggal/pendidikan/kebutuhan dasar.
   - Contoh nada: "Mantap! Bayar kosan beres, pikiran tenang tidur pun nyenyak! 🏠👍"

4. PENGELUARAN KONSUMTIF / HEDON / RUMIT / BOROS (Gaming, Shopping, Top-up Game, Nongkrong, Cafe, Fomo, Barang Mewah, dsb):
   - Boleh bertindak kocak, bernada sarkas halus, julit menghibur atau menegur pengguna agar ingat budget.

ATURAN PENULISAN:
- Maksimal 120 karakter.
- DILARANG pakai format template yang monoton.
- Langsung berikan teks balasannya saja, tanpa tanda kutip.`;

    try {
      const aiResponse = await aiManager.chat([{ role: "user", content: prompt }]);
      const messageText = aiResponse.content?.trim() || "";

      if (messageText) {
        console.log(`[Worker:Cron] Mengirim peringatan real-time ke ${userName}: ${messageText}`);
        await sendPushNotification({
          userIds: [userId],
          title: "Informasi Transaksi 💸",
          body: messageText,
          clickAction: "/dashboard",
          type: "EXPENSE_ALERT",
        });
      }
    } catch (err: any) {
      console.error(`[Worker:Cron] Gagal real-time alert untuk user ${userId}:`, err.message);
    }
  });

  // Processor untuk Peringatan Budget Melebihi Batas (DAILY, WEEKLY, MONTHLY, YEARLY)
  cronQueue.process("budget-limit-exceeded-alert", async (job) => {
    const {
      userId,
      userName,
      period,
      categoryName,
      budgetAmount,
      currentSpent,
      latestTxAmount,
      latestDescription,
    } = job.data;

    console.log(
      `[Worker:Cron] Memproses budget-limit-exceeded-alert #${job.id} me-refer user ${userId}`
    );

    const periodLabelMap: Record<string, string> = {
      DAILY: "Harian",
      WEEKLY: "Mingguan",
      MONTHLY: "Bulanan",
      YEARLY: "Tahunan",
    };
    const periodStr = periodLabelMap[period] || "Bulanan";

    const prompt = `Kamu adalah Catatin AI, asisten keuangan pintar, ekspresif, dan santun.
Tugasmu: Berikan notifikasi untuk ${userName || "User"} karena total pengeluaran ${periodStr} untuk "${categoryName}" SUDAH MELEBIHI TARGET BUDGET!
Detail:
- Periode Budget: ${periodStr}
- Target Budget: Rp ${Number(budgetAmount).toLocaleString("id-ID")}
- Total Terpakai Saat Ini: Rp ${Number(currentSpent).toLocaleString("id-ID")}
- Transaksi Terakhir: Rp ${Number(latestTxAmount).toLocaleString("id-ID")} ("${latestDescription}")

Instruksi PENTING:
- Buat Push Notification (maksimal 120 huruf).
- ATURAN KATEGORI & INTENT TRANSAKSI:
  1. Jika kategori/deskripsi transaksi terkait KEGIATAN KEBAIKAN (Infaq, Amal, Sedekah, Zakat, Donasi) atau BAKTI ORANG TUA/KELUARGA: PERTAHANKAN PUJIAN & RASA HORMAT. Acknowledge kebaikan pengeluarannya dengan doa/apresiasi mulia, sambil ingatkan arus kas secara bijak & halus. DILARANG MENYINDIR ATAU OMELI NYOLOT!
  2. Jika terkait KEWAJIBAN POKOK (Kos, Kontrakan, Pendidikan, SPP): Acknowledge sebagai kebutuhan utama yang penting, beri pengingat ramah untuk atur pos pengeluaran lain.
  3. Jika terkait pengeluaran konsumtif/hedon/rutin: Tegur dengan gaya santai, lucu/sarkas halus atau mengingatkan secara gaul ("Awas sultan", "Rem woi!", "Overbudget bor!").
- Langsung to the point, hanya balas teks notifikasinya saja tanpa tanda kutip.`;

    try {
      const aiResponse = await aiManager.chat([{ role: "user", content: prompt }]);
      const messageText = aiResponse.content?.trim() || "";

      if (messageText) {
        console.log(
          `[Worker:Cron] Mengirim peringatan over-budget ke ${userName}: ${messageText}`
        );
        await sendPushNotification({
          userIds: [userId],
          title: `Over Budget ${periodStr}! ⚠️`,
          body: messageText,
          clickAction: "/dashboard",
          type: "BUDGET_EXCEEDED",
        });
      }
    } catch (err: any) {
      console.error(
        `[Worker:Cron] Gagal budget-limit-exceeded-alert untuk user ${userId}:`,
        err.message
      );
    }
  });

  // Processor untuk Pengingat Tagihan (Subscription Reminder)
  cronQueue.process("daily-subscription-reminder", async (job) => {
    console.log(`[Worker:Cron] Memproses daily-subscription-reminder #${job.id}`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const threeDaysFromNow = new Date(today);
    threeDaysFromNow.setDate(today.getDate() + 3);
    
    // Cari semua langganan yang aktif dan jatuh tempo antara H-1 hingga H-3
    const upcomingSubs = await prisma.subscription.findMany({
      where: {
        isActive: true,
        nextDueDate: {
          gte: today,
          lte: threeDaysFromNow
        }
      },
      include: {
        user: { select: { id: true, name: true, deviceTokens: { take: 1 } } }
      }
    });

    console.log(`[Worker:Cron] Ditemukan ${upcomingSubs.length} tagihan yang akan jatuh tempo.`);

    for (const sub of upcomingSubs) {
      if (!sub.user.deviceTokens || sub.user.deviceTokens.length === 0) continue;

      // Hitung selisih hari
      const diffTime = Math.abs(sub.nextDueDate.getTime() - today.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      const dayText = diffDays === 0 ? "HARI INI" : `${diffDays} hari lagi`;

      const prompt = `Kamu adalah Catatin AI, asisten keuangan yang selalu siap sedia mengingatkan layaknya sekutu terdekat.
Tugasmu: Bikin pengingat tagihan buat ${sub.user.name}. Tagihan "${sub.name}" sebesar Rp ${sub.amount.toLocaleString("id-ID")} akan jatuh tempo ${dayText}.

Instruksi PENTING:
- Bikin pesan Push Notification (maksimal 120 huruf).
- Gunakan nada yang bervariasi: kadang serius mengancam (lucu-lucuan), kadang santai kayak teman, kadang puitis. JANGAN kaku seperti sistem bank!
- Contoh (H-3): "Psst, duit buat ${sub.name} udah disiapin belum? 3 hari lagi lho, jangan sampai kena denda!"
- Jangan pernah ulangi template yang sama.
- Langsung to the point. Hanya balas teks notifikasinya saja!`;

      try {
        const aiResponse = await aiManager.chat([{ role: "user", content: prompt }]);
        const messageText = aiResponse.content?.trim() || "";

        if (messageText) {
          console.log(`[Worker:Cron] Mengirim pengingat tagihan ke ${sub.user.name}: ${messageText}`);
          await sendPushNotification({
            userIds: [sub.user.id],
            title: "Pengingat Tagihan 📅",
            body: messageText,
            clickAction: "/dashboard",
            type: "SUBSCRIPTION_REMINDER",
          });
        }
      } catch (err: any) {
        console.error(`[Worker:Cron] Gagal pengingat tagihan untuk user ${sub.user.id}:`, err.message);
      }
    }
  });

  console.log("[Worker] Cron worker started");
}

export async function registerCronJobs(): Promise<void> {
  // Evaluasi pengeluaran setiap jam 20:00
  await cronQueue.add(
    "daily-ai-alert",
    {},
    {
      repeat: { cron: "0 20 * * *" },
      jobId: "daily-ai-alert-job", 
    }
  );

  // Pengingat tagihan setiap jam 08:00 pagi
  await cronQueue.add(
    "daily-subscription-reminder",
    {},
    {
      repeat: { cron: "0 8 * * *" },
      jobId: "daily-subscription-reminder-job",
    }
  );
  
  console.log("[Worker] Cron jobs registered");
}

import { Hono } from "hono";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { aiManager } from "../lib/ai/providerManager";
import { getDateParts, createDateInTimeZone } from "../lib/timezone";

const dashboard = new Hono();
dashboard.use("*", authMiddleware);

// ─── GET /api/dashboard/summary ──────────────────────────────────
dashboard.get("/summary", async (c) => {
  const { userId } = c.get("user");

  // Rentang bulan ini
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
  );

  // ─── Total saldo dari semua akun ─────────────────────────────
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: { balance: true },
  });
  const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

  // ─── Total pemasukan & pengeluaran bulan ini ─────────────────
  const monthlyAgg = await prisma.transaction.aggregate({
    where: {
      userId,
      date: { gte: startOfMonth, lte: endOfMonth },
    },
    _sum: { amount: true },
  });

  const [incomeTx, expenseTx] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        userId,
        type: "INCOME",
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        userId,
        type: "EXPENSE",
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      _sum: { amount: true },
    }),
  ]);

  const totalIncome = incomeTx._sum.amount || 0;
  const totalExpense = expenseTx._sum.amount || 0;

  // ─── Budget health percentage ────────────────────────────────
  // Asumsikan budget = total pemasukan bulan ini, health = (income - expense) / income
  // Jika tidak ada pemasukan tapi ada pengeluaran → 0% (Kritis)
  // Jika tidak ada pemasukan dan tidak ada pengeluaran → 100% (belum ada aktivitas)
  const budgetHealth =
    totalIncome > 0
      ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100)
      : totalExpense > 0
        ? 0
        : 100;
  const healthLabel =
    budgetHealth >= 70
      ? "Sangat Baik"
      : budgetHealth >= 50
        ? "Baik"
        : budgetHealth >= 30
          ? "Perlu Perhatian"
          : "Kritis";

  // ─── 5 Transaksi terbaru ────────────────────────────────────
  const recentTransactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { date: "desc" },
    take: 5,
    include: {
      category: { select: { name: true, icon: true, color: true } },
    },
  });

  // ─── Top kategori pengeluaran bulan ini ──────────────────────
  const topCategoriesRaw = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: {
      userId,
      type: "EXPENSE",
      date: { gte: startOfMonth, lte: endOfMonth },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: 4,
  });

  // Ambil nama kategori
  const categoryIds = topCategoriesRaw
    .map((c) => c.categoryId)
    .filter(Boolean) as string[];
  const categoriesMap = new Map<
    string,
    { name: string; icon: string | null; color: string | null }
  >();

  if (categoryIds.length > 0) {
    const cats = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, icon: true, color: true },
    });
    for (const cat of cats) {
      categoriesMap.set(cat.id, cat);
    }
  }

  const topCategories = topCategoriesRaw.map((c) => {
    const cat = c.categoryId ? categoriesMap.get(c.categoryId) : null;
    return {
      name: cat?.name || "Tanpa Kategori",
      icon: cat?.icon || "category",
      color: cat?.color || "var(--secondary)",
      amount: c._sum.amount || 0,
      percentage:
        totalExpense > 0
          ? Math.round(((c._sum.amount || 0) / totalExpense) * 100)
          : 0,
    };
  });

  // ─── Smart AI Insight (Cached 12 hours) ──────────────────────
  let aiInsight = "";
  try {
    const userDb = await prisma.user.findUnique({
      where: { id: userId },
      select: { aiInsight: true, aiInsightUpdatedAt: true },
    });
    const nowMs = Date.now();
    const lastUpdateMs = userDb?.aiInsightUpdatedAt?.getTime() || 0;
    const hoursSinceUpdate = (nowMs - lastUpdateMs) / (1000 * 60 * 60);

    if (hoursSinceUpdate > 12 || !userDb?.aiInsight) {
      // Generate new insight
      const prompt = `Kamu AI Catatin. Analisis singkat keuangan user bulan ini: Pemasukan Rp${totalIncome.toLocaleString("id-ID")}, Pengeluaran Rp${totalExpense.toLocaleString("id-ID")}. Kesehatan budget: ${budgetHealth}% (${healthLabel}). Berikan 1 kalimat Insight proaktif yang ramah, memotivasi, atau menegur jika boros (Maks 15-20 kata, gunakan emoji, bahasa gaul santai/asik). Jangan basa-basi.`;

      const aiResponse = await aiManager.chat(
        [{ role: "user", content: prompt }],
        { vision: false },
      );
      aiInsight = aiResponse.content.trim().replace(/^["']|["']$/g, "");

      // Simpan ke DB
      await prisma.user.update({
        where: { id: userId },
        data: { aiInsight, aiInsightUpdatedAt: new Date() },
      });
    } else {
      aiInsight = userDb.aiInsight;
    }
  } catch (err) {
    console.error("Gagal generate AI Insight:", err);
    aiInsight = "Ayo mulai kelola keuanganmu bersama Catatin.";
  }

  return c.json({
    aiInsight,
    balance: totalBalance,
    incomeThisMonth: totalIncome,
    expenseThisMonth: totalExpense,
    budgetHealth,
    healthLabel,
    recentTransactions: recentTransactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description || "Tanpa deskripsi",
      category: tx.category?.name || "Umum",
      categoryIcon: tx.category?.icon || "receipt_long",
      categoryColor: tx.category?.color || "var(--secondary)",
      date: tx.date,
      isExpense: tx.type === "EXPENSE",
    })),
    topCategories,
  });
});

// ─── GET /api/dashboard/chart ─────────────────────────────────────
dashboard.get("/chart", async (c) => {
  const { userId } = c.get("user");
  const range = c.req.query("range") || "today";
  const tz = c.req.header("x-timezone") || "Asia/Jakarta";

  const now = new Date();
  const nowParts = getDateParts(now, tz);
  let startDate: Date;
  let endDate: Date;
  
  let chartData: { label: string; income: number; expense: number }[] = [];
  let diffDays = 1;
  
  if (range === "today") {
    startDate = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 0, 0, 0, 0, tz);
    endDate = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 23, 59, 59, 999, tz);
    
    // 24 hours
    for (let i = 0; i < 24; i++) {
      const label = `${String(i).padStart(2, "0")}:00`;
      chartData.push({ label, income: 0, expense: 0 });
    }
  } else if (range === "week") {
    // Last 7 days in the target timezone
    const todayStart = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 0, 0, 0, 0, tz);
    startDate = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
    endDate = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 23, 59, 59, 999, tz);
    diffDays = 7;
    const dayNames = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
    
    for (let i = 6; i >= 0; i--) {
      const targetDate = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
      const dayParts = getDateParts(targetDate, tz);
      const dayOfWeek = new Date(Date.UTC(dayParts.year, dayParts.month, dayParts.day)).getUTCDay();
      const label = `${dayNames[dayOfWeek]} (${dayParts.day}/${dayParts.month + 1})`;
      chartData.push({ label, income: 0, expense: 0 });
    }
  } else if (range === "month") {
    // Last 30 days in the target timezone
    const todayStart = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 0, 0, 0, 0, tz);
    startDate = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
    endDate = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 23, 59, 59, 999, tz);
    diffDays = 30;
    
    for (let i = 29; i >= 0; i--) {
      const targetDate = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
      const dayParts = getDateParts(targetDate, tz);
      const label = `${dayParts.day}/${dayParts.month + 1}`;
      chartData.push({ label, income: 0, expense: 0 });
    }
  } else if (range === "year") {
    // Last 12 months in the target timezone
    let startMonth = nowParts.month - 11;
    let startYear = nowParts.year;
    if (startMonth < 0) {
      startMonth += 12;
      startYear -= 1;
    }
    startDate = createDateInTimeZone(startYear, startMonth, 1, 0, 0, 0, 0, tz);
    endDate = createDateInTimeZone(nowParts.year, nowParts.month, nowParts.day, 23, 59, 59, 999, tz);
    diffDays = 365;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
    
    for (let i = 11; i >= 0; i--) {
      let m = nowParts.month - i;
      let y = nowParts.year;
      if (m < 0) {
        m += 12;
        y -= 1;
      }
      const label = monthNames[m];
      chartData.push({ label, income: 0, expense: 0 });
    }
  } else if (range === "custom") {
    const startStr = c.req.query("start");
    const endStr = c.req.query("end");
    if (!startStr || !endStr) {
      return c.json({ error: "start and end dates are required for custom range" }, 400);
    }
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return c.json({ error: "Invalid start or end date format" }, 400);
    }

    startDate = createDateInTimeZone(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0, tz);
    endDate = createDateInTimeZone(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999, tz);

    const diffTime = endDate.getTime() - startDate.getTime();
    diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) diffDays = 1;

    if (diffDays <= 1) {
      // 24 hours
      for (let i = 0; i < 24; i++) {
        const label = `${String(i).padStart(2, "0")}:00`;
        chartData.push({ label, income: 0, expense: 0 });
      }
    } else if (diffDays <= 8) {
      const dayNames = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
      for (let i = 0; i < diffDays; i++) {
        const targetDate = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
        const dayParts = getDateParts(targetDate, tz);
        const dayOfWeek = new Date(Date.UTC(dayParts.year, dayParts.month, dayParts.day)).getUTCDay();
        const label = `${dayNames[dayOfWeek]} (${dayParts.day}/${dayParts.month + 1})`;
        chartData.push({ label, income: 0, expense: 0 });
      }
    } else if (diffDays <= 31) {
      for (let i = 0; i < diffDays; i++) {
        const targetDate = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
        const dayParts = getDateParts(targetDate, tz);
        const label = `${dayParts.day}/${dayParts.month + 1}`;
        chartData.push({ label, income: 0, expense: 0 });
      }
    } else {
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
      const startParts = getDateParts(startDate, tz);
      const endParts = getDateParts(endDate, tz);
      const totalMonths = (endParts.year - startParts.year) * 12 + (endParts.month - startParts.month) + 1;
      
      for (let i = 0; i < totalMonths; i++) {
        let m = startParts.month + i;
        let y = startParts.year;
        while (m >= 12) {
          m -= 12;
          y += 1;
        }
        const label = `${monthNames[m]} ${String(y).slice(-2)}`;
        chartData.push({ label, income: 0, expense: 0 });
      }
    }
  } else {
    return c.json({ error: "Invalid range parameter" }, 400);
  }

  // Fetch all transactions in the range
  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      date: { gte: startDate, lte: endDate },
      type: { in: ["INCOME", "EXPENSE"] }
    },
    orderBy: { date: "asc" },
    include: {
      category: { select: { name: true, icon: true, color: true } }
    }
  });

  // Populate chartData
  let totalIncome = 0;
  let totalExpense = 0;

  for (const tx of transactions) {
    const txDate = new Date(tx.date);
    const txParts = getDateParts(txDate, tz);
    let index = -1;

    if (range === "today" || (range === "custom" && diffDays <= 1)) {
      index = txParts.hour;
    } else if (range === "week" || range === "month" || (range === "custom" && diffDays <= 31)) {
      const txLocalDayStart = Date.UTC(txParts.year, txParts.month, txParts.day);
      const startParts = getDateParts(startDate, tz);
      const startLocalDayStart = Date.UTC(startParts.year, startParts.month, startParts.day);
      const diffDaysIndex = Math.floor((txLocalDayStart - startLocalDayStart) / (1000 * 60 * 60 * 24));
      if (diffDaysIndex >= 0 && diffDaysIndex < chartData.length) {
        index = diffDaysIndex;
      }
    } else if (range === "year" || (range === "custom" && diffDays > 31)) {
      const startParts = getDateParts(startDate, tz);
      const diffMonths = (txParts.year - startParts.year) * 12 + (txParts.month - startParts.month);
      if (diffMonths >= 0 && diffMonths < chartData.length) {
        index = diffMonths;
      }
    }

    if (index >= 0 && index < chartData.length) {
      if (tx.type === "INCOME") {
        chartData[index].income += tx.amount;
        totalIncome += tx.amount;
      } else if (tx.type === "EXPENSE") {
        chartData[index].expense += tx.amount;
        totalExpense += tx.amount;
      }
    }
  }

  // Group by category for breakdown (ONLY FOR EXPENSES)
  const categoryMap = new Map<string, { name: string; icon: string; color: string; amount: number; count: number }>();
  for (const tx of transactions) {
    if (tx.type !== "EXPENSE") continue;
    const catId = tx.categoryId || "general";
    const catName = tx.category?.name || "Umum";
    const catIcon = tx.category?.icon || "receipt_long";
    const catColor = tx.category?.color || "var(--secondary)";

    const existing = categoryMap.get(catId) || { name: catName, icon: catIcon, color: catColor, amount: 0, count: 0 };
    existing.amount += tx.amount;
    existing.count += 1;
    categoryMap.set(catId, existing);
  }

  const categoryBreakdown = Array.from(categoryMap.values()).map(cat => ({
    name: cat.name,
    icon: cat.icon,
    color: cat.color,
    amount: cat.amount,
    count: cat.count,
    percentage: totalExpense > 0 ? Math.round((cat.amount / totalExpense) * 100) : 0
  })).sort((a, b) => b.amount - a.amount);

  // Summary statistics
  const netSavings = totalIncome - totalExpense;
  const expenseRatio = totalIncome > 0 ? Math.round((totalExpense / totalIncome) * 100) : (totalExpense > 0 ? 100 : 0);
  
  // Calculate average daily expense
  const avgDailyExpense = Math.round(totalExpense / diffDays);

  // Recommendations
  let recommendation = "";
  if (totalExpense === 0) {
    recommendation = "Belum ada pengeluaran terdeteksi. Pertahankan pencatatan tertibmu.";
  } else if (expenseRatio > 80) {
    const topCat = categoryBreakdown[0];
    recommendation = `Pengeluaranmu sudah mencapai ${expenseRatio}% dari pemasukan. Kurangi pengeluaran untuk ${topCat ? topCat.name : "kategori teratas"} ya.`;
  } else if (expenseRatio > 50) {
    recommendation = `Keuanganmu cukup stabil, namun ingat untuk menyisihkan setidaknya 20% untuk tabungan dan investasi.`;
  } else {
    recommendation = `Luar biasa! Rasio pengeluaranmu hanya ${expenseRatio}%. Pertahankan gaya hidup hemat ini.`;
  }

  // Fetch account balances for the user
  const accountsData = await prisma.account.findMany({
    where: { userId },
    select: { id: true, name: true, type: true, balance: true, icon: true, color: true },
    orderBy: { balance: "desc" }
  });

  return c.json({
    summary: {
      totalIncome,
      totalExpense,
      netSavings,
      expenseRatio,
      avgDailyExpense,
      recommendation
    },
    chartData,
    categoryBreakdown,
    transactions: transactions.map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description || "Tanpa deskripsi",
      category: tx.category?.name || "Umum",
      categoryIcon: tx.category?.icon || "receipt_long",
      categoryColor: tx.category?.color || "var(--secondary)",
      date: tx.date,
      isExpense: tx.type === "EXPENSE"
    })),
    accounts: accountsData
  });
});

export default dashboard;

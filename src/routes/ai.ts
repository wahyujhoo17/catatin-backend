import { Hono } from "hono";
import { stream } from "hono/streaming";
import prisma from "../lib/prisma";
import redis, { clearUserAiCache } from "../lib/redis";
import { authMiddleware } from "../middleware/auth";
import { aiManager } from "../lib/ai/providerManager";
import { cronQueue } from "../lib/queue";
import type { ChatMessage } from "../lib/ai/types";
import {
  processTransactionActions,
  stripActions,
} from "../lib/ai/transactionActions";

const aiRoutes = new Hono();

// ─── Types ────────────────────────────────────────────────────
interface CustomProvider {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
}

// ─── Helper: Ambil custom AI config user dari database ────────
async function getUserCustomProvider(
  userId: string,
): Promise<CustomProvider | null> {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { customAiConfig: true },
    });
    const config = dbUser?.customAiConfig as any;
    if (config?.enabled && config?.apiKey) {
      return {
        provider: config.provider || "openai",
        baseUrl: config.baseUrl || "https://api.openai.com/v1",
        apiKey: config.apiKey,
        model: config.model || undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── All AI routes require auth ───────────────────────────────
aiRoutes.use("*", authMiddleware);

// ─── Shared: Kategori default untuk acuan AI ──────────────────
const DEFAULT_EXPENSE_CATS = [
  "Makanan",
  "Minuman",
  "Transportasi",
  "Bensin",
  "Parkir",
  "Belanja",
  "Pakaian",
  "Skincare",
  "Kesehatan",
  "Obat-obatan",
  "Olahraga",
  "Pendidikan",
  "Buku",
  "Tagihan Listrik",
  "Tagihan Air",
  "Internet",
  "Pulsa",
  "Sewa",
  "Cicilan",
  "Asuransi",
  "Pajak",
  "Rumah Tangga",
  "Perawatan Hewan",
  "Hiburan",
  "Game",
  "Streaming",
  "Langganan",
  "Perjalanan",
  "Hotel",
  "Makan di Restoran",
  "Kopi & Kafe",
  "Hadiah",
  "Donasi",
  "Keagamaan",
  "Anak",
  "Tabungan",
  "Investasi",
  "Biaya Bank",
  "Biaya Admin",
  "Dana Darurat",
  "Lainnya",
];
const DEFAULT_INCOME_CATS = [
  "Gaji",
  "Bonus",
  "THR",
  "Komisi",
  "Lembur",
  "Freelance",
  "Proyek",
  "Konsultasi",
  "Bisnis",
  "Penjualan Produk",
  "Penjualan Jasa",
  "Investasi",
  "Dividen",
  "Bunga Tabungan",
  "Bunga Deposito",
  "Capital Gain",
  "Royalti",
  "Sewa Properti",
  "Sewa Kendaraan",
  "Affiliate",
  "Content Creator",
  "YouTube",
  "TikTok",
  "Blog",
  "Donasi",
  "Hadiah",
  "Uang Saku",
  "Tunjangan",
  "Beasiswa",
  "Refund",
  "Cashback",
  "Reward",
  "Poin Loyalitas",
  "Klaim Asuransi",
  "Piutang Dibayar",
  "Pengembalian Pinjaman",
  "Penjualan Aset",
  "Penjualan Barang Bekas",
  "Warisan",
  "Hibah",
  "Pendapatan Pasif",
  "Lainnya",
];

// ─── Shared: Bangun system prompt + data keuangan ─────────────
interface FinancialContext {
  systemPrompt: ChatMessage;
  accounts: { id: string; name: string; type: string; balance: number }[];
  categories: { id: string; name: string; type: string }[];
}

// ─── Tools definition ─────────────────────────────
export const aiTools = [
  {
    type: "function",
    function: {
      name: "record_transaction",
      description: "Catat transaksi pengeluaran atau pemasukan baru",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["EXPENSE", "INCOME"] },
          amount: { type: "number", description: "Nominal angka tanpa titik/koma" },
          description: { type: "string", description: "Deskripsi transaksi" },
          category: { type: "string", description: "Kategori (contoh: Makanan, Gaji, dll)" },
          accountId: { type: "string", description: "ID akun yang digunakan (JANGAN DIISI jika tidak ada dompet yang cocok di data RAHASIA)" }
        },
        required: ["type", "amount", "description", "category"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "draft_transaction",
      description: "Buat DRAFT transaksi dari pemindaian struk (HANYA GUNAKAN SAAT DIMINTA DRAFT)",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["EXPENSE", "INCOME"] },
          amount: { type: "number", description: "Nominal angka tanpa titik/koma" },
          description: { type: "string", description: "Deskripsi transaksi" },
          category: { type: "string", description: "Kategori (contoh: Makanan, Gaji, dll)" },
          accountId: { type: "string", description: "ID akun yang digunakan (kosongkan jika tidak ada petunjuk)" }
        },
        required: ["type", "amount", "description", "category"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "transfer_balance",
      description: "Pindahkan uang/saldo dari satu dompet/akun ke dompet/akun lain",
      parameters: {
        type: "object",
        properties: {
          fromAccountId: { type: "string", description: "ID dompet/akun asal (sumber dana)" },
          toAccountId: { type: "string", description: "ID dompet/akun tujuan (penerima dana)" },
          amount: { type: "number", description: "Nominal angka tanpa titik/koma" },
          description: { type: "string", description: "Deskripsi transfer" }
        },
        required: ["fromAccountId", "toAccountId", "amount"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_subscription",
      description: "Catat jadwal langganan atau tagihan rutin (Netflix, Kos, BPJS, cicilan, dll)",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama langganan/tagihan (misal: 'Kos', 'Netflix')" },
          amount: { type: "number", description: "Nominal angka tanpa titik/koma" },
          cycle: { type: "string", enum: ["MONTHLY", "YEARLY", "WEEKLY", "QUARTERLY", "SEMI_ANNUALLY"], description: "Siklus tagihan. QUARTERLY=3 bulan, SEMI_ANNUALLY=6 bulan." },
          nextDueDate: { type: "string", description: "Tanggal jatuh tempo berikutnya (format: YYYY-MM-DD)" }
        },
        required: ["name", "amount", "cycle", "nextDueDate"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_transaction",
      description: "Ubah data transaksi yang sudah ada",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID transaksi" },
          amount: { type: "number" },
          description: { type: "string" }
        },
        required: ["id", "amount", "description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_transaction",
      description: "Hapus transaksi",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID transaksi" }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_alert_threshold",
      description: "Ubah batas nominal untuk peringatan pengeluaran besar (Real-time AI Alert)",
      parameters: {
        type: "object",
        properties: {
          threshold: { type: "number", description: "Batas nominal pengeluaran (misal 100000 atau 1000000)" }
        },
        required: ["threshold"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "draft_transaction",
      description: "Buat draft transaksi jika info belum lengkap",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["EXPENSE", "INCOME"] },
          amount: { type: "number" },
          description: { type: "string" },
          category: { type: "string" },
          accountId: { type: "string", description: "ID akun (opsional)" }
        },
        required: ["type", "amount", "description"]
      }
    }
  }
];


function isLikelyTransaction(message: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  const hasAmount = /\b\d[\d.,]*(?:[kK]|rb)?\b/.test(text); // 50000, 50k, 50rb, 25.000

  // Kata kerja aksi: HARUS ada untuk dianggap transaksi baru
  const actionVerbs = [
    "beli",
    "bayar",
    "jajan",
    "ongkos",
    "parkir",
    "topup",
    "transfer ke",
    "kirim",
    "catat",
    "ngeluarin",
    "ngabisin",
    "habis",
    "keluar buat",
    "pakai buat",
    "ingatkan",
    "langganan",
    "tagihan",
    "batas pengeluaran",
    "peringatan",
    "alert",
    "threshold",
    // makan-minum
    "makan",
    "minum",
    "sarapan",
    "ngopi",
    "nongkrong",
    "cemilan",
    "snack",
    "ngemil",
    // income
    "terima",
    "dapat",
    "dapet",
    "dibayar",
    "masuk dari",
  ];

  // Kata kunci query (BUKAN transaksi baru) — eksklusi eksplisit
  const queryKeywords = [
    "berapa",
    "total",
    "pengeluaran",
    "pemasukan",
    "riwayat",
    "ringkasan",
    "laporan",
    "summary",
    "minggu",
    "bulan",
    "hari",
    "kemarin",
    "terakhir",
    "lalu",
    "grafik",
    "chart",
    "tanggal",
    "terbesar",
    "terboros",
    "saran",
    "analisa",
    "evaluasi",
    "apakah",
  ];

  const hasActionVerb = actionVerbs.some((kw) => text.includes(kw));
  const isQuery = queryKeywords.some((kw) => text.includes(kw));
  const isSettings = /\b(batas pengeluaran|peringatan|alert|threshold)\b/.test(text);

  // Jika ini permintaan pengaturan batas pengeluaran, abaikan isQuery (karena ada kata "pengeluaran")
  if (isSettings && hasAmount) return true;

  // Transaksi baru = ada amount + ada kata kerja aksi + BUKAN query
  return hasAmount && hasActionVerb && !isQuery;
}

// ─── Parse transaction details from a message like "makan malam 45 rb" ──
// Returns amount, description, category, type for direct DB insertion
function parseTransactionFromMessage(message: string): {
  amount: number;
  description: string;
  category: string;
  type: "EXPENSE" | "INCOME";
} | null {
  const text = message.trim();

  // Extract amount: "45 rb", "50k", "50.000", "50000", "12,5 rb", "12.5 rb"
  const amountMatch = text.match(
    /(\d[\d.,]*)\s*(?:rb|ribu|[kK])\b|(\d[\d.,]*)\b/,
  );
  if (!amountMatch) return null;

  const rawNum = (amountMatch[1] || amountMatch[2])
    .replace(/\./g, "")
    .replace(/,/g, ".");
  let amount = parseFloat(rawNum);
  if (isNaN(amount) || amount <= 0) return null;

  // Apply suffix multiplier
  if (/\s*(?:rb|ribu|[kK])\b/i.test(text)) {
    amount *= 1000;
  }

  // Infer type: income verbs → INCOME, else EXPENSE
  const incomeVerbs = [
    "terima",
    "dapat",
    "dapet",
    "dibayar",
    "masuk dari",
    "gaji",
    "bonus",
    "freelance",
  ];

  // Pattern: "[NamaOrang] bayar hutang/utang" → someone pays debt TO you = INCOME
  const isDebtRepaymentToMe =
    /\b\w+\s+bayar\s+(hutang|utang)\b/i.test(text) ||
    /\bbayar\s+(hutang|utang)\s+ke\s+saya\b/i.test(text);

  const isIncome =
    isDebtRepaymentToMe ||
    incomeVerbs.some((v) => text.toLowerCase().includes(v));
  const type: "EXPENSE" | "INCOME" = isIncome ? "INCOME" : "EXPENSE";

  // Extract description: remove amount + suffix, clean up
  let desc = text
    .replace(/\d[\d.,]*\s*(?:rb|ribu|[kK])?\b/i, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!desc) desc = type === "EXPENSE" ? "Pengeluaran" : "Pemasukan";
  // Capitalize each word
  desc = desc.replace(/\b\w/g, (c) => c.toUpperCase());

  // Infer category from keywords — depends on type
  const expenseCatMap: Record<string, string> = {
    makan: "Makanan",
    sarapan: "Makanan",
    cemilan: "Makanan",
    snack: "Makanan",
    ngemil: "Makanan",
    jajan: "Makanan",
    minum: "Minuman",
    ngopi: "Minuman",
    nongkrong: "Hiburan",
    beli: "Belanja",
    bayar: "Tagihan",
    tagihan: "Tagihan",
    ongkos: "Transportasi",
    parkir: "Transportasi",
    transport: "Transportasi",
    topup: "Lainnya",
    transfer: "Lainnya",
    kirim: "Lainnya",
  };
  const incomeCatMap: Record<string, string> = {
    gaji: "Gaji",
    bonus: "Bonus",
    freelance: "Freelance",
    hadiah: "Hadiah",
    refund: "Refund",
    hutang: "Lainnya",
    utang: "Lainnya",
    bayar: "Lainnya", // "bayar hutang" dari orang lain → Lainnya
  };

  let category = "Lainnya";
  const lower = text.toLowerCase();
  const catMap = type === "INCOME" ? incomeCatMap : expenseCatMap;
  // Check longest keywords first for better matching
  const sortedKeys = Object.keys(catMap).sort((a, b) => b.length - a.length);
  for (const kw of sortedKeys) {
    if (lower.includes(kw)) {
      category = catMap[kw];
      break;
    }
  }

  console.log(
    `[AI] Parsed tx from message: amount=${amount} desc="${desc}" cat=${category} type=${type}`,
  );
  return { amount, description: desc, category, type };
}

// ─── Pre-filter: cheap regex check sebelum LLM classifier ──
// Skip LLM call untuk pesan yang jelas-jelas bukan transaksi (query, saldo, sapaan)
function hasPotentialAmount(message: string): boolean {
  // Amount dengan suffix: 4jt, 50rb, 100k, 2.5juta, 50000
  return /\b\d[\d.,]*(?:\s*(?:jt|juta|rb|ribu|[kK])\b)?/.test(message);
}

// ─── LLM Transaction Classifier ────────────────────────────
// Gunakan LLM untuk klasifikasi transaksi — lebih pintar dari regex,
// bisa handle "4 jt", "gaji masuk", "supriadi bayar hutang", dll.
async function classifyTransactionMessage(
  message: string,
  accounts: { id: string; name: string; type: string }[],
): Promise<{
  isTransaction: boolean;
  amount?: number;
  description?: string;
  type?: "INCOME" | "EXPENSE" | "TRANSFER";
  category?: string;
  accountId?: string;
  accountName?: string;
  needsAccount?: boolean;
} | null> {
  const accountList =
    accounts.map((a) => `${a.name}(${a.type})`).join(", ") || "tidak ada";

  const prompt = `Kamu parser transaksi keuangan. Analisis pesan user dan ekstrak detail transaksi dalam JSON.

ATURAN PENTING:
- "gaji masuk 4 jt ke bca" → {"isTransaction":true,"amount":4000000,"description":"Gaji","type":"INCOME","category":"Gaji","accountName":"BCA"}
- "makan siang 25rb" → {"isTransaction":true,"amount":25000,"description":"Makan siang","type":"EXPENSE","category":"Makanan","needsAccount":true}
- "pindah saldo 50rb dari bca ke bri" → {"isTransaction":true,"amount":50000,"description":"Transfer saldo","type":"TRANSFER"}
- "transfer 100k ke budi" → {"isTransaction":true,"amount":100000,"description":"Transfer ke Budi","type":"EXPENSE","category":"Transfer"}
- "bayar listrik 200rb pake bca" → {"isTransaction":true,"amount":200000,"description":"Bayar Listrik","type":"EXPENSE","category":"Tagihan","accountName":"BCA"}
- "supriadi bayar hutang 50rb" → {"isTransaction":true,"amount":50000,"description":"Supriadi Bayar Hutang","type":"INCOME","category":"Lainnya"}
- "terima gaji 5 juta bulan ini" → {"isTransaction":true,"amount":5000000,"description":"Gaji","type":"INCOME","category":"Gaji","needsAccount":true}

KONVERSI AMOUNT:
- 4 jt / 4 juta = 4000000
- 50rb / 50 ribu = 50000
- 100k = 100000
- 2.5 jt = 2500000
- "50000" tanpa suffix = 50000

TYPE:
- INCOME: gaji, terima, dapat, bonus, freelance, refund, hadiah, hutang dibayar, utang dibayar
- EXPENSE: beli, bayar, makan, minum, transport, tagihan, jajan, transfer keluar (ke orang lain)
- TRANSFER: pindah saldo, transfer antar rekening sendiri, mutasi antar dompet

CATEGORY (pilih salah satu):
- EXPENSE: Makanan, Minuman, Transportasi, Belanja, Hiburan, Tagihan, Kesehatan, Pendidikan, Pakaian, Rumah Tangga, Donasi, Langganan, Perjalanan, Transfer, Lainnya
- INCOME: Gaji, Bonus, Freelance, Investasi, Hadiah, Refund, Lainnya

ACCOUNT: jika user sebut nama akun (${accountList}), masukkan ke accountName.
Jika transaksi tapi tidak sebut akun, set needsAccount: true.
Jika BUKAN transaksi (query, sapaan, tanya saldo, dll): {"isTransaction":false}

OUTPUT: HANYA JSON, tanpa markdown, tanpa \`\`\`, tanpa penjelasan.`;

  try {
    const response = await aiManager.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: message },
      ],
      { temperature: 0, maxTokens: 1000, jsonMode: true },
    );

    const raw = response.content.trim();
    // Bersihkan markdown code fence jika ada
    const jsonStr = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    if (!jsonStr) {
      console.warn("[AI] Transaction classifier returned empty response");
      return null;
    }

    const parsed = JSON.parse(jsonStr);

    // Validasi & normalisasi
    if (!parsed || typeof parsed.isTransaction !== "boolean") return null;
    if (!parsed.isTransaction) return { isTransaction: false };

    // Cari accountId dari accountName
    let accountId: string | undefined;
    if (parsed.accountName) {
      const matched = accounts.find(
        (a) => a.name.toLowerCase() === parsed.accountName.toLowerCase(),
      );
      if (matched) accountId = matched.id;
    }

    return {
      isTransaction: true,
      amount:
        typeof parsed.amount === "number" && parsed.amount > 0
          ? parsed.amount
          : undefined,
      description: parsed.description || undefined,
      type:
        parsed.type === "INCOME" || parsed.type === "EXPENSE"
          ? parsed.type
          : undefined,
      category: parsed.category || undefined,
      accountId,
      accountName: parsed.accountName || undefined,
      needsAccount: parsed.needsAccount === true,
    };
  } catch (err) {
    console.error("[AI] Transaction classifier error:", err);
    return null;
  }
}

// ─── Time range from natural language ──────────────────────
interface TimeRange {
  start: Date;
  end: Date;
  label: string; // e.g., "hari ini", "3 hari terakhir", "bulan lalu"
}

function parseTemporal(message: string): TimeRange | null {
  const text = message.toLowerCase().trim();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // "N hari ini" (colloquial: "2 hari ini" = last 2 days)
  // Cek DULU sebelum "hari ini" supaya "2 hari ini" tidak ditangkap sebagai hari ini
  const daysIniMatch = text.match(/(\d+)\s*hari ini\b/);
  if (daysIniMatch) {
    const days = parseInt(daysIniMatch[1], 10);
    if (days > 0 && days <= 365) {
      const start = new Date(startOfDay);
      start.setDate(start.getDate() - days + 1);
      return { start, end: now, label: `${days} hari terakhir` };
    }
  }

  // "hari ini" / "today"
  if (/\bhari ini\b|today/i.test(text)) {
    return { start: startOfDay, end: now, label: "hari ini" };
  }

  // "kemarin" / "yesterday"
  if (/\bkemarin\b|yesterday/i.test(text)) {
    const y = new Date(startOfDay);
    y.setDate(y.getDate() - 1);
    const yEnd = new Date(y);
    yEnd.setDate(yEnd.getDate() + 1);
    return { start: y, end: yEnd, label: "kemarin" };
  }

  // "N hari terakhir" / "N hari belakangan"
  const daysMatch = text.match(/(\d+)\s*hari\s*(terakhir|belakangan)/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    if (days > 0 && days <= 365) {
      const start = new Date(startOfDay);
      start.setDate(start.getDate() - days + 1);
      return { start, end: now, label: `${days} hari terakhir` };
    }
  }

  // "tadi" / "barusan" / "sekarang" → implicitly today
  if (/\btadi\b|\bbarusan\b|\bsekarang\b/i.test(text)) {
    return { start: startOfDay, end: now, label: "hari ini" };
  }

  // "minggu lalu" / "last week"
  if (/\bminggu lalu\b|last week/i.test(text)) {
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const thisMonday = new Date(startOfDay);
    thisMonday.setDate(thisMonday.getDate() - mondayOffset);
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    return { start: lastMonday, end: thisMonday, label: "minggu lalu" };
  }

  // "minggu ini" / "pekan ini" / "this week"
  if (/\bminggu ini\b|\bpekan ini\b|this week/i.test(text)) {
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(startOfDay);
    monday.setDate(monday.getDate() - mondayOffset);
    return { start: monday, end: now, label: "minggu ini" };
  }

  // "N minggu terakhir"
  const weeksMatch = text.match(/(\d+)\s*minggu\s*(terakhir|belakangan)/);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1], 10);
    if (weeks > 0 && weeks <= 52) {
      const start = new Date(startOfDay);
      start.setDate(start.getDate() - weeks * 7);
      return { start, end: now, label: `${weeks} minggu terakhir` };
    }
  }

  // "bulan lalu" / "last month"
  if (/\bbulan lalu\b|last month/i.test(text)) {
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start: lastMonthStart, end: thisMonthStart, label: "bulan lalu" };
  }

  // "bulan ini" / "this month"
  if (/\bbulan ini\b|this month/i.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, end: now, label: "bulan ini" };
  }

  // "N bulan terakhir"
  const monthsMatch = text.match(/(\d+)\s*bulan\s*(terakhir|belakangan)/);
  if (monthsMatch) {
    const months = parseInt(monthsMatch[1], 10);
    if (months > 0 && months <= 60) {
      const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
      return { start, end: now, label: `${months} bulan terakhir` };
    }
  }

  // "tahun ini" / "this year"
  if (/\btahun ini\b|this year/i.test(text)) {
    const start = new Date(now.getFullYear(), 0, 1);
    return { start, end: now, label: "tahun ini" };
  }

  // "tahun lalu" / "last year"
  if (/\btahun lalu\b|last year/i.test(text)) {
    const start = new Date(now.getFullYear() - 1, 0, 1);
    const end = new Date(now.getFullYear(), 0, 1);
    return { start, end, label: "tahun lalu" };
  }

  // "mingguan" / "weekly" → this week
  if (/\bmingguan\b|weekly/i.test(text)) {
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(startOfDay);
    monday.setDate(monday.getDate() - mondayOffset);
    return { start: monday, end: now, label: "minggu ini" };
  }

  // "bulanan" / "monthly" → this month
  if (/\bbulanan\b|monthly/i.test(text)) {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: now,
      label: "bulan ini",
    };
  }

  return null;
}

// ─── Intent detection: klasifikasi pertanyaan user ────────────
type ChatIntent =
  | "non_finansial"
  | "saldo"
  | "pengeluaran"
  | "pemasukan"
  | "transaksi"
  | "saran"
  | "lengkap";

function analyzeIntent(message: string): {
  intent: ChatIntent;
  timeRange: TimeRange | null;
} {
  const text = message.toLowerCase().trim();

  // ── Non-finansial: cek PERTAMA (paling cepat) ───────────────
  if (/^(hai|halo|hi|hey|test|ping)\b/i.test(text)) {
    return { intent: "non_finansial", timeRange: null };
  }
  if (
    /^(siapa kamu|kamu siapa|help|bantuan|apa yang bisa|bisa apa)\b/i.test(text)
  ) {
    return { intent: "non_finansial", timeRange: null };
  }
  if (/^(apa kabar|selamat (pagi|siang|sore|malam))\b/i.test(text)) {
    return { intent: "non_finansial", timeRange: null };
  }

  // ── Parse temporal DULU sebelum intent lain ─────────────────
  // Supaya "beli kopi 15k tadi" tidak salah ambil timeRange
  const timeRange = parseTemporal(message);

  // ── Transaksi BARU: prioritas tertinggi setelah non-finansial ──────────
  if (isLikelyTransaction(message)) {
    return { intent: "transaksi", timeRange: null };
  }

  // ── Saldo: tidak ada query pengeluaran/pemasukan ────────────
  const hasFinanceQuery =
    /\b(pengeluaran|expense|pemasukan|income|transaksi|belanja|boros|hemat|keluar|habis)\b/i.test(
      text,
    );

  if (
    /\b(saldo|rekening|balance|tabungan|dompet)\b/i.test(text) &&
    !hasFinanceQuery
  ) {
    return { intent: "saldo", timeRange: null }; // saldo tidak pakai timeRange
  }

  // ── "Berapa uang saya" → saldo juga ─────────────────────────
  if (/\bberapa (uang|duit)\b/i.test(text) && !hasFinanceQuery) {
    return { intent: "saldo", timeRange: null };
  }

  // ── Saran / Analisis keuangan: deteksi SEBELUM pengeluaran/pemasukan ────
  if (
    /\b(saran|analisa|analisis|evaluasi|review keuangan|apakah saya boros|apakah aku boros|tips hemat|rekomendasi keuangan|bantu atur|cek kesehatan keuangan|gimana keuangan|bagaimana keuangan)\b/i.test(text)
  ) {
    return { intent: "saran", timeRange };
  }

  // ── Pemasukan (eksplisit, tidak campur pengeluaran) ─────────
  if (
    /\b(pemasukan|income|gaji|bonus|terima gaji)\b/i.test(text) &&
    !/\b(pengeluaran|keluar|expense)\b/i.test(text)
  ) {
    return { intent: "pemasukan", timeRange };
  }

  // ── Pengeluaran atau query keuangan umum ─────────────────────
  if (
    /\b(pengeluaran|expense|keluar|belanja|boros|hemat|budget|habis berapa|abis berapa)\b/i.test(
      text,
    )
  ) {
    return { intent: "pengeluaran", timeRange };
  }

  // ── Ada time reference tapi intent tidak jelas → pengeluaran ─
  if (timeRange) {
    return { intent: "pengeluaran", timeRange };
  }

  // ── Fallback ────────────────────────────────────────────────
  return { intent: "lengkap", timeRange: null };
}

async function extractIntentAndTemporal(
  message: string,
): Promise<{
  intent: ChatIntent;
  timeRange: TimeRange | null;
}> {
  if (!message || !message.trim()) {
    return { intent: "non_finansial", timeRange: null };
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const todayStr = `${year}-${month}-${date}`;
  const dayName = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"][now.getDay()];

  // Calculate dates of the current week (Monday to Sunday)
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mondayDate = new Date(now);
  mondayDate.setDate(now.getDate() + mondayOffset);

  const formatDt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const daysInd = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
  const weekDatesList = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + i);
    weekDatesList.push(`${daysInd[i]} (${formatDt(d)})`);
  }
  const weekDatesStr = weekDatesList.join(", ");

  const prompt = `Kamu AI ekstraktor intent dan rentang tanggal untuk asisten keuangan Catatin.
Tanggal hari ini adalah: ${todayStr} (Hari ${dayName}).
Daftar hari dan tanggal untuk minggu berjalan ini adalah: ${weekDatesStr}.

Tugasmu adalah menganalisis pesan user dan mengekstrak:
1. Intent (non_finansial | saldo | pengeluaran | pemasukan | transaksi | lengkap)
2. Rentang tanggal jika ditanyakan (start date dan end date dalam format YYYY-MM-DD)
3. Label penjelas rentang tersebut (misal: "3 hari terakhir").

Definisi Intent:
- non_finansial: sapaan, bantuan, ucapan terima kasih, atau topik di luar keuangan.
- saldo: menanyakan jumlah uang yang dimiliki, sisa saldo tabungan/rekening.
- pengeluaran: menanyakan jumlah uang yang dihabiskan, belanjaan, biaya hidup, pengeluaran.
- pemasukan: menanyakan gaji, bonus, komisi, uang masuk.
- transaksi: berniat melakukan transaksi baru (misal: "catat makan 50k", "bayar listrik 100rb"), atau mengubah/menghapus transaksi lama.
- saran: meminta analisis, evaluasi, review keuangan, tips hemat, rekomendasi, atau menanyakan "apakah saya boros", "gimana keuangan saya", "bantu atur keuangan".
- lengkap: menanyakan ikhtisar keuangan umum, summary bulanan lengkap, atau gabungan saldo + pengeluaran.

Pedoman Rentang Tanggal (Hitung secara relatif terhadap hari ini: ${todayStr}):
- "hari ini": start dan end adalah hari ini (${todayStr}).
- "kemarin": start dan end adalah kemarin.
- "3 hari kebelakang" / "3 hari terakhir" / "3 hari lalu": start = hari ini minus 2 hari (contoh jika hari ini 2026-06-10, start = 2026-06-08), end = hari ini (${todayStr}).
- Hari dalam seminggu (Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu): Gunakan daftar hari dan tanggal minggu berjalan di atas untuk menentukan tanggal hari tersebut secara presisi. Contoh jika hari ini Kamis 2026-06-11 dan user menanyakan "dari senin sampai hari ini", maka startDate adalah 2026-06-08 (tanggal Senin minggu ini) dan endDate adalah 2026-06-11.
- "minggu lalu": start = hari Senin minggu lalu, end = hari Minggu minggu lalu.
- "minggu ini": start = hari Senin minggu ini, end = hari ini (${todayStr}).
- "bulan lalu": start = tanggal 1 bulan lalu, end = tanggal terakhir bulan lalu.
- "bulan ini": start = tanggal 1 bulan ini, end = hari ini (${todayStr}).
- Jika user menyebut tanggal spesifik (misal "dari tanggal 1 sampai 5 mei 2026"), hitung rentang tanggal tersebut secara presisi.
- Jika tidak ada rentang tanggal spesifik yang ditanyakan, kembalikan null untuk startDate dan endDate.

Keluaran harus berupa JSON valid tanpa penjelasan apa pun, tanpa markdown code blocks.
Format JSON:
{
  "intent": "pengeluaran",
  "startDate": "YYYY-MM-DD" | null,
  "endDate": "YYYY-MM-DD" | null,
  "label": "label rentang waktu" | null
}
`;

  try {
    const res = await aiManager.chat([
      { role: "system", content: prompt },
      { role: "user", content: message }
    ], { temperature: 0, maxTokens: 150, jsonMode: true });

    const raw = res.content.trim();
    const cleanJson = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    if (!cleanJson) {
      console.warn("[AI] Intent LLM extractor returned empty response, falling back to regex.");
      return analyzeIntent(message);
    }

    const parsed = JSON.parse(cleanJson);
    if (!parsed || !parsed.intent) {
      return analyzeIntent(message);
    }

    let timeRange: TimeRange | null = null;
    if (parsed.startDate && parsed.endDate) {
      const start = new Date(parsed.startDate + "T00:00:00");
      const end = new Date(parsed.endDate + "T23:59:59.999");
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        timeRange = {
          start,
          end,
          label: parsed.label || "rentang kustom"
        };
      }
    }

    return {
      intent: parsed.intent as ChatIntent,
      timeRange
    };
  } catch (err) {
    console.error("[AI] Intent LLM extractor failed, falling back to regex:", err);
    return analyzeIntent(message);
  }
}

async function buildFinancialContext(
  userId: string,
  intent: ChatIntent,
  timeRange: TimeRange | null,
  draftMode: boolean = false,
  wantsChart: boolean = false,
): Promise<FinancialContext> {
  const now = new Date();
  const dayName = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"][now.getDay()];
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const timeContext = `Informasi Waktu: Hari ini adalah hari ${dayName}, tanggal ${todayStr}.\n\n`;

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // ─── Tentukan rentang efektif ────────────────────────────
  const range: TimeRange = timeRange || {
    start: intent === "transaksi" ? startOfDay : startOfMonth,
    end: now,
    label: intent === "transaksi" ? "hari ini" : "bulan ini",
  };

  // ─── Caching Check ───────────────────────────────────────
  const cacheKey = `user:context:${userId}:${intent}:${range.start.getTime()}:${range.end.getTime()}:${draftMode}:${wantsChart}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`[AI] Cache HIT for key: ${cacheKey}`);
        return JSON.parse(cached) as FinancialContext;
      }
      console.log(`[AI] Cache MISS for key: ${cacheKey}`);
    } catch (err) {
      console.warn("[AI] Error reading from Redis cache:", err);
    }
  }

  // ─── Tentukan data yang dibutuhkan ──────────────────────
  const needFullContext = intent === "transaksi";
  const needExpense =
    intent === "pengeluaran" || intent === "transaksi" || intent === "lengkap" || intent === "saran";
  const needIncome =
    intent === "pemasukan" || intent === "transaksi" || intent === "lengkap" || intent === "saran";
  const needCategories = needExpense || needFullContext;

  // FIX: recentTx hanya untuk transaksi baru (referensi delete/edit)
  const needRecentTx = needFullContext;

  // category breakdown: untuk query historis saja, bukan transaksi baru
  const needCatBreakdown = needExpense && !needFullContext;
  // income breakdown: untuk pemasukan, saran, dan lengkap
  const needIncCatBreakdown = (intent === "pemasukan" || intent === "saran" || intent === "lengkap") && !needFullContext;
  // Daftar transaksi lengkap (deskripsi, kategori, dll): untuk query historis
  const needTxList =
    (intent === "pengeluaran" || intent === "pemasukan" || intent === "lengkap" || intent === "saran") &&
    !needFullContext;

  // ─── Bangun query plan ───────────────────────────────────────
  const queries: Promise<any>[] = [];
  const keys: string[] = [];

  // Akun: selalu
  keys.push("accounts");
  queries.push(
    prisma.account.findMany({
      where: { userId },
      select: { id: true, name: true, type: true, balance: true },
    }),
  );

  // Kategori: hanya saat dibutuhkan
  keys.push("categories");
  queries.push(
    needCategories
      ? prisma.category.findMany({
          where: { userId },
          select: { id: true, name: true, type: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  );

  // Aggregate pengeluaran
  keys.push("expAgg");
  queries.push(
    needExpense
      ? prisma.transaction.aggregate({
          where: {
            userId,
            date: { gte: range.start, lte: range.end },
            type: "EXPENSE",
            isTransfer: false,
          },
          _sum: { amount: true },
          _count: true,
        })
      : Promise.resolve({ _sum: { amount: null }, _count: 0 }),
  );

  // Aggregate pemasukan
  keys.push("incAgg");
  queries.push(
    needIncome
      ? prisma.transaction.aggregate({
          where: {
            userId,
            date: { gte: range.start, lte: range.end },
            type: "INCOME",
            isTransfer: false,
          },
          _sum: { amount: true },
          _count: true, // FIX: tambah _count supaya bisa sebut "N pemasukan"
        })
      : Promise.resolve({ _sum: { amount: null }, _count: 0 }),
  );

  // Category breakdown: hanya untuk query historis
  keys.push("expByCat");
  queries.push(
    needCatBreakdown
      ? prisma.transaction.groupBy({
          by: ["categoryId"],
          where: {
            userId,
            date: { gte: range.start, lte: range.end },
            type: "EXPENSE",
            isTransfer: false,
          },
          _sum: { amount: true },
          orderBy: { _sum: { amount: "desc" } },
          take: 8,
        })
      : Promise.resolve([]),
  );

  // txList: list transaksi lengkap untuk query historis
  keys.push("txList");
  queries.push(
    needTxList
      ? prisma.transaction.findMany({
          where: {
            userId,
            date: { gte: range.start, lte: range.end },
          },
          select: {
            date: true,
            type: true,
            amount: true,
            description: true,
            category: { select: { name: true } },
            account: { select: { name: true } },
          },
          orderBy: { date: "desc" },
        })
      : Promise.resolve([]),
  );

  // Income by category: untuk intent pemasukan, saran, lengkap
  keys.push("incByCat");
  queries.push(
    needIncCatBreakdown
      ? prisma.transaction.groupBy({
          by: ["categoryId"],
          where: {
            userId,
            date: { gte: range.start, lte: range.end },
            type: "INCOME",
          },
          _sum: { amount: true },
          orderBy: { _sum: { amount: "desc" } },
          take: 8,
        })
      : Promise.resolve([]),
  );

  // Recent tx: hanya untuk transaksi baru (referensi delete/edit)
  keys.push("recentTx");
  queries.push(
    needRecentTx
      ? prisma.transaction.findMany({
          where: { userId, date: { gte: range.start, lte: range.end } },
          select: { id: true, type: true, amount: true, description: true },
          orderBy: { date: "desc" },
          take: 10,
        })
      : Promise.resolve([]),
  );

  const results = await Promise.all(queries);
  const d: Record<string, any> = {};
  keys.forEach((k, i) => (d[k] = results[i]));

  const accounts: {
    id: string;
    name: string;
    type: string;
    balance: number;
  }[] = d.accounts;
  const categories: { id: string; name: string; type: string }[] = d.categories;

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  // ─── Data akun ──────────────────────────────────────────
  const accountListInternal = accounts.length
    ? accounts
        .map(
          (a) =>
            `[${a.id}]${a.name}(${a.type}):${a.balance.toLocaleString("id-ID")}`,
        )
        .join("|")
    : "nol";
  const accountListClean = accounts.length
    ? accounts
        .map((a) => `${a.name}(${a.type}):${a.balance.toLocaleString("id-ID")}`)
        .join("|")
    : "nol";

  // ─── Resolve category names ─────────────────────────────
  const catNameById = new Map<string, string>();
  for (const c of categories) catNameById.set(c.id, c.name);

  function fmtCatBreakdown(
    groups: { categoryId: string | null; _sum: { amount: number | null } }[],
  ): string {
    return groups
      .filter((g) => g._sum.amount && g._sum.amount > 0)
      .map((g) => {
        const name = g.categoryId
          ? catNameById.get(g.categoryId) || g.categoryId
          : "Lainnya";
        return `${name}:Rp${g._sum.amount!.toLocaleString("id-ID")}`;
      })
      .join("|");
  }

  // ─── Bangun data section (single range) ─────────────────
  const expenseTotal = d.expAgg._sum?.amount || 0;
  const expenseCount = d.expAgg._count || 0;
  const incomeTotal = d.incAgg._sum?.amount || 0;
  const incomeCount = d.incAgg._count || 0; // FIX: sekarang ada _count
  const recentTx = d.recentTx as any[];

  // Hitung jumlah hari dalam periode untuk rata-rata harian
  const diffTime = Math.abs(range.end.getTime() - range.start.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
  const avgDailyExpense = Math.round(expenseTotal / diffDays);
  const avgPerTx = expenseCount > 0 ? Math.round(expenseTotal / expenseCount) : 0;

  // Format daily expense breakdown for AI context
  // expByDate sekarang adalah array { date: Date, amount: number } — di-group di sini per tanggal kalender
  function fmtDailyBreakdown(
    rows: { date: Date; amount: number }[],
  ): string {
    if (!rows || rows.length === 0) return "";
    // Group by YYYY-MM-DD (tanggal lokal)
    const byDay: Record<string, number> = {};
    for (const row of rows) {
      const d = new Date(row.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      byDay[key] = (byDay[key] || 0) + row.amount;
    }
    // Urutkan dari terbesar
    return Object.entries(byDay)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 31)
      .filter(([, total]) => total > 0)
      .map(([dateStr, total]) => `${dateStr}:Rp${total.toLocaleString("id-ID")}`)
      .join("|");
  }

  const dataParts: string[] = [];
  if (intent !== "non_finansial") {
    dataParts.push(`Total Saldo: Rp${totalBalance.toLocaleString("id-ID")}`);
    dataParts.push(`Akun: [${accountListClean}]`);
  }
  dataParts.push(`Periode: ${range.label} (${diffDays} hari)`);

  if (needExpense && (expenseTotal > 0 || expenseCount > 0)) {
    let expStr = `Pengeluaran: ${expenseCount} tx | total Rp${expenseTotal.toLocaleString("id-ID")} | Rata-rata Harian: Rp${avgDailyExpense.toLocaleString("id-ID")}/hari | Rata-rata per Transaksi: Rp${avgPerTx.toLocaleString("id-ID")}`;
    const catStr = fmtCatBreakdown(d.expByCat);
    if (catStr) expStr += ` | per-kategori: ${catStr}`;
    // Tambahkan breakdown per-tanggal agar AI bisa jawab "tanggal paling boros"
    const expByDateList = d.txList
      ? d.txList
          .filter((t: any) => t.type === "EXPENSE")
          .map((t: any) => ({ date: t.date, amount: t.amount }))
      : [];
    const dailyStr = fmtDailyBreakdown(expByDateList);
    if (dailyStr) expStr += ` | per-tanggal: ${dailyStr}`;
    dataParts.push(expStr);
  }

  if (needIncome && incomeTotal > 0) {
    let incStr = `Pemasukan: ${incomeCount} tx | total Rp${incomeTotal.toLocaleString("id-ID")}`;
    // P5: Tambah breakdown per-kategori pemasukan
    const incCatStr = fmtCatBreakdown(
      (d.incByCat || []).map((g: any) => ({ categoryId: g.categoryId, _sum: g._sum }))
    );
    if (incCatStr) incStr += ` | per-kategori: ${incCatStr}`;
    dataParts.push(incStr);
  }

  if (needTxList && d.txList && d.txList.length > 0) {
    const txLines = d.txList.map((t: any) => {
      const dateStr = t.date.toISOString().split("T")[0];
      const catName = t.category?.name || "Lainnya";
      const accName = t.account?.name || "Umum";
      const descStr = t.description || "";
      return `[${dateStr}|${t.type}|${catName}|Rp${t.amount.toLocaleString("id-ID")}|${descStr}|${accName}]`;
    });
    dataParts.push(`Daftar Transaksi: ${txLines.join(", ")}`);
  }

  if (needRecentTx && recentTx.length > 0) {
    const txItems = recentTx
      .slice(0, 8)
      .map(
        (t: any) =>
          `[${t.id}]${t.type === "EXPENSE" ? "-" : "+"}${t.description}:${t.amount}`,
      )
      .join("|");
    dataParts.push(`Transaksi hari ini: ${txItems}`);
  }

  const dataSection =
    dataParts.length > 0 ? "DATA:\n" + dataParts.join(" | ") : "";

  // ─── Internal section (hanya saat butuh ACTION) ─────────
  const userCatStr = categories.length
    ? categories.map((c) => `${c.name}(${c.type})`).join(",")
    : "nol";
  const internalSection = needFullContext
    ? `\nRAHASIA - hanya untuk isian accountId di [ACTION], JANGAN disalin ke respons:\n[${accountListInternal}]\nKategori:[${userCatStr}]`
    : "";

  // ─── Account rule (hanya saat ACTION mode) ──────────────
  let accountRule = "";
  if (needFullContext) {
    if (accounts.length === 0) {
      accountRule = "⚠️ Belum ada akun. JANGAN catat transaksi. Suruh user tambah akun dulu.\n";
    } else if (accounts.length === 1) {
      accountRule = "✅ 1 akun: " + accounts[0].name + '. Auto-pakai accountId="' + accounts[0].id + '" untuk semua transaksi.\n';
    } else {
      const accOptions = accounts.map((a) => a.name).join(",");
      accountRule = `📋 ${accounts.length} akun tersedia: ${accOptions}.\n`;
      if (draftMode) {
        accountRule += `ATURAN DRAFT:\n` +
          `1. WAJIB SELALU panggil tool 'draft_transaction'. JANGAN panggil 'record_transaction'.\n` +
          `2. Cek apakah di struk ada petunjuk dompet/akun dari daftar. Jika ada, otomatis isi accountId-nya.\n` +
          `3. JIKA di struk TIDAK ADA petunjuk dompet/akun, kosongkan accountId ("") DAN tambahkan teks: [ASK_ACCOUNT:${accOptions}] di pesan kamu.\n`;
      }
    }

    if (accounts.length > 0 && !draftMode) {
      accountRule +=
        `ATURAN PENTING SAAT MENCATAT TRANSAKSI:\n` +
        `1. Cek apakah user MEMINTA transaksi baru di pesan terakhirmya ATAU meminta pengingat tagihan.\n` +
        `2. JIKA YA: Panggil tool record_transaction, transfer_balance, atau add_subscription. Jika ada BANYAK aksi, panggil tool BERKALI-KALI secara paralel.\n` +
        `   PENTING: Gunakan ID akun yang persis sama dengan RAHASIA di bawah. JANGAN mengarang ID.\n` +
        `3. JIKA AKUN TIDAK TERDAFTAR (contoh: user pakai 'Tunai' tapi tidak ada di daftar): JANGAN panggil tool apapun. Balas dengan teks meminta user memilih akun yang tersedia.\n` +
        `4. JANGAN panggil tool jika user hanya bertanya (misal: tanya saldo, laporan, atau sapaan).\n` +
        `5. Jika mencatat tagihan (add_subscription), pilih cycle yang tepat dan hitung nextDueDate terdekat yang masuk akal.\n` +
        `6. Jika user ingin mengubah batas peringatan pengeluaran besar, gunakan tool set_alert_threshold.\n`;
    }
  }

  // ─── Action format (hanya saat transaksi) ─────────────────────────
  // P6: Gunakan kategori user jika ada, fallback ke default list
  const userExpCats = categories.filter(c => c.type === "EXPENSE").map(c => c.name);
  const userIncCats = categories.filter(c => c.type === "INCOME").map(c => c.name);
  const expCatStr = userExpCats.length > 0
    ? userExpCats.join(",")               // kategori user (lebih pendek, lebih relevan)
    : DEFAULT_EXPENSE_CATS.join(",");     // fallback default
  const incCatStr = userIncCats.length > 0
    ? userIncCats.join(",")
    : DEFAULT_INCOME_CATS.join(",");
  let actionFormat = "";

  if (needFullContext) {
    actionFormat = "AKSI TERSEDIA:\n";
    actionFormat += "Gunakan Function/Tools Calling yang tersedia untuk:\n";
    if (draftMode) {
      actionFormat += "- Membuat draft transaksi (draft_transaction).\n";
      actionFormat += "- Tentukan category secara spesifik.\n";
      actionFormat += "- Jika di struk ada petunjuk dompet/akun, otomatis isi accountId.\n";
    } else {
      actionFormat += "- Mencatat transaksi baru (record_transaction).\n";
      actionFormat += "- Memindahkan uang antar dompet (transfer_balance).\n";
      actionFormat += "- Mengubah transaksi (update_transaction).\n";
      actionFormat += "- Menghapus transaksi (delete_transaction).\n";
    }
    actionFormat +=
      "TENTANG GRAFIK: Jika user minta chart/grafik/diagram, sisipkan [SHOW_CHART:EXPENSE_MONTH] atau [SHOW_CHART:EXPENSE_WEEK] di akhir pesan.\n" +
      `- Kategori EXPENSE prioritas: [${expCatStr}]\n` +
      `- Kategori INCOME prioritas: [${incCatStr}]\n` +
      "- ID Akun (accountId) WAJIB dari daftar akun RAHASIA. Jangan ngarang ID!\n\n" +
      `${accountRule}\n\n`;
  }

  // ─── Chart tag berdasarkan rentang ──────────────────────
  const rangeDays = Math.ceil(
    (range.end.getTime() - range.start.getTime()) / (1000 * 60 * 60 * 24),
  );
  const chartTag =
    rangeDays <= 10
      ? "[SHOW_CHART:EXPENSE_WEEK]"
      : "[SHOW_CHART:EXPENSE_MONTH]";

  // ─── Bangun system prompt per intent ─────────────────────
  let systemContent = "";

  switch (intent) {
    case "non_finansial":
      systemContent =
        "Kamu: Catatin AI, asisten keuangan pribadi. Jawab singkat, tolak sopan jika di luar topik keuangan.\n" +
        "Tawarkan bantuan: catat transaksi, cek saldo, lihat pengeluaran mingguan/bulanan.";
      break;

    case "saldo":
      systemContent =
        "Kamu: Catatin AI, asisten keuangan pribadi.\n\n" +
        "FORMAT:\n" +
        "- Gunakan ### Heading untuk section, **bold** untuk angka saja, - list untuk rincian.\n" +
        "- Beri baris KOSONG sebelum dan sesudah setiap list.\n" +
        "- JANGAN pakai list bertingkat (sub-bullet di dalam bullet).\n" +
        "- Paragraf maksimal 3 kalimat.\n\n" +
        "Aturan:\n" +
        "- Jawab pertanyaan saldo HANYA dari DATA di bawah.\n" +
        "- Jika user tanya akun spesifik: jawab HANYA akun itu.\n" +
        "- Jika user tanya saldo umum: sebut Total Saldo, rinci per akun.\n" +
        "- Nada: ramah, hangat, seperti teman. SESUAIKAN dengan kondisi:\n" +
        "  * Saldo sehat → santai, optimis.\n" +
        "  * Saldo menipis → ingatkan hemat dengan sopan.\n\n" +
        dataSection;
      break;

    case "pengeluaran":
      systemContent =
        "Kamu: Catatin AI, asisten keuangan pribadi.\n\n" +
        "FORMAT:\n" +
        "- Gunakan ### Heading untuk section, **bold** untuk angka saja, - list untuk rincian.\n" +
        "- Beri baris KOSONG sebelum dan sesudah setiap list.\n" +
        "- JANGAN pakai list bertingkat (sub-bullet di dalam bullet).\n" +
        "- Paragraf maksimal 3 kalimat.\n\n" +
        `Aturan (periode: ${range.label}):\n` +
        "- Jawab pertanyaan pengeluaran HANYA dari DATA di bawah.\n" +
        "- Sebutkan total pengeluaran + breakdown per-kategori dengan - list.\n" +
        "- Jika user bertanya tanggal/hari paling boros, jawab dari data per-tanggal.\n" +
        // P4: instruksi saran/analisis
        "- Jika user minta evaluasi, analisa, atau saran: berikan 2-3 rekomendasi konkret berbasis DATA.\n" +
        (wantsChart
          ? `- User minta grafik: akhiri dengan ${chartTag}.\n`
          : "") +
        "- Nada: ramah, SESUAIKAN dengan kondisi DATA:\n" +
        "  * Pengeluaran wajar → santai.\n" +
        "  * Pengeluaran > pemasukan → ingatkan dengan sopan, beri tips hemat.\n" +
        "  * JANGAN bilang 'Masih aman' kalau defisit.\n\n" +
        dataSection;
      break;

    case "pemasukan":
      systemContent =
        "Kamu: Catatin AI, asisten keuangan pribadi.\n\n" +
        "FORMAT:\n" +
        "- Gunakan ### Heading untuk section, **bold** untuk angka saja, - list untuk rincian.\n" +
        "- Beri baris KOSONG sebelum dan sesudah setiap list.\n" +
        "- JANGAN pakai list bertingkat. Paragraf maksimal 3 kalimat.\n\n" +
        `Aturan (periode: ${range.label}):\n` +
        "- Jawab pertanyaan pemasukan HANYA dari DATA di bawah.\n" +
        // P5: instruksi breakdown kategori pemasukan
        "- Sebutkan total pemasukan dan breakdown per-sumber jika ada.\n" +
        "- Nada: ramah, hangat.\n\n" +
        dataSection;
      break;

    // P1: Case khusus saran/analisis keuangan
    case "saran":
      systemContent =
        "Kamu: Catatin AI, asisten keuangan dan analis finansial pribadi.\n\n" +
        "FORMAT:\n" +
        "- Gunakan ### Heading untuk section, **bold** untuk angka dan poin penting.\n" +
        "- Beri baris KOSONG sebelum dan sesudah setiap list.\n" +
        "- Gunakan list bernomor urut (1., 2., 3., dst.) untuk rekomendasi, - list untuk rincian.\n" +
        "- PENTING: Tulis nomor list dan teks di baris yang sama (contoh: '1. Batasi pengeluaran...'). JANGAN menuliskan nomor list di baris terpisah atau menggunakan angka 1. untuk semua item.\n" +
        "- Paragraf maksimal 3 kalimat.\n\n" +
        `Aturan (periode: ${range.label}):\n` +
        "- WAJIB berikan analisis mendalam dari DATA di bawah — jangan hanya melaporkan angka.\n" +
        "- Struktur jawaban: (1) Ringkasan kondisi keuangan, (2) Temuan penting dari data, (3) Rekomendasi konkret.\n" +
        "- Evaluasi: bandingkan pemasukan vs pengeluaran, identifikasi kategori terbesar, hari paling boros.\n" +
        "- Berikan 2-4 rekomendasi SPESIFIK berbasis DATA (bukan saran umum seperti 'hemat lebih banyak').\n" +
        "- Jika ada per-tanggal: sebutkan hari paling boros.\n" +
        "- Jika pengeluaran > pemasukan: nyatakan dengan tegas, beri saran darurat.\n" +
        "- Jika tidak ada data: katakan jujur, minta user catat transaksi dulu.\n" +
        "- Nada: profesional namun hangat, seperti konsultan keuangan yang peduli.\n" +
        `- Akhiri dengan ${chartTag} jika ada data pengeluaran.\n\n` +
        dataSection;
      break;

    case "transaksi":
      systemContent =
        "Kamu: Catatin AI, asisten keuangan pribadi. HANYA jawab topik keuangan, budgeting, transaksi, tabungan. Diluar itu tolak sopan.\n\n" +
        "FORMAT:\n" +
        "- Gunakan ### Heading untuk section, **bold** untuk angka saja, - list untuk rincian.\n" +
        "- Beri baris KOSONG sebelum dan sesudah setiap list.\n" +
        "- JANGAN pakai list bertingkat. Paragraf maksimal 3 kalimat.\n\n" +
        actionFormat +
        "Aturan menjawab pertanyaan keuangan (penting!):\n" +
        "- Jika user tanya pengeluaran: sebut total + per-kategori dari DATA + " +
        chartTag +
        ".\n" +
        "- Jika user tanya nominal spesifik: WAJIB jawab dari DATA. JANGAN cuma 'lihat grafik'.\n" +
        (draftMode
          ? ""
          : "- Jangan keluarkan [ACTION] jika amount/description belum lengkap.\n") +
        "- Nada: ramah, hangat. SESUAIKAN kondisi DATA:\n" +
        "  * Saldo tinggi & pengeluaran wajar → optimis.\n" +
        "  * Saldo menipis / pengeluaran >50% → ingatkan hemat, beri tips.\n" +
        "  * JANGAN bilang 'Masih aman'/'Lumayan' jika kondisi buruk.\n\n" +
        dataSection +
        internalSection;
      break;

    case "lengkap":
    default:
      systemContent =
        "Kamu: Catatin AI, asisten keuangan pribadi. HANYA jawab topik keuangan, budgeting, tabungan. Diluar itu tolak sopan.\n\n" +
        "FORMAT:\n" +
        "- Gunakan ### Heading untuk section, **bold** untuk angka saja, - list untuk rincian.\n" +
        "- Beri baris KOSONG sebelum dan sesudah setiap list.\n" +
        "- JANGAN pakai list bertingkat. Paragraf maksimal 3 kalimat.\n" +
        "- Struktur: ringkasan → detail → saran (jika diminta).\n\n" +
        `Aturan (periode: ${range.label}):\n` +
        "- Jawab pertanyaan keuangan HANYA dari DATA di bawah.\n" +
        "- Sebutkan total pemasukan + pengeluaran + saldo.\n" +
        "- Breakdown per-kategori pengeluaran dengan - list (cukup sebut nama + nominal).\n" +
        "- Jika user minta saran/masukan: gunakan list bernomor urut (1., 2., 3., dst.) pendek, tulis nomor dan teks di baris yang sama (contoh: '1. Batasi pengeluaran...'). JANGAN menuliskan nomor list di baris terpisah atau menggunakan angka 1. untuk semua item.\n" +
        "- JANGAN beri saran kalau user tidak minta.\n" +
        "- Jika user tanya grafik: sertakan " +
        chartTag +
        " di akhir.\n" +
        "- Nada: ramah, SESUAIKAN kondisi DATA:\n" +
        "  * Saldo tinggi & pengeluaran wajar → optimis.\n" +
        "  * Saldo menipis / pengeluaran >50% → ingatkan hemat, beri tips.\n" +
        "  * JANGAN bilang 'Masih aman'/'Lumayan' jika kondisi buruk.\n\n" +
        dataSection;
  }

  // Prepend current date and day context to help the assistant understand relative queries
  systemContent = timeContext + systemContent;

  // ─── Hallucination Prevention ────────────────────────────
  if (intent !== "non_finansial") {
    systemContent += "\n\nPENTING: JANGAN PERNAH mengarang, mengasumsikan, atau menyebutkan detail/contoh transaksi spesifik (seperti nama makanan konkret 'pecel', 'kopi', atau barang belanjaan) yang tidak tertulis secara eksplisit dalam DATA. Jika hanya ada kategori (contoh: Makanan), gunakan nama kategori tersebut tanpa membuat contoh konkret sendiri.";
  }

  console.log(
    `[AI] intent=${intent} range=${range.label} rangeDays=${rangeDays} | prompt=${systemContent.length} chars`,
  );

  const context: FinancialContext = {
    systemPrompt: { role: "system", content: systemContent },
    accounts,
    categories,
  };

  if (redis) {
    try {
      await redis.setex(cacheKey, 120, JSON.stringify(context));
      console.log(`[AI] Cache SET for key: ${cacheKey} (TTL 2m)`);
    } catch (err) {
      console.warn("[AI] Error writing to Redis cache:", err);
    }
  }

  return context;
}

// ─── Safety net: hapus ID internal yang bocor dari respons AI ──
// Model kecil (e.g. llama-4-scout) kadang copy-paste [cmq...]ID dari prompt
function stripLeakedIds(text: string): string {
  // Hapus timestamp/jam di awal respons (e.g. "05.50\n" atau "05:50 ")
  text = text.replace(/^\d{1,2}[.:]\d{2}\s*\n?/, "");
  // Hapus baris yang diawali "Internal:" (model kadang copy section header)
  text = text.replace(/^Internal:.*$/gm, "");
  // Hapus pola [cuid]NamaAkun(TYPE):angka — ID internal akun
  text = text.replace(/\[[a-z0-9]{20,}\]\w+\(\w+\):[\d.,]+/g, "");
  // Hapus sisa [cuid] kosong
  text = text.replace(/\[[a-z0-9]{20,}\]/g, "");
  // Bersihkan multiple newline
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ─── Fallback: inject [ASK_ACCOUNT:...] if AI forgot ──────────
function ensureAskAccount(
  text: string,
  accounts: { name: string }[],
): string | null {
  // Only relevant if multiple accounts exist
  if (accounts.length < 2) return null;
  // Already has the tag — no need to inject
  if (/\[ASK_ACCOUNT:/.test(text)) return null;

  // Detect account-selection language in AI response
  const askPattern =
    /(?:dompet|akun|rekening)\s*(?:mana|apa|yang|yg)\b|pilih\s*(?:di\s*bawah|akun|dompet)/i;
  if (!askPattern.test(text)) return null;

  const accOptions = accounts.map((a) => a.name).join(",");
  return `\n\n[ASK_ACCOUNT:${accOptions}]`;
}

async function callCustomProviderStream(
  messages: ChatMessage[],
  custom: CustomProvider,
): Promise<AsyncGenerator<{ type: string; content?: string; error?: string }>> {
  const baseUrl = custom.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  // Convert messages format for OpenAI-compatible API
  const body = JSON.stringify({
    model: custom.model || "gpt-4o",
    messages: messages.map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role, content: m.content };
      }
      if (m.content === null) {
        return { role: m.role, content: null, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id };
      }
      return {
        role: m.role,
        content: m.content.map((part) => {
          if (part.type === "text")
            return { type: "text", text: part.text || "" };
          if (part.type === "image_url")
            return { type: "image_url", image_url: part.image_url };
          return { type: "text", text: "" };
        }),
      };
    }),
    stream: true,
    max_tokens: 2048,
    temperature: 0.7,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${custom.apiKey}`,
      "User-Agent": "Catatin/1.0",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Custom AI error ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  if (!response.body) {
    throw new Error("Custom AI: no response body");
  }

  // Read SSE stream line by line
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function* generate() {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield { type: "token", content: delta };
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return generate() as any;
}

async function callCustomProviderSync(
  messages: ChatMessage[],
  custom: CustomProvider,
): Promise<string> {
  const baseUrl = custom.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const body = JSON.stringify({
    model: custom.model || "gpt-4o",
    messages: messages.map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role, content: m.content };
      }
      if (m.content === null) {
        return { role: m.role, content: null, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id };
      }
      return {
        role: m.role,
        content: m.content.map((part) => {
          if (part.type === "text")
            return { type: "text", text: part.text || "" };
          if (part.type === "image_url")
            return { type: "image_url", image_url: part.image_url };
          return { type: "text", text: "" };
        }),
      };
    }),
    stream: false,
    max_tokens: 2048,
    temperature: 0.7,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${custom.apiKey}`,
      "User-Agent": "Catatin/1.0",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Custom AI error ${response.status}: ${errorText.slice(0, 300)}`,
    );
  }

  const json = (await response.json()) as any;
  return json.choices?.[0]?.message?.content || "";
}

// ─── POST /api/ai/chat — Streaming chat ─────────────────────
aiRoutes.post("/chat", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { message, conversationId, image, history } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return c.json({ error: "Message is required" }, 400);
  }

  // ─── Fetch accounts early (needed for classifier + all paths) ──
  const accounts = await prisma.account.findMany({
    where: { userId: user.userId },
    select: { id: true, name: true, type: true, balance: true },
  });

  // ─── LLM Classifier: deteksi & ekstrak transaksi dari pesan ──
  // Pre-filter: skip LLM classifier jika tidak ada indikasi amount
  const txClass = hasPotentialAmount(message)
    ? await classifyTransactionMessage(message, accounts)
    : null;

  // ─── Path A: Complete transaction → save langsung, tanpa AI ──
  if (
    txClass?.isTransaction &&
    txClass.amount &&
    txClass.type &&
    txClass.accountId &&
    txClass.type !== "TRANSFER"
  ) {
    const matchedAccount = accounts.find((a) => a.id === txClass.accountId)!;
    console.log(
      `[AI] LLM classified complete tx: "${txClass.description}" Rp${txClass.amount} → ${matchedAccount.name}`,
    );

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      try {
        const catName = txClass.category || "Lainnya";
        let categoryId: string | null = null;
        const existingCat = await prisma.category.findFirst({
          where: { userId: user.userId, name: catName },
        });
        if (existingCat) {
          categoryId = existingCat.id;
        } else {
          const newCat = await prisma.category.create({
            data: {
              userId: user.userId,
              name: catName,
              type: txClass.type as any,
            },
          });
          categoryId = newCat.id;
        }

        const newTx = await prisma.$transaction(async (tx) => {
          const created = await tx.transaction.create({
            data: {
              userId: user.userId,
              type: txClass.type as any,
              amount: txClass.amount!,
              description:
                txClass.description ||
                (txClass.type === "INCOME" ? "Pemasukan" : "Pengeluaran"),
              categoryId,
              accountId: matchedAccount.id,
              source: "CHAT",
              date: new Date(),
            },
          });

          const delta =
            txClass.type === "INCOME" ? txClass.amount! : -txClass.amount!;
          await tx.account.update({
            where: { id: matchedAccount.id },
            data: { balance: { increment: delta } },
          });

          return created;
        });

        // Trigger real-time alert jika pengeluaran > threshold
        if (String(txClass.type).toUpperCase() === "EXPENSE") {
          const userObj = await prisma.user.findUnique({ where: { id: user.userId }, select: { name: true, customAiConfig: true } });
          const config = userObj?.customAiConfig as any;
          const threshold = config?.alertThreshold ?? 500000;
          
          if (txClass.amount! >= threshold) {
            await cronQueue.add("realtime-ai-alert", {
              userId: user.userId,
              userName: userObj?.name || "User",
              amount: txClass.amount!,
              description: txClass.description || "Pengeluaran"
            });
          }
        }

        try {
          await clearUserAiCache(user.userId);
        } catch (err) {
          console.error("[Cache] Failed to clear user AI cache on early write:", err);
        }

        const formattedAmount = txClass.amount!.toLocaleString("id-ID");
        const desc = txClass.description || "Transaksi";
        const responseText = `✅ **${desc}** Rp${formattedAmount} dicatat dari **${matchedAccount.name}**.`;

        await s.write(
          `data: ${JSON.stringify({ type: "token", content: responseText })}\n\n`,
        );
        await s.write(
          `data: ${JSON.stringify({
            type: "transaction_created",
            transaction: {
              ...newTx,
              category: catName,
              account: matchedAccount.name,
            },
          })}\n\n`,
        );

        // Save chat history
        try {
          let convId = conversationId;
          if (!convId) {
            const title =
              message.trim().slice(0, 60) + (message.length > 60 ? "…" : "");
            const conv = await prisma.aiConversation.create({
              data: { userId: user.userId, title, mode: "chat" },
            });
            convId = conv.id;
          }
          await prisma.aiMessage.create({
            data: {
              conversationId: convId,
              userId: user.userId,
              role: "user",
              content: message.trim(),
            },
          });
          await prisma.aiMessage.create({
            data: {
              conversationId: convId,
              userId: user.userId,
              role: "assistant",
              content: responseText,
            },
          });
        } catch (dbErr) {
          console.error("[AI] Gagal menyimpan chat history:", dbErr);
        }
      } catch (err: any) {
        await s.write(
          `data: ${JSON.stringify({ type: "error", error: err.message || "Gagal menyimpan transaksi" })}\n\n`,
        );
      }

      await s.write("data: [DONE]\n\n");
    });
  }

  // ─── Deteksi intent + bangun system prompt ──────────────
  // P3: Gunakan regex dulu — skip LLM extractor jika sudah confident
  // (hemat 1 LLM call untuk ~40% traffic: sapaan, saldo, transaksi jelas)
  const regexResult = analyzeIntent(message);
  const skipLLMExtractor =
    txClass?.isTransaction === true ||                          // LLM classifier sudah tahu ini transaksi
    regexResult.intent === "non_finansial" ||                   // Sapaan → tidak perlu tanggal
    regexResult.intent === "saldo";                             // Saldo → tidak perlu tanggal

  let { intent, timeRange } = skipLLMExtractor
    ? regexResult
    : await extractIntentAndTemporal(message);

  // Override intent jika LLM classifier mendeteksi transaksi (meski incomplete)
  if (txClass?.isTransaction) {
    intent = "transaksi";
  }

  const wantsChart =
    /\b(grafik|chart|bagan|diagram|visualisasi|tampilkan|lihat)\b/i.test(
      message,
    );

  // ─── Simpan riwayat chat ke database ────────────────────────
  const saveChatHistory = async (
    assistantContent: string,
    skipUserMessage = false,
  ) => {
    try {
      let convId = conversationId;
      if (!convId) {
        const title =
          message.trim().slice(0, 60) + (message.length > 60 ? "…" : "");
        const conv = await prisma.aiConversation.create({
          data: {
            userId: user.userId,
            title,
            mode: "chat",
          },
        });
        convId = conv.id;
      }

      // Simpan user message (kecuali follow-up akun seperti "BCA")
      if (!skipUserMessage) {
        await prisma.aiMessage.create({
          data: {
            conversationId: convId,
            userId: user.userId,
            role: "user",
            content: message.trim(),
          },
        });
      }

      if (assistantContent.trim()) {
        await prisma.aiMessage.create({
          data: {
            conversationId: convId,
            userId: user.userId,
            role: "assistant",
            content: stripActions(assistantContent),
          },
        });
      }
    } catch (dbErr) {
      console.error("[AI] Gagal menyimpan chat history:", dbErr);
    }
  };

  // ─── Format history ─────────────────────────────────────
  const formattedHistory: ChatMessage[] = (history || [])
    .slice(-10)
    .map((h: any) => ({
      role: h.type === "bot" ? "assistant" : "user",
      content: h.text,
    }));

  // ─── Deteksi follow-up: user membalas dengan nama akun ──
  if (intent === "lengkap" && message.length <= 30 && !/\d/.test(message)) {
    const matchedAccount = accounts.find(
      (a) =>
        message.toLowerCase().includes(a.name.toLowerCase()) ||
        a.name.toLowerCase().includes(message.toLowerCase().trim()),
    );
    if (matchedAccount) {
      // Gunakan LLM classifier untuk cari transaksi pending di history
      let parsed: {
        amount: number;
        description: string;
        category: string;
        type: "EXPENSE" | "INCOME";
      } | null = null;

      const lastUserMsg = [...formattedHistory]
        .reverse()
        .find((h) => h.role === "user");
      if (lastUserMsg) {
        const lastClass = await classifyTransactionMessage(
          lastUserMsg.content as string,
          accounts,
        );
        if (lastClass?.isTransaction && lastClass.amount && lastClass.type && lastClass.type !== "TRANSFER") {
          parsed = {
            amount: lastClass.amount,
            description: lastClass.description || "Transaksi",
            category: lastClass.category || "Lainnya",
            type: lastClass.type,
          };
        }
      }

      // Fallback ke regex jika LLM gagal
      if (!parsed) {
        const lastTxMsg = [...formattedHistory]
          .reverse()
          .find(
            (h) =>
              h.role === "user" && isLikelyTransaction(h.content as string),
          );
        parsed = lastTxMsg
          ? parseTransactionFromMessage(lastTxMsg.content as string)
          : null;
      }

      if (parsed) {
        console.log(
          `[AI] Account follow-up "${message}" → saving directly: ${parsed.description} Rp${parsed.amount} → ${matchedAccount.name}`,
        );

        return stream(c, async (s) => {
          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");

          try {
            // Cari/kreasi kategori di DB
            let categoryId: string | null = null;
            const existingCat = await prisma.category.findFirst({
              where: { userId: user.userId, name: parsed.category },
            });
            if (existingCat) {
              categoryId = existingCat.id;
            } else {
              const newCat = await prisma.category.create({
                data: {
                  userId: user.userId,
                  name: parsed.category,
                  type: parsed.type,
                },
              });
              categoryId = newCat.id;
            }

            // Buat transaksi + update saldo
            const newTx = await prisma.$transaction(async (tx) => {
              const created = await tx.transaction.create({
                data: {
                  userId: user.userId,
                  type: parsed.type,
                  amount: parsed.amount,
                  description: parsed.description,
                  categoryId,
                  accountId: matchedAccount.id,
                  source: "CHAT",
                  date: new Date(),
                },
              });

              const delta =
                parsed.type === "INCOME" ? parsed.amount : -parsed.amount;
              await tx.account.update({
                where: { id: matchedAccount.id },
                data: { balance: { increment: delta } },
              });

              return created;
            });

            // Trigger real-time alert jika pengeluaran > threshold
            if (String(parsed.type).toUpperCase() === "EXPENSE") {
              const userObj = await prisma.user.findUnique({ where: { id: user.userId }, select: { name: true, customAiConfig: true } });
              const config = userObj?.customAiConfig as any;
              const threshold = config?.alertThreshold ?? 500000;

              if (parsed.amount >= threshold) {
                await cronQueue.add("realtime-ai-alert", {
                  userId: user.userId,
                  userName: userObj?.name || "User",
                  amount: parsed.amount,
                  description: parsed.description
                });
              }
            }

            try {
              await clearUserAiCache(user.userId);
            } catch (err) {
              console.error("[Cache] Failed to clear user AI cache on follow-up write:", err);
            }

            const formattedAmount = parsed.amount.toLocaleString("id-ID");
            const responseText = `✅ **${parsed.description}** Rp${formattedAmount} dicatat dari **${matchedAccount.name}**.`;

            await s.write(
              `data: ${JSON.stringify({ type: "token", content: responseText })}\n\n`,
            );
            await s.write(
              `data: ${JSON.stringify({ type: "transaction_created", transaction: { ...newTx, category: parsed.category, account: matchedAccount.name } })}\n\n`,
            );

            // Simpan only assistant response — skip user "BCA" message
            await saveChatHistory(responseText, true);
          } catch (err: any) {
            await s.write(
              `data: ${JSON.stringify({ type: "error", error: err.message || "Gagal menyimpan transaksi" })}\n\n`,
            );
          }

          await s.write("data: [DONE]\n\n");
        });
      }
    }
  }

  const ctx = await buildFinancialContext(
    user.userId,
    intent,
    timeRange,
    false,
    wantsChart,
  );
  const { systemPrompt, categories } = ctx;

  const userMessage: ChatMessage = image
    ? {
        role: "user",
        content: [
          { type: "text", text: message },
          { type: "image_url", image_url: { url: image } },
        ],
      }
    : {
        role: "user",
        content: message,
      };

  const messages: ChatMessage[] = [
    systemPrompt,
    ...formattedHistory,
    userMessage,
  ];

  // ─── SSE Streaming Response ─────────────────────────────────
  return stream(c, async (s) => {
    let fullResponse = "";

    try {
      // Set SSE headers
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      // Only pass tools if the user is actually intending to record a transaction
      // This prevents the AI from hallucinating tool calls when answering questions about history
      const hasTools = intent === "transaksi";
      const chatOptions = { 
        vision: !!image, 
        tools: hasTools ? aiTools : undefined,
        tool_choice: hasTools ? "auto" : undefined
      };
      let finalToolCalls: any[] = [];

      // ─── Cek custom AI dari database ─────────────────────
      const customProvider = await getUserCustomProvider(user.userId);

      // ─── Gunakan custom provider jika user mengaktifkannya ──
      if (customProvider) {
        console.log(
          `[AI] Menggunakan custom AI: ${customProvider.provider}, model: ${customProvider.model || "default"}`,
        );

        // TODO: callCustomProviderStream should pass tools if customProvider supports it.
        // For now, custom providers might only support text actions, but assuming they support tools
        const generator = await callCustomProviderStream(
          messages,
          customProvider,
        );

        for await (const event of generator) {
          const data = JSON.stringify(event);
          await s.write(`data: ${data}\n\n`);

          if (event.type === "token" && event.content) {
            fullResponse += event.content;
          }

          if (event.type === "error" || event.type === "done") {
            break;
          }
        }
      } else {
        // ─── Default: gunakan Catatin AI (.env) dengan failover ──
        const generator = aiManager.chatStream(messages, chatOptions);

        for await (const event of generator) {
          const data = JSON.stringify(event);
          await s.write(`data: ${data}\n\n`);

          if (event.type === "token" && event.content) {
            fullResponse += event.content;
          }
          
          if (event.type === "tool_calls" && event.tool_calls) {
            finalToolCalls = event.tool_calls;
          }

          if (event.type === "error" || event.type === "done") {
            break;
          }
        }
      }

      // ─── Safety net: hapus ID internal yang mungkin bocor ──
      fullResponse = stripLeakedIds(fullResponse);

      // ─── Fallback: inject [ASK_ACCOUNT:...] jika AI lupa ──
      const injectedTag = ensureAskAccount(fullResponse, accounts);
      if (injectedTag) {
        fullResponse += injectedTag;
        await s.write(
          `data: ${JSON.stringify({ type: "token", content: injectedTag })}\n\n`,
        );
        console.log("[AI] Injected missing [ASK_ACCOUNT:...] tag");
      }

      // ─── Proses transaksi dari respons AI ─────────────
      // Tool calls execution
      let createdTxs: any[] = [];
      if (finalToolCalls.length > 0) {
        createdTxs = await processTransactionActions(
          finalToolCalls,
          user.userId,
          accounts,
        );
      } else if (fullResponse.includes("[ACTION:")) {
        // Fallback for old custom text action or custom providers without tool support
        // We handle this gracefully by wrapping string in fake tool call if needed or let legacy parse handle it
        // Note: processTransactionActions now expects toolCalls[], so we parse it if string fallback
        const actionRegex = /\[ACTION:\s*(record_transaction|update_transaction|delete_transaction|draft_transaction|transfer_balance|add_subscription|set_alert_threshold)\s*\]([\s\S]*?)\[\/ACTION\]/g;
        let match;
        const fallbackToolCalls = [];
        while ((match = actionRegex.exec(fullResponse)) !== null) {
          fallbackToolCalls.push({
            function: {
              name: match[1],
              arguments: match[2].trim()
            }
          });
        }
        if (fallbackToolCalls.length > 0) {
           createdTxs = await processTransactionActions(fallbackToolCalls, user.userId, accounts);
        }
      }

      // If AI only returned tool_calls, it means the text stream was empty.
      const isAiResponseEmpty = !fullResponse.trim();

      // Kirim event transaksi tercatat ke frontend
      if (createdTxs.length > 0) {
        for (const ev of createdTxs) {
          let eventType = "transaction_created";
          if (ev.action === "update") eventType = "transaction_updated";
          if (ev.action === "delete") eventType = "transaction_deleted";
          if (ev.action === "add_subscription") eventType = "subscription_created";
          if (ev.action === "set_alert_threshold") eventType = "threshold_updated";

          // We must generate the text so it renders in chat and saves to history.
          if (isAiResponseEmpty) {
            let msg = "";
            if (eventType === "transaction_created") {
              const tx = ev.transaction;
              const sign = tx.type === "INCOME" ? "+" : "-";
              const amt = Number(tx.amount || 0).toLocaleString("id-ID");
              msg = `✅ Transaksi tercatat: ${sign}Rp ${amt} — ${tx.description} (${tx.category}) ke ${tx.account}\n\n`;
            } else if (eventType === "transaction_updated") {
              const tx = ev.transaction;
              const sign = tx.type === "INCOME" ? "+" : "-";
              const amt = Number(tx.amount || 0).toLocaleString("id-ID");
              msg = `✅ Transaksi diubah: menjadi ${sign}Rp ${amt} — ${tx.description}\n\n`;
            } else if (eventType === "transaction_deleted") {
              msg = `🗑️ Transaksi berhasil dihapus.\n\n`;
            } else if (eventType === "subscription_created") {
              const sub = ev.subscription;
              const amt = Number(sub.amount || 0).toLocaleString("id-ID");
              msg = `📅 Pengingat tagihan dibuat: ${sub.name} (Rp ${amt}) siklus ${sub.cycle}, jatuh tempo berikutnya: ${sub.nextDueDate.toISOString().split("T")[0]}\n\n`;
            } else if (eventType === "threshold_updated") {
              const threshold = Number(ev.threshold || 0).toLocaleString("id-ID");
              msg = `⚙️ Batas peringatan pengeluaran besar berhasil diubah menjadi **Rp ${threshold}**.\n\n`;
            }

            fullResponse += msg;
            await s.write(`data: ${JSON.stringify({ type: "token", content: msg })}\n\n`);
          }

          await s.write(
            `data: ${JSON.stringify({ type: eventType, transaction: ev.transaction })}\n\n`,
          );
        }
      }

      if (fullResponse.trim()) {
        await saveChatHistory(fullResponse);
      }

      await s.write("data: [DONE]\n\n");
    } catch (err: any) {
      // Simpan partial response jika ada error
      if (fullResponse.trim()) {
        await saveChatHistory(fullResponse);
      }

      const data = JSON.stringify({
        type: "error",
        error: err.message || "Internal server error",
      });
      await s.write(`data: ${data}\n\n`);
      await s.write("data: [DONE]\n\n");
    }
  });
});

// ─── POST /api/ai/chat/sync — Non-streaming (fallback) ───────
aiRoutes.post("/chat/sync", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { message, image, draft } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return c.json({ error: "Message is required" }, 400);
  }

  // ─── Deteksi intent + bangun system prompt ──────────────
  let { intent, timeRange } = await extractIntentAndTemporal(message);
  // draft mode selalu butuh full context (transaksi)
  let finalIntent = draft ? "transaksi" : intent;
  const wantsChart =
    /\b(grafik|chart|bagan|diagram|visualisasi|tampilkan|lihat)\b/i.test(
      message,
    );

  // ─── Deteksi follow-up: user membalas [ASK_ACCOUNT] dengan nama akun ──
  if (
    finalIntent === "lengkap" &&
    message.length <= 30 &&
    !/\d/.test(message)
  ) {
    const accounts = await prisma.account.findMany({
      where: { userId: user.userId },
      select: { id: true, name: true, type: true, balance: true },
    });
    const isAccountReply = accounts.some(
      (a) =>
        message.toLowerCase().includes(a.name.toLowerCase()) ||
        a.name.toLowerCase().includes(message.toLowerCase().trim()),
    );
    if (isAccountReply) {
      console.log(
        `[AI] Detected account-selection follow-up: "${message}" → override intent to transaksi`,
      );
      finalIntent = "transaksi";
    }
  }

  const ctx = await buildFinancialContext(
    user.userId,
    finalIntent,
    timeRange,
    draft,
    wantsChart,
  );
  const { systemPrompt, accounts } = ctx;

  const userMessage: ChatMessage = image
    ? {
        role: "user",
        content: [
          { type: "text", text: message },
          { type: "image_url", image_url: { url: image } },
        ],
      }
    : { role: "user", content: message };

  try {
    // Cek custom AI dari database
    const customProvider = await getUserCustomProvider(user.userId);
    let content: string;
    let toolCalls: any[] = [];
    const chatOptions = { vision: false, tools: aiTools };

    if (image) {
      // ─── 2-Step Pipeline: Vision OCR -> Text Logic ───
      console.log("[AI] Memulai pipeline 2-tahap (Vision -> Text)");

      // Step 1: Vision OCR
      const ocrSystemPrompt: ChatMessage = {
        role: "system",
        content:
          "Kamu adalah asisten OCR. Ekstrak seluruh teks dan informasi dari gambar struk/dokumen ini dengan akurat. JANGAN tambahkan penjelasan atau format apapun, cukup ketik ulang isi teksnya.",
      };
      const ocrUserMessage: ChatMessage = {
        role: "user",
        content: [{ type: "image_url", image_url: { url: image } }],
      };

      let extractedText = "";
      try {
        const ocrResult = await aiManager.chat(
          [ocrSystemPrompt, ocrUserMessage],
          { vision: true },
        );
        extractedText = ocrResult.content;
        console.log("[AI] Hasil OCR:", extractedText.slice(0, 100) + "...");
      } catch (ocrErr) {
        console.error("[AI] Gagal OCR:", ocrErr);
        extractedText = "(Gagal membaca teks dari gambar)";
      }

      // Step 2: Text Logic
      const finalUserMessage: ChatMessage = {
        role: "user",
        content: `${message}\n\n=== TEKS STRUK ===\n${extractedText}`,
      };

      if (customProvider) {
        content = await callCustomProviderSync(
          [systemPrompt, finalUserMessage],
          customProvider,
        );
      } else {
        const result = await aiManager.chat([systemPrompt, finalUserMessage], { ...chatOptions, vision: false });
        content = result.content;
        toolCalls = result.tool_calls || [];
      }
    } else {
      // ─── Normal 1-Step Pipeline (Hanya Teks) ───
      if (customProvider) {
        content = await callCustomProviderSync(
          [systemPrompt, userMessage],
          customProvider,
        );
      } else {
        const result = await aiManager.chat([systemPrompt, userMessage], { ...chatOptions, vision: false });
        content = result.content;
        toolCalls = result.tool_calls || [];
      }
    }

    // ─── Safety net: hapus ID internal yang mungkin bocor ──
    content = stripLeakedIds(content);

    // ─── Fallback: inject [ASK_ACCOUNT:...] jika AI lupa ──
    const injectedTag = ensureAskAccount(content, accounts);
    if (injectedTag) {
      content += injectedTag;
      console.log("[AI] Injected missing [ASK_ACCOUNT:...] tag");
    }

    // ─── Parse & proses transaksi dari respons ────────────
    let processedEvents: any[] = [];
    if (toolCalls.length > 0) {
      processedEvents = await processTransactionActions(
        toolCalls,
        user.userId,
        accounts,
      );
    } else if (content.includes("[ACTION:")) {
      const actionRegex = /\[ACTION:\s*(record_transaction|update_transaction|delete_transaction|draft_transaction|transfer_balance)\s*\]([\s\S]*?)\[\/ACTION\]/g;
      let match;
      const fallbackToolCalls = [];
      while ((match = actionRegex.exec(content)) !== null) {
        fallbackToolCalls.push({
          function: {
            name: match[1],
            arguments: match[2].trim()
          }
        });
      }
      if (fallbackToolCalls.length > 0) {
         processedEvents = await processTransactionActions(fallbackToolCalls, user.userId, accounts);
      }
    }

    // Map output structure to maintain backward compatibility if needed by the frontend sync caller
    const createdTxs = processedEvents.map((e) => e.transaction);

    // Strip [ACTION] blocks dari content yang disimpan
    // Strip [ACTION] blocks dari content yang disimpan
    const cleanContent = stripActions(content);

    // Simpan riwayat chat (sync)
    try {
      const title =
        message.trim().slice(0, 60) + (message.length > 60 ? "…" : "");
      const conv = await prisma.aiConversation.create({
        data: { userId: user.userId, title, mode: "chat" },
      });
      await prisma.aiMessage.create({
        data: {
          conversationId: conv.id,
          userId: user.userId,
          role: "user",
          content: message.trim(),
        },
      });
      if (cleanContent.trim()) {
        await prisma.aiMessage.create({
          data: {
            conversationId: conv.id,
            userId: user.userId,
            role: "assistant",
            content: cleanContent,
          },
        });
      }
    } catch (dbErr) {
      console.error("[AI] Gagal menyimpan chat history:", dbErr);
    }

    return c.json({
      content: cleanContent,
      transactions: createdTxs.length > 0 ? createdTxs : undefined,
      provider: customProvider ? "custom" : "catatin",
    });
  } catch (err: any) {
    return c.json({ error: err.message || "AI request failed" }, 503);
  }
});

// ─── GET /api/ai/providers — Check provider status ──────────
aiRoutes.get("/providers", async (c) => {
  const user = c.get("user");
  return c.json({
    providers: ["deepseek", "openrouter", "groq"],
    status: "ok",
  });
});
// ─── GET /api/ai/chat/history — Fetch chat history with pagination ──────────
aiRoutes.get("/chat/history", async (c) => {
  try {
    const user = c.get("user");
    const page = parseInt(c.req.query("page") || "1", 10);
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const skip = (page - 1) * limit;

    const messages = await prisma.aiMessage.findMany({
      where: { userId: user.userId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    });

    const total = await prisma.aiMessage.count({
      where: { userId: user.userId },
    });

    // Format to match frontend Message interface
    const formattedMessages = messages.map((m) => {
      // Role is 'user' or 'assistant'. Frontend expects 'user' | 'bot'
      const type = m.role.toLowerCase() === "user" ? "user" : "bot";

      // Time format HH:MM
      const time = new Date(m.createdAt).toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      });

      return {
        id: m.id,
        type,
        text: m.content,
        time,
      };
    });

    return c.json({
      messages: formattedMessages.reverse(), // reverse to show chronological order for the chunk
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    return c.json(
      { error: err.message || "Failed to fetch chat history" },
      500,
    );
  }
});

// ─── DELETE /api/ai/chat/clear — Clear all chat history ──────────
aiRoutes.delete("/chat/clear", async (c) => {
  try {
    const user = c.get("user");

    await prisma.$transaction([
      prisma.aiMessage.deleteMany({
        where: { userId: user.userId },
      }),
      prisma.aiConversation.deleteMany({
        where: { userId: user.userId },
      }),
    ]);

    return c.json({
      status: "success",
      message: "History chat berhasil dihapus",
    });
  } catch (err: any) {
    return c.json(
      { error: err.message || "Failed to clear chat history" },
      500,
    );
  }
});

// ─── POST /api/ai/stt (Speech-to-Text via ElevenLabs Scribe / Groq Whisper) ──
aiRoutes.post("/stt", async (c) => {
  const { userId } = c.get("user");

  try {
    const body = await c.req.parseBody();
    const audioFile = body["file"] as File;

    if (!audioFile) {
      return c.json({ error: "File audio wajib diupload" }, 400);
    }

    // Validate file type
    const allowedTypes = [
      "audio/webm",
      "audio/mp3",
      "audio/wav",
      "audio/m4a",
      "audio/ogg",
      "audio/mp4",
      "audio/mpeg",
      "audio/aac",
      "audio/x-m4a",
    ];
    if (!allowedTypes.includes(audioFile.type) && !audioFile.name.match(/\.(webm|mp3|wav|m4a|ogg|aac)$/i)) {
      return c.json({ error: `Format audio tidak didukung: ${audioFile.type}` }, 400);
    }

    // Limit file size (25MB max)
    if (audioFile.size > 25 * 1024 * 1024) {
      return c.json({ error: "Ukuran audio maksimal 25MB" }, 400);
    }

    // Get user config for API keys
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { customAiConfig: true },
    });
    const config: any = dbUser?.customAiConfig || {};

    // ── 1) Groq Whisper (Terbaik untuk Bahasa Indonesia & Gaul) ──
    // ElevenLabs Scribe sering kesulitan dengan slang bahasa Indonesia, 
    // jadi kita langsung tembak pakai Groq Whisper-Large-V3.
    const groqKeys = [
      process.env.GROQ_KEY_1,
      process.env.GROQ_KEY_2,
      process.env.GROQ_KEY_3,
    ].filter(Boolean) as string[];
    if (groqKeys.length > 0) {
      try {
        const randomKey = groqKeys[Math.floor(Math.random() * groqKeys.length)];
        const formData = new FormData();
        formData.append("file", audioFile, audioFile.name || "audio.webm");
        formData.append("model", "whisper-large-v3");
        formData.append("language", "id");
        formData.append("response_format", "json");

        const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${randomKey}` },
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          const transcript = (data.text || "").trim();
          if (transcript) {
            return c.json({ text: transcript, provider: "groq" });
          }
        } else {
          console.warn("[STT] Groq Whisper failed:", response.status);
        }
      } catch (err) {
        console.warn("[STT] Groq Whisper error, falling back:", err);
      }
    }

    // ── 3) Fall back to OpenAI Whisper ──
    const openaiKey =
      config.enabled && config.apiKey && config.provider === "openai"
        ? config.apiKey
        : process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const formData = new FormData();
        formData.append("file", audioFile, audioFile.name || "audio.webm");
        formData.append("model", "whisper-1");
        formData.append("language", "id");
        formData.append("response_format", "json");

        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          const transcript = (data.text || "").trim();
          if (transcript) {
            return c.json({ text: transcript, provider: "openai" });
          }
        }
      } catch (err) {
        console.warn("[STT] OpenAI Whisper error:", err);
      }
    }

    return c.json({ error: "Semua provider STT gagal. Coba lagi nanti." }, 500);
  } catch (error: any) {
    console.error("[STT] Error:", error);
    return c.json({ error: error.message || "Terjadi kesalahan saat transkripsi" }, 500);
  }
});

// ─── POST /api/ai/tts (ElevenLabs Text-to-Speech) ───────────────
aiRoutes.post("/tts", async (c) => {
  const { userId } = c.get("user");
  const { text, voiceId = "JBFqnCBsd6RMkjVDRZzb" } = await c.req.json(); // Default voice (George) or any valid ID

  if (!text) return c.json({ error: "Teks wajib diisi" }, 400);

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { customAiConfig: true },
  });

  const config: any = dbUser?.customAiConfig || {};
  const apiKey = config.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    return c.json({ error: "ElevenLabs API Key belum dikonfigurasi. Silakan isi di menu Pengaturan > Asisten AI." }, 400);
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_multilingual_v2", // Multilingual v2 supports Indonesian!
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[TTS] ElevenLabs Error:", response.status, errorText);
      return c.json({ error: "Gagal menghasilkan audio dari ElevenLabs" }, response.status as any);
    }

    const audioBuffer = await response.arrayBuffer();

    return c.body(audioBuffer, 200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=31536000",
    });
  } catch (error: any) {
    console.error("[TTS] Error generating speech:", error);
    return c.json({ error: "Terjadi kesalahan internal saat generate audio" }, 500);
  }
});

export default aiRoutes;

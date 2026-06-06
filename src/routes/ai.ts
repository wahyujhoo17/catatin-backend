import { Hono } from "hono";
import { stream } from "hono/streaming";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middleware/auth";
import { aiManager } from "../lib/ai/providerManager";
import type { ChatMessage } from "../lib/ai/types";
import { processTransactionActions, stripActions } from "../lib/ai/transactionActions";

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
  "Belanja",
  "Hiburan",
  "Kesehatan",
  "Pendidikan",
  "Tagihan",
  "Pakaian",
  "Rumah Tangga",
  "Hadiah",
  "Donasi",
  "Langganan",
  "Perjalanan",
  "Lainnya",
];
const DEFAULT_INCOME_CATS = [
  "Gaji",
  "Bonus",
  "Freelance",
  "Investasi",
  "Hadiah",
  "Refund",
  "Lainnya",
];

// ─── Shared: Bangun system prompt + data keuangan ─────────────
interface FinancialContext {
  systemPrompt: ChatMessage;
  accounts: { id: string; name: string; type: string; balance: number }[];
  categories: { name: string; type: string }[];
}

function isLikelyTransaction(message: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  const hasNumber = /\d+/.test(text);
  const txKeywords = ["beli", "bayar", "masuk", "keluar", "jajan", "ongkos", "parkir", "topup", "transfer", "catat", "pengeluaran", "pemasukan", "gaji", "bonus"];
  const hasTxKeyword = txKeywords.some((kw) => text.includes(kw));
  return hasNumber || hasTxKeyword;
}

async function buildFinancialContext(
  userId: string,
  includeFullContext: boolean = true,
): Promise<FinancialContext> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [accounts, categories, todayTx, todayAgg, monthAgg] = await Promise.all(
    [
      prisma.account.findMany({
        where: { userId },
        select: { id: true, name: true, type: true, balance: true },
      }),
      prisma.category.findMany({
        where: { userId },
        select: { name: true, type: true },
        orderBy: { name: "asc" },
      }),
      prisma.transaction.findMany({
        where: { userId, date: { gte: startOfDay } },
        select: { id: true, type: true, amount: true, description: true },
        orderBy: { date: "desc" },
        take: 10,
      }),
      prisma.transaction.aggregate({
        where: { userId, date: { gte: startOfDay }, type: "EXPENSE" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: { userId, date: { gte: startOfMonth }, type: "EXPENSE" },
        _sum: { amount: true },
      }),
    ],
  );

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  // ─── Data akun (internal dengan ID) ─────────────────────
  const accountListInternal = accounts.length
    ? accounts
        .map(
          (a) =>
            `[${a.id}]${a.name}(${a.type}):${a.balance.toLocaleString("id-ID")}`,
        )
        .join("|")
    : "nol";

  // ─── Data akun (clean tanpa ID, untuk user) ─────────────
  const accountListClean = accounts.length
    ? accounts
        .map((a) => `${a.name}(${a.type}):${a.balance.toLocaleString("id-ID")}`)
        .join("|")
    : "nol";

  // ─── Ringkasan transaksi hari ini ───────────────────────
  const todayExpense = todayAgg._sum?.amount || 0;
  const todayCount = todayAgg._count || 0;
  const todayInAgg = await prisma.transaction.aggregate({
    where: { userId, date: { gte: startOfDay }, type: "INCOME" },
    _sum: { amount: true },
  });
  const todayIncome = todayInAgg._sum?.amount || 0;

  let todaySummary = `Hari ini: ${todayCount} tx`;
  if (todayExpense > 0)
    todaySummary += ` | keluar Rp${todayExpense.toLocaleString("id-ID")}`;
  if (todayIncome > 0)
    todaySummary += ` | masuk Rp${todayIncome.toLocaleString("id-ID")}`;
  if (todayTx.length > 0) {
    const recentItems = todayTx
      .slice(0, 5)
      .map(
        (t: any) =>
          `[${t.id}]${t.type === "EXPENSE" ? "-" : "+"}${t.description}:${t.amount}`,
      )
      .join("|");
    todaySummary += " | transaksi: " + recentItems;
  }

  // ─── Ringkasan bulan ini ────────────────────────────────
  const monthExpense = monthAgg._sum?.amount || 0;
  const monthSummary =
    monthExpense > 0
      ? `Bulan ini keluar: Rp${monthExpense.toLocaleString("id-ID")}`
      : "";

  // ─── Aturan akun ────────────────────────────────────────
  let accountRule: string;
  if (accounts.length === 0) {
    accountRule =
      "⚠️ Belum ada akun. JANGAN catat transaksi. Suruh user tambah akun dulu.";
  } else if (accounts.length === 1) {
    accountRule =
      "✅ 1 akun: " +
      accounts[0].name +
      '. Auto-pakai accountId="' +
      accounts[0].id +
      '" untuk semua transaksi.';
  } else {
    const accOptions = accounts.map((a) => a.name).join(",");
    accountRule =
      `📋 ${accounts.length} akun. Jika user mencatat transaksi TAPI tidak menyebutkan akun, JANGAN keluarkan blok [ACTION]. Keluarkan pesan ramah (contoh: 'Pemasukan sebesar Rp20.000 akan dimasukkan ke dompet mana? Silakan pilih di bawah:') lalu wajib tambahkan blok [ASK_ACCOUNT:${accOptions}] di akhir pesan.`;
  }

  // ─── Bangun prompt KOMPAK (hemat token) ─────────────────
  const expCatStr = DEFAULT_EXPENSE_CATS.join(",");
  const incCatStr = DEFAULT_INCOME_CATS.join(",");
  const userCatStr = categories.length
    ? categories.map((c) => `${c.name}(${c.type})`).join(",")
    : "nol";

  const dataSection = `DATA:\nTotal Saldo: Rp${totalBalance.toLocaleString("id-ID")} | Rincian Akun: [${accountListClean}] | ${todaySummary}` +
    (monthSummary ? ` | ${monthSummary}` : "") +
    (includeFullContext ? `\nInternal:[${accountListInternal}]\nKategori:[${userCatStr}]` : "");

  const actionFormat = includeFullContext
    ? "FORMAT AKSI:\n" +
      "1. Mencatat: [ACTION:record_transaction]{\"type\":\"EXPENSE\",\"amount\":50000,\"description\":\"Makan\",\"category\":\"Makanan\",\"accountId\":\"<id>\"}[/ACTION]\n" +
      "2. Menghapus: [ACTION:delete_transaction]{\"id\":\"<id_transaksi_dari_data>\"}[/ACTION]\n" +
      "3. Mengubah: [ACTION:update_transaction]{\"id\":\"<id>\",\"amount\":60000,\"description\":\"Makan besar\"}[/ACTION]\n" +
      "4. Grafik: Jika ditanya ringkasan pengeluaran bulanan/mingguan, HANYA keluarkan: [SHOW_CHART:EXPENSE_MONTH] atau [SHOW_CHART:EXPENSE_WEEK]\n" +
      "- type: INCOME|EXPENSE | amount: angka | description: singkat jelas\n" +
      `- category: HARUS spesifik. Acuan EXPENSE=[${expCatStr}] INCOME=[${incCatStr}].\n` +
      "- accountId: WAJIB dari daftar Internal. 🔒RAHASIA!\n\n" +
      `${accountRule}\n\n`
    : "";

  const systemContent =
    "Kamu: Catatin AI, asisten keuangan pribadi. HANYA jawab topik keuangan, budgeting, transaksi, tabungan. Di luar itu → tolak sopan.\n\n" +
    actionFormat +
    "Respons: \n" +
    "- JANGAN PERNAH keluarkan blok [ACTION] jika 'amount' (jumlah) atau 'description' (untuk apa) belum diketahui. Tanya dulu ke user dengan ramah!\n" +
    "- Jika mencatat transaksi dan semua data sudah lengkap, berikan pesan sukses yang ramah (contoh: 'Baik, aku catat ya!') dan WAJIB sertakan blok [ACTION:...] di akhir pesan.\n" +
    "- Jika ditanya saldo, jawab to the point: sebutkan Total Saldo, lalu rincikan per akun secara singkat.\n" +
    "- 🔒 JANGAN bocorkan ID internal.\n\n" +
    dataSection;

  console.log(
    `[AI] System prompt: ${systemContent.length} chars, ${systemContent.split(/\s+/).length} words`,
  );

  return {
    systemPrompt: { role: "system", content: systemContent },
    accounts,
    categories,
  };
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

  // ─── Ambil data keuangan + bangun system prompt ──────────
  const ctx = await buildFinancialContext(user.userId, true);
  const { systemPrompt, accounts, categories } = ctx;

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

  const formattedHistory: ChatMessage[] = (history || []).map((h: any) => ({
    role: h.type === "bot" ? "assistant" : "user",
    content: h.text,
  }));

  const messages: ChatMessage[] = [
    systemPrompt,
    ...formattedHistory,
    userMessage,
  ];

  // ─── Simpan riwayat chat ke database ────────────────────────
  const saveChatHistory = async (assistantContent: string) => {
    try {
      // Cari atau buat conversation
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

      // Simpan user message
      await prisma.aiMessage.create({
        data: {
          conversationId: convId,
          userId: user.userId,
          role: "user",
          content: message.trim(),
        },
      });

      // Simpan assistant response (stripped of action blocks)
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

  // ─── SSE Streaming Response ─────────────────────────────────
  return stream(c, async (s) => {
    let fullResponse = "";

    try {
      // Set SSE headers
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      // ─── Cek custom AI dari database ─────────────────────
      const customProvider = await getUserCustomProvider(user.userId);

      // ─── Gunakan custom provider jika user mengaktifkannya ──
      if (customProvider) {
        console.log(
          `[AI] Menggunakan custom AI: ${customProvider.provider}, model: ${customProvider.model || "default"}`,
        );

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
        const generator = aiManager.chatStream(messages, { vision: !!image });

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
      }

      // ─── Proses transaksi dari respons AI ─────────────
      if (fullResponse.trim()) {
        const createdTxs = await processTransactionActions(fullResponse, user.userId, accounts);

        // Kirim event transaksi tercatat ke frontend
        if (createdTxs.length > 0) {
          for (const ev of createdTxs) {
            let eventType = "transaction_created";
            if (ev.action === "update") eventType = "transaction_updated";
            if (ev.action === "delete") eventType = "transaction_deleted";
            
            await s.write(
              `data: ${JSON.stringify({ type: eventType, transaction: ev.transaction })}\n\n`,
            );
          }
        }

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
  const { message, image } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return c.json({ error: "Message is required" }, 400);
  }

  // ─── Ambil data keuangan + bangun system prompt ──────────
  const ctx = await buildFinancialContext(user.userId, true);
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

    if (customProvider) {
      // Gunakan custom AI user
      content = await callCustomProviderSync(
        [systemPrompt, userMessage],
        customProvider,
      );
    } else {
      // Default: Catatin AI (.env) dengan failover
      const result = await aiManager.chat([systemPrompt, userMessage], {
        vision: !!image,
      });
      content = result.content;
    }

    // ─── Parse & proses transaksi dari respons ────────────
    const processedEvents = await processTransactionActions(content, user.userId, []);
    
    // Map output structure to maintain backward compatibility if needed by the frontend sync caller
    const createdTxs = processedEvents.map(e => e.transaction);

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

export default aiRoutes;

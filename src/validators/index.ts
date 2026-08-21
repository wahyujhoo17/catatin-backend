import { z } from "zod";

// ─── HELPERS ──────────────────────────────────────────────────

function isEmail(val: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

function isPhoneNumber(val: string): boolean {
  const digits = val.replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits);
}

// ─── AUTH VALIDATORS ──────────────────────────────────────────

// EmailOrPhone: menerima email ATAU nomor HP (08xx, +62, 62xx, dll)
const emailOrPhone = z
  .string()
  .min(5, "Email atau nomor HP minimal 5 karakter")
  .refine(
    (val) => isEmail(val) || isPhoneNumber(val),
    "Masukkan email atau nomor HP yang valid",
  );

export const registerSchema = z.object({
  name: z.string().min(2, "Nama minimal 2 karakter").max(100),
  email: emailOrPhone,
  password: z.string().min(6, "Password minimal 6 karakter"),
  cfTurnstileToken: z.string().optional(),
});

export const loginSchema = z.object({
  email: emailOrPhone,
  password: z.string().min(1, "Password wajib diisi"),
  cfTurnstileToken: z.string().optional(),
});

export const verifyOtpSchema = z.object({
  email: z.string().min(1, "Email atau nomor HP diperlukan"),
  code: z.string().length(4, "Kode OTP harus 4 digit"),
});

export const forgotPasswordSchema = z.object({
  email: emailOrPhone,
  cfTurnstileToken: z.string().optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token reset diperlukan"),
  password: z.string().min(6, "Password minimal 6 karakter"),
});

// ─── TRANSACTION VALIDATORS ───────────────────────────────────

export const createTransactionSchema = z.object({
  accountId: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  type: z.enum(["INCOME", "EXPENSE", "DEBT", "DEBT_PAYMENT"]),
  amount: z.number().positive("Jumlah harus lebih dari 0"),
  description: z
    .string()
    .max(500, "Deskripsi terlalu panjang")
    .optional()
    .nullable(),
  note: z.string().max(1000, "Catatan terlalu panjang").optional().nullable(),
  method: z.string().optional().nullable(),
  source: z.enum(["CHAT", "SCAN", "MANUAL"]).default("MANUAL"),
  date: z
    .string()
    .datetime({ message: "Format waktu tidak valid" })
    .optional()
    .nullable(),
});

export const updateTransactionSchema = createTransactionSchema.partial();

// ─── ACCOUNT VALIDATORS ───────────────────────────────────────

export const createAccountSchema = z.object({
  name: z.string().min(1, "Nama akun wajib diisi"),
  type: z.enum(["CASH", "BANK", "E_WALLET"]),
  balance: z.number().default(0),
});

// ─── PRODUCT VALIDATORS ───────────────────────────────────────

export const createProductSchema = z.object({
  name: z.string().min(1, "Nama produk wajib diisi"),
  sku: z.string().trim().max(80).optional().nullable(),
  barcode: z.string().trim().max(120).optional().nullable(),
  price: z.number().positive("Harga harus lebih dari 0"),
  costPrice: z.number().nonnegative().optional().nullable(),
  category: z.string().trim().max(80).optional().nullable(),
  unit: z.string().trim().min(1).max(30).default("pcs"),
  stock: z.number().nonnegative().default(0),
  minStock: z.number().nonnegative().default(5),
  image: z.string().url().max(2000).optional().nullable(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1, "Nama produk wajib diisi").optional(),
  sku: z.string().trim().max(80).optional().nullable(),
  barcode: z.string().trim().max(120).optional().nullable(),
  price: z.number().positive("Harga harus lebih dari 0").optional(),
  costPrice: z.number().nonnegative().optional().nullable(),
  category: z.string().trim().max(80).optional().nullable(),
  unit: z.string().trim().min(1).max(30).optional(),
  stock: z.number().nonnegative().optional(),
  minStock: z.number().nonnegative().optional(),
  image: z.string().url().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
});

// ─── CUSTOMER VALIDATORS ──────────────────────────────────────

export const createCustomerSchema = z.object({
  name: z.string().min(1, "Nama pelanggan wajib diisi"),
  phone: z.string().trim().max(30).optional().nullable(),
  maxDebt: z.number().positive().optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  isActive: z.boolean().optional(),
});

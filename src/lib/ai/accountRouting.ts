interface TransactionClassification {
  isTransaction: boolean;
  needsAccount?: boolean;
  accountId?: string;
}

export function isNotificationOrSubscriptionRequest(
  message: string,
): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  const explicitReminder =
    /\b(notifikasi|ingatkan|pengingat|alarm)\b/i.test(text);
  const subscriptionAction =
    /\b(tambah|tambahkan|buat|catat|daftarkan|aktifkan)\b/i.test(text) &&
    /\b(langganan|subscription|tagihan|pengingat|notifikasi)\b/i.test(text);
  const recurringSubscription =
    /\b(langganan|subscription|tagihan)\b/i.test(text) &&
    /\b(rutin|setiap minggu|tiap minggu|setiap bulan|tiap bulan|mingguan|bulanan|tahunan)\b/i.test(
      text,
    ) &&
    !/\b(apa|berapa|mana|daftar|laporan|total)\b/i.test(text);
  const subscriptionRemoval =
    /\b(lunas|hapus|batalkan|nonaktifkan)\b/i.test(text) &&
    /\b(langganan|subscription|tagihan)\b/i.test(text);

  return (
    explicitReminder ||
    subscriptionAction ||
    recurringSubscription ||
    subscriptionRemoval
  );
}

export function shouldClassifyAsDirectTransaction(message: string): boolean {
  return (
    /\b\d[\d.,]*(?:\s*(?:jt|juta|rb|ribu|[kK])\b)?/.test(message) &&
    !isNotificationOrSubscriptionRequest(message)
  );
}

export function shouldAskForTransactionAccount(input: {
  message: string;
  classification: TransactionClassification | null;
  accountCount: number;
  isBalanceAdjustment: boolean;
}): boolean {
  const {
    message,
    classification,
    accountCount,
    isBalanceAdjustment,
  } = input;
  return Boolean(
    classification?.isTransaction &&
      classification.needsAccount &&
      !classification.accountId &&
      accountCount > 0 &&
      !isBalanceAdjustment &&
      !isNotificationOrSubscriptionRequest(message),
  );
}

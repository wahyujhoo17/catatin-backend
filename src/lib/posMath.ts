export type PosPaymentInput = {
  method: "CASH" | "BANK_TRANSFER" | "E_WALLET" | "CARD" | "CREDIT";
  amount: number;
};

export function calculatePaymentSummary(total: number, payments: PosPaymentInput[]) {
  const credit = payments
    .filter((payment) => payment.method === "CREDIT")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const tendered = payments
    .filter((payment) => payment.method !== "CREDIT")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const requiredPaid = total - credit;
  const change = Math.max(0, tendered - requiredPaid);
  return { credit, tendered, requiredPaid, change };
}

export function allocateDebtPayment(amount: number, outstandingSales: { id: string; outstanding: number }[]) {
  let remaining = amount;
  const allocations: { saleId: string; amount: number }[] = [];
  for (const sale of outstandingSales) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, sale.outstanding);
    if (allocated > 0) allocations.push({ saleId: sale.id, amount: allocated });
    remaining -= allocated;
  }
  return { allocations, remaining: Math.max(0, remaining) };
}

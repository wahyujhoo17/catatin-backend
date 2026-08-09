/**
 * Helper to compute start and end dates for a user's monthly financial cycle
 * based on their configured financialCycleStartDay (1..28, default 1).
 */
export function getFinancialMonthlyRange(
  referenceDate: Date = new Date(),
  startDay: number = 1
): { start: Date; end: Date } {
  const day = Math.min(Math.max(startDay || 1, 1), 28);
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const currentDate = referenceDate.getDate();

  let start: Date;
  let end: Date;

  if (day === 1) {
    start = new Date(year, month, 1, 0, 0, 0, 0);
    end = new Date(year, month + 1, 0, 23, 59, 59, 999);
  } else if (currentDate >= day) {
    // Already in current month's cycle starting on `day`
    start = new Date(year, month, day, 0, 0, 0, 0);
    end = new Date(year, month + 1, day - 1, 23, 59, 59, 999);
  } else {
    // In cycle that started on `day` of previous month
    start = new Date(year, month - 1, day, 0, 0, 0, 0);
    end = new Date(year, month, day - 1, 23, 59, 59, 999);
  }

  return { start, end };
}

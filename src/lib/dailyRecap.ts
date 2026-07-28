export function buildDailyRecapExpenseWhere(input: {
  userId: string;
  start: Date;
  end: Date;
}) {
  return {
    userId: input.userId,
    type: "EXPENSE" as const,
    isTransfer: false,
    date: {
      gte: input.start,
      lte: input.end,
    },
  };
}

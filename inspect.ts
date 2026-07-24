import prisma from './src/lib/prisma';

async function main() {
  const user = await prisma.user.findFirst({ where: { email: 'lalaaliyaj@gmail.com' } });
  if (!user) {
    console.log("User not found");
    return;
  }
  const accounts = await prisma.account.findMany({ where: { userId: user.id } });
  console.log("Accounts:", accounts);

  const txs = await prisma.transaction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log("Transactions:", txs);
}

main().then(() => prisma.$disconnect());

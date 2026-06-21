const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const subs = await prisma.subscription.findMany();
  console.log("Subscriptions in DB:", JSON.stringify(subs, null, 2));
  process.exit(0);
}

main();

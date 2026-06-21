import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function check() {
  const users = await prisma.user.findMany();
  for (const user of users) {
    console.log(`User ${user.id} (${user.name}):`, user.customAiConfig);
  }
}

check().catch(console.error).finally(() => prisma.$disconnect());

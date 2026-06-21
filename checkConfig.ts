import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function check() {
  const user = await prisma.user.findFirst({ where: { name: "wahyu jhoo" } });
  if (user) {
    const config = (user.customAiConfig as any) || {};
    const newConfig = { ...config, alertThreshold: 20000 };
    await prisma.user.update({
      where: { id: user.id },
      data: { customAiConfig: newConfig }
    });
    
    const updatedUser = await prisma.user.findFirst({ where: { name: "wahyu jhoo" } });
    console.log("Updated config:", updatedUser?.customAiConfig);
  }
}

check().catch(console.error).finally(() => prisma.$disconnect());

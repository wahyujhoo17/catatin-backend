import { PrismaClient } from "@prisma/client";
import { sendPushNotificationDirect } from "./src/services/notification";
import * as dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const targetEmail = process.argv[2];
  if (!targetEmail) {
    console.error("Usage: npx ts-node broadcast.ts <email_or_all>");
    process.exit(1);
  }

  try {
    let userIds: string[] = [];
    
    if (targetEmail === "all") {
      const users = await prisma.user.findMany({
        select: { id: true }
      });
      userIds = users.map(u => u.id);
      console.log(`Broadcasting to all ${userIds.length} users...`);
    } else {
      const user = await prisma.user.findUnique({
        where: { email: targetEmail }
      });
      if (!user) {
        console.error(`User with email ${targetEmail} not found`);
        process.exit(1);
      }
      userIds = [user.id];
      console.log(`Broadcasting to user ${targetEmail} (ID: ${user.id})...`);
    }

    const payload = {
      userIds: userIds,
      title: "🚀 Update Besar Catatin AI!",
      body: "Kini Catatin AI makin sakti dan lengkap! Banyak fitur baru yang bisa kamu lakukan langsung dari obrolan:\n\n" +
            "🎯 1. Atur Budget (Harian/Mingguan/Bulanan)\n" +
            "💡 Contoh: \"Buat budget harian makan 50rb\" atau \"Set budget bulanan bensin 300rb\"\n\n" +
            "🏦 2. Buat Target Tabungan Impian\n" +
            "💡 Contoh: \"Tolong buatkan target tabungan 15 juta untuk beli motor\"\n\n" +
            "Tunggu apa lagi? Yuk cobain ngobrol dan berikan perintah ke AI Catatin sekarang juga!",
      type: "ADMIN_BROADCAST" as any,
    };

    const result = await sendPushNotificationDirect(payload);
    console.log("Broadcast Result:", result);

  } catch (error) {
    console.error("Error during broadcast:", error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

main();

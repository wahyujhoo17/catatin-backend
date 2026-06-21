const Bull = require("bull");
require("dotenv").config();

async function main() {
  const notificationQueue = new Bull("notification", process.env.REDIS_URL || "redis://localhost:6379");
  console.log("Triggering test push notification...");
  
  await notificationQueue.add("push", {
    userIds: ["cmq2lssi90000qhz80i68qeu7"],
    title: "Test Notifikasi 🚀",
    body: "Halo Wahyu! Ini adalah test push notification langsung dari AI.",
    clickAction: "/dashboard"
  });
  
  console.log("Job added to notificationQueue! Check the backend terminal for logs.");
  process.exit(0);
}

main();

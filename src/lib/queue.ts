import Bull from "bull";

const REDIS_URL = process.env.REDIS_URL;

function createQueue(name: string): Bull.Queue {
  const queue = new Bull(name, REDIS_URL || "redis://localhost:6379", {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  queue.on("error", (err) => {
    console.warn(`[Queue:${name}] Error:`, err.message);
  });

  queue.on("completed", (job) => {
    console.log(`[Queue:${name}] Job #${job.id} completed`);
  });

  queue.on("failed", (job, err) => {
    console.error(`[Queue:${name}] Job #${job?.id} failed:`, err.message);
  });

  return queue;
}

// ─── Queues ───────────────────────────────────────────────────
export const emailQueue = createQueue("email");
export const whatsappQueue = createQueue("whatsapp");
export const notificationQueue = createQueue("notification");
export const cronQueue = createQueue("cron");

// ─── Graceful shutdown ────────────────────────────────────────
export async function closeQueues(): Promise<void> {
  await Promise.all([
    emailQueue.close(),
    whatsappQueue.close(),
    notificationQueue.close(),
    cronQueue.close(),
  ]);
}

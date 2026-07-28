export type NotificationPipelinePhase = "enqueue" | "delivery";

export function shouldPersistNotification(
  phase: NotificationPipelinePhase,
): boolean {
  return phase === "enqueue";
}

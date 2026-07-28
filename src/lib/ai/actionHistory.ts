export type StoredAiActionStatus =
  | "PENDING"
  | "EXECUTING"
  | "EXECUTED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export type ClientAiActionStatus =
  | "pending"
  | "processing"
  | "executed"
  | "cancelled"
  | "expired"
  | "failed";

interface StoredAiAction {
  id: string;
  actionType: string;
  title: string;
  summary: string;
  expiresAt: Date;
  status: StoredAiActionStatus;
  error: string | null;
}

export interface StoredAiHistoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  proposedActions: StoredAiAction[];
}

export interface FormattedAiHistoryMessage {
  id: string;
  type: "user" | "bot";
  text: string;
  time: string;
  pendingActions?: Array<{
    id: string;
    actionType: string;
    title: string;
    summary: string;
    expiresAt: string;
    status: ClientAiActionStatus;
    error?: string;
  }>;
}

export function toClientAiActionStatus(
  status: StoredAiActionStatus,
): ClientAiActionStatus {
  if (status === "EXECUTING") return "processing";
  return status.toLowerCase() as ClientAiActionStatus;
}

export function formatAiHistoryMessage(
  message: StoredAiHistoryMessage,
): FormattedAiHistoryMessage {
  const pendingActions =
    message.proposedActions.length > 0
      ? message.proposedActions.map((action) => ({
          id: action.id,
          actionType: action.actionType,
          title: action.title,
          summary: action.summary,
          expiresAt: action.expiresAt.toISOString(),
          status: toClientAiActionStatus(action.status),
          error: action.error || undefined,
        }))
      : undefined;

  return {
    id: message.id,
    type: message.role.toLowerCase() === "user" ? "user" : "bot",
    text: message.content,
    time: new Date(message.createdAt).toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    pendingActions,
  };
}

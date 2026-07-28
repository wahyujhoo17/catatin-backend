import { z } from "zod";

const imageDataSchema = z
  .string()
  .max(8 * 1024 * 1024)
  .regex(/^data:image\/(?:jpeg|png|webp);base64,/i);

const chatHistoryItemSchema = z.union([
  z.object({
    type: z.enum(["user", "bot", "error"]),
    text: z.string().max(4_000),
  }),
  z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(4_000),
  }),
]);

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  conversationId: z.string().max(128).optional(),
  requestId: z.string().min(8).max(128).optional(),
  image: imageDataSchema.optional(),
  history: z.array(chatHistoryItemSchema).max(10).optional().default([]),
});

export const syncChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  requestId: z.string().min(8).max(128).optional(),
  image: imageDataSchema.optional(),
  draft: z.union([z.boolean(), z.string().max(4_000)]).optional(),
});

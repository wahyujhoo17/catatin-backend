-- Link an AI action proposal to the assistant message that introduced it.
ALTER TABLE "AiActionRequest"
ADD COLUMN "proposalMessageId" TEXT;

-- Backfill existing proposals by matching the nearest assistant message from
-- the same user. This restores already-executed cards created before this
-- relation existed.
UPDATE "AiActionRequest" AS action
SET "proposalMessageId" = (
    SELECT message."id"
    FROM "AiMessage" AS message
    WHERE message."userId" = action."userId"
      AND LOWER(message."role") = 'assistant'
      AND message."createdAt" >= action."createdAt" - INTERVAL '5 seconds'
      AND message."createdAt" <= action."createdAt" + INTERVAL '2 minutes'
      AND (
        message."content" LIKE 'Saya sudah menyiapkan aksi berikut.%'
        OR message."content" LIKE 'Akun sudah dipilih.%'
      )
    ORDER BY ABS(EXTRACT(EPOCH FROM (message."createdAt" - action."createdAt")))
    LIMIT 1
)
WHERE action."proposalMessageId" IS NULL;

CREATE INDEX "AiActionRequest_proposalMessageId_idx"
ON "AiActionRequest"("proposalMessageId");

ALTER TABLE "AiActionRequest"
ADD CONSTRAINT "AiActionRequest_proposalMessageId_fkey"
FOREIGN KEY ("proposalMessageId") REFERENCES "AiMessage"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "AiActionStatus" AS ENUM ('PENDING', 'EXECUTING', 'EXECUTED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "AiActionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "AiActionStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiActionRequest_idempotencyKey_key" ON "AiActionRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AiActionRequest_userId_status_idx" ON "AiActionRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "AiActionRequest_expiresAt_idx" ON "AiActionRequest"("expiresAt");

-- AddForeignKey
ALTER TABLE "AiActionRequest" ADD CONSTRAINT "AiActionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

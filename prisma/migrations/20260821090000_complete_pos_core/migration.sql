ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POS_DEBT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POS_DEBT_PAYMENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POS_LOW_STOCK';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'POS_DAILY_RECAP';

CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');
CREATE TYPE "PosPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'E_WALLET', 'CARD', 'CREDIT');
CREATE TYPE "StockMovementType" AS ENUM ('INITIAL', 'PURCHASE', 'SALE', 'ADJUSTMENT', 'RETURN', 'VOID');
CREATE TYPE "ReceivableEntryType" AS ENUM ('CHARGE', 'PAYMENT', 'ADJUSTMENT', 'VOID');
CREATE TYPE "RegisterStatus" AS ENUM ('OPEN', 'CLOSED');

ALTER TABLE "Product" ADD COLUMN "sku" TEXT;
ALTER TABLE "Product" ADD COLUMN "barcode" TEXT;
ALTER TABLE "Product" ALTER COLUMN "price" TYPE DECIMAL(18,2) USING "price"::DECIMAL(18,2);
ALTER TABLE "Product" ALTER COLUMN "costPrice" TYPE DECIMAL(18,2) USING "costPrice"::DECIMAL(18,2);
ALTER TABLE "Product" ALTER COLUMN "stock" TYPE DECIMAL(18,3) USING "stock"::DECIMAL(18,3);
ALTER TABLE "Product" ALTER COLUMN "minStock" TYPE DECIMAL(18,3) USING "minStock"::DECIMAL(18,3);

ALTER TABLE "Customer" ALTER COLUMN "debt" TYPE DECIMAL(18,2) USING "debt"::DECIMAL(18,2);
ALTER TABLE "Customer" ALTER COLUMN "maxDebt" TYPE DECIMAL(18,2) USING "maxDebt"::DECIMAL(18,2);

CREATE TABLE "PosProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "businessName" TEXT NOT NULL DEFAULT 'Usaha Saya',
  "address" TEXT,
  "phone" TEXT,
  "receiptFooter" TEXT,
  "taxPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PosProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegisterSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "RegisterStatus" NOT NULL DEFAULT 'OPEN',
  "openingCash" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "expectedCash" DECIMAL(18,2),
  "closingCash" DECIMAL(18,2),
  "notes" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "RegisterSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Sale" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "customerId" TEXT,
  "registerSessionId" TEXT,
  "invoiceNumber" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
  "subtotal" DECIMAL(18,2) NOT NULL,
  "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(18,2) NOT NULL,
  "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "creditAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "outstandingAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "changeAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "voidReason" TEXT,
  "voidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleItem" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "productId" TEXT,
  "productName" TEXT NOT NULL,
  "sku" TEXT,
  "quantity" DECIMAL(18,3) NOT NULL,
  "unit" TEXT NOT NULL,
  "unitPrice" DECIMAL(18,2) NOT NULL,
  "unitCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "subtotal" DECIMAL(18,2) NOT NULL,
  CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalePayment" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "registerSessionId" TEXT,
  "method" "PosPaymentMethod" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "reference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalePayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockMovement" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "saleId" TEXT,
  "type" "StockMovementType" NOT NULL,
  "quantity" DECIMAL(18,3) NOT NULL,
  "stockBefore" DECIMAL(18,3) NOT NULL,
  "stockAfter" DECIMAL(18,3) NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReceivableEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "saleId" TEXT,
  "type" "ReceivableEntryType" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "method" "PosPaymentMethod",
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceivableEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PosProfile_userId_key" ON "PosProfile"("userId");
CREATE UNIQUE INDEX "Product_userId_sku_key" ON "Product"("userId", "sku");
CREATE UNIQUE INDEX "Product_userId_barcode_key" ON "Product"("userId", "barcode");
CREATE INDEX "RegisterSession_userId_status_idx" ON "RegisterSession"("userId", "status");
CREATE INDEX "RegisterSession_userId_openedAt_idx" ON "RegisterSession"("userId", "openedAt");
CREATE UNIQUE INDEX "Sale_invoiceNumber_key" ON "Sale"("invoiceNumber");
CREATE UNIQUE INDEX "Sale_userId_idempotencyKey_key" ON "Sale"("userId", "idempotencyKey");
CREATE INDEX "Sale_userId_createdAt_idx" ON "Sale"("userId", "createdAt");
CREATE INDEX "Sale_userId_status_idx" ON "Sale"("userId", "status");
CREATE INDEX "Sale_customerId_outstandingAmount_idx" ON "Sale"("customerId", "outstandingAmount");
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");
CREATE INDEX "SalePayment_saleId_idx" ON "SalePayment"("saleId");
CREATE INDEX "SalePayment_registerSessionId_createdAt_idx" ON "SalePayment"("registerSessionId", "createdAt");
CREATE INDEX "StockMovement_userId_createdAt_idx" ON "StockMovement"("userId", "createdAt");
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");
CREATE INDEX "StockMovement_saleId_idx" ON "StockMovement"("saleId");
CREATE INDEX "ReceivableEntry_userId_createdAt_idx" ON "ReceivableEntry"("userId", "createdAt");
CREATE INDEX "ReceivableEntry_customerId_createdAt_idx" ON "ReceivableEntry"("customerId", "createdAt");
CREATE INDEX "ReceivableEntry_saleId_idx" ON "ReceivableEntry"("saleId");

ALTER TABLE "PosProfile" ADD CONSTRAINT "PosProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegisterSession" ADD CONSTRAINT "RegisterSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_registerSessionId_fkey" FOREIGN KEY ("registerSessionId") REFERENCES "RegisterSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_registerSessionId_fkey" FOREIGN KEY ("registerSessionId") REFERENCES "RegisterSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReceivableEntry" ADD CONSTRAINT "ReceivableEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceivableEntry" ADD CONSTRAINT "ReceivableEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceivableEntry" ADD CONSTRAINT "ReceivableEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

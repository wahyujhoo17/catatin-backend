ALTER TABLE "Product" DROP CONSTRAINT "Product_userId_fkey";
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Customer" DROP CONSTRAINT "Customer_userId_fkey";
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

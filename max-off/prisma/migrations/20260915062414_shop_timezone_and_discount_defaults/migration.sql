-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "defaultCombinesOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultCombinesProduct" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultCombinesShipping" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "defaultOncePerCustomer" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "defaultScope" TEXT NOT NULL DEFAULT 'order',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- CreateTable
CREATE TABLE "CappedDiscount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "discountGid" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "code" TEXT,
    "title" TEXT,
    "percentage" INTEGER NOT NULL,
    "capMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'order',
    "checkoutNote" TEXT,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME,
    "status" TEXT NOT NULL,
    "usageLimit" INTEGER,
    "oncePerCustomer" BOOLEAN NOT NULL DEFAULT true,
    "combinesShipping" BOOLEAN NOT NULL DEFAULT true,
    "combinesProduct" BOOLEAN NOT NULL DEFAULT false,
    "combinesOrder" BOOLEAN NOT NULL DEFAULT false,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "keptMinor" INTEGER NOT NULL DEFAULT 0,
    "givenMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CapEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "cappedDiscountId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "uncappedMinor" INTEGER NOT NULL,
    "givenMinor" INTEGER NOT NULL,
    "keptMinor" INTEGER NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    CONSTRAINT "CapEvent_cappedDiscountId_fkey" FOREIGN KEY ("cappedDiscountId") REFERENCES "CappedDiscount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "rounding" TEXT NOT NULL DEFAULT 'cent',
    "defaultCheckoutNote" TEXT NOT NULL DEFAULT 'Discount capped at maximum amount',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "updatedAt" DATETIME NOT NULL,
    "setupGuideDismissedAt" DATETIME,
    "lastCartTestAt" DATETIME,
    "lastCartTestSubtotalMinor" INTEGER,
    "lastCartTestCappedMinor" INTEGER
);

-- CreateIndex
CREATE UNIQUE INDEX "CappedDiscount_discountGid_key" ON "CappedDiscount"("discountGid");

-- CreateIndex
CREATE INDEX "CappedDiscount_shop_status_idx" ON "CappedDiscount"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CapEvent_orderGid_key" ON "CapEvent"("orderGid");

-- CreateIndex
CREATE INDEX "CapEvent_shop_occurredAt_idx" ON "CapEvent"("shop", "occurredAt");

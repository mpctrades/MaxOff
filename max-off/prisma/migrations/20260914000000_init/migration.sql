-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CappedDiscount" (
    "id" TEXT NOT NULL,
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
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "usageLimit" INTEGER,
    "oncePerCustomer" BOOLEAN NOT NULL DEFAULT true,
    "combinesShipping" BOOLEAN NOT NULL DEFAULT true,
    "combinesProduct" BOOLEAN NOT NULL DEFAULT false,
    "combinesOrder" BOOLEAN NOT NULL DEFAULT false,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "keptMinor" INTEGER NOT NULL DEFAULT 0,
    "givenMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CappedDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "cappedDiscountId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "uncappedMinor" INTEGER NOT NULL,
    "givenMinor" INTEGER NOT NULL,
    "keptMinor" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "rounding" TEXT NOT NULL DEFAULT 'cent',
    "defaultCheckoutNote" TEXT NOT NULL DEFAULT 'Discount capped at maximum amount',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "setupGuideDismissedAt" TIMESTAMP(3),
    "lastCartTestAt" TIMESTAMP(3),
    "lastCartTestSubtotalMinor" INTEGER,
    "lastCartTestCappedMinor" INTEGER,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE UNIQUE INDEX "CappedDiscount_discountGid_key" ON "CappedDiscount"("discountGid");

-- CreateIndex
CREATE INDEX "CappedDiscount_shop_status_idx" ON "CappedDiscount"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CapEvent_orderGid_key" ON "CapEvent"("orderGid");

-- CreateIndex
CREATE INDEX "CapEvent_shop_occurredAt_idx" ON "CapEvent"("shop", "occurredAt");

-- AddForeignKey
ALTER TABLE "CapEvent" ADD CONSTRAINT "CapEvent_cappedDiscountId_fkey" FOREIGN KEY ("cappedDiscountId") REFERENCES "CappedDiscount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

